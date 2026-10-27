#!/usr/bin/env node
// draft-assortment: the real request handler against an in-memory Supabase stand-in. Run: node scripts/test-draft-assortment.mjs
import assert from "node:assert/strict";
import { handleDraftAssortment, validateParams } from "../supabase/functions/_shared/draft-assortment-handler.js";
import { addDaysISO, applyResetDraftChanges } from "../supabase/functions/_shared/app-core.js";
import { fingerprint } from "../supabase/functions/_shared/proposal-core.js";

function makeDb({ tables, tokens, failInsert = {} }) {
  class Query {
    constructor(t) { this.t = t; this.f = []; this.ins = null; }
    insert(rows) { this.ins = Array.isArray(rows) ? rows : [rows]; return this; }
    select() { return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
    range(a, b) { this.r = [a, b]; return this; }
    run() {
      if (this.ins) {
        if (failInsert[this.t]) return { data: null, error: { message: failInsert[this.t] } };
        const stored = this.ins.map((r) => ({ id: globalThis.crypto.randomUUID(), ...r }));
        (tables[this.t] ||= []).push(...stored);
        return { data: stored, error: null };
      }
      let rows = (tables[this.t] || []).filter((r) => this.f.every((f) => f(r)));
      if (this.r) rows = rows.slice(this.r[0], this.r[1] + 1);
      return { data: rows, error: null };
    }
    maybeSingle() { return Promise.resolve({ data: this.run().data[0] ?? null, error: null }); }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  }
  return { from: (t) => new Query(t), auth: { getUser: async (tok) => (tokens[tok] ? { data: { user: { id: tokens[tok] } }, error: null } : { data: { user: null }, error: { message: "bad" } }) } };
}

const schema = [{ id: "f_cat", label: "Category" }, { id: "f_age", label: "Age" }, { id: "f_sug", label: "Sugar" }];
const prod = (name, age, sugar, extra = {}) => ({ id: name.toLowerCase(), name, dims: { w: 8, h: 10, d: 6 }, attributes: { f_cat: "Cereal", f_age: age, f_sug: sugar }, ...extra });
const shelfDef = { id: "shelf", type: "Shelf", name: "Shelf", dims: { w: 48, h: 2, d: 20 } };
let n = 0;
const pl = (id) => ({ id: `pl${++n}`, productId: id, facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" });
const fx = (id, y, ids) => ({ id, fixtureId: "shelf", notchY: y, xOffset: 0, placements: ids.map(pl) });
const pogA = { id: "A", name: "Cereal 8FT", category: "Cereal", status: "live", dims: { w: 48, h: 72, d: 20 }, base: 0, storeIds: ["s1"], sections: [{ id: "secA", name: "S1", width: 48, fixtures: [fx("a1", 10, ["ks1", "ks2", "an1", "an2", "as1", "kn1"]), fx("a2", 40, ["an3", "ks4"])] }] };
const pogB = { id: "B", name: "Cereal 4FT", category: "Cereal", status: "live", dims: { w: 48, h: 72, d: 20 }, base: 0, storeIds: ["s2"], sections: [{ id: "secB", name: "S1", width: 48, fixtures: [fx("b1", 10, ["ks1", "an1", "an2", "as1", "kn1", "ks5"])] }] };
const UNITS = { ks1: [20, 14], ks2: [18, 12], ks4: [16, 11], ks5: [15, 10], kn1: [6, 6], an1: [10, 15], an2: [9, 14], an3: [8, 13], as1: [8, 8] };
const LATEST = "2026-10-17";
const records = (id) => {
  const out = [];
  [[pogA, "s1"], [pogB, "s2"]].forEach(([pg, sid]) => {
    if (!pg.sections[0].fixtures.some((f) => f.placements.some((p) => p.productId === id))) return;
    for (let i = 0; i < 26; i++) out.push({ weekEnding: addDaysISO(LATEST, -7 * (25 - i)), unitCost: 3, price: 4, units: i < 13 ? UNITS[id][0] : UNITS[id][1], storeId: sid });
  });
  return out;
};
const people = ["KS1", "KS2", "KS4", "KS5", "KN1", "AN1", "AN2", "AN3", "AS1"].map((nm) => prod(nm, nm[0] === "K" ? "Kids" : "Adult", nm.endsWith("N1") || nm === "AN2" || nm === "AN3" ? "No sugar" : "Sugar"));
const N1 = prod("N1", "Adult", "No sugar", { newItem: { source: "category_manager", retailPrice: 4, unitCost: 3, forecastUnitsPerStoreWeek: 12 } });
const NOFC = prod("NoFC", "Adult", "Sugar", { newItem: { source: "category_manager" } });
const tables = () => ({
  profiles: [{ id: "u-cm", role: "category_manager" }, { id: "u-admin", role: "admin" }, { id: "u-store", role: "store_associate" }],
  agents: [{ id: "assortment-agent", enabled: true, allowed_target_types: ["planogram_version"] }],
  planograms: [pogA, pogB].map((d) => ({ id: d.id, data: d })),
  products: [...people, N1, NOFC].map((d) => ({ id: d.id, data: d })),
  fixtures: [{ id: "shelf", data: shelfDef }],
  performance: Object.keys(UNITS).map((id) => ({ id, data: { id, records: records(id) } })),
  stores: [{ id: "s1", data: { id: "s1", name: "East 1", region: "East" } }, { id: "s2", data: { id: "s2", name: "West 1", region: "West" } }],
  app_settings: [{ key: "schema:product", value: JSON.stringify(schema) }],
});
const tokens = { "tok-cm": "u-cm", "tok-admin": "u-admin", "tok-store": "u-store" };
const fresh = (o = {}) => { const t = tables(); return Object.assign(makeDb({ tables: t, tokens, ...o }), { t }); };
const params = { category: "Cereal", scope: { type: "all" }, weeks: 13, compare: "prior", segmentFieldIds: ["f_age", "f_sug"] };
const call = (db, { method = "POST", token = "tok-cm", body = { newItemIds: ["n1"], params } } = {}) =>
  handleDraftAssortment(new Request("http://local/x", { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined }), db);

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { console.error("FAIL " + name + "\n" + e.stack); process.exitCode = 1; } };

console.log("draft-assortment handler");
await test("preflight, wrong method, no token, store associate", async () => {
  assert.equal((await call(fresh(), { method: "OPTIONS" })).status, 200);
  assert.equal((await call(fresh(), { method: "GET" })).status, 405);
  assert.equal((await call(fresh(), { token: null })).status, 401);
  assert.equal((await call(fresh(), { token: "tok-store" })).status, 403);
});
await test("a disabled or missing agent is refused with a schema hint", async () => {
  const db = fresh(); db.t.agents = [];
  const res = await call(db); assert.equal(res.status, 403); assert.match((await res.json()).error, /schema\.sql/);
});
await test("input validation", async () => {
  for (const body of ["nope", { newItemIds: [], params }, { newItemIds: 5, params }, { newItemIds: ["n1"], params: { ...params, category: "" } }, { newItemIds: ["n1"], params: { ...params, weeks: 0 } },
    { newItemIds: ["n1"], params: { ...params, scope: { type: "galaxy" } } }, { newItemIds: ["n1"], params: { ...params, scope: { type: "region" } } },
    { newItemIds: ["n1"], params: { ...params, assumptions: { metric: "vibes" } } }, { newItemIds: ["n1"], params: { ...params, assumptions: { cannibalization: 3 } } },
    { newItemIds: ["n1"], params, exclude: "x" }, { newItemIds: ["ghost"], params }, { newItemIds: ["ks1"], params }]) {
    assert.equal((await call(fresh(), { body })).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.ok(validateParams({ params }).params);
});
await test("records one pending proposal per planogram, attributed to the assortment agent and the person", async () => {
  const db = fresh();
  const res = await call(db); assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.proposals.map((p) => p.planogramId).sort(), ["A", "B"]);
  const rows = db.t.proposals;
  assert.equal(rows.length, 2);
  rows.forEach((r) => { assert.equal(r.agent_id, "assortment-agent"); assert.equal(r.target_type, "planogram_version"); assert.equal(r.status, "pending"); assert.equal(r.requested_by, "u-cm"); });
  assert.equal(db.t.activity_log.length, 2); assert.equal(db.t.activity_log[0].actor_id, "assortment-agent");
});
await test("the stored change list is the engine's plan, applies cleanly and carries a source fingerprint", async () => {
  const db = fresh(); await call(db);
  const b = db.t.proposals.find((r) => r.target_id === "B");
  const ch = b.proposed_change.changes;
  assert.deepEqual(ch.map((c) => c.type), ["delete", "addProduct"]);
  assert.equal(ch[0].productName, "KN1"); assert.equal(ch[1].productName, "N1");
  const out = applyResetDraftChanges(pogB.sections, ch);
  const ids = out[0].fixtures[0].placements.map((x) => x.productId);
  assert.ok(ids.includes("n1") && !ids.includes("kn1"));
  assert.equal(b.proposed_change.sourceFingerprint, await fingerprint(pogB.sections));
  assert.equal(b.proposed_change.assortment.scope, "All stores");
  assert.match(b.reason, /1 item added, 1 removed/);
  const a = db.t.proposals.find((r) => r.target_id === "A");
  assert.deepEqual(a.proposed_change.changes.map((c) => c.type), ["addProduct"]); // free space: nothing removed
});
await test("excluded planograms get no proposal; protected items are not removed", async () => {
  const db = fresh();
  const res = await call(db, { body: { newItemIds: ["n1"], params, exclude: ["n1|A"], protect: ["kn1"] } });
  const body = await res.json();
  assert.deepEqual(body.proposals.map((p) => p.planogramId), ["B"]);
  assert.equal(db.t.proposals[0].proposed_change.changes[0].productName, "AS1");
});
await test("an item with no forecast is never drafted; nothing is recorded", async () => {
  const db = fresh();
  const res = await call(db, { body: { newItemIds: ["nofc"], params } });
  assert.equal(res.status, 200); assert.equal((await res.json()).proposals.length, 0); assert.equal(db.t.proposals, undefined);
});
await test("if the proposal can't be saved the caller is told, with a schema hint", async () => {
  const res = await call(fresh({ failInsert: { proposals: "relation \"proposals\" does not exist" } }));
  const body = await res.json();
  assert.equal(body.proposals.length, 0);
  assert.ok(body.notDrafted.every((x) => /schema\.sql/.test(x.reason)));
});
await test("core mode: only core items with gaps are drafted, with a core-item reason", async () => {
  const db = fresh();
  const probe = await call(db, { body: { mode: "core", newItemIds: ["ks1"], params, coreOverrides: { ks1: "notcore" } } });
  assert.equal(probe.status, 400); assert.match((await probe.json()).error, /Not a core item with gaps/);
  const { buildContext, coreProfile } = await import("../supabase/functions/_shared/assortment.js");
  const data = { products: db.t.products.map((r) => r.data), planograms: [pogA, pogB], fixtures: [shelfDef], stores: db.t.stores.map((r) => r.data), productSchema: schema, performance: Object.fromEntries(db.t.performance.map((r) => [r.id, r.data.records])) };
  const gaps = coreProfile(buildContext(data, { ...params, assumptions: { coreMinCoverage: 1 } })).rows.filter((r) => r.isGap).map((r) => r.productId);
  assert.ok(gaps.length > 0, "fixture has a core gap at 100% coverage");
  const ok = await call(db, { body: { mode: "core", newItemIds: [gaps[0]], params: { ...params, assumptions: { coreMinCoverage: 1 } } } });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.ok(body.proposals.length >= 1, JSON.stringify(body)); assert.match(JSON.stringify(db.t.proposals[0]), /Core item/);
  assert.equal((await call(fresh(), { body: { mode: "core", newItemIds: ["n1"], params } })).status, 400, "a new item is not a core item");
  assert.equal((await call(fresh(), { body: { mode: "core", newItemIds: ["ks1"], params, coreOverrides: { ks1: "maybe" } } })).status, 400);
  assert.equal((await call(fresh(), { body: { mode: "weird", newItemIds: ["ks1"], params } })).status, 400);
  assert.equal((await call(fresh(), { body: { newItemIds: ["n1"], params: { ...params, assumptions: { coreMaxCv: -1 } } } })).status, 400);
});
await test("the proposal carries what it is expected to add, so a plan can quote it", async () => {
  const db = fresh();
  await call(db);
  const impact = db.t.proposals[0].proposed_change.assortment.impact;
  assert.equal(impact.metric, "sales");
  assert.ok(impact.netNetworkWeek > 0, "positive weekly impact");
  assert.equal(impact.items[0].name, "N1"); assert.ok(impact.items[0].stores >= 1); assert.equal(impact.items[0].basis != null, true);
  assert.equal(db.t.proposals[0].proposed_change.assortment.kind, "new");
  assert.ok(impact.items[0].gainNetworkWeek > 0 && impact.items[0].lossNetworkWeek >= 0); assert.ok(Math.abs(impact.items[0].gainNetworkWeek - impact.items[0].lossNetworkWeek - impact.items[0].netNetworkWeek) < 0.05, "gain - loss = net");
});
console.log(`\n${passed} passed`);
