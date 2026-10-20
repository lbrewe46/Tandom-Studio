// Request handling for the manage-users Edge Function (plain JS, service-role client injected).
// Admin only. This is the one place user accounts are created: sign-up is closed, so a person gets in
// only through an emailed invitation an Admin sends here, with their role and store/regions set up front.
//
// Contract
//   POST { action: "invite", email, displayName?, role, storeId? (store_associate), regions? (regional_manager), redirectTo? }
//   200 { ok: true, userId }
//   400 bad input · 401 no/invalid JWT · 403 not an Admin · 409 that email already has an account · 502 invite email failed
//
// The service-role key never leaves this function; the browser only ever sends the form fields above.

import { json, preflightOrWrongMethod, authenticate } from "./http.js";

export const ALLOWED_ROLES = ["admin"];
export const ASSIGNABLE_ROLES = ["admin", "category_manager", "regional_manager", "event_planner", "store_associate"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function fetchAll(db, table, columns) {
  const { data, error } = await db.from(table).select(columns).range(0, 9999);
  if (error) throw new Error(`reading ${table}: ${error.message}`);
  return data || [];
}

export async function handleManageUsers(req, db) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Only an Admin can manage users");
  if (auth.response) return auth.response;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  if (body?.action !== "invite") return json(400, { error: "Unknown action" });

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) return json(400, { error: "Enter a valid email address" });
  const role = body.role;
  if (!ASSIGNABLE_ROLES.includes(role)) return json(400, { error: "Choose a role" });
  const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim().slice(0, 120) : email;
  let redirectTo;
  if (body.redirectTo !== undefined) {
    try { const u = new URL(body.redirectTo); if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad"); redirectTo = u.origin; } catch { return json(400, { error: "redirectTo must be a web address" }); }
  }

  let storeId = null;
  let regions = [];
  try {
    const stores = await fetchAll(db, "stores", "id, name:data->>name, region:data->>region");
    // the same row can come back as {data:{...}} from a plain select (tests) or as aliased columns (PostgREST)
    const view = stores.map((s) => (s.data ? { id: s.id, region: s.data.region } : { id: s.id, region: s.region }));
    if (role === "store_associate") {
      if (typeof body.storeId !== "string" || !view.some((s) => s.id === body.storeId)) return json(400, { error: "Choose the store this person works in" });
      storeId = body.storeId;
    }
    if (role === "regional_manager") {
      regions = Array.isArray(body.regions) ? [...new Set(body.regions.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()))] : [];
      if (regions.length === 0) return json(400, { error: "Choose at least one region" });
      const known = new Set(view.map((s) => s.region).filter(Boolean));
      const unknown = regions.filter((r) => !known.has(r));
      if (unknown.length) return json(400, { error: `No store is in region: ${unknown.join(", ")}` });
    }
  } catch (e) {
    console.error("manage-users: could not read stores", e);
    return json(500, { error: "Could not check the store list" });
  }

  const { data: invited, error: inviteErr } = await db.auth.admin.inviteUserByEmail(email, { data: { display_name: displayName }, ...(redirectTo ? { redirectTo } : {}) });
  if (inviteErr || !invited?.user) {
    const msg = inviteErr?.message || "The invitation could not be sent";
    if (/already|registered|exists/i.test(msg)) return json(409, { error: "That email already has an account. Change their role in the list below, or ask them to use Forgot password." });
    console.error("manage-users: invite failed", inviteErr);
    return json(502, { error: `The invitation email could not be sent (${msg})` });
  }
  const userId = invited.user.id;

  // The sign-up trigger normally creates the profile; make sure it exists and carries the assignment.
  const { error: profileErr } = await db.from("profiles").upsert({ id: userId, email, display_name: displayName, role, store_id: storeId, regions });
  if (profileErr) {
    console.error("manage-users: invited but could not set the role", profileErr);
    return json(500, { error: `The invitation was sent, but setting their role failed (${profileErr.message}). Set it in the Users list.` });
  }
  try {
    await db.from("activity_log").insert([{ actor_type: "user", actor_id: auth.user.id, action: "user_invited", target_type: "user", target_id: userId, detail: { email, role, storeId, regions } }]);
  } catch (e) { console.error("manage-users: invited but activity log write failed", e); }
  return json(200, { ok: true, userId });
}
