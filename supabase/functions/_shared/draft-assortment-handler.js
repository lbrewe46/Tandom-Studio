// Request handling for the draft-assortment Edge Function (plain JS, service-role client injected).
// Takes the new items a planner wants placed, re-runs the Assortment recommender on the server's own copy of
// the data (the browser never supplies placements, so nothing it sends can put an item somewhere the engine
// wouldn't), and records one pending Proposal per planogram. People review and approve those exactly like Reset
// Drafting proposals; apply-proposal turns an approved one into a new WIP version.
//
// Contract
//   POST { newItemIds: string[],
//          params: { category, scope?: {type, value}, weeks?, compare?, segmentFieldIds?: string[], assumptions? },
//          exclude?: string[]  ("itemId|planogramId" pairs the planner unticked),
//          protect?: string[]  (product ids that must not be removed),
//          maxPlanogramsPerItem?: int }
//   200 { proposals: [{ planogramId, planogramName, proposalId, adds, removes }], notDrafted: [{ planogramId, planogramName, reason }] }
//   400 bad input · 401 · 403 role not allowed or agent disabled · 500
//
// Only Admins and Category Managers may run it. Thresholds and data are read here, with the service-role key.

import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { fingerprint } from "./proposal-core.js";
import { recordProposals } from "./draft-reset-handler.js";
import { buildContext, recommend } from "./assortment.js";
import { getLatestWeekEnding, addDaysISO } from "./app-core.js";

export const AGENT_ID = "assortment-agent";
export const TARGET_TYPE = "planogram_version";
export const ALLOWED_ROLES = ["admin", "category_manager"];
export const MAX_ITEMS = 100;
const PAGE_SIZE = 1000;

