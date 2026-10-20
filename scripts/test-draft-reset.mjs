#!/usr/bin/env node
// Exercises the real draft-reset request handler (same code the Edge Function runs) against an
// in-memory stand-in for the Supabase client. Run: node scripts/test-draft-reset.mjs
//
// What this proves: auth/role/agent gating, input validation, PostgREST page-limit handling,
// settings parsing, store scoping, per-planogram error isolation, and the agent's actual output
// on a hand-built planogram whose correct answer is known in advance.
// What it does NOT prove: that Supabase's own JWT verification and RLS behave — that needs a
// deployed project (see supabase/functions/README.md for the smoke test).

import assert from "node:assert/strict";
import { handleDraftReset, MAX_PLANOGRAMS_PER_CALL } from "../supabase/functions/_shared/draft-reset-handler.js";

// ---------------------------------------------------------------------------------------
// A minimal PostgREST-shaped fake: from(t).select().eq().in().range() / .maybeSingle(), plus
// from(t).insert(rows).select(cols). `failInsert` / `throwInsert` map a table name to an error
// message to simulate a rejected (or thrown) insert.
// ---------------------------------------------------------------------------------------
function makeDb({ tables, tokens, pageLimit = 1000, failInsert = {}, throwInsert = {} }) {
  const calls = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.rangeArg = null; this.inserting = null; }
    insert(rows) { this.inserting = Array.isArray(rows) ? rows : [rows]; return this; }
    select() { return this; }
    eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
    in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
    range(a, b) { this.rangeArg = [a, b]; return this; }
    run() {
      if (this.inserting) {
        if (throwInsert[this.table]) throw new Error(throwInsert[this.table]);
        if (failInsert[this.table]) return { data: null, error: { message: failInsert[this.table] } };
        const stored = this.inserting.map((r) => ({ id: globalThis.crypto.randomUUID(), created_at: "now", ...r }));
        (tables[this.table] ||= []).push(...stored);
        return { data: stored, error: null };
      }
      calls.push({ table: this.table, range: this.rangeArg });
      let rows = (tables[this.table] || []).filter((r) => this.filters.every((f) => f(r)));
      if (this.rangeArg) rows = rows.slice(this.rangeArg[0], Math.min(this.rangeArg[1] + 1, this.rangeArg[0] + pageLimit));
      calls[calls.length - 1].ids = rows.map((r) => r.id ?? r.key);
      return { data: rows, error: null };
    }
    maybeSingle() { return Promise.resolve({ data: this.run().data[0] ?? null, error: null }); }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
  }
  return {
    calls,
    from: (t) => new Query(t),
    auth: { getUser: async (token) => (tokens[token] ? { data: { user: { id: tokens[token] } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } }) },
  };
}

// ---------------------------------------------------------------------------------------
// Hand-built scenario. Fixture is 48in wide; every product is 4in wide. Eight weeks of data.
//   A dead (0 units)            -> delete
//   B weak, 3 facings           -> reduce to 2          (Sales/Space Index ~6, below 70)
//   C strong, 1 facing          -> increase to 2        (index ~700, above 130, room available)
//   D Core/Must-Carry, 0 units  -> skipped, NOT deleted
//   E middling                  -> untouched            (index ~88)
//   M not placed, same category -> added (missing winner)
//   N not placed, other category-> not added
// ---------------------------------------------------------------------------------------
const SCHEMA = [{ id: "fcat", label: "Category", type: "text" }];
const prod = (id, name, cat, extra = {}) => ({ id, name, dims: { w: 4, h: 6, d: 3 }, attributes: { fcat: cat }, ...extra });
const weeks = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 7, 2 + i * 7)).toISOString().slice(0, 10));
const rec = (units, storeId = "s1") => weeks.map((weekEnding) => ({ weekEnding, units, price: 1, unitCost: 0.5, storeId }));
const pl = (id, productId, facings) => ({ id, productId, facings, orientation: "front", rotation: 0, merchStyle: "unit" });

const planogram = {
  id: "pog1", name: "Snacks main", category: "Snacks",
  sections: [{ id: "sec1", fixtures: [{ id: "fx1", fixtureId: "fdef", placements: [pl("pA", "A", 2), pl("pB", "B", 3), pl("pC", "C", 1), pl("pD", "D", 1), pl("pE", "E", 2)] }] }],
};

