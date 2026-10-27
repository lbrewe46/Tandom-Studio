#!/usr/bin/env node
import assert from "node:assert/strict";
import { spaceFit } from "../supabase/functions/_shared/space-fit.js";
let passed = 0;
const test = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { console.error("FAIL " + n + "\n" + e.stack); process.exitCode = 1; } };
console.log("space fit");
// products are 4in wide, 6 high, 3 deep; shelf depth is not limited here (units per facing = 1 wide x 1 high x 1 deep)
const prod = (id, extra = {}) => ({ id, name: id, dims: { w: 4, h: 6, d: 3 }, ...extra });
const weeks = Array.from({ length: 13 }, (_, i) => new Date(Date.UTC(2026, 6, 4 + i * 7)).toISOString().slice(0, 10));
const rec = (units) => weeks.map((weekEnding) => ({ weekEnding, units, price: 1, unitCost: 0.5, storeId: "s1" }));
const pl = (id, productId, facings) => ({ id, productId, facings, orientation: "front", rotation: 0, merchStyle: "unit" });
const fixtures = [{ id: "shelf", dims: { w: 48 } }];
const mk = (sections) => ({ id: "P", category: "Snacks", sections });
const section = (id, ...placements) => ({ id, width: 48, fixtures: [{ id: id + "fx", fixtureId: "shelf", placements }] });
const dos = [{ category: "Snacks", days: 7 }];

test("a planogram too small for its items is told to add a section", () => {
  // each item sells 70 a week => 10 a day => 70 units for 7 days; one facing holds 1 unit... so it needs 70 facings (4in each): far too big
  // use a gentler rate: 14 units a week = 14 units for 7 days => 14 facings of 4in = 56in each
  const items = ["A", "B", "C", "D"];
  const pog = mk([section("s1", pl("1", "A", 2), pl("2", "B", 2)), section("s2", pl("3", "C", 2), pl("4", "D", 2))]);
  const perf = Object.fromEntries(items.map((id) => [id, { id, records: rec(14) }]));
  const r = spaceFit(pog, { products: items.map((i) => prod(i)), fixtures, performance: Object.fromEntries(items.map((id) => [id, rec(14)])), dosTargets: dos });
  assert.equal(r.ok, true); assert.equal(r.capacityIn, 96); assert.equal(r.sectionCount, 2);
  assert.equal(r.neededIn, 4 * 14 * 4); // 4 items x 14 facings x 4in = 224in
  assert.equal(r.action, "add"); assert.equal(r.sectionsNeeded, Math.ceil(224 / (48 * 0.95))); void perf;
  assert.match(r.reason, /sections of 48in/);
});
test("an over-sized planogram is told it can shrink, but only by whole sections", () => {
  // two items needing 1 facing each (about 8in) in four 48in sections
  const pog = mk([section("a", pl("1", "A", 2)), section("b", pl("2", "B", 2)), section("c"), section("d")]);
  const perf = { A: rec(1), B: rec(1) };
  const r = spaceFit(pog, { products: [prod("A"), prod("B")], fixtures, performance: perf, dosTargets: dos });
  assert.equal(r.action, "remove"); assert.equal(r.sectionsNeeded, 1); assert.equal(r.delta, -3);
});
test("a planogram that is close but not a whole section off stays as it is", () => {
  const pog = mk([section("a", pl("1", "A", 5), pl("2", "B", 5)), section("b", pl("3", "C", 5))]);
  const perf = { A: rec(7), B: rec(7), C: rec(7) }; // 7 a week = 7 units for 7 days => 7 facings x 4in x 3 items = 84in of 96in
  const r = spaceFit(pog, { products: ["A", "B", "C"].map((i) => prod(i)), fixtures, performance: perf, dosTargets: dos });
  assert.equal(r.neededIn, 84); assert.equal(r.action, "ok");
});
test("without days-of-supply targets it falls back to the facings it has, and says so", () => {
  const pog = mk([section("a", pl("1", "A", 3))]);
  const r = spaceFit(pog, { products: [prod("A")], fixtures, performance: { A: rec(50) }, dosTargets: [] });
  assert.equal(r.neededIn, 12); assert.equal(r.basedOnItems, 0); assert.match(r.reason, /No days-of-supply targets/);
});
test("empty or unmeasurable planograms are reported, not crashed on", () => {
  assert.equal(spaceFit({ id: "x", sections: [] }, {}).ok, false);
  assert.equal(spaceFit({ id: "x", sections: [{ id: "s", fixtures: [] }] }, {}).ok, false);
});
console.log(`\n${passed} passed`);
