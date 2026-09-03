import { supabase, supabaseConfigured } from "./supabaseClient.js";

export { supabase, supabaseConfigured };

// tracks in-flight writes so the app can show a "saving…" indicator and warn before the tab
// closes/refreshes mid-save — same contract the app already relied on with localStorage/window.storage
let pendingWrites = 0;
export const pendingWriteListeners = new Set();
function notifyPendingWriteListeners() { pendingWriteListeners.forEach((fn) => fn(pendingWrites)); }
function trackWriteStart() { pendingWrites++; notifyPendingWriteListeners(); }
function trackWriteEnd() { pendingWrites = Math.max(0, pendingWrites - 1); notifyPendingWriteListeners(); }

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
