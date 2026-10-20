#!/usr/bin/env node
// Exercises the real apply-proposal request handler (the code the Edge Function runs) against an
// in-memory stand-in for Supabase, including an end-to-end pass through draft-reset -> apply.
// Run: node scripts/test-apply-proposal.mjs
//
// What this proves: auth/role gating, input validation, every refusal path (already decided,
// source gone, source edited since), idempotent retries, version numbering inside a family, fresh
// ids, and that applying a proposal yields exactly the shelf the agent drafted.
// What it does NOT prove: the SQL function itself (checked separately against a real Postgres —
// see the Phase 4 section of supabase/schema.sql) or Supabase's own JWT/RLS machinery.

import assert from "node:assert/strict";
import { handleApplyProposal } from "../supabase/functions/_shared/apply-proposal-handler.js";
import { handleDraftReset } from "../supabase/functions/_shared/draft-reset-handler.js";
import { fingerprint, appliedPlanogramId } from "../supabase/functions/_shared/proposal-core.js";

// ---------------------------------------------------------------------------------------
// PostgREST-shaped fake: select/eq (incl. data->>key paths)/in/range/maybeSingle/insert, plus an
// rpc() that mirrors apply_proposal() in schema.sql (atomic: all of it or nothing).
// ---------------------------------------------------------------------------------------
function makeDb({ tables, tokens, rpcError = null }) {
  const get = (row, col) => (col.includes("->>") ? col.split("->>").reduce((o, k, i) => (i === 0 ? o?.[k] : o?.[k]), row) : row[col]);
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.rangeArg = null; this.inserting = null; }
    insert(rows) { this.inserting = Array.isArray(rows) ? rows : [rows]; return this; }
    select() { return this; }
    eq(col, val) { this.filters.push((r) => { const v = get(r, col); return v !== undefined && v !== null && String(v) === String(val); }); return this; }
    in(col, vals) { this.filters.push((r) => vals.includes(get(r, col))); return this; }
    range(a, b) { this.rangeArg = [a, b]; return this; }
    run() {
      if (this.inserting) {
        const stored = this.inserting.map((r) => ({ id: globalThis.crypto.randomUUID(), created_at: "2026-10-20T10:00:00Z", ...r }));
        (tables[this.table] ||= []).push(...stored);
        return { data: stored, error: null };
      }
      let rows = (tables[this.table] || []).filter((r) => this.filters.every((f) => f(r)));
      if (this.rangeArg) rows = rows.slice(this.rangeArg[0], this.rangeArg[1] + 1);
      return { data: rows, error: null };
    }
    maybeSingle() { return Promise.resolve({ data: this.run().data[0] ?? null, error: null }); }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
  }
  return {
    from: (t) => new Query(t),
    auth: { getUser: async (token) => (tokens[token] ? { data: { user: { id: tokens[token] } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } }) },
    async rpc(name, args) {
      assert.equal(name, "apply_proposal");
      if (rpcError) return { data: null, error: { message: rpcError } };
      const prop = (tables.proposals || []).find((p) => p.id === args.p_id);
      if (!prop) return { data: null, error: { message: "Proposal not found" } };
      if (prop.status === "applied") return { data: prop.applied_id, error: null };
      if (prop.status !== "pending") return { data: null, error: { message: `This proposal was already ${prop.status}` } };
      const newId = args.p_planogram.id;
      if ((tables.planograms || []).some((p) => p.id === newId)) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
      (tables.planograms ||= []).push({ id: newId, data: args.p_planogram, updated_by: args.p_user });
      Object.assign(prop, { status: "applied", applied_id: newId, reviewed_by: prop.reviewed_by ?? args.p_user });
      (tables.activity_log ||= []).push({ actor_type: "user", actor_id: args.p_user, action: "proposal_applied", target_type: prop.target_type, target_id: prop.target_id, detail: { proposalId: prop.id, planogramId: newId, planogramName: args.p_planogram.name, version: args.p_planogram.versionNumber } });
      return { data: newId, error: null };
    },
  };
}

