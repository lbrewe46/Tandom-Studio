#!/usr/bin/env node
// Major reset engine on a hand-built planogram whose right answer is known. Run: node scripts/test-major-reset.mjs
import assert from "node:assert/strict";
import { computeMajorReset } from "../supabase/functions/_shared/major-reset.js";
import { applyResetDraftChanges, addDaysISO } from "../supabase/functions/_shared/app-core.js";
let passed = 0;
const test = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { console.error("FAIL " + n + "\n" + e.stack); process.exitCode = 1; } };
console.log("major reset");

const LATEST = "2026-10-17";
const weeks = Array.from({ length: 13 }, (_, i) => addDaysISO(LATEST, -7 * (12 - i)));
const rec = (units) => weeks.map((weekEnding) => ({ weekEnding, units, price: 2, unitCost: 1, storeId: "s1" }));
const prod = (id, seg, extra = {}) => ({ id, name: id, dims: { w: 4, h: 6, d: 3 }, attributes: { seg }, ...extra });
const shelfDef = { id: "shelf", type: "Shelf", name: "Shelf", dims: { w: 48, h: 2, d: 20 } };
const pegDef = { id: "peg", type: "Pegboard", name: "Pegboard", dims: { w: 48, h: 48, d: 4 } };
let n = 0;
const pl = (productId, facings = 2) => ({ id: `pl${++n}`, productId, facings, orientation: "front", rotation: 0, merchStyle: "unit" });
const fx = (id, notchY, placements = [], fixtureId = "shelf") => ({ id, fixtureId, notchY, xOffset: 0, placements });
const sec = (id, fixtures) => ({ id, name: id, width: 48, fixtures });
const planogram = (sections) => ({ id: "P", name: "Test", category: "Snacks", base: 0, dims: { w: 48, h: 72, d: 20 }, sections });
const FIELDS = ["seg"];
const sales = { P1: 40, P2: 36, P3: 30, P4: 24, B1: 20, B2: 16, B3: 10, B4: 6 };
const products = Object.keys(sales).map((id) => prod(id, id[0] === "P" ? "Premium" : "Basic"));
const performance = Object.fromEntries(Object.keys(sales).map((id) => [id, rec(sales[id])]));
const jumbled = () => planogram([sec("s1", [fx("low", 12, ["B4", "P4", "B2", "P1"].map((p) => pl(p))), fx("mid", 36, ["B1", "P3", "B3", "P2"].map((p) => pl(p))), fx("eye", 60, [])])]);
const run = (pog, extra = {}) => computeMajorReset(pog, { products, fixtures: [shelfDef, pegDef], performance, segmentFieldIds: FIELDS, weeks: 13, ...extra });
const placementsOf = (sections) => sections.flatMap((s) => s.fixtures.map((f) => [f.id, f.placements.map((p) => p.productId)]));