async function fetchAll(db, table, columns, applyFilters = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await applyFilters(db.from(table).select(columns)).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function parseSetting(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

const isStringArray = (x) => Array.isArray(x) && x.every((v) => typeof v === "string" && v);

// -> { error } or { params } with everything checked and defaulted
export function validateParams(body) {
  const p = body?.params || {};
  if (typeof p.category !== "string" || !p.category.trim()) return { error: "params.category is required" };
  const weeks = p.weeks === undefined ? 13 : p.weeks;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 156) return { error: "weeks must be an integer from 1 to 156" };
  const compare = p.compare === undefined ? "prior" : p.compare;
  if (!["prior", "yoy"].includes(compare)) return { error: "compare must be prior or yoy" };
  const scope = p.scope || { type: "all" };
  if (!["all", "region", "cluster", "format", "store", "storeAttr"].includes(scope.type)) return { error: "scope.type is not recognised" };
  if (scope.type === "storeAttr" && (typeof scope.fieldId !== "string" || !scope.fieldId)) return { error: "scope.fieldId is required for a store attribute scope" };
  const pfIn = p.planogramFilter;
  if (pfIn !== undefined && pfIn !== null && (typeof pfIn !== "object" || typeof pfIn.fieldId !== "string" || typeof pfIn.value !== "string")) return { error: "planogramFilter needs a fieldId and a value" };
  const planogramFilter = pfIn && pfIn.fieldId && pfIn.value ? { fieldId: pfIn.fieldId, value: pfIn.value, fieldLabel: typeof pfIn.fieldLabel === "string" ? pfIn.fieldLabel : undefined } : undefined;
  if (scope.type !== "all" && (typeof scope.value !== "string" || !scope.value)) return { error: "scope.value is required for that scope" };
  const segmentFieldIds = p.segmentFieldIds === undefined ? [] : p.segmentFieldIds;
  if (!isStringArray(segmentFieldIds) || segmentFieldIds.length > 6) return { error: "segmentFieldIds must be up to six attribute ids" };
  const a = p.assumptions || {};
  const assumptions = {};
  if (a.metric !== undefined) { if (!["sales", "margin", "units"].includes(a.metric)) return { error: "assumptions.metric must be sales, margin or units" }; assumptions.metric = a.metric; }
  for (const k of ["cannibalization", "transfer"]) if (a[k] !== undefined) { if (typeof a[k] !== "number" || a[k] < 0 || a[k] > 1) return { error: `assumptions.${k} must be a number from 0 to 1` }; assumptions[k] = a[k]; }
  if (a.maxRemovalsPerAdd !== undefined) { if (!Number.isInteger(a.maxRemovalsPerAdd) || a.maxRemovalsPerAdd < 0 || a.maxRemovalsPerAdd > 5) return { error: "assumptions.maxRemovalsPerAdd must be 0 to 5" }; assumptions.maxRemovalsPerAdd = a.maxRemovalsPerAdd; }
  return { params: { category: p.category.trim(), weeks, compare, scope, planogramFilter, segmentFieldIds, assumptions } };
}

export async function handleDraftAssortment(req, db) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Only an Admin or Category Manager can draft an assortment change");
  if (auth.response) return auth.response;

  const { data: agent } = await db.from("agents").select("enabled, allowed_target_types").eq("id", AGENT_ID).maybeSingle();
  if (!agent || !agent.enabled) return json(403, { error: "This agent is disabled (has the latest supabase/schema.sql been run?)" });
  if (!(agent.allowed_target_types || []).includes(TARGET_TYPE)) return json(403, { error: "Agent is not allowed to target planogram versions" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  if (!Array.isArray(body?.newItemIds)) return json(400, { error: "newItemIds must be a non-empty array of product ids" });
  const ids = [...new Set(body.newItemIds)];
  if (!isStringArray(ids) || ids.length === 0) return json(400, { error: "newItemIds must be a non-empty array of product ids" });
  if (ids.length > MAX_ITEMS) return json(400, { error: `At most ${MAX_ITEMS} new items per call` });
  const checked = validateParams(body);
  if (checked.error) return json(400, { error: checked.error });
  if (body.exclude !== undefined && !isStringArray(body.exclude)) return json(400, { error: "exclude must be an array of itemId|planogramId strings" });
  if (body.protect !== undefined && !isStringArray(body.protect)) return json(400, { error: "protect must be an array of product ids" });
  if (body.maxPlanogramsPerItem !== undefined && (!Number.isInteger(body.maxPlanogramsPerItem) || body.maxPlanogramsPerItem < 1)) return json(400, { error: "maxPlanogramsPerItem must be a positive integer" });

  try {
    const [planogramRows, productRows, fixtureRows, , storeRows, settingRows] = await Promise.all([
      fetchAll(db, "planograms", "id, data"),
      fetchAll(db, "products", "data"),
      fetchAll(db, "fixtures", "data"),
      Promise.resolve(null), // performance is read below, only for the products this run needs
      fetchAll(db, "stores", "data"),
      fetchAll(db, "app_settings", "key, value", (q) => q.in("key", ["schema:product"])),
    ]);
    const products = productRows.map((r) => r.data);
    const known = new Set(products.map((p) => p.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) return json(400, { error: `Unknown product ids: ${missing.slice(0, 3).join(", ")}` });
    const notNew = products.filter((p) => ids.includes(p.id) && !p.newItem).map((p) => p.name);
    if (notNew.length) return json(400, { error: `Not new items (nothing to place): ${notNew.slice(0, 3).join(", ")}` });

    const planograms = planogramRows.map((r) => r.data);
    // A large chain has millions of sales records, so only the products on this category's planograms (plus the new
    // items' similar items) are read, and only the weeks the two comparison windows need.
    const needed = new Set();
    planograms.filter((p) => p.category === checked.params.category).forEach((p) => (p.sections || []).forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => needed.add(pl.productId)))));
    products.filter((p) => ids.includes(p.id)).forEach((p) => (p.newItem?.proxyProductIds || []).forEach((id) => needed.add(id)));
    const perfRows = [];
    const neededIds = [...needed];
    for (let i = 0; i < neededIds.length; i += 100) {
      const chunk = neededIds.slice(i, i + 100);
      perfRows.push(...(await fetchAll(db, "performance", "id, data", (q) => q.in("id", chunk))));
    }
    const performance = Object.fromEntries(perfRows.map((r) => [r.id, r.data?.records || []]));
    const latest = getLatestWeekEnding(performance);
    if (latest) {
      const horizon = addDaysISO(latest, -(checked.params.weeks * 2 * 7 + (checked.params.compare === "yoy" ? 364 : 0) + 14));
      Object.keys(performance).forEach((id) => { performance[id] = performance[id].filter((r) => r.weekEnding >= horizon); });
    }
    const data = {
      products, planograms, fixtures: fixtureRows.map((r) => r.data),
      performance,
      stores: storeRows.map((r) => r.data),
      productSchema: parseSetting(settingRows.find((r) => r.key === "schema:product")?.value, []),
    };
    const ctx = buildContext(data, checked.params);
    const rec = recommend(ctx, ids, { exclude: new Set(body.exclude || []), protect: new Set(body.protect || []), maxPlanogramsPerItem: body.maxPlanogramsPerItem || null });

    const planogramById = Object.fromEntries(planograms.map((p) => [p.id, p]));
    const results = [];
    const notDrafted = [];
    for (const [planogramId, g] of Object.entries(rec.byPlanogram)) {
      const planogram = planogramById[planogramId];
      if (!planogram) continue;
      if (!g.changes.length) { notDrafted.push({ planogramId, planogramName: planogram.name, reason: g.skipped.map((s) => `${s.productName}: ${s.reason}`).join(" ") }); continue; }
      const adds = g.changes.filter((c) => c.type === "addProduct").length;
      const removes = g.changes.filter((c) => c.type === "delete").length;
      const result = {
        changes: g.changes, skipped: g.skipped, notes: [], startISO: rec.startISO, endISO: rec.endISO, lookbackWeeks: rec.lookbackWeeks,
        assortment: { category: checked.params.category, scope: ctx.scope.label, metric: rec.metric, assumptions: rec.assumptions, newItems: g.changes.filter((c) => c.type === "addProduct").map((c) => c.productName) },
      };
      result.sourceFingerprint = await fingerprint(planogram.sections ?? null);
      const score = Math.round((adds / (adds + g.skipped.length)) * 100);
      results.push({
        planogramId, ok: true, score, result, planogramName: planogram.name, adds, removes,
        reason: `New item assortment for ${checked.params.category} (${ctx.scope.label}): ${adds} item${adds === 1 ? "" : "s"} added${removes ? `, ${removes} removed to make room` : ""}${g.skipped.length ? `, ${g.skipped.length} could not be placed` : ""}.`,
      });
    }
    await recordProposals(db, results, auth.user.id, AGENT_ID);
    const proposals = results.filter((r) => r.ok).map((r) => ({ planogramId: r.planogramId, planogramName: r.planogramName, proposalId: r.proposalId, adds: r.adds, removes: r.removes }));
    results.filter((r) => !r.ok).forEach((r) => notDrafted.push({ planogramId: r.planogramId, planogramName: r.planogramName, reason: r.error }));
    return json(200, { proposals, notDrafted });
  } catch (e) {
    console.error("draft-assortment failed", e);
    return json(500, { error: "Could not draft the assortment change" });
  }
}
