// Usage tracking: records how long, and in which module, a signed-in person actively uses the app.
// One "session" = a run of activity with no gap longer than SESSION_TIMEOUT_MS. Time only counts while the
// person is interacting (a click, key, scroll or touch in the last IDLE_MS) and the tab is in view.
// Only the person's id, role, timings and module names are recorded: nothing about what they edit.
//
// The logic is plain (no React, no browser globals) so it can be tested with a fake clock and a fake database;
// startUsageTracking() below wires it to the page.

export const IDLE_MS = 2 * 60 * 1000; // no interaction for this long = not actively using the app
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // a gap this long ends the session
export const TICK_MS = 15 * 1000;
export const FLUSH_MS = 60 * 1000; // how often progress is saved while active

const newId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));

export function createUsageTracker({ db, userId, getModule = () => "app", isVisible = () => true, now = () => Date.now(), makeId = newId }) {
  let session = null; // { id, saved, seconds, modules, lastFlushAt, inserted }
  let lastActivityAt = null;
  let lastTickAt = null;
  let disabled = false;

  // The table may not exist yet (schema.sql not run) or the person may lack access: stop quietly, never bother them.
  const fail = (error) => { if (error) { disabled = true; return true; } return false; };

  async function save(s) {
    if (disabled || !s) return;
    const snapshot = { active_seconds: Math.round(s.seconds), modules: { ...s.modules } };
    try {
      let res;
      if (!s.inserted) {
        s.inserted = true; // set first so a second save doesn't insert again while this one is in flight
        res = await db.from("usage_sessions").insert({ id: s.id, user_id: userId, ...snapshot });
      } else {
        res = await db.from("usage_sessions").update(snapshot).eq("id", s.id);
      }
      if (fail(res && res.error)) return;
      s.savedSeconds = snapshot.active_seconds;
      s.lastFlushAt = now();
    } catch (e) { disabled = true; }
  }

  function begin() {
    session = { id: makeId(), seconds: 0, modules: {}, lastFlushAt: now(), inserted: false, savedSeconds: -1 };
    lastTickAt = now();
    save(session); // the row exists from the first moment, so even a short visit is counted
  }

  // Called on every interaction (throttle it at the caller).
  function activity() {
    if (disabled) return;
    const t = now();
    if (session && lastActivityAt !== null && t - lastActivityAt > SESSION_TIMEOUT_MS) {
      save(session); // close out the old session
      session = null;
    }
    lastActivityAt = t;
    if (!session) begin();
  }

  // Called on a timer: adds the time since the last tick if the person is active, and saves now and then.
  function tick() {
    if (disabled || !session) return;
    const t = now();
    const elapsed = Math.max(0, t - lastTickAt);
    lastTickAt = t;
    if (isVisible() && lastActivityAt !== null && t - lastActivityAt <= IDLE_MS) {
      const secs = Math.min(elapsed, TICK_MS * 4) / 1000; // a laptop waking from sleep must not credit the gap
      session.seconds += secs;
      const m = getModule() || "app";
      session.modules[m] = Math.round(((session.modules[m] || 0) + secs) * 1000) / 1000;
    }
    if (t - session.lastFlushAt >= FLUSH_MS && Math.round(session.seconds) !== session.savedSeconds) save(session);
  }

  function flush() { return save(session); }
  return { activity, tick, flush, get disabled() { return disabled; }, get session() { return session; } };
}

// Hooks the tracker to the page: interaction events, a timer, and a save when the tab is hidden or closed.
// Returns a function that stops it.
export function startUsageTracking({ db, userId, getModule }) {
  if (typeof window === "undefined" || !db || !userId) return () => {};
  const tracker = createUsageTracker({ db, userId, getModule, isVisible: () => document.visibilityState !== "hidden" });
  let lastEvent = 0;
  const onActivity = () => { const t = Date.now(); if (t - lastEvent < 1000) return; lastEvent = t; tracker.activity(); };
  const events = ["pointerdown", "keydown", "scroll", "touchstart", "wheel"];
  events.forEach((e) => window.addEventListener(e, onActivity, { passive: true, capture: true }));
  const onHide = () => { tracker.tick(); tracker.flush(); };
  const onVis = () => { if (document.visibilityState === "hidden") onHide(); else onActivity(); };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", onHide);
  const timer = window.setInterval(() => tracker.tick(), TICK_MS);
  onActivity(); // opening the app counts
  return () => {
    window.clearInterval(timer);
    events.forEach((e) => window.removeEventListener(e, onActivity, { capture: true }));
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", onHide);
    onHide();
  };
}
