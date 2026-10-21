// Request handling for the draft-reset Edge Function, kept as plain JS with the Supabase
// service-role client injected so the exact same code runs in Deno (supabase/functions/
// draft-reset/index.ts) and in Node (scripts/test-draft-reset.mjs).
//
// Contract
//   POST { planogramIds: string[] (1..MAX_PLANOGRAMS_PER_CALL), lookbackWeeks?: int, storeId?: string|null }
//     (planogramId: string is accepted as shorthand for a one-element planogramIds)
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

import { computeResetDraft, computeDraftScore, createDraftCache } from "./reset-agent.js";
import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { fingerprint } from "./proposal-core.js";

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
  let data, error;
  try { ({ data, error } = await db.from("proposals").insert(rows).select("id, target_id")); }
  catch (e) { error = { message: e?.message || String(e) }; }
  if (error || !data) {
    console.error("draft-reset: could not record proposals", error);
    const why = `Couldn't record the proposal${error?.message ? ` (${error.message})` : ""} — has the latest supabase/schema.sql been run?`;
    drafted.forEach((r) => { r.ok = false; r.error = why; delete r.result; delete r.score; });
    return;
  }
  const idByTarget = Object.fromEntries(data.map((d) => [d.target_id, d.id]));
  drafted.forEach((r) => { r.proposalId = idByTarget[r.planogramId]; });
  try {
    const { error: logError } = await db.from("activity_log").insert(
      drafted.map((r) => ({
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
  const rawIds = Array.isArray(body?.planogramIds) ? body.planogramIds : body?.planogramId ? [body.planogramId] : [];
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
        const result = computeResetDraft(planogram, products, fixtures, performance, productSchema, resetThresholds, lookbackWeeks, storeId, cache, dosTargets);
        // what the planogram looked like when this was drafted; apply-proposal refuses to apply
        // the proposal if the planogram has been edited since (its placement ids may have moved)
        result.sourceFingerprint = await fingerprint(planogram.sections ?? null);
        results.push({ planogramId, ok: true, score: computeDraftScore(result), result });
      } catch (e) {
        results.push({ planogramId, ok: false, error: `Draft failed: ${e?.message || e}` });
      }
    }
    await recordProposals(db, results, userData.user.id);
    return json(200, { results });
  } catch (e) {
    console.error("draft-reset failed", e);
    return json(500, { error: "Could not read the data needed to draft a reset" });
  }
}