test("blocks run biggest-selling first and the best sellers take the eye-level shelf", () => {
  const r = run(jumbled());
  const after = Object.fromEntries(placementsOf(applyResetDraftChanges(jumbled().sections, r.changes)));
  assert.deepEqual(after.eye, ["P1", "P2", "P3", "P4", "B1", "B2"]);   // 48in at 8in a pair of facings = 6 items; eye shelf is filled first
  assert.deepEqual(after.mid, ["B3", "B4"]);
  assert.deepEqual(after.low, []);
  assert.equal(r.major.blocks[0].path, "Premium");
});
test("every item is placed exactly once and total facings are kept when no days-of-supply targets apply", () => {
  const r = run(jumbled());
  const out = applyResetDraftChanges(jumbled().sections, r.changes);
  const all = out.flatMap((s) => s.fixtures.flatMap((f) => f.placements));
  assert.deepEqual(all.map((p) => p.productId).sort(), Object.keys(sales).sort());
  assert.equal(all.reduce((s, p) => s + p.facings, 0), 16);
  assert.equal(r.skipped.length, 0); assert.equal(r.movement.unplaced, 0);
});
test("movement counts items that changed shelf, and reports unchanged ones", () => {
  const r = run(jumbled());
  // before: P1,P4 on low; P2,P3 on mid; after: P1..P4 and B1,B2 on eye, B3,B4 on mid => moved = P1..P4 + B1 + B2 (B1 mid->eye, B2 low->eye); B3 stays mid, B4 low->mid
  assert.equal(r.movement.items, 8); assert.equal(r.movement.moved, 7); assert.equal(r.movement.unchanged, 1); assert.equal(r.movement.pctMoved, 87.5);
});
test("an already well-laid planogram produces no shelf changes", () => {
  const first = run(jumbled());
  const laid = planogram(applyResetDraftChanges(jumbled().sections, first.changes));
  const again = run(laid);
  assert.equal(again.changes.length, 0); assert.equal(again.movement.moved, 0);
});
test("when the needs outgrow the shelves, sections are added and everything still fits", () => {
  const dos = [{ category: "Snacks", days: 7 }];
  const big = planogram([sec("s1", [fx("low", 12, Object.keys(sales).map((p) => pl(p, 5))), fx("mid", 36, []), fx("eye", 60, [])])]);
  const r = run(big, { dosTargets: dos });
  assert.ok(r.major.sectionsAdded >= 1, "added sections");
  const add = r.changes.filter((c) => c.type === "addSection"); assert.equal(add.length, r.major.sectionsAdded);
  const out = applyResetDraftChanges(big.sections, r.changes);
  assert.equal(out.length, 1 + r.major.sectionsAdded);
  assert.deepEqual(out.flatMap((s) => s.fixtures.flatMap((f) => f.placements.map((p) => p.productId))).sort(), Object.keys(sales).sort());
  assert.equal(r.skipped.length, 0);
  const noResize = run(big, { dosTargets: dos, allowResize: false });
  assert.equal(noResize.major.sectionsAdded, 0);
  const total = applyResetDraftChanges(big.sections, noResize.changes).flatMap((s) => s.fixtures.flatMap((f) => f.placements)).reduce((s, p) => s + p.facings * 4, 0);
  assert.ok(total <= 144, "fits the shelves it has");
});
test("an item that fits nowhere is named, and a protected item is never the one that is dropped", () => {
  const tall = prod("TALL", "Premium", { dims: { w: 4, h: 100, d: 3 } });
  const pog = planogram([sec("s1", [fx("low", 12, [pl("P1"), pl("TALL")]), fx("eye", 60, [])])]);
  const r = computeMajorReset(pog, { products: [...products, tall], fixtures: [shelfDef], performance: { ...performance, TALL: rec(5) }, segmentFieldIds: FIELDS, weeks: 13 });
  assert.ok(r.skipped.some((s) => s.productId === "TALL" && /drop off the planogram/.test(s.reason)));
  assert.equal(r.movement.unplaced, 1);
  const narrow = { id: "narrow", type: "Shelf", name: "Narrow", dims: { w: 24, h: 2, d: 20 } };
  const tight = planogram([sec("s1", [fx("only", 12, Object.keys(sales).map((p) => pl(p, 3)), "narrow")])]);
  const prot = products.map((p) => (p.id === "B4" ? { ...p, resetProtected: true } : p));
  const t = computeMajorReset(tight, { products: prot, fixtures: [narrow], performance, segmentFieldIds: FIELDS, weeks: 13, allowResize: false });
  assert.ok(!t.skipped.some((s) => s.productId === "B4"), "protected B4 kept"); assert.ok(t.skipped.length >= 3 && t.skipped.some((s) => s.productId === "B3"), "weak items go first"); assert.ok(!t.skipped.some((s) => s.productId === "P1"), "the best seller stays");
  const kept = applyResetDraftChanges(tight.sections, t.changes).flatMap((s) => s.fixtures.flatMap((f) => f.placements.map((p) => p.productId)));
  assert.ok(kept.includes("B4"));
});
test("pegboards are left alone and a planogram with no shelves is refused", () => {
  const pog = planogram([sec("s1", [fx("low", 12, [pl("P1"), pl("B1")]), fx("pegfx", 0, [pl("B2")], "peg")])]);
  const out = applyResetDraftChanges(pog.sections, run(pog).changes);
  assert.deepEqual(out[0].fixtures.find((f) => f.id === "pegfx").placements.map((p) => p.productId), ["B2"]);
  assert.throws(() => run(planogram([sec("s1", [fx("pegfx", 0, [pl("B2")], "peg")])])), /no shelves/);
});
test("applying never changes the input sections and the draft has a review-friendly reason on each shelf", () => {
  const pog = jumbled(); const before = JSON.stringify(pog.sections);
  const r = run(pog); applyResetDraftChanges(pog.sections, r.changes);
  assert.equal(JSON.stringify(pog.sections), before);
  r.changes.filter((c) => c.type === "setLayout").forEach((c) => { assert.ok(c.productName && c.reason); });
});
console.log(`\n${passed} passed`);