function baseTables() {
  return {
    profiles: [{ id: "u-cm", role: "category_manager" }, { id: "u-admin", role: "admin" }, { id: "u-store", role: "store_associate" }],
    agents: [{ id: "reset-drafting-agent", enabled: true, allowed_target_types: ["planogram_version"] }],
    planograms: [{ id: "pog1", data: planogram }, { id: "pogBroken", data: { id: "pogBroken", category: "Snacks", sections: "oops" } }],
    products: [
      prod("A", "Dead Item", "Snacks"), prod("B", "Weak Item", "Snacks"), prod("C", "Star Item", "Snacks"),
      prod("D", "Core Item", "Snacks", { resetProtected: true }), prod("E", "Middling Item", "Snacks"),
      prod("M", "Missing Winner", "Snacks"), prod("N", "Other Category Winner", "Beverages"),
    ].map((d) => ({ id: d.id, data: d })),
    fixtures: [{ id: "fdef", data: { id: "fdef", name: "48in shelf", dims: { w: 48 } } }],
    performance: [["A", 0], ["B", 1], ["C", 40], ["D", 0], ["E", 10], ["M", 30], ["N", 50]].map(([id, u]) => ({ id, data: { id, records: rec(u) } })),
    app_settings: [{ key: "schema:product", value: JSON.stringify(SCHEMA) }],
  };
}
const tokens = { "tok-cm": "u-cm", "tok-admin": "u-admin", "tok-store": "u-store" };

