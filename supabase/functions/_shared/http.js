// Plumbing shared by the Edge Function handlers: CORS, JSON responses, and "who is calling?".
// Plain JS with the Supabase client injected, so it runs unchanged under Deno and Node tests.

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Returns a Response for requests that need no further work (CORS preflight, wrong method), else null.
export function preflightOrWrongMethod(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Use POST" });
  return null;
}

// Verifies the caller's Supabase session and that their profile role is allowed.
//   -> { user, role }            the caller may proceed
//   -> { response }              401 (no/invalid session) or 403 (role not allowed) — return it as is
export async function authenticate(req, db, allowedRoles, roleDeniedMessage) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { response: json(401, { error: "Missing Authorization header" }) };
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData?.user) return { response: json(401, { error: "Invalid or expired session" }) };

  const { data: profile } = await db.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!profile || !allowedRoles.includes(profile.role)) return { response: json(403, { error: roleDeniedMessage }) };
  return { user: userData.user, role: profile.role };
}
