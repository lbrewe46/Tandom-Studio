// Request handling for the draft-reset Edge Function, kept as plain JS with the Supabase
// service-role client injected so the exact same code runs in Deno (supabase/functions/
// draft-reset/index.ts) and in Node (scripts/test-draft-reset.mjs).
//
// Contract
//   POST { planogramIds: string[] (1..MAX_PLANOGRAMS_PER_CALL), lookbackWeeks?: int, storeId?: string|null }
//     (planogramId: string is accepted as shorthand for a one-element planogramIds)
//   Minor reset from an Assortment plan: POST { planId: uuid, maxMoves?: int 0..50 (default 5), lookbackWeeks?, storeId? }.
//     Drafts, for each planogram the plan's applied assortment drafts created, the facing / days-of-supply / case-pack changes
//     (never more than maxMoves products moved). planogramIds is not needed; a plan item whose draft is not applied yet is
//     reported as a failure asking for it to be applied first.
//   Major reset from a plan: POST { planId, mode: "major", segmentFieldIds?: string[] (blocking order, up to 6), allowResize?: boolean (default true) }.
//     Re-lays each planogram the plan's applied drafts created: blocks by segment, best sellers at eye level, sections added when the
//     items need more width. Nothing is removed without being named in the draft; maxMoves does not apply.
//   200 { results: [{ planogramId, ok: true, score, proposalId, result: {changes, skipped, startISO, endISO, lookbackWeeks} }
//                 | { planogramId, ok: false, error }] }
//
// Phase 3: every successful draft is recorded as a pending row in `proposals` (what the agent
// suggested, why, its Draft Score, who asked) and logged in `activity_log`, using the service-role
// client. A draft that could not be recorded is reported as a failure — the app never gets a
// draft it can't trace back to a Proposal.
//   401 no/invalid JWT · 403 role not allowed or agent disabled · 400 bad input · 405 wrong method
//
// The caller never supplies thresholds, protection rules or data — those are read here, with
// the service-role key, so they never travel to (or from) the browser.

import { computeResetDraft, computeDraftScore, createDraftCache, limitMovement } from "./reset-agent.js";
import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { fingerprint } from "./proposal-core.js";
import { computeMajorReset } from "./major-reset.js";

export const AGENT_ID = "reset-drafting-agent";
export const TARGET_TYPE = "planogram_version";
// Who may trigger this agent. Store Associates are deliberately absent: they may only trigger
// Store Assistant functions (Ask Tandom, Store Feedback Triage), per the design doc.
export const ALLOWED_ROLES = ["admin", "category_manager"];
// Tunable: Edge Functions have a per-invocation CPU budget; the client chunks bulk runs to this.
export const MAX_PLANOGRAMS_PER_CALL = 50;
const PAGE_SIZE = 1000; // PostgREST's default max rows per request

