// Request handling for the reset-impact Edge Function (plain JS, service-role client injected).
//
// Contract
//   POST { planogramIds?: string[], all?: true, preWeeks?: int, postWeeks?: int }
//     all = every Live planogram that has a Historical baseline version (the ones a reset can be judged on)
//   200 { results: [{ planogramId, ok: true, status, result } | { planogramId, ok: false, error }] }
//   Each measured result is saved (one row per planogram, replaced on re-measure) in `reset_impacts`,
//   linked to the AI proposal that created the version when there was one, and logged in activity_log.
//   400 bad input · 401 no/invalid JWT · 403 role not allowed / agent disabled
//
// Deterministic: thresholds, windows and performance data are read here; nothing is sent to a model.

import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { effectivePlanogramStatus, getLatestWeekEnding } from "./app-core.js";
import { computeResetImpact, getBaselinePlanogram, IMPACT_DEFAULTS } from "./reset-impact.js";

export const AGENT_ID = "reset-impact-agent";
export const ALLOWED_ROLES = ["admin", "category_manager"];
export const MAX_PLANOGRAMS_PER_CALL = 100;
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

const intInRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export async function handleResetImpact(req, db) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Your role is not permitted to run this agent");
  if (auth.response) return auth.response;

  const { data: agent } = await db.from("agents").select("enabled").eq("id", AGENT_ID).maybeSingle();
  if (!agent || !agent.enabled) return json(403, { error: "This agent is disabled" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const params = {};
  if (body.preWeeks !== undefined) { if (!intInRange(body.preWeeks, 2, 52)) return json(400, { error: "preWeeks must be an integer from 2 to 52" }); params.preWeeks = body.preWeeks; }
  if (body.postWeeks !== undefined) { if (!intInRange(body.postWeeks, 2, 52)) return json(400, { error: "postWeeks must be an integer from 2 to 52" }); params.postWeeks = body.postWeeks; }
  if ((params.postWeeks ?? IMPACT_DEFAULTS.postWeeks) < IMPACT_DEFAULTS.minPostWeeks) return json(400, { error: `postWeeks must be at least ${IMPACT_DEFAULTS.minPostWeeks}` });
  const wantAll = body.all === true;
  const ids = Array.isArray(body.planogramIds) ? [...new Set(body.planogramIds)] : [];
  if (!wantAll && (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id))) return json(400, { error: "Give planogramIds, or all: true" });
  if (ids.length > MAX_PLANOGRAMS_PER_CALL) return json(400, { error: `At most ${MAX_PLANOGRAMS_PER_CALL} planograms per call` });

  try {
    // the whole family of each requested planogram is needed (to find its baseline), so read them all
    const [planogramRows, productRows, perfRows, storeRows] = await Promise.all([
      fetchAll(db, "planograms", "id, data"),
      fetchAll(db, "products", "id, data"),
      fetchAll(db, "performance", "id, data"),
      // only the fields the report needs (store rows can carry large photo blobs)
      fetchAll(db, "stores", "id, name:data->>name, storeNumber:data->>storeNumber, region:data->>region, format:data->>format"),
    ]);
    const allPlanograms = planogramRows.map((r) => ({ ...r.data, id: r.id }));
    const products = productRows.map((r) => ({ ...r.data, id: r.id }));
    const performance = Object.fromEntries(perfRows.map((r) => [r.id, r.data?.records || []]));
    const stores = storeRows.map((r) => (r.data ? { id: r.id, name: r.data.name, storeNumber: r.data.storeNumber, region: r.data.region, format: r.data.format } : { id: r.id, name: r.name, storeNumber: r.storeNumber, region: r.region, format: r.format }));
    const latestISO = getLatestWeekEnding(performance);

    const targets = wantAll
      ? allPlanograms.filter((p) => effectivePlanogramStatus(p) === "live" && getBaselinePlanogram(p, allPlanograms)).slice(0, MAX_PLANOGRAMS_PER_CALL)
      : ids.map((id) => allPlanograms.find((p) => p.id === id) || { id, missing: true });

    const results = [];
    for (const pg of targets) {
      if (pg.missing) { results.push({ planogramId: pg.id, ok: false, error: "Planogram not found" }); continue; }
      try {
        const result = computeResetImpact({ planogram: pg, allPlanograms, products, performance, stores, params, latestISO });
        results.push({ planogramId: pg.id, ok: true, status: result.status, result, proposalId: pg.resetDraft?.proposalId || null });
      } catch (e) {
        results.push({ planogramId: pg.id, ok: false, error: `Measurement failed: ${e?.message || e}` });
      }
    }

    const saveable = results.filter((r) => r.ok && r.status === "ok");
    if (saveable.length) {
      const now = new Date().toISOString();
      const rows = saveable.map((r) => ({
        planogram_id: r.planogramId, baseline_planogram_id: r.result.baselinePlanogramId, proposal_id: r.proposalId,
        go_live_date: r.result.goLiveDate, params: r.result.params, result: r.result, computed_by: auth.user.id, computed_at: now,
      }));
      const { error } = await db.from("reset_impacts").upsert(rows, { onConflict: "planogram_id" });
      if (error) {
        console.error("reset-impact: could not save results", error);
        return json(500, { error: `Couldn't save the results (${error.message}) — has the latest supabase/schema.sql been run?` });
      }
      try {
        await db.from("activity_log").insert(saveable.map((r) => ({
          actor_type: "agent", actor_id: AGENT_ID, action: "impact_measured", target_type: "planogram_version", target_id: r.planogramId,
          detail: { proposalId: r.proposalId, goLiveDate: r.result.goLiveDate, measuredStores: r.result.counts.measured, maturingStores: r.result.counts.maturing, salesChangePct: r.result.summary?.metrics.sales.changePct ?? null, liftPp: r.result.summary?.metrics.sales.liftPp ?? null, requestedBy: auth.user.id },
        })));
      } catch (e) { console.error("reset-impact: results saved but activity log write failed", e); }
    }
    return json(200, { results });
  } catch (e) {
    console.error("reset-impact failed", e);
    return json(500, { error: "Could not read the data needed to measure impact" });
  }
}
