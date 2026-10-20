// Request handling for the ask-tandom Edge Function (plain JS; Supabase client and model call
// injected so it runs unchanged in Deno and in scripts/test-ask-tandom.mjs).
//
// Contract
//   POST { messages: [{role:"user"|"assistant", content:string}, ...], storeId?: string, planogramId?: string }
//     (planogramId = the planogram the person has open; ignored if it is outside their scope)
//     -> 200 { reply: string, actions: [{type:"update_task_status", storeId, storeName, taskId,
//                                         taskDescription, fromStatus, toStatus}] }
//   POST { confirmAction: {type:"update_task_status", storeId, taskId, status} }
//     -> 200 { ok: true, task }       (the ONLY write this function makes, and only on a person's confirm)
//   401 no/invalid session · 403 role not allowed / agent disabled · 400 bad input · 503 not configured
//
// Roles: admin and category_manager (everything), regional_manager (stores in their assigned regions) and
// store_associate (their one assigned store). A store associate's store comes from their profile, never
// from the request; a regional manager names a store but it must be inside their regions.

import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { buildSystemPrompt, createToolRunner, runAskTandom, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, TASK_STATUSES } from "./ask-tandom-agent.js";

export const AGENT_ID = "ask-tandom";
export const TARGET_TYPE = "store_task";
export const ALLOWED_ROLES = ["admin", "category_manager", "regional_manager", "store_associate"];
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

// Product images are large base64 blobs the model never needs.
const stripImages = (p) => { const { images, ...rest } = p || {}; return rest; };

async function readStore(db, storeId) {
  const { data } = await db.from("stores").select("id, data").eq("id", storeId).maybeSingle();
  return data ? { row: data, store: { ...data.data, id: data.id } } : null;
}

// Which store this caller may act on. Returns { storeId } or { response } (an error to return as is).
export function resolveStoreScope(auth, requestedStoreId, storeRegion) {
  if (auth.role === "store_associate") {
    const assigned = auth.profile?.store_id || null;
    if (!assigned) return { response: json(403, { error: "Your account isn't assigned to a store yet — ask an admin." }) };
    return { storeId: assigned };
  }
  if (auth.role === "regional_manager") {
    if (!requestedStoreId) return { response: json(400, { error: "Choose a store first" }) };
    if (!(auth.profile?.regions || []).includes(storeRegion)) return { response: json(403, { error: "That store is outside your region" }) };
  }
  return { storeId: requestedStoreId || null };
}

async function confirmTaskUpdate(db, auth, body) {
  const a = body.confirmAction;
  if (!a || a.type !== "update_task_status") return json(400, { error: "Unknown action" });
  if (typeof a.storeId !== "string" || typeof a.taskId !== "string" || !TASK_STATUSES.includes(a.status)) return json(400, { error: "storeId, taskId and a valid status are required" });
  const found = await readStore(db, a.storeId);
  if (!found) return json(404, { error: "Store not found" });
  // a store user can only act on their own store(s)
  if (auth.role === "store_associate" || auth.role === "regional_manager") {
    const scope = resolveStoreScope(auth, a.storeId, found.store.region);
    if (scope.response) return scope.response;
    if (scope.storeId !== a.storeId) return json(403, { error: "That task belongs to a different store" });
  }
  const tasks = found.store.tasks || [];
  const task = tasks.find((t) => t.id === a.taskId);
  if (!task) return json(404, { error: "Task not found" });
  const now = new Date().toISOString();
  const updated = { ...task, status: a.status, completedAt: a.status === "completed" ? now : null };
  const nextData = { ...found.row.data, tasks: tasks.map((t) => (t.id === task.id ? updated : t)) };
  const { error } = await db.from("stores").update({ data: nextData, updated_by: auth.user.id }).eq("id", a.storeId);
  if (error) return json(500, { error: `Couldn't update the task: ${error.message}` });
  try {
    await db.from("activity_log").insert([{
      actor_type: "user", actor_id: auth.user.id, action: "task_status_changed", target_type: TARGET_TYPE, target_id: task.id,
      detail: { storeId: a.storeId, from: task.status, to: a.status, via: AGENT_ID },
    }]);
  } catch (e) { console.error("ask-tandom: task updated but activity log write failed", e); }
  return json(200, { ok: true, task: updated });
}

export async function handleAskTandom(req, db, { callModel, configured = true, now = () => new Date() } = {}) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Your role is not permitted to use Ask Tandom");
  if (auth.response) return auth.response;

  const { data: agent } = await db.from("agents").select("enabled, allowed_target_types").eq("id", AGENT_ID).maybeSingle();
  if (!agent || !agent.enabled) return json(403, { error: "Ask Tandom is turned off" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  let storeId = typeof body?.storeId === "string" && body.storeId ? body.storeId : null;

  if (body?.confirmAction) {
    if (!(agent.allowed_target_types || []).includes(TARGET_TYPE)) return json(403, { error: "Ask Tandom is not allowed to update tasks" });
    return confirmTaskUpdate(db, auth, body);
  }

  if (!configured || !callModel) return json(503, { error: "Ask Tandom isn't set up yet — the ANTHROPIC_API_KEY secret is missing." });
  if (auth.role === "store_associate") storeId = auth.profile?.store_id || null; // from the profile, never the request
  if ((auth.role === "store_associate" || auth.role === "regional_manager") && !storeId) return json(auth.role === "store_associate" ? 403 : 400, { error: auth.role === "store_associate" ? "Your account isn't assigned to a store yet — ask an admin." : "Choose a store first" });
  if (!Array.isArray(body?.messages) || body.messages.length === 0) return json(400, { error: "messages must be a non-empty array" });
  const history = body.messages.slice(-MAX_HISTORY_MESSAGES)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
  while (history.length && history[0].role !== "user") history.shift(); // the API needs the first turn to be the user's
  if (history.length === 0 || history[history.length - 1].role !== "user") return json(400, { error: "The last message must be from the user" });

  try {
    let storeFound = null;
    if (storeId) {
      storeFound = await readStore(db, storeId);
      if (!storeFound) return json(404, { error: "Store not found" });
      const scope = resolveStoreScope(auth, storeId, storeFound.store.region);
      if (scope.response) return scope.response;
    }
    const store = storeFound ? { id: storeFound.store.id, name: storeFound.store.name, tasks: storeFound.store.tasks || [] } : null;
    const runner = createToolRunner({
      role: auth.role, store, storeId,
      loadPlanograms: async () => (await fetchAll(db, "planograms", "id, data")).map((r) => ({ ...r.data, id: r.id })),
      loadProducts: async () => (await fetchAll(db, "products", "data")).map((r) => stripImages(r.data)),
      loadFixtures: async () => (await fetchAll(db, "fixtures", "data")).map((r) => r.data),
      loadSettings: async (key) => { const { data } = await db.from("app_settings").select("key, value").eq("key", key).maybeSingle(); return parseSetting(data?.value, null); },
    });
    const focus = await runner.describePlanogram(body.planogramId);
    const system = buildSystemPrompt({ role: auth.role, store, today: now().toISOString().slice(0, 10), focus });
    const { reply } = await runAskTandom({ callModel, system, history, runner });
    return json(200, { reply, actions: runner.pending });
  } catch (e) {
    console.error("ask-tandom failed", e);
    return json(502, { error: "Ask Tandom couldn't get an answer just now. Try again in a moment." });
  }
}