// ---------------------------------------------------------------------------------------
// Scenario: one 48in shelf. A is dead (delete), B weak with 3 facings (reduce), C strong with
// 1 facing (increase), D protected & dead (skipped), E middling, M a missing winner (add).
// ---------------------------------------------------------------------------------------
const SCHEMA = [{ id: "fcat", label: "Category", type: "text" }];
const prod = (id, name, cat, extra = {}) => ({ id, name, dims: { w: 4, h: 6, d: 3 }, attributes: { fcat: cat }, ...extra });
const weeks = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 7, 2 + i * 7)).toISOString().slice(0, 10));
const rec = (units) => weeks.map((weekEnding) => ({ weekEnding, units, price: 1, unitCost: 0.5, storeId: "s1" }));
const pl = (id, productId, facings) => ({ id, productId, facings, orientation: "front", rotation: 0, merchStyle: "unit" });
const makePlanogram = (id = "pog1", extra = {}) => ({
  id, name: "Snacks main", category: "Snacks", status: "live", eventDate: "2026-11-01", versionNumber: 1,
  sections: [{ id: "sec1", fixtures: [{ id: "fx1", fixtureId: "fdef", placements: [pl("pA", "A", 2), pl("pB", "B", 3), pl("pC", "C", 1), pl("pD", "D", 1), pl("pE", "E", 2)] }] }],
  ...extra,
});

function baseTables() {
  return {
    profiles: [{ id: "u-cm", role: "category_manager" }, { id: "u-admin", role: "admin" }, { id: "u-store", role: "store_associate" }],
    agents: [{ id: "reset-drafting-agent", enabled: true, allowed_target_types: ["planogram_version"] }],
    planograms: [{ id: "pog1", data: makePlanogram() }],
    products: [prod("A", "Dead Item", "Snacks"), prod("B", "Weak Item", "Snacks"), prod("C", "Star Item", "Snacks"), prod("D", "Core Item", "Snacks", { resetProtected: true }), prod("E", "Middling Item", "Snacks"), prod("M", "Missing Winner", "Snacks")].map((d) => ({ id: d.id, data: d })),
    fixtures: [{ id: "fdef", data: { id: "fdef", name: "48in shelf", dims: { w: 48 } } }],
    performance: [["A", 0], ["B", 1], ["C", 40], ["D", 0], ["E", 10], ["M", 30]].map(([id, u]) => ({ id, data: { id, records: rec(u) } })),
    app_settings: [{ key: "schema:product", value: JSON.stringify(SCHEMA) }],
    proposals: [],
    activity_log: [],
  };
}
const tokens = { "tok-cm": "u-cm", "tok-admin": "u-admin", "tok-store": "u-store" };
const PID = "11111111-1111-4111-8111-111111111111";

const CHANGES = [
  { type: "delete", productId: "A", sectionId: "sec1", fixtureInstId: "fx1", placementId: "pA" },
  { type: "reduceFacings", productId: "B", sectionId: "sec1", fixtureInstId: "fx1", placementId: "pB", oldFacings: 3, newFacings: 2 },
  { type: "increaseFacings", productId: "C", sectionId: "sec1", fixtureInstId: "fx1", placementId: "pC", oldFacings: 1, newFacings: 2 },
  { type: "addProduct", productId: "M", sectionId: "sec1", fixtureInstId: "fx1", placementId: "pNew", newFacings: 1 },
];
async function withProposal(tables, overrides = {}, source = tables.planograms[0].data) {
  tables.proposals.push({
    id: PID, agent_id: "reset-drafting-agent", target_type: "planogram_version", target_id: source.id, status: "pending", score: 80,
    proposed_change: { changes: CHANGES, skipped: [], sourceFingerprint: await fingerprint(source.sections), lookbackWeeks: 8 },
    ...overrides,
  });
  return tables;
}

const call = (db, { method = "POST", token = "tok-cm", body = { proposalId: PID } } = {}) =>
  handleApplyProposal(
    new Request("http://local/apply-proposal", {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    }),
    db,
  );
