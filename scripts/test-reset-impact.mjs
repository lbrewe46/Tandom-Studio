#!/usr/bin/env node
// Reset Impact: windows, control adjustment, status handling and rollups on a hand-built case with
// known answers. Run: node scripts/test-reset-impact.mjs
import assert from "node:assert/strict";
import { computeResetImpact, getBaselinePlanogram, measureWindows } from "../supabase/functions/_shared/reset-impact.js";
import { rollupResetImpact } from "../supabase/functions/_shared/app-core.js";
import { handleResetImpact } from "../supabase/functions/_shared/reset-impact-handler.js";

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const GOLIVE = "2026-03-07"; // a Saturday
const weeks = Array.from({ length: 18 }, (_, i) => addDays("2026-01-03", 7 * i)); // 01-03 .. 05-02
const LATEST = weeks[weeks.length - 1];

const products = [
  { id: "cola", name: "Cola", dims: { w: 3, h: 6, d: 3 } },
  { id: "diet", name: "Diet", dims: { w: 3, h: 6, d: 3 } },
  { id: "root", name: "Root Beer", dims: { w: 3, h: 6, d: 3 } },
];
const pl = (productId, facings) => ({ id: `${productId}${facings}`, productId, facings });
const sec = (placements) => [{ id: "s", fixtures: [{ id: "f", fixtureId: "fx", placements }] }];
const stores = [
  { id: "s1", name: "East 1", storeNumber: "1", region: "East", format: "Large" },
  { id: "s2", name: "West 1", storeNumber: "2", region: "West", format: "Large" },
  { id: "s3", name: "East 2", storeNumber: "3", region: "East", format: "Small" },
  { id: "s4", name: "West 2", storeNumber: "4", region: "West", format: "Small" },
  { id: "c1", name: "Control 1" }, { id: "c2", name: "Control 2" },
];
const planograms = [
  { id: "v1", name: "Soda v1", category: "Soda", department: "Grocery", status: "historical", versionNumber: 1, masterId: "v1", storeIds: ["s1", "s2", "s3", "s4"], sections: sec([pl("cola", 3), pl("diet", 2)]) },
  {
    id: "v2", name: "Soda v2", category: "Soda", department: "Grocery", cluster: "Urban", status: "live", versionNumber: 2, masterId: "v1", eventDate: GOLIVE,
    storeIds: ["s1", "s2", "s3", "s4"], sections: sec([pl("cola", 4), pl("root", 1)]),
    execution: {
      s1: { status: "completed", completedAt: `${GOLIVE}T10:00:00Z` }, s2: { status: "completed", completedAt: `${GOLIVE}T11:00:00Z` },
      s3: { status: "completed", completedAt: "2026-04-25T09:00:00Z" }, s4: { status: "in_progress" },
    },
  },
];

// weekly units on cola @ $2 (cost $1); `pre`/`post` split at go-live (data weeks ending <= GOLIVE are "pre")
const perf = { cola: [], diet: [], root: [] };
const feed = (sid, pre, post) => weeks.forEach((we) => perf.cola.push({ weekEnding: we, storeId: sid, units: we <= GOLIVE ? pre : post, price: 2, unitCost: 1 }));
feed("s1", 100, 130); // +30%
feed("s2", 100, 100); // flat
feed("s3", 100, 150); // maturing (only 1 post week since its own go-live)
feed("s4", 100, 100);
feed("c1", 100, 110); // control: +10%
feed("c2", 100, 110);

const run = (pg, extra = {}) => computeResetImpact({ planogram: pg, allPlanograms: planograms, products, performance: perf, stores, latestISO: LATEST, ...extra });
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

assert.equal(getBaselinePlanogram(planograms[1], planograms).id, "v1"); ok("baseline = the Historical version");
assert.equal(getBaselinePlanogram(planograms[0], planograms), null); ok("first version has no baseline");

const r = run(planograms[1]);
assert.equal(r.status, "ok"); assert.equal(r.goLiveDate, GOLIVE); assert.equal(r.baselinePlanogramId, "v1"); ok("measurable live version with baseline");
const row = (id) => r.rows.find((x) => x.storeId === id);
assert.equal(row("s1").status, "measured"); assert.equal(row("s2").status, "measured");
assert.equal(row("s3").status, "maturing"); assert.equal(row("s4").status, "not_executed"); ok("store statuses: measured / maturing / not executed");
near(row("s1").pre.sales, 200, "s1 pre sales/wk"); near(row("s1").post.sales, 260, "s1 post sales/wk");
near(row("s1").pre.units, 100, "units"); near(row("s1").post.margin, 130, "s1 post margin/wk"); ok("weekly averages: sales, units, margin");
assert.equal(row("s1").preWeeks ?? 8, 8); assert.equal(row("s1").postWeeks, 8); ok("8 post weeks of data counted");
assert.equal(r.control.stores, 2); near(r.control.change.sales, 0.1, "control change"); ok("control = 2 stores that did not reset, +10%");
near(r.space.preLinearFt, 15 / 12, "baseline linear feet"); near(r.space.postLinearFt, 15 / 12, "new linear feet"); ok("space from both versions");
near(r.summary.metrics.sales.pre, 400, "total pre"); near(r.summary.metrics.sales.post, 460, "total post");
near(r.summary.metrics.sales.changePct, 15, "raw change %"); near(r.summary.metrics.sales.liftPp, 5, "lift over control (pp)"); ok("planogram total: +15% raw, +5 pp over control");
assert.equal(r.counts.measured, 2); assert.equal(r.counts.maturing, 1); ok("maturing store excluded from totals but counted");

