#!/usr/bin/env node
// Days of supply + case pack: the shared helpers and the Reset Drafting Agent's DOS pass.
// Run: node scripts/test-supply.mjs
import assert from "node:assert/strict";
import { getDosTargetDays, getDaysOfSupply, getCasePackFill, applyResetDraftChanges } from "../supabase/functions/_shared/app-core.js";
import { computeResetDraft } from "../supabase/functions/_shared/reset-agent.js";

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.error("FAIL " + name + "\n", e); process.exitCode = 1; } };

console.log("helpers");
test("target: product override beats category row; blank/invalid means no target", () => {
  const targets = [{ category: "Snacks", days: 7 }, { category: "Dairy", days: "" }];
  assert.equal(getDosTargetDays("Snacks", targets, {}), 7);
  assert.equal(getDosTargetDays("Snacks", targets, { dosTargetDays: 3 }), 3);
  assert.equal(getDosTargetDays("Dairy", targets, {}), null);
  assert.equal(getDosTargetDays("Other", targets, {}), null);
  assert.equal(getDosTargetDays("Snacks", [], {}), null);
});
test("days of supply = capacity / daily sales; no sales = unknown", () => {
  assert.equal(getDaysOfSupply(30, 70), 3);
  assert.equal(getDaysOfSupply(30, 0), null);
});
test("case pack fill: a case or a case and a half is the standard pack-out", () => {
  const f = (u, cp) => getCasePackFill(u, cp);
  assert.equal(f(12, 12).exact, true);   // one case
  assert.equal(f(18, 12).exact, true);   // a case and a half
  assert.equal(f(30, 12).exact, true);   // two and a half
  assert.equal(f(13, 12).exact, false);  // overage
  assert.equal(f(6, 12).exact, false);   // half a case: a full delivery cannot fit
  assert.equal(f(9, 3).exact, true);     // odd pack: whole cases only
  assert.equal(f(7, 3).exact, false);
  assert.equal(f(4, 3).exact, false);    // odd pack has no half case, so 1.33 cases is not allowed
  assert.equal(f(18, 12).cases, 1.5);
  assert.deepEqual([f(30, 12).wholeCases, f(30, 12).loose, f(30, 12).casesToFill], [2, 6, 3]);
  assert.equal(f(24, 0), null);
  assert.equal(f(24, undefined), null);
});

console.log("agent");
const weeks = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 7, 2 + i * 7)).toISOString().slice(0, 10));
const rec = (units, price = 1) => weeks.map((weekEnding) => ({ weekEnding, units, price, unitCost: 0.5, storeId: "s1" }));
const prod = (id, extra = {}) => ({ id, name: id, dims: { w: 4, h: 5, d: 4 }, attributes: {}, ...extra });
const shelf = { id: "shelf", type: "Shelf", name: "Shelf", dims: { w: 24, h: 1, d: 12 } };
const pl = (id, productId, facings, extra = {}) => ({ id, productId, facings, orientation: "front", rotation: 0, merchStyle: "unit", ...extra });
const pog = (placements, gap = 12) => ({
  id: "pog", category: "Snacks", dims: { w: 48, h: 60 }, base: 0,
  sections: [{ id: "sec", fixtures: [{ id: "f1", fixtureId: "shelf", notchY: 0, xOffset: 0, placements }, { id: "f2", fixtureId: "shelf", notchY: 1 + gap, xOffset: 0, placements: [] }] }],
});
const draft = (planogram, products, performance, dosTargets) => computeResetDraft(planogram, products, [shelf], performance, [], [], 8, null, undefined, dosTargets);
const T = (days) => [{ category: "Snacks", days }];

