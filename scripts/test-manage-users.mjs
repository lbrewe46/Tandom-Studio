#!/usr/bin/env node
// manage-users: Admin-only invitations with a role and store/regions. Run: node scripts/test-manage-users.mjs
import assert from "node:assert/strict";
import { handleManageUsers } from "../supabase/functions/_shared/manage-users-handler.js";

function makeDb(tables, { inviteError } = {}) {
  const invites = [];
  class Q {
    constructor(t) { this.t = t; this.f = []; this.ins = null; this.ups = null; }
    insert(r) { this.ins = Array.isArray(r) ? r : [r]; return this; }
    upsert(r) { this.ups = r; return this; }
    select() { return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    range() { return this; }
    run() {
      const rows = (tables[this.t] ||= []);
      if (this.ins) { rows.push(...this.ins); return { data: this.ins, error: null }; }
      if (this.ups) { const i = rows.findIndex((r) => r.id === this.ups.id); if (i >= 0) rows[i] = { ...rows[i], ...this.ups }; else rows.push(this.ups); return { data: null, error: null }; }
      return { data: rows.filter((r) => this.f.every((f) => f(r))), error: null };
    }
    maybeSingle() { return Promise.resolve({ data: this.run().data[0] ?? null, error: null }); }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
  }
  return {
    invites,
    from: (t) => new Q(t),
    auth: {
      getUser: async (tok) => ({ adminTok: { id: "a" }, cmTok: { id: "c" } }[tok] ? { data: { user: { adminTok: { id: "a" }, cmTok: { id: "c" } }[tok] }, error: null } : { data: { user: null }, error: { message: "bad" } }),
      admin: { inviteUserByEmail: async (email, opts) => { if (inviteError) return { data: null, error: { message: inviteError } }; invites.push({ email, opts }); const user = { id: `new-${invites.length}` }; (tables.profiles ||= []).push({ id: user.id, email, role: "store_associate" }); return { data: { user }, error: null }; } },
    },
  };
}
const mk = () => ({ profiles: [{ id: "a", role: "admin" }, { id: "c", role: "category_manager" }], stores: [{ id: "s1", data: { name: "East 1", region: "East" } }, { id: "s2", data: { name: "West 1", region: "West" } }], activity_log: [] });
const call = async (tok, body, t = mk(), opts) => {
  const db = makeDb(t, opts);
  const res = await handleManageUsers(new Request("https://x/u", { method: "POST", headers: { Authorization: tok ? `Bearer ${tok}` : "" }, body: JSON.stringify(body) }), db);
  return { res, json: await res.json(), t, db };
};
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const base = { action: "invite", email: "Sam@Example.com", displayName: "Sam", role: "store_associate", storeId: "s1" };

assert.equal((await call("", base)).res.status, 401); ok("no session -> 401");
assert.equal((await call("cmTok", base)).res.status, 403); ok("only an Admin can invite");
assert.equal((await call("adminTok", { ...base, action: "delete" })).res.status, 400); ok("unknown action -> 400");
assert.equal((await call("adminTok", { ...base, email: "nope" })).res.status, 400); ok("bad email -> 400");
assert.equal((await call("adminTok", { ...base, role: "superuser" })).res.status, 400); ok("bad role -> 400");
assert.equal((await call("adminTok", { ...base, storeId: undefined })).res.status, 400); ok("store associate needs a store");
assert.equal((await call("adminTok", { ...base, storeId: "nope" })).res.status, 400); ok("the store must exist");
assert.equal((await call("adminTok", { ...base, role: "regional_manager", regions: [] })).res.status, 400); ok("regional manager needs at least one region");
{ const r = await call("adminTok", { ...base, role: "regional_manager", regions: ["North"] }); assert.equal(r.res.status, 400); assert.match(r.json.error, /North/); ok("regions must match stores' regions"); }
{
  const r = await call("adminTok", { ...base, redirectTo: "https://tandom-studio.netlify.app/some/path" });
  assert.equal(r.res.status, 200); assert.equal(r.db.invites[0].email, "sam@example.com"); assert.equal(r.db.invites[0].opts.redirectTo, "https://tandom-studio.netlify.app"); assert.equal(r.db.invites[0].opts.data.display_name, "Sam"); ok("invite email goes to the lower-cased address, redirecting to the site");
  const p = r.t.profiles.find((x) => x.id === r.json.userId); assert.equal(p.role, "store_associate"); assert.equal(p.store_id, "s1"); assert.deepEqual(p.regions, []); ok("profile gets the role and store");
  assert.equal(r.t.activity_log[0].action, "user_invited"); ok("invitation is logged");
}
{ const r = await call("adminTok", { ...base, role: "regional_manager", regions: ["East", "West", "East"], storeId: undefined }); const p = r.t.profiles.find((x) => x.id === r.json.userId); assert.deepEqual(p.regions, ["East", "West"]); assert.equal(p.store_id, null); ok("regional manager: regions saved (de-duplicated), no store"); }
{ const r = await call("adminTok", { ...base, role: "event_planner", storeId: undefined }); assert.equal(r.res.status, 200); assert.equal(r.t.profiles.find((x) => x.id === r.json.userId).role, "event_planner"); ok("event planner needs neither store nor region"); }
{ const r = await call("adminTok", base, mk(), { inviteError: "A user with this email address has already been registered" }); assert.equal(r.res.status, 409); ok("existing account -> 409 with guidance"); }
{ const r = await call("adminTok", base, mk(), { inviteError: "SMTP down" }); assert.equal(r.res.status, 502); ok("email failure -> 502"); }
{ const r = await call("adminTok", { ...base, redirectTo: "javascript:alert(1)" }); assert.equal(r.res.status, 400); ok("redirectTo must be a web address"); }
console.log(`\n${n} passed`);
