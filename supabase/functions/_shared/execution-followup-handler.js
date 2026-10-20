// Request handling for the execution-followup Edge Function (plain JS, service-role client injected).
//
// Contract
//   POST { apply?: boolean (default false = preview only), stuckDays?: int, escalateAfterDays?: int }
//   200 { applied: boolean, plan: { findings, reminders, escalations, resolutions, params, today } }
//   A preview writes nothing. With apply: true it (1) adds one reminder task to each late store's
//   Task Management list, (2) records an escalation for the Category Manager once a store is overdue
//   by escalateAfterDays, (3) closes reminders/escalations for stores that have since finished,
//   and logs each in activity_log.
//   400 bad input · 401 no/invalid JWT · 403 role not allowed / agent disabled

import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { planExecutionFollowup, FOLLOWUP_DEFAULTS } from "./execution-followup.js";

export const AGENT_ID = "execution-followup-agent";
export const ALLOWED_ROLES = ["admin", "category_manager"];
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

// A store row read with only what detection needs (the `name`/`tasks` aliases), or full `data` in tests.
const storeView = (r) => (r.data ? { id: r.id, name: r.data.name, tasks: r.data.tasks || [] } : { id: r.id, name: r.name, tasks: r.tasks || [] });

export async function handleExecutionFollowup(req, db, { now = () => new Date() } = {}) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Your role is not permitted to run this agent");
  if (auth.response) return auth.response;

  const { data: agent } = await db.from("agents").select("enabled").eq("id", AGENT_ID).maybeSingle();
  if (!agent || !agent.enabled) return json(403, { error: "This agent is disabled" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const params = {};
  if (body.stuckDays !== undefined) { if (!intInRange(body.stuckDays, 1, 60)) return json(400, { error: "stuckDays must be an integer from 1 to 60" }); params.stuckDays = body.stuckDays; }
  if (body.escalateAfterDays !== undefined) { if (!intInRange(body.escalateAfterDays, 1, 90)) return json(400, { error: "escalateAfterDays must be an integer from 1 to 90" }); params.escalateAfterDays = body.escalateAfterDays; }
  const apply = body.apply === true;
  const today = now().toISOString().slice(0, 10);

  try {
    const [planogramRows, storeRows, escRows] = await Promise.all([
      fetchAll(db, "planograms", "id, data"),
      fetchAll(db, "stores", "id, name:data->>name, tasks:data->tasks"),
      fetchAll(db, "escalations", "id, planogram_id, store_id, status, created_at"),
    ]);
    const planograms = planogramRows.map((r) => ({ ...r.data, id: r.id }));
    const stores = storeRows.map(storeView);
    const plan = planExecutionFollowup({
      planograms, stores, today, params: { ...FOLLOWUP_DEFAULTS, ...params },
      openEscalations: escRows.filter((e) => e.status === "open"), escalationHistory: escRows,
    });
    const summary = { findings: plan.findings, reminders: plan.reminders.map(({ task, ...r }) => ({ ...r, taskId: task.id })), escalations: plan.escalations, resolutions: plan.resolutions, params: plan.params, today };
    if (!apply) return json(200, { applied: false, plan: summary });

    // --- apply ---------------------------------------------------------------------------
    const actor = { actor_type: "agent", actor_id: AGENT_ID };
    const log = [];
    // 1) reminder tasks + 2) closing reminders for stores that finished: both edit a store's tasks list
    const taskEdits = new Map(); // storeId -> { add: [task], close: Set(taskId) }
    const edit = (sid) => { if (!taskEdits.has(sid)) taskEdits.set(sid, { add: [], close: new Set() }); return taskEdits.get(sid); };
    plan.reminders.forEach((r) => { edit(r.storeId).add.push(r.task); log.push({ ...actor, action: "reminder_sent", target_type: "planogram_version", target_id: r.planogramId, detail: { storeId: r.storeId, storeName: r.storeName, reason: r.reason, taskId: r.task.id, requestedBy: auth.user.id } }); });
    plan.resolutions.forEach((r) => r.taskIds.forEach((id) => edit(r.storeId).close.add(id)));
    const nowISO = now().toISOString();
    for (const [sid, e] of taskEdits) {
      const { data: row } = await db.from("stores").select("id, data").eq("id", sid).maybeSingle();
      if (!row) continue;
      const tasks = (row.data.tasks || []).map((t) => (e.close.has(t.id) ? { ...t, status: "completed", completedAt: nowISO } : t)).concat(e.add);
      const { error } = await db.from("stores").update({ data: { ...row.data, tasks }, updated_by: auth.user.id }).eq("id", sid);
      if (error) throw new Error(`updating store ${sid}: ${error.message}`);
    }
    // 3) escalations
    if (plan.escalations.length) {
      const { error } = await db.from("escalations").insert(plan.escalations.map((x) => ({
        planogram_id: x.planogramId, planogram_name: x.planogramName, store_id: x.storeId, store_name: x.storeName, kind: x.kind,
        days_overdue: x.daysOverdue, reason: x.reason, prior_escalations: x.priorEscalations, status: "open", created_by_agent: AGENT_ID,
      })));
      if (error) throw new Error(`recording escalations: ${error.message}`);
      plan.escalations.forEach((x) => log.push({ ...actor, action: "execution_escalated", target_type: "planogram_version", target_id: x.planogramId, detail: { storeId: x.storeId, storeName: x.storeName, daysOverdue: x.daysOverdue, priorEscalations: x.priorEscalations, requestedBy: auth.user.id } }));
    }
    // 4) resolve escalations for finished stores
    for (const r of plan.resolutions.filter((x) => x.escalationCount > 0)) {
      const { error } = await db.from("escalations").update({ status: "resolved", resolved_at: nowISO, resolution: `Store ${r.execStatus} the reset` }).eq("planogram_id", r.planogramId).eq("store_id", r.storeId).eq("status", "open");
      if (error) throw new Error(`resolving escalations: ${error.message}`);
      log.push({ ...actor, action: "escalation_resolved", target_type: "planogram_version", target_id: r.planogramId, detail: { storeId: r.storeId, storeName: r.storeName, execStatus: r.execStatus } });
    }
    if (log.length) {
      try { await db.from("activity_log").insert(log); } catch (e) { console.error("execution-followup: changes saved but activity log write failed", e); }
    }
    return json(200, { applied: true, plan: summary });
  } catch (e) {
    console.error("execution-followup failed", e);
    return json(500, { error: `Follow-up check failed: ${e?.message || e}. Has the latest supabase/schema.sql been run?` });
  }
}
