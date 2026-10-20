#!/usr/bin/env node
// Stacking (Facings Wide/High/Deep + Capping): the geometry helpers, the shelf-clearance rule,
// and the Reset Drafting Agent's use of them. Run: node scripts/test-stacking.mjs
import assert from "node:assert/strict";
import {
  getStackConfig, getStackDims, getShelfClearanceIn, getStackHeightProblem, getStackDepthProblem, getAutoStackHigh, refitAutoStacks, layoutFixtureBoxes, applyResetDraftChanges,
} from "../supabase/functions/_shared/app-core.js";
import { computeResetDraft } from "../supabase/functions/_shared/reset-agent.js";

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.error("FAIL " + name + "\n", e); process.exitCode = 1; } };

const prod = (id, w, h, d = 4, extra = {}) => ({ id, name: id.toUpperCase(), dims: { w, h, d }, attributes: {}, ...extra });
const A = prod("a", 4, 5);
const B = prod("b", 6, 3);
const products = [A, B];
const shelfDef = { id: "shelf", type: "Shelf", name: "Shelf", dims: { w: 24, h: 1, d: 12 } };
const pegDef = { id: "peg", type: "Pegboard", name: "Peg", dims: { w: 24, h: 40, d: 2 } };
const defs = [shelfDef, pegDef];
const pog = { dims: { w: 48, h: 60 }, base: 4 };
const fxAt = (id, notchY, placements = [], extra = {}) => ({ id, fixtureId: "shelf", notchY, xOffset: 0, placements, ...extra });

console.log("stacking helpers");
test("defaults: 1 wide x 1 high x 1 deep, no cap", () => {
  assert.deepEqual(getStackConfig({}), { wide: 1, high: 1, deep: 1, cap: null });
  const s = getStackDims(A, { facings: 3 }, products);
  assert.equal(s.units, 3); assert.equal(s.heightIn, 5); assert.equal(s.cap, null);
});
test("high and deep multiply units; only high adds height", () => {
  const s = getStackDims(A, { facings: 2, high: 3, deep: 2 }, products);
  assert.equal(s.baseUnits, 12); assert.equal(s.heightIn, 15); assert.equal(s.units, 12);
});
test("same-product cap adds height and units per wide facing", () => {
  const s = getStackDims(A, { facings: 2, high: 2, cap: { productId: null, count: 1 } }, products);
  assert.equal(s.heightIn, 15); assert.equal(s.cap.sameProduct, true); assert.equal(s.capUnits, 2); assert.equal(s.units, 6);
});
test("different-product cap uses the cap product's own height", () => {
  const s = getStackDims(A, { facings: 1, high: 2, cap: { productId: "b", count: 2 } }, products);
  assert.equal(s.heightIn, 10 + 6); assert.equal(s.cap.product.id, "b"); assert.equal(s.cap.sameProduct, false);
});
test("an unknown or not-yet-chosen cap product degrades to no cap instead of throwing", () => {
  assert.equal(getStackDims(A, { cap: { productId: "gone", count: 2 } }, products).cap, null);
  assert.equal(getStackDims(A, { cap: { productId: "", count: 2 } }, products).cap, null);
});
test("a rotated placement stacks by its rotated height", () => {
  assert.equal(getStackDims(A, { rotation: 90, high: 2 }, products).heightIn, 8);
});
test("garbage counts are clamped to at least 1", () => {
  assert.deepEqual(getStackConfig({ facings: 0, high: -3, deep: "x" }), { wide: 1, high: 1, deep: 1, cap: null });
});

