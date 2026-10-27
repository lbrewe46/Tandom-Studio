#!/usr/bin/env node
// Assortment engine: segments, slow movers, forecast and SKU rationalization on a hand-built Cereal category
// whose right answers are known in advance. Run: node scripts/test-assortment.mjs
import assert from "node:assert/strict";
import { buildContext, segmentTree, slowMovers, forecastFor, recommend, resolveScope, scopeOptions, windowsFor, coreProfile, coreForecasts, coreValueScale, storeProductivity, planogramsAsOf } from "../supabase/functions/_shared/assortment.js";
import { applyResetDraftChanges, addDaysISO } from "../supabase/functions/_shared/app-core.js";

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { failed++; console.error("FAIL " + name + "\n", e); } };

const schema = [{ id: "f_cat", label: "Category" }, { id: "f_age", label: "Age" }, { id: "f_sug", label: "Sugar" }];
const prod = (name, age, sugar, extra = {}) => ({ id: name.toLowerCase().replace(/ /g, "_"), name, dims: { w: 8, h: 10, d: 6 }, attributes: { f_cat: "Cereal", f_age: age, f_sug: sugar }, ...extra });
const P = {
  ks1: prod("KS1", "Kids", "Sugar"), ks2: prod("KS2", "Kids", "Sugar"), ks3: prod("KS3", "Kids", "Sugar"), ks4: prod("KS4", "Kids", "Sugar"), ks5: prod("KS5", "Kids", "Sugar"), kn1: prod("KN1", "Kids", "No sugar"),
  an1: prod("AN1", "Adult", "No sugar"), an2: prod("AN2", "Adult", "No sugar"), an3: prod("AN3", "Adult", "No sugar"), an4: prod("AN4", "Adult", "No sugar"), as1: prod("AS1", "Adult", "Sugar"),
};
const shelfDef = { id: "shelf", type: "Shelf", name: "Shelf", dims: { w: 48, h: 2, d: 20 } };
let n = 0;
const pl = (id) => ({ id: `pl${++n}`, productId: id, facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" });
const fx = (id, notchY, ids) => ({ id, fixtureId: "shelf", notchY, xOffset: 0, placements: ids.map(pl) });
const pogA = { id: "A", name: "Cereal 8FT", category: "Cereal", status: "live", dims: { w: 48, h: 72, d: 20 }, base: 0, storeIds: ["s1"], sections: [{ id: "secA", name: "S1", width: 48, fixtures: [fx("a1", 10, ["ks1", "ks2", "ks3", "an1", "an2", "as1"]), fx("a2", 40, ["an3", "an4", "ks4", "kn1"])] }] };
const pogB = { id: "B", name: "Cereal 4FT", category: "Cereal", status: "live", dims: { w: 48, h: 72, d: 20 }, base: 0, storeIds: ["s2"], sections: [{ id: "secB", name: "S1", width: 48, fixtures: [fx("b1", 10, ["ks1", "an1", "an2", "as1", "kn1", "ks5"])] }] };
const stores = [{ id: "s1", name: "East 1", region: "East", cluster: "Urban", format: "Large" }, { id: "s2", name: "West 1", region: "West", cluster: "Rural", format: "Small" }];

// 26 weeks ending 2026-10-17; first 13 = the base period, last 13 = the current period (per store per week)
const LATEST = "2026-10-17";
const UNITS = { ks1: [20, 14], ks2: [18, 12], ks3: [2, 1], ks4: [16, 11], ks5: [15, 10], kn1: [6, 6], an1: [10, 15], an2: [9, 14], an3: [8, 13], an4: [1, 1], as1: [8, 8] };
const stores_of = { A: "s1", B: "s2" };
const perf = {};
Object.entries(UNITS).forEach(([id, [b, c]]) => {
  perf[id] = [];
  [["A", "s1"], ["B", "s2"]].forEach(([pg, sid]) => {
    const onIt = (pg === "A" ? pogA : pogB).sections[0].fixtures.some((f) => f.placements.some((p) => p.productId === id));
    if (!onIt) return;
    for (let i = 0; i < 26; i++) perf[id].push({ weekEnding: addDaysISO(LATEST, -7 * (25 - i)), unitCost: 3, price: 4, units: i < 13 ? b : c, storeId: sid });
  });
});

const data = (extraProducts = []) => ({ products: [...Object.values(P), ...extraProducts], planograms: [pogA, pogB], fixtures: [shelfDef], performance: perf, stores, productSchema: schema });
const params = (o = {}) => ({ category: "Cereal", scope: { type: "all" }, weeks: 13, compare: "prior", segmentFieldIds: ["f_age", "f_sug"], ...o });
const newItem = (name, age, sugar, newItemInfo) => prod(name, age, sugar, { newItem: { source: "category_manager", retailPrice: 4, unitCost: 3, ...newItemInfo } });

console.log("windows and scope");
test("prior-period and year-ago windows", () => {
  const w = windowsFor(perf, 13, "prior");
  assert.equal(w.cur.end, LATEST); assert.equal(w.base.end, addDaysISO(w.cur.start, -1));
  assert.equal(windowsFor(perf, 13, "yoy").base.end, addDaysISO(LATEST, -364));
});
test("scope by region/cluster/format/store; chain rows only count for all stores", () => {
  assert.deepEqual([...resolveScope(stores, { type: "region", value: "West" }).storeIds], ["s2"]);
  assert.deepEqual([...resolveScope(stores, { type: "cluster", value: "Urban" }).storeIds], ["s1"]);
  assert.deepEqual([...resolveScope(stores, { type: "store", value: "s2" }).storeIds], ["s2"]);
  assert.equal(resolveScope(stores, { type: "all" }).includeChain, true);
  assert.equal(resolveScope(stores, { type: "region", value: "West" }).includeChain, false);
  assert.deepEqual(scopeOptions(stores).region, ["East", "West"]);
});

console.log("segments");
const ctx = buildContext(data(), params());
const tree = segmentTree(ctx);
test("Kids are declining and Adult is growing, with shares that add up", () => {
  const kids = tree.nodes.find((x) => x.label === "Kids"), adult = tree.nodes.find((x) => x.label === "Adult");
  assert.equal(kids.trend, "Declining"); assert.equal(adult.trend, "Growing");
  assert.ok(Math.abs(kids.shareOfCategorySales + adult.shareOfCategorySales - 1) < 1e-9);
  assert.ok(Math.abs(kids.shareOfCategorySpace + adult.shareOfCategorySpace - 1) < 1e-9);
  assert.ok(kids.growth < 0 && adult.growth > 0);
});
test("space index = share of sales / share of space; the biggest space holder is flagged", () => {
  tree.nodes.forEach((nd) => assert.equal(nd.spaceIndex, Math.round((nd.shareOfParentSales / nd.shareOfParentSpace) * 100)));
  assert.equal(tree.nodes.filter((x) => x.largestSpace).length, 1);
  const flagged = tree.nodes.find((x) => x.largestSpace);
  assert.equal(flagged.metrics.space, Math.max(...tree.nodes.map((x) => x.metrics.space)));
});
test("second decision level nests under the first", () => {
  const adult = tree.nodes.find((x) => x.label === "Adult");
  assert.deepEqual(adult.children.map((c) => c.label).sort(), ["No sugar", "Sugar"]);
  const noSugar = adult.children.find((c) => c.label === "No sugar");
  assert.equal(noSugar.metrics.skus, 4); assert.equal(noSugar.trend, "Growing");
});
test("a segment with no earlier-period sales has no growth figure rather than a made-up one", () => {
  const c2 = buildContext(data(), params({ weeks: 30 }));
  assert.equal(segmentTree(c2).total.growth, null);
});

console.log("slow movers");
test("ranked slowest first by units per store per week, with ties broken by sales per inch then name", () => {
  const { rows } = slowMovers(ctx);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.name), ["AN4", "KS3"]);
  assert.equal(rows[0].velocity, 1); assert.equal(rows[0].rank, 1);
  assert.equal(rows[rows.length - 1].name, "AN1"); // 15 units/store/week, the fastest
});
test("velocity divides by the stores that carry it (KS1 is in two stores)", () => {
  const ks1 = slowMovers(ctx).rows.find((r) => r.name === "KS1");
  assert.equal(ks1.stores, 2); assert.equal(ks1.velocity, 14); // 14 units/week in each of 2 stores
});
test("narrowing the scope to one region only ranks what that region carries", () => {
  const west = buildContext(data(), params({ scope: { type: "region", value: "West" } }));
  const names = slowMovers(west).rows.map((r) => r.name);
  assert.ok(!names.includes("KS3") && !names.includes("AN4") && names.includes("KN1"));
});
test("grouped by region it shows how widely an item is slow", () => {
  const sm = slowMovers(ctx, { groupBy: "region" });
  assert.deepEqual(sm.groups.map((g) => g.key).sort(), ["East", "West"]);
  const ks1 = sm.rows.find((r) => r.name === "KS1");
  assert.equal(ks1.groupsCarried, 2);
  const an4 = sm.rows.find((r) => r.name === "AN4");
  assert.equal(an4.groupsCarried, 1); assert.equal(an4.slowIn, 1);
});
test("items on shelf with no sales at all are the slowest", () => {
  const p = JSON.parse(JSON.stringify(pogA)); p.sections[0].fixtures[0].placements.push({ id: "zz", productId: "ghost", facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" });
  const d = data([prod("Ghost", "Adult", "Sugar", { id: "ghost" })]); d.planograms = [p, pogB];
  const rows = slowMovers(buildContext(d, params())).rows;
  assert.equal(rows[0].name, "Ghost"); assert.equal(rows[0].velocity, 0);
});

console.log("forecast");
test("a typed forecast wins; similar items average their actual velocity and scale; nothing -> not ready", () => {
  const f = forecastFor(ctx, newItem("N", "Adult", "No sugar", { forecastUnitsPerStoreWeek: 12 }));
  assert.equal(f.basis, "forecast"); assert.equal(f.unitsPerStoreWeek, 12); assert.equal(f.valuePerStoreWeek, 48); assert.ok(f.ready);
  const s = forecastFor(ctx, newItem("N", "Adult", "No sugar", { proxyProductIds: ["an1", "an2"], proxyScale: 0.5 }));
  assert.equal(s.basis, "similar items"); assert.equal(s.unitsPerStoreWeek, 7.25); // mean(15,14) x 0.5
  const none = forecastFor(ctx, newItem("N", "Adult", "No sugar", {}));
  assert.equal(none.ready, false); assert.match(none.missing, /forecast or a similar item/);
});
test("price and cost default to the similar items' actuals", () => {
  const f = forecastFor(ctx, newItem("N", "Adult", "No sugar", { proxyProductIds: ["an1"], retailPrice: 0, unitCost: 0 }));
  assert.equal(f.price, 4); assert.equal(f.cost, 3);
});

console.log("rationalization");
const N1 = newItem("N1", "Adult", "No sugar", { forecastUnitsPerStoreWeek: 12 });
const cand = (r, item, pid) => r.items.find((i) => i.name === item).candidates.find((c) => c.planogramId === pid);
test("fits in free space where there is some; trades out the slowest item where there is none", () => {
  const c = buildContext(data([N1]), params());
  const r = recommend(c, [N1.id]);
  const a = cand(r, "N1", "A"), b = cand(r, "N1", "B");
  assert.equal(a.status, "recommended"); assert.equal(a.removes.length, 0); assert.equal(a.add.fixtureInstId, "a2");
  assert.equal(b.status, "recommended"); assert.deepEqual(b.removes.map((x) => x.name), ["KN1"]);
  assert.equal(a.netPerStoreWeek, 38.4);
  assert.equal(b.netPerStoreWeek, 21.6); // 48 x 0.8 - (24 x 0.7)
});
test("the value of a swap is network-wide: per-store net x stores on that planogram", () => {
  const r = recommend(buildContext(data([N1]), params()), [N1.id]);
  assert.equal(r.items[0].totalNetNetworkWeek, 60); // 38.4 x 1 + 21.6 x 1
});
test("changes are the real plan: applying them puts the item in and the slow one out", () => {
  const r = recommend(buildContext(data([N1]), params()), [N1.id]);
  const out = applyResetDraftChanges(pogB.sections, r.byPlanogram.B.changes);
  const ids = out[0].fixtures[0].placements.map((x) => x.productId);
  assert.ok(ids.includes(N1.id) && !ids.includes("kn1")); assert.equal(ids.length, 6);
  assert.deepEqual(r.byPlanogram.B.changes.map((c) => c.type), ["delete", "addProduct"]);
  assert.match(r.byPlanogram.B.changes[1].reason, /Forecast 12/);
});
test("a swap that loses money is not recommended, but a free-space add still is", () => {
  const weak = newItem("Weak", "Adult", "No sugar", { forecastUnitsPerStoreWeek: 1 });
  const r = recommend(buildContext(data([weak]), params()), [weak.id]);
  assert.equal(cand(r, "Weak", "B").status, "not_worth_it"); assert.match(cand(r, "Weak", "B").reason, /would lose/);
  assert.equal(cand(r, "Weak", "A").status, "recommended");
  assert.equal(r.byPlanogram.B, undefined, "nothing drafted for a planogram with no good swap");
});
test("protected items are never removed; the next slowest goes instead", () => {
  const r = recommend(buildContext(data([N1]), params()), [N1.id], { protect: new Set(["kn1"]) });
  assert.deepEqual(cand(r, "N1", "B").removes.map((x) => x.name), ["AS1"]);
});
test("excluded planograms are left out and drafted nothing", () => {
  const r = recommend(buildContext(data([N1]), params()), [N1.id], { exclude: new Set([`${N1.id}|B`]) });
  assert.equal(cand(r, "N1", "B").status, "excluded"); assert.equal(r.byPlanogram.B, undefined);
});
test("variety guard: the last item of a segment is never traded away for a different segment", () => {
  // KS1 is the only Kids item left once the rest are gone: build a planogram whose only Kids item is also the slowest
  const only = { ...pogB, id: "C", name: "Cereal 2FT", storeIds: ["s2"], sections: [{ id: "secC", name: "S1", width: 48, fixtures: [fx("c1", 10, ["kn1", "an1", "an2", "as1", "an3", "an4"])] }] };
  const d = data([N1]); d.planograms = [only];
  // everything else on that shelf sells well in s2, so KN1 (6 a week) would be the obvious one to drop
  d.performance = { ...perf };
  ["an3", "an4", "an1", "an2", "as1"].forEach((id) => { d.performance[id] = [...(perf[id] || []).filter((r) => r.storeId !== "s2"), ...Array.from({ length: 26 }, (_, i) => ({ weekEnding: addDaysISO(LATEST, -7 * (25 - i)), unitCost: 3, price: 4, units: 20, storeId: "s2" }))]; });
  const r = recommend(buildContext(d, params()), [N1.id]);
  const c = r.items[0].candidates[0];
  assert.ok(!c.removes.some((x) => x.name === "KN1"), "KN1 is the only Kids item, so it stays");
  assert.equal(c.removes.length === 0 || c.status !== "recommended" ? true : c.removes[0].name !== "KN1", true);
});
test("two new items compete for the same planogram: the second sees the first's changes", () => {
  const N2 = newItem("N2", "Adult", "No sugar", { forecastUnitsPerStoreWeek: 10 });
  const r = recommend(buildContext(data([N1, N2]), params()), [N1.id, N2.id]);
  const removed = r.byPlanogram.B.changes.filter((c) => c.type === "delete").map((c) => c.productName);
  assert.equal(new Set(removed).size, removed.length, "no item is removed twice");
  assert.ok(!removed.includes("N1"), "an item added in this plan is not removed by it");
  const out = applyResetDraftChanges(pogB.sections, r.byPlanogram.B.changes);
  assert.equal(out[0].fixtures[0].placements.length, 6, "the shelf still fits after both swaps");
});
test("a segment that is growing and under-spaced ranks its planograms higher", () => {
  const c = buildContext(data([N1]), params());
  const withBoost = cand(recommend(c, [N1.id]), "N1", "A");
  assert.ok(withBoost.score >= withBoost.netNetworkWeek, "Adult / No sugar is growing and earns more than its space");
  assert.equal(recommend(c, [N1.id]).items[0].segmentTrend.opportunity === "Add space" || recommend(c, [N1.id]).items[0].segmentTrend.trend === "Growing", true);
});
test("an item with no forecast and no similar item is reported, never guessed", () => {
  const blank = newItem("Blank", "Adult", "Sugar", {});
  const r = recommend(buildContext(data([blank]), params()), [blank.id]);
  assert.ok(r.items[0].candidates.every((c) => c.status === "not_ready"));
});
test("an item already on the planogram is not added twice", () => {
  const dup = { ...P.an1, id: "an1" };
  const r = recommend(buildContext(data(), params()), [dup.id]);
  assert.ok(r.items[0].candidates.every((c) => c.status === "already_carried"));
});
test("the metric can be margin or units instead of sales", () => {
  const cheap = newItem("Cheap", "Adult", "No sugar", { forecastUnitsPerStoreWeek: 12, retailPrice: 4, unitCost: 3.5 });
  const sales = recommend(buildContext(data([cheap]), params()), [cheap.id]).items[0].forecast.valuePerStoreWeek;
  const margin = recommend(buildContext(data([cheap]), params({ assumptions: { metric: "margin" } })), [cheap.id]).items[0].forecast.valuePerStoreWeek;
  assert.equal(sales, 48); assert.equal(margin, 6);
});
test("scope narrows which planograms are considered", () => {
  const west = buildContext(data([N1]), params({ scope: { type: "region", value: "West" } }));
  const r = recommend(west, [N1.id]);
  assert.deepEqual(r.items[0].candidates.map((c) => c.planogramId), ["B"]);
});

console.log("core assortment");
{
  // Large store s1 carries KS1, AN1... on pog A; Small store s2 carries fewer on pog B. KS2 is on A only.
  const cctx = buildContext(data(), params());
  const prof = coreProfile(cctx);
  const row = (id) => prof.rows.find((r) => r.productId === id);
  test("steady, frequent, high-selling items are core; slow ones are not", () => {
    assert.equal(row("ks2").cls, "core"); assert.equal(row("an1").cls, "core");
    assert.notEqual(row("ks3").cls, "core"); assert.notEqual(row("an4").cls, "core"); // 1-2 units a week
  });
  test("coverage and format breakdown show an item carried only in the large stores", () => {
    const r = row("ks2");
    assert.equal(r.stores, 1); assert.equal(r.storesInView, 2); assert.equal(r.coverage, 0.5);
    assert.deepEqual(r.byFormat.map((f) => [f.format, f.carried, f.of]), [["Large", 1, 1], ["Small", 0, 1]]);
    assert.deepEqual(r.missingPlanograms.map((m) => m.planogramId), ["B"]);
    assert.equal(row("an1").coverage, 1);
  });
  test("a core item below the coverage threshold is a gap; one in every store is not", () => {
    assert.equal(row("ks2").isGap, true); assert.equal(row("an1").isGap, false);
    assert.ok(prof.summary.gaps >= 1); assert.ok(prof.summary.coreShareOfSales > 0.5);
    assert.equal(coreProfile(buildContext(data(), params({ assumptions: { coreMinCoverage: 0.4 } }))).rows.find((r) => r.productId === "ks2").isGap, false);
  });
  test("a person can mark an item core or not core", () => {
    const p2 = coreProfile(cctx, { overrides: { ks3: "core", ks2: "notcore" } });
    assert.equal(p2.rows.find((r) => r.productId === "ks3").cls, "core"); assert.equal(p2.rows.find((r) => r.productId === "ks3").override, "core");
    assert.equal(p2.rows.find((r) => r.productId === "ks2").cls, "not");
  });
  test("an erratic seller fails the steadiness check even when it sells every week", () => {
    const wobbly = {}; Object.keys(perf).forEach((k) => { wobbly[k] = perf[k]; });
    wobbly.ks2 = perf.ks2.map((r, i) => ({ ...r, units: i % 2 ? 40 : 2 }));
    const c = buildContext({ ...data(), performance: wobbly }, params());
    const r = coreProfile(c).rows.find((x) => x.productId === "ks2");
    assert.equal(r.checks.frequency.ok, true); assert.equal(r.checks.steady.ok, false); assert.notEqual(r.cls, "core");
  });
  test("store productivity compares how strong two sets of stores are for the category", () => {
    const big = storeProductivity(cctx, ["s1"]), small = storeProductivity(cctx, ["s2"]);
    assert.ok(big > 0 && small > 0);
  });
  test("a core gap can be expanded: measured forecast, scaled to the stores, placed like a new item", () => {
    const fcs = coreForecasts(cctx, ["ks2"]);
    assert.equal(fcs.ks2.ready, true); assert.equal(fcs.ks2.basis, "measured where carried");
    const r = recommend(cctx, ["ks2"], { forecastOverrides: fcs, valueScale: coreValueScale(cctx), kind: "core" });
    const cand = r.items[0].candidates.find((c) => c.planogramId === "B");
    assert.ok(["recommended", "not_worth_it", "no_room"].includes(cand.status));
    assert.equal(r.items[0].candidates.find((c) => c.planogramId === "A").status, "already_carried");
    assert.ok(cand.scale > 0 && cand.scale <= 1.5);
    if (cand.status === "recommended") { const ch = r.byPlanogram.B.changes.find((c) => c.type === "addProduct"); assert.match(ch.reason, /^Core item expansion/); }
  });
  test("expansion value is lower where the stores sell less of the category", () => {
    const fcs = coreForecasts(cctx, ["ks2"]);
    const sc = coreValueScale(cctx)(cctx.productsById.ks2, pogB, ["s2"]);
    const expected = storeProductivity(cctx, ["s2"]) / storeProductivity(cctx, ["s1"]);
    assert.equal(sc, Math.min(1.5, Math.max(0.25, expected)));
  });
}

console.log("user-defined store and planogram attributes");
const attrStores = stores.map((st) => ({ ...st, attributes: { fs: st.id === "s1" ? "High" : "Low" } }));
const attrPogA = { ...pogA, attributes: { tier: "A" } }, attrPogB = { ...pogB, attributes: { tier: "B" } };
const attrData = (extra = []) => ({ ...data(extra), stores: attrStores, planograms: [attrPogA, attrPogB] });
test("a store attribute can be the scope", () => {
  const sc = resolveScope(attrStores, { type: "storeAttr", fieldId: "fs", fieldLabel: "Foot traffic", value: "High" });
  assert.deepEqual([...sc.storeIds], ["s1"]); assert.equal(sc.label, "Foot traffic: High"); assert.equal(sc.includeChain, false);
  assert.deepEqual(scopeOptions(attrStores, [{ id: "fs", label: "Foot traffic" }]).attrs.fs, ["High", "Low"]);
  const r = recommend(buildContext(attrData([N1]), params({ scope: { type: "storeAttr", fieldId: "fs", value: "Low" } })), [N1.id]);
  assert.deepEqual(r.items[0].candidates.map((c) => c.planogramId), ["B"]);
});
test("a planogram attribute filters which planograms are considered", () => {
  const r = recommend(buildContext(attrData([N1]), params({ planogramFilter: { fieldId: "tier", value: "A" } })), [N1.id]);
  assert.deepEqual(r.items[0].candidates.map((c) => c.planogramId), ["A"]);
});
test("slow movers can be compared across a store attribute", () => {
  const sm = slowMovers(buildContext(attrData(), params()), { groupBy: "storeAttr:fs" });
  assert.deepEqual(sm.groups.map((g) => g.label).sort(), ["High", "Low"]);
});

// ---- as-of date: the shelf as it will be on a date ----
test("planogramsAsOf picks the version standing on a date", () => {
  const fam = [
    { id: "m", status: "live", versionNumber: 1, eventDate: "" },
    { id: "v2", masterId: "m", status: "wip", versionNumber: 2, eventDate: "2027-03-01" },
    { id: "v3", masterId: "m", status: "wip", versionNumber: 3, eventDate: "2027-06-01" },
    { id: "v4", masterId: "m", status: "wip", versionNumber: 4, eventDate: "" },
    { id: "solo", status: "live", versionNumber: 1 },
  ];
  const ids = (d) => planogramsAsOf(fam, d).map((p) => p.id).sort();
  assert.deepEqual(ids("2027-01-01"), ["m", "solo"]);
  assert.deepEqual(ids("2027-03-01"), ["solo", "v2"]);
  assert.deepEqual(ids("2027-12-31"), ["solo", "v3"]); // a dated version wins; the undated WIP is not scheduled
  assert.equal(planogramsAsOf(fam, "2027-12-31")[0], fam[2]); // original objects, not copies
});

console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
