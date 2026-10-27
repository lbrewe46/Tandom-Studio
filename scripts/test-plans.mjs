#!/usr/bin/env node
import assert from "node:assert/strict";
import { renderPack } from "../src/lib/pack-pptx.js";
import { contextRows, storeGroups, scenarioRange, buildPack, fmtImpact, planItemFromProposal, planTotals, proposalsAvailableForPlan, planRows, planDateFlags, planLink, planIdFromHash, planStatusLabel } from "../src/lib/plans.js";
let passed = 0;
const test = (n, f) => { try { f(); passed++; console.log("  ok  " + n); } catch (e) { console.error("FAIL " + n + "\n" + e.stack); process.exitCode = 1; } };
const prop = (id, target, changes) => ({ id, target_id: target, proposed_change: { changes } });
console.log("assortment plans");
test("a plan line counts adds, removes and facings", () => {
  const it = planItemFromProposal(prop("p1", "A", [{ type: "addProduct", productName: "N1" }, { type: "delete", productName: "S1" }, { type: "increaseFacings", productName: "X" }]), "Cereal 8FT");
  assert.deepEqual(it, { proposalId: "p1", planogramId: "A", planogramName: "Cereal 8FT", adds: ["N1"], removes: ["S1"], facings: 1, impact: null, kind: null, window: null, assumptions: null });
  assert.equal(planItemFromProposal({ id: "p2", target_id: "B" }).adds.length, 0);
});
test("totals", () => {
  const t = planTotals([{ planogramId: "A", adds: ["a", "b"], removes: ["c"], facings: 2 }, { planogramId: "B", adds: ["a"], removes: [], facings: 0 }]);
  assert.deepEqual(t, { planograms: 2, adds: 3, removes: 1, facings: 2 });
});
test("proposals already in a live plan are not offered again; cancelled plans free them", () => {
  const ps = [{ id: "p1", target_id: "A" }, { id: "p2", target_id: "B" }, { id: "p3", target_id: "C" }];
  const plans = [{ status: "draft", proposal_ids: ["p1"] }, { status: "cancelled", proposal_ids: ["p2"] }];
  assert.deepEqual(proposalsAvailableForPlan(ps, plans).map((p) => p.id), ["p2", "p3"]);
  const byId = { A: { category: "Cereal" }, B: { category: "Soup" }, C: { category: "Cereal" } };
  assert.deepEqual(proposalsAvailableForPlan(ps, plans, { category: "Cereal", planogramById: byId }).map((p) => p.id), ["p3"]);
});
test("download rows", () => {
  const rows = planRows({ items: [{ planogramName: "A", adds: ["N1"], removes: ["S1", "S2"], facings: 3 }] });
  assert.equal(rows.length, 4); assert.deepEqual(rows[0], { Planogram: "A", Action: "Add", Item: "N1" }); assert.equal(rows[3].Item, "3 items");
});
test("late and review-due flags only apply while open", () => {
  assert.deepEqual(planDateFlags({ status: "scheduled", effective_date: "2026-10-01", review_by: "2026-10-20" }, "2026-10-27"), { late: true, reviewDue: true });
  assert.deepEqual(planDateFlags({ status: "executed", effective_date: "2026-10-01" }, "2026-10-27"), { late: false, reviewDue: false });
  assert.deepEqual(planDateFlags({ status: "draft" }, "2026-10-27"), { late: false, reviewDue: false });
});
test("share links round-trip", () => {
  const id = "abc-123";
  assert.equal(planIdFromHash(new URL(planLink("https://x.app", id)).hash), id);
  assert.equal(planIdFromHash("#access_token=1&plan=z"), "z"); assert.equal(planIdFromHash(""), null);
  assert.equal(planStatusLabel("shared"), "Shared for review");
});