console.log("shelf clearance");
test("clearance runs to the next shelf above; top shelf runs to the planogram top", () => {
  const section = { fixtures: [fxAt("s1", 0), fxAt("s2", 20), fxAt("s3", 40)] };
  assert.equal(getShelfClearanceIn(pog, section, section.fixtures[0], defs), 20 - 1);
  assert.equal(getShelfClearanceIn(pog, section, section.fixtures[1], defs), 20 - 1);
  assert.equal(getShelfClearanceIn(pog, section, section.fixtures[2], defs), 60 - (4 + 40 + 1));
});
test("a shelf that doesn't overlap horizontally isn't a ceiling; a pegboard backdrop never is", () => {
  const section = { fixtures: [fxAt("s1", 0), { ...fxAt("s2", 10), xOffset: 30 }, { id: "p", fixtureId: "peg", notchY: 8, xOffset: 0, placements: [] }] };
  assert.equal(getShelfClearanceIn(pog, section, section.fixtures[0], defs), 60 - (4 + 0 + 1));
});
test("mounted-on-pegboard fixtures report unlimited headroom", () => {
  const section = { fixtures: [fxAt("s1", 5, [], { mountedOnId: "p" })] };
  assert.equal(getShelfClearanceIn(pog, section, section.fixtures[0], defs), Infinity);
});
test("height problem: fits / too tall / unknown clearance", () => {
  assert.equal(getStackHeightProblem(A, { high: 3 }, products, 15), null);
  assert.match(getStackHeightProblem(A, { high: 4 }, products, 15), /20in tall.*only has 15in/);
  assert.match(getStackHeightProblem(A, { high: 2, cap: { productId: "b", count: 2 } }, products, 15), /\(2 high \+ 2 capped\)/);
  assert.equal(getStackHeightProblem(A, { high: 99 }, products, Infinity), null);
});

console.log("layout");
test("high/deep/cap never change shelf width; boxes carry the stack", () => {
  const plain = layoutFixtureBoxes(fxAt("s", 0, [{ id: "p1", productId: "a", facings: 3 }]), shelfDef, products);
  const stacked = layoutFixtureBoxes(fxAt("s", 0, [{ id: "p1", productId: "a", facings: 3, high: 4, deep: 3, cap: { productId: "b", count: 1 } }]), shelfDef, products);
  assert.equal(plain.totalWidth, stacked.totalWidth);
  assert.equal(stacked.boxes.length, 3);
  assert.equal(stacked.boxes[0].stack.high, 4);
  assert.equal(stacked.boxes[0].stack.cap.product.id, "b");
});

console.log("Reset Drafting Agent");
// Shelf is 24in wide. A (4in) x5 facings + B (6in) x0... build a full shelf so no facing fits.
const weeks = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 7, 2 + i * 7)).toISOString().slice(0, 10));
const rec = (units) => weeks.map((weekEnding) => ({ weekEnding, units, price: 1, unitCost: 0.5, storeId: "s1" }));
function scenario({ clearanceGap }) {
  // shelf at 0; shelf above at (1 + clearanceGap). A is the standout; the shelf is exactly full.
  const fx1 = fxAt("fx1", 0, [{ id: "pA", productId: "a", facings: 3, orientation: "front", rotation: 0, merchStyle: "unit" }, { id: "pB", productId: "b", facings: 2, orientation: "front", rotation: 0, merchStyle: "unit" }]);
  const fx2 = fxAt("fx2", 1 + clearanceGap, []);
  return { id: "pog", category: "", dims: pog.dims, base: pog.base, sections: [{ id: "sec", fixtures: [fx1, fx2] }] };
}
// A: 3 facings x 4in = 12 + B 2 x 6 = 12 -> exactly 24in, full.
const performance = { a: rec(1000), b: rec(10) };
const draft = (pl) => computeResetDraft(pl, products, defs, performance, [], [], 8, null);
test("no room for another facing + headroom -> stack one higher instead", () => {
  const r = draft(scenario({ clearanceGap: 12 }));
  const c = r.changes.find((x) => x.type === "increaseHigh");
  assert.ok(c, JSON.stringify(r));
  assert.deepEqual([c.productId, c.oldHigh, c.newHigh, c.placementId], ["a", 1, 2, "pA"]);
  assert.ok(!r.changes.some((x) => x.type === "increaseFacings"));
});
test("no headroom for the taller stack -> skipped with a reason, no change", () => {
  const r = draft(scenario({ clearanceGap: 4 })); // A is 5in; 2 high = 10in > 4in
  assert.ok(!r.changes.some((x) => x.type === "increaseHigh"));
  assert.ok(r.skipped.some((s) => s.productId === "a" && /no room/.test(s.reason)));
});
test("a draft never stacks past what a stack can already be: second pass respects the new height", () => {
  const pl = scenario({ clearanceGap: 12 });
  pl.sections[0].fixtures[0].placements[0].high = 2; // already 10in of 12in clearance; 3 high = 15in
  const r = draft(pl);
  assert.ok(!r.changes.some((x) => x.type === "increaseHigh"));
});
test("applyResetDraftChanges sets High (and clears it back to 1 cleanly)", () => {
  const pl = scenario({ clearanceGap: 12 });
  const out = applyResetDraftChanges(pl.sections, [{ type: "increaseHigh", placementId: "pA", newHigh: 3 }]);
  assert.equal(out[0].fixtures[0].placements[0].high, 3);
  const back = applyResetDraftChanges(out, [{ type: "increaseHigh", placementId: "pA", newHigh: 1 }]);
  assert.equal("high" in back[0].fixtures[0].placements[0], false);
  assert.equal(pl.sections[0].fixtures[0].placements[0].high, undefined, "input untouched");
});

