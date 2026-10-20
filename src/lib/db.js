import { supabase, supabaseConfigured } from "./supabaseClient.js";

export { supabase, supabaseConfigured };

// tracks in-flight writes so the app can show a "saving…" indicator and warn before the tab
// closes/refreshes mid-save — same contract the app already relied on with localStorage/window.storage
let pendingWrites = 0;
export const pendingWriteListeners = new Set();
function notifyPendingWriteListeners() { pendingWriteListeners.forEach((fn) => fn(pendingWrites)); }
function trackWriteStart() { pendingWrites++; notifyPendingWriteListeners(); }
function trackWriteEnd() { pendingWrites = Math.max(0, pendingWrites - 1); notifyPendingWriteListeners(); }

// Resolves once no saves are in flight (or after timeoutMs, so a stuck save can't hang the UI).
// Anything that asks the *server* to read data the user just edited — like the draft-reset Edge
// Function — should wait on this first, or it will analyze the previous saved version.
export function waitForPendingWrites(timeoutMs = 10000) {
  if (pendingWrites === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); pendingWriteListeners.delete(check); resolve(); };
    const check = (n) => { if (n === 0) done(); };
    const timer = setTimeout(done, timeoutMs);
    pendingWriteListeners.add(check);
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (pendingWrites > 0) {
      e.preventDefault();
      e.returnValue = "Changes are still saving — leaving now may lose recent work.";
      return e.returnValue;
    }
  });
}

async function currentUserId() {
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user?.id || null;
  } catch (e) {
    return null;
  }
}

// -------------------------------------------------------------------
// Settings namespace (schema:product, schema:fixture, settings:*) —
// arbitrary string key -> string value, stored in app_settings(key, value)
// -------------------------------------------------------------------

export async function safeGet(key) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("app_settings").select("value").eq("key", key).maybeSingle();
    if (error || !data) return null;
    return typeof data.value === "string" ? data.value : JSON.stringify(data.value);
  } catch (e) {
    return null;
  }
}

export async function safeSet(key, value) {
  if (!supabase) return false;
  trackWriteStart();
  try {
    const userId = await currentUserId();
    const { error } = await supabase.from("app_settings").upsert({ key, value, updated_by: userId });
    return !error;
  } catch (e) {
    return false;
  } finally {
    trackWriteEnd();
  }
}

export async function safeDelete(key) {
  if (!supabase) return;
  trackWriteStart();
  try {
    await supabase.from("app_settings").delete().eq("key", key);
  } catch (e) {
    /* ignore */
  } finally {
    trackWriteEnd();
  }
}

// -------------------------------------------------------------------
// Entity kinds (product / fixture / planogram / store / perf) — each
// row is {id, data jsonb}; "data" holds the full object exactly as the
// app already reads/writes it, so no shape changes were needed anywhere
// else in the app to make this swap.
// -------------------------------------------------------------------

const KIND_TABLE = {
  product: "products",
  fixture: "fixtures",
  planogram: "planograms",
  store: "stores",
  perf: "performance",
};

export async function loadIndexed(kind) {
  if (!supabase) return [];
  const table = KIND_TABLE[kind];
  if (!table) return [];
  try {
    const { data, error } = await supabase.from(table).select("data");
    if (error || !data) return [];
    return data.map((row) => row.data);
  } catch (e) {
    return [];
  }
}

export async function saveIndexed(kind, obj) {
  const table = KIND_TABLE[kind];
  if (!supabase || !table) return;
  trackWriteStart();
  try {
    const userId = await currentUserId();
    await supabase.from(table).upsert({ id: obj.id, data: obj, updated_by: userId });
  } catch (e) {
    /* ignore — matches the app's existing fire-and-forget save contract */
  } finally {
    trackWriteEnd();
  }
}

export async function deleteIndexed(kind, id) {
  const table = KIND_TABLE[kind];
  if (!supabase || !table) return;
  trackWriteStart();
  try {
    await supabase.from(table).delete().eq("id", id);
  } catch (e) {
    /* ignore */
  } finally {
    trackWriteEnd();
  }
}

// -------------------------------------------------------------------
// Proposals + activity log (Phase 3). Agents write Proposals through an
// Edge Function; people only read them and record a decision through the
// review_proposal() database function — there is no direct write path.
// -------------------------------------------------------------------

// Pending Proposals, newest first. `ok` is false when the table can't be read (e.g. the latest
// schema.sql hasn't been run yet) so callers can fall back instead of treating it as "none".
export async function loadPendingProposals() {
  if (!supabase) return { ok: false, rows: [] };
  try {
    const { data, error } = await supabase
      .from("proposals")
      .select("id, agent_id, target_type, target_id, reason, score, status, requested_by, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error || !data) return { ok: false, rows: [] };
    return { ok: true, rows: data };
  } catch (e) {
    return { ok: false, rows: [] };
  }
}

// Records an Admin / Category Manager's decision ("approved" | "rejected"). Throws with the
// database's message (wrong role, already decided differently, …) so the caller can show it.
export async function reviewProposal(proposalId, decision, note) {
  if (!supabase) throw new Error("Supabase isn't configured.");
  const { data, error } = await supabase.rpc("review_proposal", { p_id: proposalId, p_decision: decision, p_note: note || null });
  if (error) throw new Error(error.message);
  return data;
}

// id -> display name (falls back to email) for the given user ids.
export async function loadProfileNames(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!supabase || unique.length === 0) return {};
  try {
    const { data, error } = await supabase.from("profiles").select("id, display_name, email").in("id", unique);
    if (error || !data) return {};
    return Object.fromEntries(data.map((p) => [p.id, p.display_name || p.email || "Someone"]));
  } catch (e) {
    return {};
  }
}

// Newest-first activity for any of the given target ids (a planogram and the version it was
// drafted from, say), with the people involved resolved to names.
export async function loadActivity(targetIds, limit = 100) {
  const ids = [...new Set((targetIds || []).filter(Boolean))];
  if (!supabase || ids.length === 0) return { ok: true, rows: [], names: {} };
  try {
    const { data, error } = await supabase
      .from("activity_log")
      .select("id, actor_type, actor_id, action, target_type, target_id, detail, created_at")
      .in("target_id", ids)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return { ok: false, rows: [], names: {}, error: error?.message };
    const userIds = data.flatMap((r) => [r.actor_type === "user" ? r.actor_id : null, r.detail?.requestedBy]);
    return { ok: true, rows: data, names: await loadProfileNames(userIds) };
  } catch (e) {
    return { ok: false, rows: [], names: {}, error: e?.message };
  }
}