const A = (extra = {}) => ({ assortment: { kind: "new", impact: { metric: "sales", netNetworkWeek: 1200, items: [{ name: "N1", stores: 10, forecastUnitsPerStoreWeek: 12, basis: "supplier forecast", netNetworkWeek: 1200, gives: [{ name: "Rival 12pk", velocity: 3.2 }] }] }, assumptions: { cannibalization: 0.3, transfer: 0.5 }, ...extra }, startISO: "2026-07-18", endISO: "2026-10-17", changes: [{ type: "addProduct", productName: "N1" }, { type: "delete", productName: "Rival 12pk" }] });
const plan = () => ({ name: "Spring set", category: "Bath Tissue", effective_date: "2027-02-01", review_by: "2027-04-01", items: [
  planItemFromProposal({ id: "p1", target_id: "A", proposed_change: A() }, "Bath 8FT"), planItemFromProposal({ id: "p2", target_id: "B", proposed_change: A() }, "Bath 4FT")] });
test("a plan line keeps the expected impact, window and assumptions", () => {
  const it = plan().items[0];
  assert.equal(it.impact.net, 1200); assert.equal(it.window.endISO, "2026-10-17"); assert.equal(it.assumptions.cannibalization, 0.3); assert.equal(it.kind, "new");
  assert.equal(planItemFromProposal({ id: "x", target_id: "A", proposed_change: { changes: [] } }).impact, null);
});
test("the presentation pack states the ask, the evidence and the assumptions from the plan's own numbers", () => {
  const slides = buildPack(plan(), { preparedBy: "Acme Paper", preparedFor: "Kroger buyer" });
  const kinds = slides.map((s) => s.kind);
  assert.deepEqual(kinds, ["title", "ask", "recs", "evidence", "tradeoffs", "execution", "appendix"]); // no context, groups or range without their data
  assert.equal(slides[0].preparedBy, "Acme Paper");
  assert.equal(slides[1].tiles[3].value, "$2,400");
  assert.match(slides[1].bullets[0], /2 items added and 2 removed across 2 planograms, effective 2027-02-01/);
  assert.equal(slides[3].rows.length, 2); assert.equal(slides[3].rows[0][4], "supplier forecast");
  assert.ok(slides[4].bullets.some((b) => /30%/.test(b)) && slides[4].bullets.some((b) => /Rival 12pk/.test(b)));
  assert.match(slides.at(-1).bullets[0], /2026-07-18 to 2026-10-17/);
});
test("competitor names can be hidden for an external audience, and never leak anywhere in the pack", () => {
  const slides = buildPack(plan(), { hideRemovedNames: true });
  assert.ok(!JSON.stringify(slides).includes("Rival 12pk"));
  assert.match(JSON.stringify(slides), /Item 1 on the same shelf/); assert.match(JSON.stringify(slides), /3.2 units per store per week/);
});
test("missing or partial impact is said plainly, not invented", () => {
  const p = plan(); p.items[1].impact = null;
  const a = buildPack(p)[1]; assert.equal(a.tiles[3].value, "$1,200*"); assert.match(a.bullets[1], /1 of 2 planograms/);
  const none = plan(); none.items.forEach((i) => { i.impact = null; });
  assert.equal(buildPack(none)[1].tiles[3].value, "n/a"); assert.equal(fmtImpact("sales", null), "not recorded"); assert.equal(fmtImpact("units", 1500), "1,500 units");
});
test("long plans are paged", () => {
  const p = plan(); p.items = Array.from({ length: 16 }, (_, i) => ({ ...plan().items[0], proposalId: `p${i}`, planogramName: `Bath ${i}` }));
  const recs = buildPack(p).filter((s) => s.kind === "recs"); assert.equal(recs.length, 3); assert.match(recs[0].title, /1 of 3/); assert.equal(recs[2].rows.length, 2);
});
test("every slide kind draws with the PptxGenJS calls we rely on", () => {
  const calls = [];
  const slide = () => ({ addText: (...a) => calls.push(["text", ...a]), addShape: (...a) => calls.push(["shape", ...a]), addTable: (...a) => calls.push(["table", ...a]), set background(v) { calls.push(["bg", v]); } });
  const pptx = { ShapeType: { rect: "rect" }, addSlide: () => slide() };
  const slides = buildPack(plan(), { preparedBy: "Acme" });
  renderPack(pptx, slides, { preparedBy: "Acme" });
  assert.equal(pptx.layout, "LAYOUT_WIDE");
  assert.ok(calls.filter((c) => c[0] === "table").length >= 2);
  const t = calls.find((c) => c[0] === "table"); assert.equal(t[1][0].length, 4); // header + body rows are arrays of cells
  assert.ok(calls.every((c) => c[0] !== "text" || (typeof c[1] === "string" || Array.isArray(c[1]))));
});

