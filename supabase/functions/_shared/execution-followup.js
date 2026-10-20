// Execution Follow-up Agent — the detection. Finds stores whose reset execution is stuck or past
// due and works out what to do about each: send one reminder task, and escalate to the Category
// Manager once a store is far enough overdue. Deterministic; the handler decides whether the plan
// is previewed or applied.
//
//   past due  = the planogram's Event Date has passed and the store has not completed (or rejected) it
//   stuck     = the store has been "Partially Completed" for more than `stuckDays` days
//   reminder  = one open Task Management task per store and planogram (never repeated while open)
//   escalate  = overdue (or stuck) for at least `escalateAfterDays` days; once per store and planogram
//   resolve   = the store has since completed or been released: close its reminder task and escalation

import { effectivePlanogramStatus, addDaysISO, uid } from "./app-core.js";

export const FOLLOWUP_DEFAULTS = { stuckDays: 3, escalateAfterDays: 5 };
export const REMINDER_SOURCE = "execution-followup";
export const REMINDER_TASK_TYPE = "reset_followup";
const DONE = new Set(["completed", "rejected"]);

const dayNumber = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const daysBetween = (fromISO, toISO) => dayNumber(toISO) - dayNumber(fromISO);
const datePart = (v) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);

// planograms: [{id, ...planogram data}]; stores: [{id, name, tasks}]
// openEscalations: [{planogram_id, store_id}], escalationHistory: [{store_id, created_at}] (any status)
export function planExecutionFollowup({ planograms, stores, openEscalations = [], escalationHistory = [], today, params = {} }) {
  const p = { ...FOLLOWUP_DEFAULTS, ...params };
  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));
  const findings = [], reminders = [], escalations = [], resolutions = [];
  const histCutoff = addDaysISO(today, -90);

  planograms.forEach((pg) => {
    const status = effectivePlanogramStatus(pg);
    if (status !== "pending" && status !== "live") return;
    (pg.storeIds || []).forEach((sid) => {
      const store = storeById[sid];
      if (!store) return;
      const exec = pg.execution?.[sid] || {};
      const execStatus = exec.status || "new";
      const openReminders = (store.tasks || []).filter((t) => t.source === REMINDER_SOURCE && t.planogramId === pg.id && t.status !== "completed");
      const openEsc = openEscalations.filter((e) => e.planogram_id === pg.id && e.store_id === sid);

      if (DONE.has(execStatus)) {
        // finished since we last looked: tidy up what the agent left behind
        if (openReminders.length || openEsc.length) resolutions.push({ planogramId: pg.id, planogramName: pg.name, storeId: sid, storeName: store.name, taskIds: openReminders.map((t) => t.id), escalationCount: openEsc.length, execStatus });
        return;
      }

      const pastDueDays = pg.eventDate && today > pg.eventDate ? daysBetween(pg.eventDate, today) : 0;
      const stuckSince = execStatus === "partially_completed" ? datePart(exec.updatedAt) : null;
      const stuckDays = stuckSince ? daysBetween(stuckSince, today) : 0;
      const isStuck = stuckSince && stuckDays > p.stuckDays;
      if (pastDueDays <= 0 && !isStuck) return;

      const daysOverdue = Math.max(pastDueDays, isStuck ? stuckDays : 0);
      const kind = pastDueDays > 0 && isStuck ? "past_due_and_stuck" : pastDueDays > 0 ? "past_due" : "stuck";
      const reason = [
        pastDueDays > 0 ? `${pastDueDays} day${pastDueDays === 1 ? "" : "s"} past its ${pg.eventDate} due date` : null,
        isStuck ? `Partially Completed since ${stuckSince} (${stuckDays} days)` : null,
        pastDueDays > 0 && (execStatus === "new" || execStatus === "reviewed") ? `not started (status is ${execStatus === "new" ? "New" : "Reviewed"})` : null,
      ].filter(Boolean).join("; ");
      const finding = { planogramId: pg.id, planogramName: pg.name || "Untitled", storeId: sid, storeName: store.name, kind, execStatus, daysOverdue, dueDate: pg.eventDate || null, reason };
      findings.push(finding);

      if (openReminders.length === 0) {
        reminders.push({
          ...finding,
          task: {
            id: uid("task"), type: REMINDER_TASK_TYPE, status: "open", dueDate: today, createdAt: new Date().toISOString(), completedAt: null,
            source: REMINDER_SOURCE, planogramId: pg.id,
            description: `Reset "${pg.name || "Untitled"}" is behind: ${reason}. Please finish it, or report what is blocking you under Store Feedback.`,
          },
        });
      }
      if (daysOverdue >= p.escalateAfterDays && openEsc.length === 0) {
        const prior = escalationHistory.filter((e) => e.store_id === sid && (e.created_at || "").slice(0, 10) >= histCutoff).length;
        escalations.push({ ...finding, priorEscalations: prior });
      }
    });
  });

  return { params: p, today, findings, reminders, escalations, resolutions };
}
