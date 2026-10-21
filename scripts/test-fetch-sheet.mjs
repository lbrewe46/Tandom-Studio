#!/usr/bin/env node
// fetch-sheet: Google Sheet link -> CSV for the Performance import. Run: node scripts/test-fetch-sheet.mjs
import assert from "node:assert/strict";
import { handleFetchSheet, parseSheetUrl } from "../supabase/functions/_shared/fetch-sheet-handler.js";

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { failed++; console.error("FAIL " + name + "\n", e); } };

const users = { adminTok: "a", cmTok: "c", storeTok: "s" };
const roles = { a: "admin", c: "category_manager", s: "store_associate" };
const db = {
  auth: { getUser: async (t) => (users[t] ? { data: { user: { id: users[t] } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
  from: () => ({ select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => ({ data: roles[id] ? { role: roles[id] } : null }) }) }) }),
};
const call = (body, tok = "adminTok", fetchImpl) => handleFetchSheet(new Request("http://x", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), db, fetchImpl);
const ok = (text, type = "text/csv") => async () => new Response(text, { status: 200, headers: { "content-type": type } });
const URL_OK = "https://docs.google.com/spreadsheets/d/1s9bGTCA0mUHlwX2zQvJkdHLtdNIHf1fDzrPSf3EsB1g/edit?gid=12345#gid=12345";

console.log("fetch-sheet");
await test("parses id and gid; rejects other hosts and schemes", () => {
  assert.deepEqual(parseSheetUrl(URL_OK), { id: "1s9bGTCA0mUHlwX2zQvJkdHLtdNIHf1fDzrPSf3EsB1g", gid: "12345" });
  assert.equal(parseSheetUrl("https://docs.google.com/spreadsheets/d/abcdefghij1234/edit").gid, "0");
  assert.equal(parseSheetUrl("https://evil.example/spreadsheets/d/abcdefghij1234"), null);
  assert.equal(parseSheetUrl("http://docs.google.com/spreadsheets/d/abcdefghij1234"), null);
  assert.equal(parseSheetUrl("https://docs.google.com/document/d/abcdefghij1234"), null);
  assert.equal(parseSheetUrl("nonsense"), null);
});
await test("returns the sheet as base64 CSV and asks Google for the right tab", async () => {
  let asked;
  const r = await call({ url: URL_OK }, "adminTok", async (u) => { asked = u; return ok("a,b\n1,2\n")(); });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(Buffer.from(b.base64, "base64").toString(), "a,b\n1,2\n");
  assert.equal(b.format, "csv");
  assert.ok(asked.startsWith("https://docs.google.com/spreadsheets/d/1s9bGTCA0mUHlwX2zQvJkdHLtdNIHf1fDzrPSf3EsB1g/export?format=csv&gid=12345"));
});
await test("category manager allowed; store associate refused; no token refused", async () => {
  assert.equal((await call({ url: URL_OK }, "cmTok", ok("x"))).status, 200);
  assert.equal((await call({ url: URL_OK }, "storeTok", ok("x"))).status, 403);
  assert.equal((await call({ url: URL_OK }, "nope", ok("x"))).status, 401);
});
await test("a non-Google link is refused without fetching anything", async () => {
  let called = false;
  const r = await call({ url: "https://example.com/x" }, "adminTok", async () => { called = true; return ok("x")(); });
  assert.equal(r.status, 400); assert.equal(called, false);
});
await test("a private sheet (Google sign-in page) -> 422 with sharing guidance", async () => {
  const r = await call({ url: URL_OK }, "adminTok", ok("<html>Sign in</html>", "text/html; charset=utf-8"));
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /Anyone with the link/);
});
await test("Google unreachable -> 502; oversized -> 413", async () => {
  assert.equal((await call({ url: URL_OK }, "adminTok", async () => { throw new Error("down"); })).status, 502);
  const big = new Uint8Array(15 * 1024 * 1024 + 1);
  assert.equal((await call({ url: URL_OK }, "adminTok", async () => new Response(big, { headers: { "content-type": "text/csv" } }))).status, 413);
});
console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