test("category context rows come from the segment tree", () => {
  const rows = contextRows({ nodes: [{ label: "Ultra Soft", shareOfCategorySales: 0.4, shareOfCategorySpace: 0.3, growth: 0.05, spaceIndex: 133, opportunity: "Add space", spaceNote: "" }, { label: "Basic", shareOfCategorySales: 0.2, shareOfCategorySpace: 0.3, growth: null, spaceIndex: null }] });
  assert.deepEqual(rows[0], { segment: "Ultra Soft", sales: "40.0%", space: "30.0%", growth: "+5.0%", index: "133", note: "Add space" });
  assert.equal(rows[1].growth, "n/a");
});
test("store groups count each store once per group and the items added once per planogram", () => {
  const stores = { s1: { format: "Large" }, s2: { format: "Large" }, s3: { format: "Small" }, s4: {} };
  const pgs = { A: { id: "A", storeIds: ["s1", "s2", "s3"] }, B: { id: "B", storeIds: ["s2", "s4"] } };
  const items = [{ planogramId: "A", adds: ["x", "y"] }, { planogramId: "B", adds: ["z"] }];
  const g = storeGroups(items, (i) => pgs[i.planogramId], stores, "format");
  assert.deepEqual(g, [{ group: "Large", stores: 2, planograms: 2, adds: 3 }, { group: "(not set)", stores: 1, planograms: 1, adds: 1 }, { group: "Small", stores: 1, planograms: 1, adds: 2 }]);
});
test("low / base / high move with the forecast and need gain and loss recorded", () => {
  const it = (gain, loss) => ({ impact: { items: [{ gainNetworkWeek: gain, lossNetworkWeek: loss }] } });
  const r = scenarioRange([it(1000, 400), it(500, 100)], 0.25);
  assert.deepEqual([r.low, r.base, r.high], [1125 - 500, 1000, 1875 - 500]);
  assert.equal(scenarioRange([it(1000, 400), { impact: { items: [{ netNetworkWeek: 5 }] } }]), null);
  assert.ok(scenarioRange([it(100, 90)], 0.25).low < 0);
});
test("the pack adds context, store-group and range slides when it has the data", () => {
  const p = plan(); p.items.forEach((i) => { i.impact.items[0].gainNetworkWeek = 2000; i.impact.items[0].lossNetworkWeek = 800; });
  const slides = buildPack(p, { context: [{ segment: "Ultra Soft", sales: "40%", space: "30%", growth: "+5%", index: "133", note: "Add space" }], byGroup: { label: "format", rows: [{ group: "Large", stores: 10, planograms: 2, adds: 2 }] } });
  assert.deepEqual(slides.map((s) => s.kind), ["title", "ask", "context", "recs", "evidence", "groups", "range", "tradeoffs", "execution", "appendix"]);
  const range = slides.find((s) => s.kind === "range");
  assert.equal(range.rows[1][1], "$2,400"); assert.match(range.note, /stays positive/);
  assert.equal(buildPack(plan()).some((s) => s.kind === "range"), false, "no range without gain and loss");
});
console.log(`\n${passed} passed`);