test("no targets configured: the DOS pass changes nothing", () => {
  const r = draft(pog([pl("pA", "A", 1)]), [prod("A")], { A: rec(10) }, []);
  assert.deepEqual(r.changes, []); assert.deepEqual(r.notes, []);
});
test("short of target: goes deeper first, then taller, then adds facings, until the target is met", () => {
  // 70 units/week = 10/day; target 1 day = 10 units. 1 unit now. Shelf is 12in deep (3 x 4in), clearance 12in (2 high).
  const r = draft(pog([pl("pA", "A", 1)]), [prod("A")], { A: rec(70) }, T(1));
  const deep = r.changes.find((c) => c.type === "setDeep");
  const high = r.changes.find((c) => c.type === "increaseHigh");
  const wide = r.changes.find((c) => c.type === "increaseFacings");
  assert.deepEqual([deep.oldDeep, deep.newDeep], [1, 3]);
  assert.deepEqual([high.oldHigh, high.newHigh], [1, 2]);
  assert.deepEqual([wide.oldFacings, wide.newFacings], [1, 2]); // 2 wide x 2 high x 3 deep = 12 >= 10
  assert.match(high.reason, /days of supply against a 1-day target/);
  assert.equal(r.skipped.length, 0);
  const out = applyResetDraftChanges(pog([pl("pA", "A", 1)]).sections, r.changes);
  const placed = out[0].fixtures[0].placements[0];
  assert.deepEqual([placed.facings, placed.high, placed.deep], [2, 2, 3]);
});
test("cannot reach the target: reported as skipped, with the days it does reach", () => {
  const r = draft(pog([pl("pA", "A", 1)]), [prod("A")], { A: rec(700) }, T(30));
  assert.ok(r.skipped.some((s) => s.productId === "A" && /days of supply against a 30-day target/.test(s.reason)), JSON.stringify(r.skipped));
});
test("an auto-stacked placement is not stacked by the DOS pass (it is already at the headroom limit)", () => {
  const r = draft(pog([pl("pA", "A", 1, { autoStack: true, high: 2 })]), [prod("A")], { A: rec(70) }, T(1));
  assert.ok(!r.changes.some((c) => c.type === "increaseHigh"));
  assert.ok(r.changes.some((c) => c.type === "increaseFacings"));
});
test("over-supplied: trims stack height first, and stops while the target is still met", () => {
  // 7/week = 1/day; target 2 days; 3 wide x 2 high = 6 units = 6 days (> 2 x 2). 3 units = 3 days is still >= 2.
  const r = draft(pog([pl("pA", "A", 3, { high: 2 })]), [prod("A")], { A: rec(7) }, T(2));
  const c = r.changes.find((x) => x.type === "reduceHigh");
  assert.deepEqual([c.oldHigh, c.newHigh], [2, 1]);
  assert.ok(!r.changes.some((x) => x.type === "reduceFacings"));
});
test("a Core / Must-Carry product is never trimmed for over-supply", () => {
  const r = draft(pog([pl("pA", "A", 3, { high: 2 })]), [prod("A", { resetProtected: true })], { A: rec(7) }, T(2));
  assert.deepEqual(r.changes, []);
});
test("a reduction the index asked for is cancelled when it would break the target", () => {
  // A is weak by index (tiny sales next to B in equal space) but only just meets its 3-day target at 3 units.
  const planogram = pog([pl("pA", "A", 3), pl("pB", "B", 3)], 4);
  const r = draft(planogram, [prod("A"), prod("B")], { A: rec(7), B: rec(100000) }, T(3));
  assert.ok(!r.changes.some((c) => c.type === "reduceFacings" && c.productId === "A"), JSON.stringify(r.changes));
  const note = r.notes.find((n) => n.kind === "dosKept");
  assert.ok(note && note.productId === "A");
  assert.match(note.reason, /2 days of supply against a 3-day target/);
});
test("a per-product target overrides the category", () => {
  const r = draft(pog([pl("pA", "A", 1)]), [prod("A", { dosTargetDays: 1 })], { A: rec(70) }, T(0.1));
  assert.ok(r.changes.some((c) => c.type === "increaseFacings" || c.type === "increaseHigh"));
});
test("case pack: Deep is adjusted so the shelf takes whole cases", () => {
  // 4 wide x 1 deep = 4 units against 12-unit cases; 3 deep = 12 units = exactly one case
  const r = draft(pog([pl("pA", "A", 4)]), [prod("A", { casePack: 12 })], { A: rec(70) }, []);
  const c = r.changes.find((x) => x.type === "setDeep");
  assert.deepEqual([c.oldDeep, c.newDeep], [1, 3]);
  assert.match(c.reason, /4 units of a 12-unit case.*not a case or half-case pack-out.*12 \(1 case\)/);
  const out = applyResetDraftChanges(pog([pl("pA", "A", 4)]).sections, r.changes);
  assert.equal(out[0].fixtures[0].placements[0].deep, 3);
});
test("case pack: a shelf that is already whole cases is left alone", () => {
  const r = draft(pog([pl("pA", "A", 6, { high: 2 })]), [prod("A", { casePack: 12 })], { A: rec(70) }, []);
  assert.deepEqual(r.changes, []); assert.deepEqual(r.notes, []); assert.deepEqual(r.skipped, []);
});
test("case pack: a shelf smaller than one case is flagged -- every delivery would overflow", () => {
  const r = draft(pog([pl("pA", "A", 3)]), [prod("A", { casePack: 20 })], { A: rec(70) }, []);
  assert.ok(!r.changes.some((x) => x.type === "setDeep"), "3, 6 and 9 units never reach 20");
  const s = r.skipped.find((x) => x.productId === "A");
  assert.match(s.reason, /holds only 3 units but a case is 20/);
});
test("case pack: when no Deep lands on a case or half case, the gap is reported, not hidden", () => {
  // 5 wide x 2 high = 10 units (then 20, 30) against cases of 7: never a whole number of cases
  const r = draft(pog([pl("pA", "A", 5, { high: 2 })]), [prod("A", { casePack: 7 })], { A: rec(70) }, []);
  assert.deepEqual(r.changes, []);
  const n = r.notes.find((x) => x.kind === "casePack");
  assert.match(n.reason, /10 units \(1\.43 cases of 7\).*not a case or half-case pack-out.*leave 4 units/);
});
test("case pack: a case and a half already on the shelf is accepted", () => {
  // 3 wide x 2 high x 3 deep = 18 units of 12 = 1.5 cases
  const r = draft(pog([pl("pA", "A", 3, { high: 2, deep: 3 })]), [prod("A", { casePack: 12 })], { A: rec(70) }, []);
  assert.deepEqual([r.changes, r.notes, r.skipped], [[], [], []]);
});
test("case pack never trades away the days-of-supply target", () => {
  // 70/week = 10/day, 2-day target = 20 units. Deep 3 would give exactly 12 (one case) -- too little -- so Deep 2 (8)... is also short;
  // the DOS pass raises capacity first, and the case fit then has to respect the same target.
  const r = draft(pog([pl("pA", "A", 4)]), [prod("A", { casePack: 12 })], { A: rec(70) }, T(2));
  const planogram = applyResetDraftChanges(pog([pl("pA", "A", 4)]).sections, r.changes);
  const placed = planogram[0].fixtures[0].placements[0];
  const units = placed.facings * (placed.high || 1) * (placed.deep || 1);
  assert.ok(units >= 20, "target of 20 units still met, got " + units);
  assert.equal(units % 12, 0, "and it lands on whole cases, got " + units);
});

console.log(`\n${passed} passed`);