console.log("cap orientation");
const T = prod("t", 4, 10, 3); // 4w x 10h x 3d: standing it is 10 tall, lying on its top face it is 3 tall
test("one front on the shelf, two caps showing the top: cap height is the depth", () => {
  const s = getStackDims(T, { facings: 1, cap: { productId: null, count: 2, orientation: "top" } }, [T]);
  assert.equal(s.cap.orientation, "top");
  assert.equal(s.cap.unitHIn, 3); assert.equal(s.heightIn, 10 + 6);
  assert.equal(s.cap.unitWIn, 4);
});
test("side facings swap width and depth; front (default) is unchanged", () => {
  const side = getStackDims(T, { cap: { productId: null, count: 1, orientation: "left" } }, [T]);
  assert.deepEqual([side.cap.unitWIn, side.cap.unitHIn], [3, 10]);
  const front = getStackDims(T, { cap: { productId: null, count: 1 } }, [T]);
  assert.deepEqual([front.cap.unitWIn, front.cap.unitHIn, front.cap.orientation], [4, 10, "front"]);
});
test("a different-product cap in another orientation uses that product's dims", () => {
  const s = getStackDims(A, { cap: { productId: "t", count: 1, orientation: "top" } }, [A, T]);
  assert.equal(s.cap.unitHIn, 3);
});
test("a bad orientation falls back to front; the height rule sees the shorter cap", () => {
  assert.equal(getStackDims(T, { cap: { productId: null, count: 1, orientation: "sideways" } }, [T]).cap.orientation, "front");
  const withTop = { facings: 1, cap: { productId: null, count: 2, orientation: "top" } };
  assert.equal(getStackHeightProblem(T, withTop, [T], 16), null);
  assert.match(getStackHeightProblem(T, { ...withTop, cap: { ...withTop.cap, orientation: "front" } }, [T], 16), /tall/);
});

console.log("worked example: 6w x 10h x 2d, 24in-deep shelf, 15in between shelves");
const W = prod("w", 6, 10, 2);
const example = (cap) => ({ facings: 1, high: 1, deep: 12, cap });
test("1 high x 12 deep fills the shelf depth exactly; 2 caps showing the top fit under 15in", () => {
  const s = getStackDims(W, example({ productId: null, count: 2, orientation: "top" }), [W]);
  assert.equal(s.stackDepthIn, 24);
  assert.equal(getStackDepthProblem(W, example(null), [W], 24), null);
  assert.equal(s.heightIn, 10 + 2 * 2); // caps lie flat: 2in tall each
  assert.equal(getStackHeightProblem(W, example({ productId: null, count: 2, orientation: "top" }), [W], 15), null);
});
test("a third top cap (16in) no longer fits the 15in opening", () => {
  assert.match(getStackHeightProblem(W, example({ productId: null, count: 3, orientation: "top" }), [W], 15), /16in tall/);
});
test("cap units run only as far back as they physically fit: 10in-long caps over a 24in stack = 2 deep", () => {
  const s = getStackDims(W, example({ productId: null, count: 2, orientation: "top" }), [W]);
  assert.equal(s.cap.deep, 2);
  assert.equal(s.capUnits, 4); // 2 high x 2 deep
  assert.equal(s.units, 12 + 4);
});
test("13 deep would reach 26in on a 24in shelf and is flagged", () => {
  assert.match(getStackDepthProblem(W, { deep: 13 }, [W], 24), /13 deep reaches 26in back but this shelf is only 24in deep/);
  assert.equal(getStackDepthProblem(W, { deep: 13 }, [W], undefined), null);
});

