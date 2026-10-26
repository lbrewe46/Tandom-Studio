#!/usr/bin/env node
// The browser-side usage tracker, with a fake clock and a fake database. Run: node scripts/test-usage.mjs
import assert from "node:assert/strict";
import { createUsageTracker, IDLE_MS, SESSION_TIMEOUT_MS, TICK_MS, FLUSH_MS } from "../src/lib/usage.js";

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { console.error("FAIL " + name + "\n", e); process.exitCode = 1; } };

function setup(opts = {}) {
  let t = 1_000_000;
  const rows = []; // every write, in order
  const db = { from: () => ({
    insert: async (r) => { if (opts.error) return { error: { message: "no table" } }; rows.push({ op: "insert", ...r }); return { error: null }; },
    update: (r) => ({ eq: async (c, id) => { if (opts.error) return { error: { message: "x" } }; rows.push({ op: "update", id, ...r }); return { error: null }; } }),
  }) };
  let module = "spacePlanner", visible = true;
  const tr = createUsageTracker({ db, userId: "u1", getModule: () => module, isVisible: () => visible, now: () => t, makeId: (() => { let n = 0; return () => `s${++n}`; })() });
  return { tr, rows, advance: (ms) => { t += ms; }, setModule: (m) => { module = m; }, setVisible: (v) => { visible = v; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

await test("opening the app starts a session and records it straight away", async () => {
  const x = setup(); x.tr.activity(); await settle();
  assert.equal(x.rows.length, 1); assert.equal(x.rows[0].op, "insert"); assert.equal(x.rows[0].user_id, "u1"); assert.equal(x.rows[0].active_seconds, 0);
});
await test("time counts only while the person is interacting, split by module", async () => {
  const x = setup(); x.tr.activity();
  for (let i = 0; i < 4; i++) { x.advance(TICK_MS); x.tr.tick(); } // 60s in spacePlanner
  x.setModule("assortment"); x.tr.activity();
  for (let i = 0; i < 2; i++) { x.advance(TICK_MS); x.tr.tick(); } // 30s in assortment
  assert.equal(Math.round(x.tr.session.seconds), 90);
  assert.equal(Math.round(x.tr.session.modules.spacePlanner), 60); assert.equal(Math.round(x.tr.session.modules.assortment), 30);
});
await test("idle time is not counted", async () => {
  const x = setup(); x.tr.activity();
  x.advance(IDLE_MS); x.tr.tick(); // exactly at the limit still counts the last stretch
  const before = x.tr.session.seconds;
  x.advance(TICK_MS); x.tr.tick(); x.advance(TICK_MS); x.tr.tick();
  assert.equal(x.tr.session.seconds, before);
});
await test("a hidden tab does not count", async () => {
  const x = setup(); x.tr.activity(); x.setVisible(false);
  x.advance(TICK_MS); x.tr.tick(); assert.equal(x.tr.session.seconds, 0);
});
await test("waking from sleep does not credit the gap", async () => {
  const x = setup(); x.tr.activity(); x.advance(TICK_MS * 100); x.tr.activity(); x.tr.tick();
  assert.ok(x.tr.session.seconds <= (TICK_MS * 4) / 1000);
});
await test("progress is saved about once a minute, and not re-saved when nothing changed", async () => {
  const x = setup(); x.tr.activity(); await settle();
  for (let i = 0; i < 4; i++) { x.advance(TICK_MS); x.tr.activity(); x.tr.tick(); } await settle();
  const updates = x.rows.filter((r) => r.op === "update"); assert.equal(updates.length, 1); assert.equal(updates[0].active_seconds, 60);
  x.advance(FLUSH_MS); x.tr.tick(); await settle(); // idle: no new time
  const again = x.rows.filter((r) => r.op === "update"); assert.ok(again.length <= 2);
});
await test("a long gap starts a new session; the old one is closed out", async () => {
  const x = setup(); x.tr.activity(); x.advance(TICK_MS); x.tr.tick(); const first = x.tr.session.id;
  x.advance(SESSION_TIMEOUT_MS + 1); x.tr.activity(); await settle();
  assert.notEqual(x.tr.session.id, first); assert.equal(x.rows.filter((r) => r.op === "insert").length, 2);
});
await test("flush saves the latest numbers", async () => {
  const x = setup(); x.tr.activity(); x.advance(TICK_MS); x.tr.tick(); await x.tr.flush(); await settle();
  const last = x.rows.filter((r) => r.op === "update").pop(); assert.equal(last.active_seconds, 15);
});
await test("if the table is missing the tracker switches itself off quietly", async () => {
  const x = setup({ error: true }); x.tr.activity(); await settle();
  assert.equal(x.tr.disabled, true); x.advance(TICK_MS); x.tr.activity(); x.tr.tick(); await x.tr.flush(); assert.equal(x.rows.length, 0);
});
console.log(`\n${passed} passed`);