// rollups
const byRegion = rollupResetImpact([r], "region");
const east = byRegion.groups.find((g) => g.label === "East"), west = byRegion.groups.find((g) => g.label === "West");
near(east.metrics.sales.changePct, 30, "east raw"); near(east.metrics.sales.liftPp, 20, "east lift");
near(west.metrics.sales.changePct, 0, "west raw"); near(west.metrics.sales.liftPp, -10, "west lift"); ok("by Region: East +30% (+20 pp), West flat (-10 pp)");
assert.equal(byRegion.maturing, 1); ok("rollup reports maturing stores separately");
assert.equal(rollupResetImpact([r], "store").groups.length, 2); ok("by Store: one group per measured store");
assert.equal(rollupResetImpact([r], "category").groups[0].label, "Soda"); assert.equal(rollupResetImpact([r], "department").groups[0].label, "Grocery"); assert.equal(rollupResetImpact([r], "cluster").groups[0].label, "Urban"); ok("by Category / Department / Cluster");
assert.equal(rollupResetImpact([r], "format").groups[0].label, "Large"); ok("by Store format");
near(byRegion.total.metrics.sales.post, 460, "grand total"); ok("grand total row");
near(byRegion.total.salesPerLinearFt.pre, 400 / (2 * 15 / 12), "sales per linear ft pre"); ok("sales per linear foot");
// two planograms in one rollup keep their own control trend
{
  const r2 = { ...r, planogramId: "other", planogram: { ...r.planogram, name: "Other", category: "Chips" }, control: { stores: 1, change: { sales: 0.3, units: 0.3, margin: 0.3 } } };
  const mix = rollupResetImpact([r, r2], "category");
  // Chips rows: pre 400, post 460, its control says +30% => expected 520 => lift (460-520)/400 = -15 pp
  near(mix.groups.find((g) => g.label === "Chips").metrics.sales.liftPp, -15, "second planogram's own control trend");
  near(mix.groups.find((g) => g.label === "Soda").metrics.sales.liftPp, 5, "first planogram keeps its own");
}
ok("each planogram is adjusted by its own control trend");