const call = (db, { method = "POST", token = "tok-cm", body } = {}) =>
  handleDraftReset(
    new Request("http://local/draft-reset", {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body ?? { planogramIds: ["pog1"], lookbackWeeks: 8 })) : undefined,
    }),
    db,
  );

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n${e.stack}`); process.exitCode = 1; }
};
const fresh = (opts = {}) => makeDb({ tables: baseTables(), tokens, ...opts });

console.log("draft-reset handler");

await test("OPTIONS preflight answers with CORS headers", async () => {
  const res = await call(fresh(), { method: "OPTIONS" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /authorization/);
});
await test("GET is rejected", async () => assert.equal((await call(fresh(), { method: "GET" })).status, 405));
await test("no Authorization header -> 401", async () => assert.equal((await call(fresh(), { token: null })).status, 401));
await test("unknown token -> 401", async () => assert.equal((await call(fresh(), { token: "nope" })).status, 401));
await test("store_associate -> 403", async () => assert.equal((await call(fresh(), { token: "tok-store" })).status, 403));
await test("signed-in user with no profile row -> 403", async () => {
  const db = fresh(); db.auth.getUser = async () => ({ data: { user: { id: "ghost" } }, error: null });
  assert.equal((await call(db)).status, 403);
});
await test("admin is allowed", async () => assert.equal((await call(fresh(), { token: "tok-admin" })).status, 200));
await test("disabled agent -> 403, re-enabled -> 200", async () => {
  const t = baseTables(); t.agents[0].enabled = false;
  assert.equal((await call(makeDb({ tables: t, tokens }))).status, 403);
  t.agents[0].enabled = true;
  assert.equal((await call(makeDb({ tables: t, tokens }))).status, 200);
});
await test("agent missing from registry, or without planogram_version target -> 403", async () => {
  const t = baseTables(); t.agents = [];
  assert.equal((await call(makeDb({ tables: t, tokens }))).status, 403);
  t.agents = [{ id: "reset-drafting-agent", enabled: true, allowed_target_types: ["task"] }];
  assert.equal((await call(makeDb({ tables: t, tokens }))).status, 403);
});

await test("bad input -> 400", async () => {
  const bad = [
    "not json", {}, { planogramIds: [] }, { planogramIds: [1] }, { planogramIds: [""] },
    { planogramIds: Array.from({ length: MAX_PLANOGRAMS_PER_CALL + 1 }, (_, i) => `p${i}`) },
    { planogramIds: ["pog1"], lookbackWeeks: 0 }, { planogramIds: ["pog1"], lookbackWeeks: 1.5 },
    { planogramIds: ["pog1"], lookbackWeeks: 157 }, { planogramIds: ["pog1"], lookbackWeeks: "13" },
  ];
  for (const body of bad) assert.equal((await call(fresh(), { body })).status, 400, JSON.stringify(body));
});
await test("planogramId shorthand and default lookback (13) work", async () => {
  const res = await call(fresh(), { body: { planogramId: "pog1" } });
  const { results } = await res.json();
  assert.equal(results[0].ok, true);
  assert.equal(results[0].result.lookbackWeeks, 13);
});

await test("known scenario: delete A, reduce B, increase C, add M, protect D", async () => {
  const { results } = await (await call(fresh())).json();
  const [r] = results;
  assert.equal(r.ok, true);
  const byType = (t) => r.result.changes.filter((c) => c.type === t);
  assert.deepEqual(byType("delete").map((c) => [c.productId, c.placementId]), [["A", "pA"]]);
  assert.deepEqual(byType("reduceFacings").map((c) => [c.productId, c.oldFacings, c.newFacings]), [["B", 3, 2]]);
  assert.deepEqual(byType("increaseFacings").map((c) => [c.productId, c.oldFacings, c.newFacings]), [["C", 1, 2]]);
  assert.deepEqual(byType("addProduct").map((c) => [c.productId, c.fixtureInstId]), [["M", "fx1"]]);
  assert.equal(r.result.changes.length, 4, "E (in range) and N (other category) must not appear");
  assert.deepEqual(r.result.skipped.map((s) => s.productId), ["D"]);
  assert.match(r.result.skipped[0].reason, /Core \/ Must-Carry/);
  assert.match(byType("addProduct")[0].reason, /chain-wide/);
  assert.equal(r.score, 80); // 4 changes / (4 changes + 1 skipped)
  assert.equal(r.result.endISO, weeks.at(-1));
});

await test("thresholds are read server-side, from either a JSON string or a real array", async () => {
  for (const value of [JSON.stringify([{ category: "Snacks", low: 5, high: 5000 }]), [{ category: "Snacks", low: 5, high: 5000 }]]) {
    const t = baseTables(); t.app_settings.push({ key: "schema:resetThresholds", value });
    const { results } = await (await call(makeDb({ tables: t, tokens }))).json();
    const types = results[0].result.changes.map((c) => c.type);
    assert.ok(!types.includes("reduceFacings"), "B's index (~6) is above the overridden low of 5");
    assert.ok(!types.includes("increaseFacings"), "C's index (~700) is below the overridden high of 5000");
  }
});
await test("storeId scopes the data (no records for s2 -> everything skipped as thin data)", async () => {
  const { results } = await (await call(fresh(), { body: { planogramIds: ["pog1"], lookbackWeeks: 8, storeId: "s2" } })).json();
  assert.equal(results[0].result.changes.length, 0);
  assert.equal(results[0].result.skipped.length, 5);
  assert.equal(results[0].score, 0);
});
await test("one unknown and one broken planogram do not sink the rest of the batch", async () => {
  const { results } = await (await call(fresh(), { body: { planogramIds: ["pog1", "missing", "pogBroken"], lookbackWeeks: 8 } })).json();
  assert.deepEqual(results.map((r) => [r.planogramId, r.ok]), [["pog1", true], ["missing", false], ["pogBroken", false]]);
  assert.equal(results[1].error, "Planogram not found");
  assert.match(results[2].error, /^Draft failed/);
});
await test("tables larger than one PostgREST page are read in full", async () => {
  const t = baseTables();
  for (let i = 0; i < 2300; i++) t.products.push({ id: `filler${i}`, data: prod(`filler${i}`, `Filler ${i}`, "Other") });
  const db = makeDb({ tables: t, tokens });
  const { results } = await (await call(db)).json();
  assert.equal(results[0].result.changes.length, 4);
  const productReads = db.calls.filter((c) => c.table === "products").length;
  assert.equal(productReads, 3, "2307 rows at 1000/page = 3 reads");
});
await test("only the requested planograms are read (not the whole table)", async () => {
  const db = fresh(); await call(db); // tables hold pog1 AND pogBroken; only pog1 was asked for
  assert.deepEqual(db.calls.filter((c) => c.table === "planograms").map((c) => c.ids), [["pog1"]]);
});

// ---------------------------------------------------------------------------------------
// Phase 3: Proposals + activity log
// ---------------------------------------------------------------------------------------
console.log("\nproposals and activity log");

await test("a successful draft is stored as a pending Proposal and returned with its id", async () => {
  const t = baseTables(); const db = makeDb({ tables: t, tokens });
  const { results } = await (await call(db)).json();
  const [r] = results;
  assert.equal(t.proposals.length, 1);
  const prop = t.proposals[0];
  assert.equal(r.proposalId, prop.id);
  assert.deepEqual(
    { agent_id: prop.agent_id, target_type: prop.target_type, target_id: prop.target_id, status: prop.status, score: prop.score, requested_by: prop.requested_by },
    { agent_id: "reset-drafting-agent", target_type: "planogram_version", target_id: "pog1", status: "pending", score: 80, requested_by: "u-cm" },
  );
  assert.deepEqual(prop.proposed_change, r.result, "the stored change set is exactly what the app is given");
  assert.match(prop.reason, /^4 changes proposed, 1 skipped from the last 8 weeks \(/);
});
await test("the agent's action is logged with the requester and a pointer to the Proposal", async () => {
  const t = baseTables(); const { results } = await (await call(makeDb({ tables: t, tokens }), { token: "tok-admin" })).json();
  assert.equal(t.activity_log.length, 1);
  const a = t.activity_log[0];
  assert.deepEqual([a.actor_type, a.actor_id, a.action, a.target_type, a.target_id], ["agent", "reset-drafting-agent", "proposal_created", "planogram_version", "pog1"]);
  assert.deepEqual(a.detail, { proposalId: results[0].proposalId, score: 80, changes: 4, skipped: 1, lookbackWeeks: 8, requestedBy: "u-admin" });
});
await test("only successful drafts get a Proposal; a batch records each one separately", async () => {
  const t = baseTables(); t.planograms.push({ id: "pog2", data: { ...planogram, id: "pog2", name: "Snacks endcap" } });
  const { results } = await (await call(makeDb({ tables: t, tokens }), { body: { planogramIds: ["pog1", "missing", "pog2", "pogBroken"], lookbackWeeks: 8 } })).json();
  assert.deepEqual(results.map((r) => [r.planogramId, r.ok, Boolean(r.proposalId)]), [["pog1", true, true], ["missing", false, false], ["pog2", true, true], ["pogBroken", false, false]]);
  assert.deepEqual(t.proposals.map((p) => p.target_id).sort(), ["pog1", "pog2"]);
  assert.equal(t.activity_log.length, 2);
  assert.notEqual(results[0].proposalId, results[2].proposalId);
});
await test("a repeated planogram id in one call yields one draft and one Proposal", async () => {
  const t = baseTables();
  const { results } = await (await call(makeDb({ tables: t, tokens }), { body: { planogramIds: ["pog1", "pog1"], lookbackWeeks: 8 } })).json();
  assert.equal(results.length, 1);
  assert.equal(t.proposals.length, 1);
});
await test("running the agent again adds a new Proposal rather than overwriting the old one", async () => {
  const t = baseTables(); const db = makeDb({ tables: t, tokens });
  await call(db); await call(db);
  assert.equal(t.proposals.length, 2);
  assert.notEqual(t.proposals[0].id, t.proposals[1].id);
});
await test("if the Proposal can't be saved the draft is reported as failed, with a schema hint and nothing leaked", async () => {
  for (const opts of [{ failInsert: { proposals: 'relation "public.proposals" does not exist' } }, { throwInsert: { proposals: "socket hang up" } }]) {
    const t = baseTables(); const res = await call(makeDb({ tables: t, tokens, ...opts }));
    assert.equal(res.status, 200);
    const [r] = (await res.json()).results;
    assert.equal(r.ok, false);
    assert.match(r.error, /Couldn't record the proposal/);
    assert.match(r.error, /schema\.sql/);
    assert.equal(r.result, undefined); assert.equal(r.score, undefined); assert.equal(r.proposalId, undefined);
    assert.equal((t.activity_log || []).length, 0, "no activity row for something that wasn't recorded");
  }
});
await test("a failed activity write doesn't lose the draft (the Proposal is the record)", async () => {
  for (const opts of [{ failInsert: { activity_log: "boom" } }, { throwInsert: { activity_log: "boom" } }]) {
    const t = baseTables(); const res = await call(makeDb({ tables: t, tokens, ...opts }));
    const [r] = (await res.json()).results;
    assert.equal(res.status, 200); assert.equal(r.ok, true); assert.ok(r.proposalId);
    assert.equal(t.proposals.length, 1);
  }
});
await test("rejected callers and bad input write nothing", async () => {
  const t = baseTables(); const db = makeDb({ tables: t, tokens });
  await call(db, { token: null }); await call(db, { token: "tok-store" }); await call(db, { body: { planogramIds: [] } }); await call(db, { method: "GET" });
  assert.equal((t.proposals || []).length, 0); assert.equal((t.activity_log || []).length, 0);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