const fresh = async (overrides, source) => { const t = await withProposal(baseTables(), overrides, source); return { t, db: makeDb({ tables: t, tokens }) }; };
const shelf = (planogram) => planogram.sections.flatMap((s) => s.fixtures.flatMap((f) => f.placements.map((p) => [p.productId, p.facings])));
const unchanged = (t) => t.proposals[0].status === "pending" && t.planograms.length === 1 && t.activity_log.length === 0;

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n${e.stack}`); process.exitCode = 1; }
};

console.log("apply-proposal handler");

await test("OPTIONS preflight, GET, missing/unknown token", async () => {
  const { db } = await fresh();
  const pre = await call(db, { method: "OPTIONS" });
  assert.equal(pre.status, 200); assert.match(pre.headers.get("Access-Control-Allow-Headers"), /authorization/);
  assert.equal((await call(db, { method: "GET" })).status, 405);
  assert.equal((await call(db, { token: null })).status, 401);
  assert.equal((await call(db, { token: "nope" })).status, 401);
});
await test("store_associate -> 403 and nothing is written; admin and category_manager are allowed", async () => {
  const { t, db } = await fresh();
  assert.equal((await call(db, { token: "tok-store" })).status, 403);
  assert.ok(unchanged(t));
  for (const token of ["tok-cm", "tok-admin"]) {
    const f = await fresh(); assert.equal((await call(f.db, { token })).status, 200, token);
  }
});
await test("bad input -> 400; unknown proposal -> 404; non-planogram target -> 400", async () => {
  const { t, db } = await fresh();
  for (const body of ["not json", {}, { proposalId: "" }, { proposalId: 5 }, { proposalId: "not-a-uuid" }]) assert.equal((await call(db, { body })).status, 400, JSON.stringify(body));
  assert.equal((await call(db, { body: { proposalId: "22222222-2222-4222-8222-222222222222" } })).status, 404);
  t.proposals[0].target_type = "task";
  assert.equal((await call(db)).status, 400);
  assert.ok(unchanged(t));
});

await test("applying builds the next WIP version with exactly the proposed changes", async () => {
  const { t, db } = await fresh();
  const res = await call(db);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.planogramId, appliedPlanogramId(PID));
  const np = out.planogram;
  assert.deepEqual(shelf(np), [["B", 2], ["C", 2], ["D", 1], ["E", 2], ["M", 1]]); // A deleted, B reduced, C increased, M added
  assert.equal(np.name, "Snacks main (v2)");
  assert.deepEqual([np.masterId, np.versionNumber, np.status, np.eventDate], ["pog1", 2, "wip", ""]);
  assert.deepEqual(np.aiDraft, { proposalId: PID, sourceId: "pog1", score: 80 });
  assert.equal(np.resetDraft, undefined);
  // committed: the planogram row exists, the proposal is applied and points at it, one activity row
  assert.equal(t.planograms.length, 2);
  assert.equal(t.planograms[1].id, out.planogramId);
  assert.deepEqual([t.proposals[0].status, t.proposals[0].applied_id, t.proposals[0].reviewed_by], ["applied", out.planogramId, "u-cm"]);
  assert.deepEqual(t.activity_log.map((a) => [a.action, a.actor_id, a.target_id, a.detail.planogramId]), [["proposal_applied", "u-cm", "pog1", out.planogramId]]);
  // the source planogram itself is untouched
  assert.deepEqual(shelf(t.planograms[0].data), [["A", 2], ["B", 3], ["C", 1], ["D", 1], ["E", 2]]);
});
await test("the new version gets fresh section, fixture and placement ids", async () => {
  const { db } = await fresh();
  const np = (await (await call(db)).json()).planogram;
  const ids = np.sections.flatMap((s) => [s.id, ...s.fixtures.flatMap((f) => [f.id, ...f.placements.map((p) => p.id)])]);
  assert.equal(new Set(ids).size, ids.length);
  for (const old of ["sec1", "fx1", "pB", "pC"]) assert.ok(!ids.includes(old), old);
});
await test("applying twice is harmless: same planogram, no second row, no second log entry", async () => {
  const { t, db } = await fresh();
  const first = await (await call(db)).json();
  const res = await call(db, { token: "tok-admin" });
  assert.equal(res.status, 200);
  const second = await res.json();
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.planogramId, first.planogramId);
  assert.deepEqual(second.planogram.sections.length, first.planogram.sections.length);
  assert.equal(t.planograms.length, 2); assert.equal(t.activity_log.length, 1);
});
await test("a proposal already rejected or approved can't be applied", async () => {
  for (const status of ["rejected", "approved"]) {
    const { t, db } = await fresh({ status });
    const res = await call(db);
    assert.equal(res.status, 409, status);
    assert.match((await res.json()).error, new RegExp(`already ${status}`));
    assert.equal(t.planograms.length, 1); assert.equal(t.activity_log.length, 0);
  }
});
await test("source planogram deleted -> 409", async () => {
  const { t, db } = await fresh(); t.planograms.length = 0;
  const res = await call(db);
  assert.equal(res.status, 409); assert.match((await res.json()).error, /no longer exists/);
  assert.equal(t.proposals[0].status, "pending");
});
await test("source edited since the draft -> 409 and the proposal stays pending", async () => {
  const { t, db } = await fresh();
  t.planograms[0].data.sections[0].fixtures[0].placements.find((p) => p.id === "pB").facings = 5; // someone edited it
  const res = await call(db);
  assert.equal(res.status, 409); assert.match((await res.json()).error, /edited since/);
  assert.ok(unchanged(t));
});
await test("key order doesn't matter to the edit check (a reshuffled but identical planogram still applies)", async () => {
  const { t, db } = await fresh();
  const d = t.planograms[0].data;
  t.planograms[0].data = { ...Object.fromEntries(Object.entries(d).reverse()), sections: JSON.parse(JSON.stringify(d.sections, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))) };
  assert.equal((await call(db)).status, 200);
});
await test("a proposal with no recorded fingerprint (older ones) still applies", async () => {
  const { t, db } = await fresh();
  delete t.proposals[0].proposed_change.sourceFingerprint;
  assert.equal((await call(db)).status, 200);
});
await test("version numbers continue the family; a version's source keeps the original master", async () => {
  const t = baseTables();
  t.planograms[0].data = makePlanogram("pog1", { name: "Snacks main", versionNumber: 1 });
  t.planograms.push({ id: "pog2", data: makePlanogram("pog2", { name: "Snacks main (v2)", masterId: "pog1", versionNumber: 2, sections: makePlanogram().sections }) });
  t.planograms.push({ id: "pog3", data: makePlanogram("pog3", { name: "Snacks main (v3)", masterId: "pog1", versionNumber: 3, sections: makePlanogram().sections }) });
  t.planograms.push({ id: "other", data: makePlanogram("other", { name: "Different family", versionNumber: 9 }) });
  await withProposal(t, {}, t.planograms[1].data); // drafted from v2
  const np = (await (await call(makeDb({ tables: t, tokens }))).json()).planogram;
  assert.deepEqual([np.name, np.versionNumber, np.masterId], ["Snacks main (v4)", 4, "pog1"]);
});
await test("a lost race inside the database commit surfaces as 409; any other failure is a generic 500", async () => {
  const t = await withProposal(baseTables());
  const raced = await call(makeDb({ tables: t, tokens, rpcError: "This proposal was already applied" }));
  assert.equal(raced.status, 409);
  const broken = await call(makeDb({ tables: await withProposal(baseTables()), tokens, rpcError: 'relation "planograms" is on fire' }));
  assert.equal(broken.status, 500);
  assert.ok(!JSON.stringify(await broken.json()).includes("on fire"), "internal error text isn't leaked");
});

console.log("\nend to end: draft-reset -> apply-proposal");

await test("the shelf you approve is the shelf the agent drafted", async () => {
  const t = baseTables(); const db = makeDb({ tables: t, tokens });
  const drafted = await handleDraftReset(new Request("http://local/draft-reset", { method: "POST", headers: { Authorization: "Bearer tok-cm", "Content-Type": "application/json" }, body: JSON.stringify({ planogramIds: ["pog1"], lookbackWeeks: 8 }) }), db);
  const { results } = await drafted.json();
  assert.equal(results[0].ok, true);
  const proposalId = results[0].proposalId;
  assert.match(t.proposals[0].proposed_change.sourceFingerprint, /^[0-9a-f]{64}$/);
  const res = await call(db, { body: { proposalId } });
  assert.equal(res.status, 200);
  const np = (await res.json()).planogram;
  assert.deepEqual(shelf(np), [["B", 2], ["C", 2], ["D", 1], ["E", 2], ["M", 1]]);
  assert.deepEqual(t.activity_log.map((a) => a.action), ["proposal_created", "proposal_applied"]);
  assert.equal(t.proposals[0].status, "applied");
});
await test("edit the planogram between drafting and approving: refused with a clear reason", async () => {
  const t = baseTables(); const db = makeDb({ tables: t, tokens });
  const { results } = await (await handleDraftReset(new Request("http://local/draft-reset", { method: "POST", headers: { Authorization: "Bearer tok-cm" }, body: JSON.stringify({ planogramIds: ["pog1"], lookbackWeeks: 8 }) }), db)).json();
  t.planograms[0].data.sections[0].fixtures[0].placements.pop();
  const res = await call(db, { body: { proposalId: results[0].proposalId } });
  assert.equal(res.status, 409); assert.match((await res.json()).error, /edited since/);
  assert.equal(t.proposals[0].status, "pending");
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