// no control stores -> raw only
{
  const p2 = { ...perf, cola: perf.cola.filter((x) => !x.storeId.startsWith("c")) };
  const r3 = computeResetImpact({ planogram: planograms[1], allPlanograms: planograms, products, performance: p2, stores, latestISO: LATEST });
  assert.equal(r3.control.stores, 0); assert.equal(r3.summary.metrics.sales.liftPp, null); near(r3.summary.metrics.sales.changePct, 15, "raw still shown"); ok("no comparison stores: lift is null, raw change still reported");
}
// other reset in same category around same time excludes its stores from control
{
  const others = [...planograms, { id: "z", name: "Soda other", category: "Soda", status: "live", eventDate: addDays(GOLIVE, 14), storeIds: ["c1"], sections: [] }];
  const r4 = computeResetImpact({ planogram: planograms[1], allPlanograms: others, products, performance: perf, stores, latestISO: LATEST });
  assert.equal(r4.control.stores, 1); ok("stores reset by another same-category planogram are not used as control");
}
// not live / no data
assert.equal(run(planograms[0]).status, "not_live"); ok("only Live versions are measured");
assert.equal(computeResetImpact({ planogram: planograms[1], allPlanograms: planograms, products, performance: {}, stores, latestISO: null }).status, "no_data"); ok("no performance data -> no_data");
// windows helper: a go-live in mid-week leaves the week that straddles it out of both sides
{
  const w = new Map([["2026-02-28", { sales: 80, units: 40, margin: 40 }], ["2026-03-07", { sales: 999, units: 1, margin: 1 }], ["2026-03-14", { sales: 100, units: 50, margin: 50 }]]);
  const m = measureWindows(w, "2026-03-04", "2026-03-14", { preWeeks: 8, postWeeks: 8 });
  near(m.pre.sales, 10, "pre avg over 8 calendar weeks"); assert.equal(m.postWeeks, 1); near(m.post.sales, 100, "post");
  ok("window edges: the week straddling a mid-week go-live is ignored");
}
// --- handler ---
{
  class Q {
    constructor(db, t) { this.db = db; this.t = t; this.f = []; this.rangeArg = null; this.ins = null; this.ups = null; }
    insert(r) { this.ins = Array.isArray(r) ? r : [r]; return this; }
    upsert(r, o) { this.ups = { rows: Array.isArray(r) ? r : [r], key: o.onConflict }; return this; }
    select() { return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    range(a, b) { this.rangeArg = [a, b]; return this; }
    run() {
      const rows = (this.db.tables[this.t] ||= []);
      if (this.ins) { rows.push(...this.ins); return { data: this.ins, error: null }; }
      if (this.ups) { this.ups.rows.forEach((r) => { const i = rows.findIndex((x) => x[this.ups.key] === r[this.ups.key]); if (i >= 0) rows[i] = r; else rows.push(r); }); return { data: null, error: null }; }
      const hit = rows.filter((r) => this.f.every((f) => f(r)));
      return { data: this.rangeArg ? hit.slice(this.rangeArg[0], this.rangeArg[1] + 1) : hit, error: null };
    }
    maybeSingle() { return Promise.resolve({ data: this.run().data[0] ?? null, error: null }); }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  }
  const makeDb = (tables) => ({ tables, from(t) { return new Q(this, t); }, auth: { getUser: async (tok) => (tok === "cmTok" ? { data: { user: { id: "cm" } }, error: null } : tok === "saTok" ? { data: { user: { id: "sa" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) } });
  const tables = () => ({
    profiles: [{ id: "cm", role: "category_manager" }, { id: "sa", role: "store_associate" }],
    agents: [{ id: "reset-impact-agent", enabled: true }],
    planograms: planograms.map((p) => ({ id: p.id, data: { ...p, id: undefined, ...(p.id === "v2" ? { resetDraft: { proposalId: "11111111-1111-1111-1111-111111111111" } } : {}) } })),
    products: products.map((x) => ({ id: x.id, data: x })),
    performance: Object.entries(perf).map(([id, records]) => ({ id, data: { records } })),
    stores: stores.map((x) => ({ id: x.id, data: x })),
    reset_impacts: [], activity_log: [],
  });
  const call = async (tok, body, t = tables()) => {
    const res = await handleResetImpact(new Request("https://x/i", { method: "POST", headers: { Authorization: tok ? `Bearer ${tok}` : "" }, body: JSON.stringify(body) }), makeDb(t));
    return { res, json: await res.json(), t };
  };
  assert.equal((await call("", { all: true })).res.status, 401); assert.equal((await call("saTok", { all: true })).res.status, 403); ok("handler: 401 without a session, 403 for store associates");
  assert.equal((await call("cmTok", {})).res.status, 400); assert.equal((await call("cmTok", { all: true, postWeeks: 1 })).res.status, 400); ok("handler: bad input -> 400");
  const { json, t } = await call("cmTok", { all: true });
  assert.equal(json.results.length, 1); assert.equal(json.results[0].planogramId, "v2"); ok("all: = Live versions that have a Historical baseline");
  assert.equal(t.reset_impacts.length, 1); assert.equal(t.reset_impacts[0].proposal_id, "11111111-1111-1111-1111-111111111111"); assert.equal(t.reset_impacts[0].baseline_planogram_id, "v1"); ok("saved with its baseline and the AI proposal it came from");
  near(t.reset_impacts[0].result.summary.metrics.sales.liftPp, 5, "saved lift"); assert.equal(t.activity_log[0].action, "impact_measured"); ok("result saved in full and logged to the activity view");
  await call("cmTok", { planogramIds: ["v2"] }, t); assert.equal(t.reset_impacts.length, 1); ok("re-measuring replaces the row");
  const miss = await call("cmTok", { planogramIds: ["nope"] }); assert.equal(miss.json.results[0].ok, false); ok("unknown planogram reported, not thrown");
  const notLive = await call("cmTok", { planogramIds: ["v1"] }); assert.equal(notLive.json.results[0].status, "not_live"); assert.equal(notLive.t.reset_impacts.length, 0); ok("a non-Live version is reported and not saved");
}

{ // summaries can group by a store or planogram attribute the user defined
  const row = (sid, pre, post) => ({ status: "measured", storeId: sid, storeName: sid, region: "E", format: "F", pre: { sales: pre, units: 1, margin: 1, weeks: 8 }, post: { sales: post, units: 1, margin: 1, weeks: 8 } });
  const imp = { status: "ok", planogramId: "g1", planogram: { name: "P", category: "C" }, rows: [row("s1", 10, 20), row("s2", 10, 15)] };
  const byStore = rollupResetImpact([imp], "sattr:fs", { stores: [{ id: "s1", attributes: { fs: "High" } }, { id: "s2" }], planograms: [], fields: { "sattr:fs": "Foot traffic" } });
  assert.deepEqual(byStore.groups.map((g) => g.label).sort(), ["(No Foot traffic)", "High"]); ok("groups by a store attribute, blanks labelled");
  const byPog = rollupResetImpact([imp], "pattr:t", { stores: [], planograms: [{ id: "g1", attributes: { t: "A" } }], fields: {} });
  assert.deepEqual(byPog.groups.map((g) => g.label), ["A"]); ok("groups by a planogram attribute");
}
console.log(`\n${n} passed`);