console.log("auto-stack");
const autoPog = (gap, extra = {}) => ({ ...pog, sections: [{ id: "sec", fixtures: [fxAt("f1", 0, [{ id: "p1", productId: "a", facings: 2, autoStack: true, ...extra }]), fxAt("f2", 1 + gap)] }] });
test("high = whole units that fit under the shelf above", () => {
  assert.equal(getAutoStackHigh(A, { autoStack: true }, products, 12), 2); // 5in units in 12in
  assert.equal(getAutoStackHigh(A, { autoStack: true }, products, 4), 1);  // never below 1
  assert.equal(getAutoStackHigh(A, { autoStack: true }, products, 500), 12); // capped
  assert.equal(getAutoStackHigh(A, { autoStack: true, high: 3 }, products, Infinity), 3); // unknown headroom: leave alone
});
test("a cap's height is reserved before stacking", () => {
  assert.equal(getAutoStackHigh(A, { cap: { productId: "b", count: 1 } }, products, 14), 2); // (14-3)/5
});
test("refit grows, shrinks when the shelf above moves, and is a no-op when already right", () => {
  const grown = refitAutoStacks(autoPog(12), defs, products);
  assert.equal(grown.sections[0].fixtures[0].placements[0].high, 2);
  assert.equal(refitAutoStacks(grown, defs, products), grown, "same object when nothing changes");
  const moved = { ...grown, sections: [{ ...grown.sections[0], fixtures: [grown.sections[0].fixtures[0], { ...grown.sections[0].fixtures[1], notchY: 1 + 5 }] }] };
  const shrunk = refitAutoStacks(moved, defs, products);
  assert.equal("high" in shrunk.sections[0].fixtures[0].placements[0], false, "back to 1 high");
  assert.equal(grown.sections[0].fixtures[0].placements[0].high, 2, "input untouched");
});
test("only placements flagged autoStack are touched; pegboards are skipped", () => {
  const manual = autoPog(12); delete manual.sections[0].fixtures[0].placements[0].autoStack;
  assert.equal(refitAutoStacks(manual, defs, products), manual);
  const peg = { ...pog, sections: [{ id: "s", fixtures: [{ id: "pg", fixtureId: "peg", notchY: 0, xOffset: 0, placements: [{ id: "x", productId: "a", autoStack: true }] }] }] };
  assert.equal(refitAutoStacks(peg, defs, products), peg);
});
test("agent: a product it adds comes in auto-stacked to the headroom", () => {
  const fx1 = fxAt("fx1", 0, [{ id: "pA", productId: "a", facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" }]);
  const pl = { id: "pog", category: "Snacks", dims: pog.dims, base: pog.base, sections: [{ id: "sec", fixtures: [fx1, fxAt("fx2", 1 + 12)] }] };
  const prods = [{ ...A, attributes: { fcat: "Snacks" } }, { ...B, attributes: { fcat: "Snacks" } }];
  const r = computeResetDraft(pl, prods, defs, { a: rec(100), b: rec(500) }, [{ id: "fcat", label: "Category", type: "text" }], [], 8, null);
  const add = r.changes.find((c) => c.type === "addProduct");
  assert.ok(add, JSON.stringify(r));
  assert.equal(add.newHigh, 4); // B is 3in tall; 12in of headroom
  const out = applyResetDraftChanges(pl.sections, [add]);
  const placed = out[0].fixtures[0].placements.find((p) => p.id === add.placementId);
  assert.deepEqual([placed.high, placed.autoStack], [4, true]);
});

console.log(`\n${passed} passed`);
