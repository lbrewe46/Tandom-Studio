#!/usr/bin/env node
// Execution Follow-up: detection rules and the real handler (preview vs apply) against an in-memory
// Supabase stand-in. Run: node scripts/test-execution-followup.mjs
import assert from "node:assert/strict";
import { planExecutionFollowup } from "../supabase/functions/_shared/execution-followup.js";
import { handleExecutionFollowup } from "../supabase/functions/_shared/execution-followup-handler.js";

function makeDb({ tables, tokens }) {
  class Q {
    constructor(t) { this.t = t; this.f = []; this.rangeArg = null; this.ins = null; this.upd = null; }
    insert(rows) { this.ins = Array.isArray(rows) ? rows : [rows]; return this; }
    update(v) { this.upd = v; return this; }
    select() { return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    range(a, b) { this.rangeArg = [a, b]; return this; }
    run() {
      const rows = (tables[this.t] ||= []);
      if (this.ins) { this.ins.forEach((r) => rows.push({ id: r.id || `gen${rows.length}`, created_at: "2026-10-20T00:00:00Z", ...r })); return { data: this.ins, error: null }; }
      const hit = rows.filter((r) => this.f.every((f) => f(r)));
      if (this.upd) { hit.forEach((r) => Object.assign(r, this.upd)); return { data: hit, error: null }; }
      return { data: this.rangeArg ? hit.slice(this.rangeArg[0], this.rangeArg[1] + 1) : hit, error: null };
    }
    maybeSingle() { return Promise.resolve({ data: this.run().data[0] ?? null, error: null }); }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  }
  return { from: (t) => new Q(t), auth: { getUser: async (tok) => (tokens[tok] ? { data: { user: { id: tokens[tok] } }, error: null } : { data: { user: null }, error: { message: "bad" } }) } };
}

const TODAY = "2026-10-20";
const pg = (over = {}) => ({ id: "p1", name: "Soda v2", status: "live", eventDate: "2026-10-10", storeIds: ["a", "b", "c", "d"], execution: {}, ...over });
const stores = [{ id: "a", name: "A", tasks: [] }, { id: "b", name: "B", tasks: [] }, { id: "c", name: "C", tasks: [] }, { id: "d", name: "D", tasks: [] }];
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

// --- detection ---
{
  const plan = planExecutionFollowup({
    today: TODAY, stores,
    planograms: [pg({ execution: { a: { status: "completed" }, b: { status: "in_progress", updatedAt: "2026-10-19T00:00:00Z" }, c: { status: "partially_completed", updatedAt: "2026-10-15T00:00:00Z" } } })],
  });
  assert.deepEqual(plan.findings.map((f) => f.storeId).sort(), ["b", "c", "d"]); ok("completed stores are not flagged; overdue ones are");
  assert.equal(plan.findings.find((f) => f.storeId === "d").daysOverdue, 10); assert.match(plan.findings.find((f) => f.storeId === "d").reason, /10 days past its 2026-10-10 due date.*not started/); ok("never-started store: days overdue and plain-English reason");
  assert.equal(plan.findings.find((f) => f.storeId === "c").kind, "past_due_and_stuck"); ok("partially completed and past due is both");
  assert.equal(plan.reminders.length, 3); assert.equal(plan.reminders[0].task.type, "reset_followup"); assert.equal(plan.reminders[0].task.source, "execution-followup"); ok("one reminder task per late store");
  assert.equal(plan.escalations.length, 3); ok("10 days overdue >= 5 -> escalated");
}
{
  const plan = planExecutionFollowup({ today: TODAY, stores, planograms: [pg({ eventDate: "2026-10-17", storeIds: ["a", "b"], execution: { a: { status: "new" }, b: { status: "partially_completed", updatedAt: "2026-10-12T00:00:00Z" } } })] });
  assert.equal(plan.findings.find((f) => f.storeId === "a").daysOverdue, 3); assert.equal(plan.escalations.length, 1); assert.equal(plan.escalations[0].storeId, "b"); ok("below the threshold: reminder only; escalate once stuck/overdue long enough");
}
{
  const plan = planExecutionFollowup({ today: TODAY, stores, planograms: [pg({ eventDate: "2026-12-01", status: "approved", storeIds: ["a", "b"], execution: { a: { status: "partially_completed", updatedAt: "2026-10-18T00:00:00Z" }, b: { status: "partially_completed", updatedAt: "2026-10-10T00:00:00Z" } } })] });
  assert.equal(plan.findings.length, 0); ok("approved but not pending/live yet: ignored");
}
{
  const plan = planExecutionFollowup({ today: TODAY, stores, planograms: [pg({ eventDate: "2026-12-25", storeIds: ["a", "b"], status: "pending", execution: { a: { status: "partially_completed", updatedAt: "2026-10-18T00:00:00Z" }, b: { status: "partially_completed", updatedAt: "2026-10-10T00:00:00Z" } } })] });
  assert.deepEqual(plan.findings.map((f) => f.storeId), ["b"]); assert.equal(plan.findings[0].kind, "stuck"); ok("stuck in Partially Completed (>3 days) is flagged even before the due date; 2 days is not");
}
{
  const withReminder = stores.map((s) => (s.id === "d" ? { ...s, tasks: [{ id: "t1", source: "execution-followup", planogramId: "p1", status: "open" }] } : s));
  const plan = planExecutionFollowup({ today: TODAY, stores: withReminder, planograms: [pg()], openEscalations: [{ planogram_id: "p1", store_id: "d" }] });
  assert.ok(!plan.reminders.some((r) => r.storeId === "d")); assert.ok(!plan.escalations.some((r) => r.storeId === "d")); ok("no repeat reminder or second escalation while the first is open");
}
{
  const done = stores.map((s) => (s.id === "d" ? { ...s, tasks: [{ id: "t1", source: "execution-followup", planogramId: "p1", status: "open" }] } : s));
  const plan = planExecutionFollowup({ today: TODAY, stores: done, planograms: [pg({ execution: { d: { status: "completed" } } })], openEscalations: [{ planogram_id: "p1", store_id: "d" }] });
  const r = plan.resolutions.find((x) => x.storeId === "d"); assert.deepEqual(r.taskIds, ["t1"]); assert.equal(r.escalationCount, 1); ok("a store that finished has its reminder and escalation closed");
}
{
  const plan = planExecutionFollowup({ today: TODAY, stores, planograms: [pg({ storeIds: ["a"] })], escalationHistory: [{ store_id: "a", created_at: "2026-09-01T00:00:00Z" }, { store_id: "a", created_at: "2026-03-01T00:00:00Z" }, { store_id: "b", created_at: "2026-09-01T00:00:00Z" }] });
  assert.equal(plan.escalations[0].priorEscalations, 1); ok("repeat problems: prior escalations for the store in the last 90 days are counted");
}

// --- handler ---
const mk = () => ({
  profiles: [{ id: "cm", role: "category_manager" }, { id: "sa", role: "store_associate" }],
  agents: [{ id: "execution-followup-agent", enabled: true }],
  planograms: [{ id: "p1", data: pg({ id: undefined, storeIds: ["a", "b"], execution: { b: { status: "completed" } } }) }],
  stores: [
    { id: "a", data: { name: "A", tasks: [], photos: ["BIG"] } },
    { id: "b", data: { name: "B", tasks: [{ id: "old", source: "execution-followup", planogramId: "p1", status: "open" }] } },
  ],
  escalations: [{ id: "e1", planogram_id: "p1", store_id: "b", status: "open", created_at: "2026-10-01T00:00:00Z" }],
  activity_log: [],
});
const tokens = { cmTok: "cm", saTok: "sa" };
const call = async (tok, body, tables = mk()) => {
  const db = makeDb({ tables, tokens });
  const res = await handleExecutionFollowup(new Request("https://x/f", { method: "POST", headers: { Authorization: tok ? `Bearer ${tok}` : "" }, body: JSON.stringify(body) }), db, { now: () => new Date(`${TODAY}T12:00:00Z`) });
  return { res, json: await res.json(), tables };
};
{ const { res } = await call("", {}); assert.equal(res.status, 401); ok("no token -> 401"); }
{ const { res } = await call("saTok", {}); assert.equal(res.status, 403); ok("store associates cannot run it"); }
{ const t = mk(); t.agents[0].enabled = false; const { res } = await call("cmTok", {}, t); assert.equal(res.status, 403); ok("disabled agent -> 403"); }
{ const { res } = await call("cmTok", { stuckDays: 0 }); assert.equal(res.status, 400); ok("bad parameter -> 400"); }
{
  const { res, json, tables } = await call("cmTok", {});
  assert.equal(res.status, 200); assert.equal(json.applied, false); assert.equal(json.plan.reminders.length, 1); assert.equal(json.plan.resolutions.length, 1);
  assert.equal(tables.stores[0].data.tasks.length, 0); assert.equal(tables.escalations.length, 1); assert.equal(tables.activity_log.length, 0); ok("preview writes nothing");
}
{
  const { json, tables } = await call("cmTok", { apply: true });
  assert.equal(json.applied, true);
  assert.equal(tables.stores[0].data.tasks.length, 1); assert.equal(tables.stores[0].data.tasks[0].type, "reset_followup"); assert.equal(tables.stores[0].data.photos[0], "BIG"); ok("apply adds the reminder task to the store and keeps its other data");
  assert.equal(tables.stores[1].data.tasks[0].status, "completed"); ok("apply closes the finished store's old reminder");
  const esc = tables.escalations; assert.equal(esc.find((e) => e.id === "e1").status, "resolved"); assert.equal(esc.filter((e) => e.store_id === "a" && e.status === "open").length, 1); ok("apply records a new escalation and resolves the finished store's");
  assert.deepEqual(tables.activity_log.map((a) => a.action).sort(), ["escalation_resolved", "execution_escalated", "reminder_sent"]); ok("every action is logged");
}
{
  const t = mk(); await call("cmTok", { apply: true }, t); const before = JSON.stringify(t.stores) + t.escalations.length;
  const again = await call("cmTok", { apply: true }, t); assert.equal(again.json.plan.reminders.length, 0); assert.equal(again.json.plan.escalations.length, 0); assert.equal(JSON.stringify(t.stores) + t.escalations.length, before); ok("running it twice does not duplicate reminders or escalations");
}
console.log(`\n${n} passed`);
