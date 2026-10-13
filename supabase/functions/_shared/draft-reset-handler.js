// Request handling for the draft-reset Edge Function, kept as plain JS with the Supabase
// service-role client injected so the exact same code runs in Deno (supabase/functions/
// draft-reset/index.ts) and in Node (scripts/test-draft-reset.mjs).
//
// Contract
//   POST { planogramIds: string[] (1..MAX_PLANOGRAMS_PER_CALL), lookbackWeeks?: int, storeId?: string|null }
//     (planogramId: string is accepted as shorthand for a one-element planogramIds)
//   200 { results: [{ planogramId, ok: true, score, result: {changes, skipped, startISO, endISO, lookbackWeeks} }
//                 | { planogramId, ok: false, error }] }
//   401 no/invalid JWT · 403 role not allowed or agent disabled · 400 bad input · 405 wrong method
//
// The caller never supplies thresholds, protection rules or data — those are read here, with
// the service-role key, so they never travel to (or from) the browser.

import { computeResetDraft, computeDraftScore, createDraftCache } from "./reset-agent.js";

export const AGENT_ID = "reset-drafting-agent";
export const TARGET_TYPE = "planogram_version";
// Who may trigger this agent. Store Associates are deliberately absent: they may only trigger
// Store Assistant functions (Ask Tandom, Store Feedback Triage), per the design doc.
export const ALLOWED_ROLES = ["admin", "category_manager"];
// Tunable: Edge Functions have a per-invocation CPU budget; the client chunks bulk runs to this.
export const MAX_PLANOGRAMS_PER_CALL = 50;
const PAGE_SIZE = 1000; // PostgREST's default max rows per request

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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

export async function handleDraftReset(req, db) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Use POST" });

  // --- who is calling? -------------------------------------------------------------------
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(401, { error: "Missing Authorization header" });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData?.user) return json(401, { error: "Invalid or expired session" });

  const { data: profile } = await db.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
    return json(403, { error: "Your role is not permitted to run this agent" });
  }

  // --- is the agent switched on, and allowed to touch this kind of target? ---------------
  const { data: agent } = await db.from("agents").select("enabled, allowed_target_types").eq("id", AGENT_ID).maybeSingle();
  if (!agent || !agent.enabled) return json(403, { error: "This agent is disabled" });
  if (!(agent.allowed_target_types || []).includes(TARGET_TYPE)) return json(403, { error: "Agent is not allowed to target planogram versions" });

  // --- input ---------------------------------------------------------------------------
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const ids = Array.isArray(body?.planogramIds) ? body.planogramIds : body?.planogramId ? [body.planogramId] : [];
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
      fetchAll(db, "app_settings", "key, value", (q) => q.in("key", ["schema:product", "schema:resetThresholds"])),
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

    const cache = createDraftCache(); // one Performance snapshot, so planograms can share window totals
    const results = ids.map((planogramId) => {
      const planogram = planogramById[planogramId];
      if (!planogram) return { planogramId, ok: false, error: "Planogram not found" };
      try {
        const result = computeResetDraft(planogram, products, fixtures, performance, productSchema, resetThresholds, lookbackWeeks, storeId, cache);
        return { planogramId, ok: true, score: computeDraftScore(result), result };
      } catch (e) {
        return { planogramId, ok: false, error: `Draft failed: ${e?.message || e}` };
      }
    });
    return json(200, { results });
  } catch (e) {
    console.error("draft-reset failed", e);
    return json(500, { error: "Could not read the data needed to draft a reset" });
  }
}