// PostgREST silently truncates at PAGE_SIZE rows, so page through until a short page comes back.
async function fetchAll(db, table, columns, applyFilters = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await applyFilters(db.from(table).select(columns)).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

// app_settings values are stored as JSON strings (the app writes JSON.stringify(...)), but a
// jsonb column may also hold a real array/object — accept either.
function parseSetting(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function summarize(r) {
  const { changes, skipped, startISO, endISO, lookbackWeeks } = r.result;
  const n = changes.length;
  const k = skipped.length;
  return `${n} change${n === 1 ? "" : "s"} proposed${k ? `, ${k} skipped` : ""} from the last ${lookbackWeeks} weeks${startISO && endISO ? ` (${startISO} to ${endISO})` : ""}.`;
}

// Writes one pending Proposal per successful draft, then the matching activity rows. Mutates
// `results` in place: a draft that couldn't be recorded becomes a failure (its proposal is the
// audit trail), while a failed activity write is only logged — the Proposal itself is the record
// of record and review_proposal() writes its own activity rows.
export async function recordProposals(db, results, requestedBy, agentId = AGENT_ID) {
  const drafted = results.filter((r) => r.ok);
  if (drafted.length === 0) return;
  const rows = drafted.map((r) => ({
    agent_id: agentId, target_type: TARGET_TYPE, target_id: r.planogramId,
    proposed_change: r.result, reason: r.reason || summarize(r), score: r.score, status: "pending", requested_by: requestedBy,
  }));
  // Written in chunks so a run over thousands of planograms is never one huge request; a chunk that fails marks
  // only its own drafts as failed.
  const CHUNK = 100;
  const idByTarget = {};
  for (let i = 0; i < drafted.length; i += CHUNK) {
    const slice = drafted.slice(i, i + CHUNK);
    let data, error;
    try { ({ data, error } = await db.from("proposals").insert(rows.slice(i, i + CHUNK)).select("id, target_id")); }
    catch (e) { error = { message: e?.message || String(e) }; }
    if (error || !data) {
      console.error("draft-reset: could not record proposals", error);
      const why = `Couldn't record the proposal${error?.message ? ` (${error.message})` : ""} — has the latest supabase/schema.sql been run?`;
      slice.forEach((r) => { r.ok = false; r.error = why; delete r.result; delete r.score; });
      continue;
    }
    data.forEach((d) => { idByTarget[d.target_id] = d.id; });
  }
  const recorded = drafted.filter((r) => r.ok);
  if (recorded.length === 0) return;
  recorded.forEach((r) => { r.proposalId = idByTarget[r.planogramId]; });
  try {
    const { error: logError } = await db.from("activity_log").insert(
      recorded.map((r) => ({
        actor_type: "agent", actor_id: agentId, action: "proposal_created", target_type: TARGET_TYPE, target_id: r.planogramId,
        detail: { proposalId: r.proposalId, score: r.score, changes: r.result.changes.length, skipped: r.result.skipped.length, lookbackWeeks: r.result.lookbackWeeks, requestedBy },
      })),
    );
    if (logError) console.error("draft-reset: proposals saved but activity log write failed", logError);
  } catch (e) {
    console.error("draft-reset: proposals saved but activity log write threw", e);
  }
}

export async function handleDraftReset(req, db) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;

  // --- who is calling? -------------------------------------------------------------------
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Your role is not permitted to run this agent");
  if (auth.response) return auth.response;
  const userData = { user: auth.user };

  // --- is the agent switched on, and allowed to touch this kind of target? ---------------
  const { data: agent } = await db.from("agents").select("enabled, allowed_target_types").eq("id", AGENT_ID).maybeSingle();
  if (!agent || !agent.enabled) return json(403, { error: "This agent is disabled" });
  if (!(agent.allowed_target_types || []).includes(TARGET_TYPE)) return json(403, { error: "Agent is not allowed to target planogram versions" });

  // --- input ---------------------------------------------------------------------------
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const planMode = body?.planId !== undefined;
  let plan = null;
  let planFailures = [];
  let rawIds = Array.isArray(body?.planogramIds) ? body.planogramIds : body?.planogramId ? [body.planogramId] : [];
  const major = body?.mode === "major";
  if (body?.mode !== undefined && !["minor", "major"].includes(body.mode)) return json(400, { error: "mode must be minor or major" });
  if (major && !planMode) return json(400, { error: "A major reset needs a planId" });
  const segmentFieldIds = body.segmentFieldIds === undefined ? [] : body.segmentFieldIds;
  if (!Array.isArray(segmentFieldIds) || segmentFieldIds.length > 6 || segmentFieldIds.some((x) => typeof x !== "string" || !x)) return json(400, { error: "segmentFieldIds must be up to six attribute ids" });
  if (body.allowResize !== undefined && typeof body.allowResize !== "boolean") return json(400, { error: "allowResize must be true or false" });
  const maxMoves = body.maxMoves === undefined ? 5 : body.maxMoves;
  if (planMode) {
    if (typeof body.planId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.planId)) return json(400, { error: "planId must be a plan id" });
    if (!Number.isInteger(maxMoves) || maxMoves < 0 || maxMoves > 50) return json(400, { error: "maxMoves must be an integer from 0 to 50" });
    const { data: planRow, error: planErr } = await db.from("assortment_plans").select("id, name, status, proposal_ids").eq("id", body.planId).maybeSingle();
    if (planErr) return json(500, { error: "Could not read the plan", detail: planErr.message });
    if (!planRow) return json(404, { error: "Plan not found" });
    if (["executed", "cancelled"].includes(planRow.status)) return json(409, { error: `This plan is ${planRow.status}` });
    plan = planRow;
    const { data: planProposals, error: propErr } = await db.from("proposals").select("id, target_id, status, applied_id").in("id", plan.proposal_ids || []);
    if (propErr) return json(500, { error: "Could not read the plan's drafts", detail: propErr.message });
    rawIds = [];
    (planProposals || []).forEach((pr) => {
      if (pr.status === "applied" && pr.applied_id) rawIds.push(pr.applied_id);
      else planFailures.push({ planogramId: pr.target_id, ok: false, error: `The assortment draft for this planogram is ${pr.status}; apply it first so a version exists to reset.` });
    });
    if (rawIds.length === 0) return json(200, { results: planFailures });
  }
  const ids = [...new Set(rawIds)]; // one proposal per planogram per call, even if an id is repeated
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || !id)) return json(400, { error: "planogramIds must be a non-empty array of ids" });
  if (ids.length > MAX_PLANOGRAMS_PER_CALL) return json(400, { error: `At most ${MAX_PLANOGRAMS_PER_CALL} planograms per call` });
  const lookbackWeeks = body.lookbackWeeks === undefined ? 13 : body.lookbackWeeks;
  if (!Number.isInteger(lookbackWeeks) || lookbackWeeks < 1 || lookbackWeeks > 156) return json(400, { error: "lookbackWeeks must be an integer from 1 to 156" });
  const storeId = typeof body.storeId === "string" && body.storeId ? body.storeId : null;

  // --- data (read once, shared by every planogram in the call) ---------------------------
  try {
    const [planogramRows, productRows, fixtureRows, perfRows, settingRows] = await Promise.all([
      fetchAll(db, "planograms", "id, data", (q) => q.in("id", ids)),
      fetchAll(db, "products", "data"),
      fetchAll(db, "fixtures", "data"),
      fetchAll(db, "performance", "id, data"),
      fetchAll(db, "app_settings", "key, value", (q) => q.in("key", ["schema:product", "schema:resetThresholds", "schema:dosTargets"])),
    ]);
    const planogramById = Object.fromEntries(planogramRows.map((r) => [r.id, r.data]));
    const products = productRows.map((r) => r.data);
    const fixtures = fixtureRows.map((r) => r.data);
    const performance = Object.fromEntries(perfRows.map((r) => [r.id, r.data?.records || []]));
    const setting = (key, fallback) => parseSetting(settingRows.find((r) => r.key === key)?.value, fallback);
    // No saved product schema = nothing can be matched by label; the agent then simply skips
    // missing-winner additions, same as the app would.
    const productSchema = setting("schema:product", []);
    const resetThresholds = setting("schema:resetThresholds", []);
    const dosTargets = setting("schema:dosTargets", []);

    const cache = createDraftCache(); // one Performance snapshot, so planograms can share window totals
    const results = [];
    for (const planogramId of ids) {
      const planogram = planogramById[planogramId];
      if (!planogram) { results.push({ planogramId, ok: false, error: "Planogram not found" }); continue; }
      try {
        let result;
        if (major) {
          result = computeMajorReset(planogram, { products, fixtures, performance, dosTargets, segmentFieldIds, weeks: lookbackWeeks, allowResize: body.allowResize !== false });
          result.majorPlan = { planId: plan.id, planName: plan.name, segmentFieldIds };
        } else {
          result = computeResetDraft(planogram, products, fixtures, performance, productSchema, resetThresholds, lookbackWeeks, storeId, cache, dosTargets);
          if (plan) result = { ...limitMovement(result, maxMoves), minor: { planId: plan.id, planName: plan.name, maxMoves } };
        }
        // what the planogram looked like when this was drafted; apply-proposal refuses to apply
        // the proposal if the planogram has been edited since (its placement ids may have moved)
        result.sourceFingerprint = await fingerprint(planogram.sections ?? null);
        const entry = { planogramId, ok: true, score: computeDraftScore(result), result };
        if (major) {
          const m = result.movement;
          entry.reason = `Major reset for plan "${plan.name}": ${m.items} items re-laid, ${m.moved} on a different shelf (${m.pctMoved}%)${result.major.sectionsAdded ? `, ${result.major.sectionsAdded} section${result.major.sectionsAdded === 1 ? "" : "s"} added` : ""}${m.unplaced || m.trimmedOut ? `, ${m.unplaced + m.trimmedOut} left out for lack of room` : ""}.`;
        } else if (plan) {
          const m = result.movement;
          entry.reason = `Minor reset for plan "${plan.name}": ${result.changes.length} change${result.changes.length === 1 ? "" : "s"} (${m.facingChanges} facing/stack/case-pack, ${m.adds} added, ${m.removes} removed)${m.trimmed ? `, ${m.trimmed} move${m.trimmed === 1 ? "" : "s"} left for a major reset` : ""}.`;
        }
        results.push(entry);
      } catch (e) {
        results.push({ planogramId, ok: false, error: `Draft failed: ${e?.message || e}` });
      }
    }
    await recordProposals(db, results, userData.user.id);
    return json(200, { results: [...planFailures, ...results] });
  } catch (e) {
    console.error("draft-reset failed", e);
    return json(500, { error: "Could not read the data needed to draft a reset" });
  }
}
