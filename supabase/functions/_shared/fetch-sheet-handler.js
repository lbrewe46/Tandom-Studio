// Request handling for the fetch-sheet Edge Function (plain JS; the Supabase client and `fetch` are injected).
// Reads a Google Sheet the owner has shared as "Anyone with the link can view" and hands its contents back to
// the browser, which feeds it into the normal Performance import. The browser can't fetch Google's export URL
// itself (cross-origin), and nothing is stored here. Private sheets can't be read: Google answers with a
// sign-in page, which is reported as "share it with the link".
//
// Contract
//   POST { url }   (a docs.google.com/spreadsheets/d/<id>/... link; the tab is taken from #gid=, default first tab)
//   200 { ok: true, format: "csv", filename, base64 }
//   400 not a Google Sheets link · 401 no/invalid JWT · 403 role not allowed
//   422 the sheet isn't shared / can't be read · 413 too large · 502 Google unreachable

import { json, preflightOrWrongMethod, authenticate } from "./http.js";

export const ALLOWED_ROLES = ["admin", "category_manager"];
export const MAX_BYTES = 15 * 1024 * 1024;

// -> { id, gid } or null. Only https://docs.google.com/spreadsheets/d/<id> links are accepted, so this can't be pointed at other hosts.
export function parseSheetUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return null;
  const m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,})/);
  if (!m) return null;
  const gidMatch = (u.hash + "&" + u.search).match(/gid=(\d+)/);
  return { id: m[1], gid: gidMatch ? gidMatch[1] : "0" };
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function handleFetchSheet(req, db, fetchImpl = fetch) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;
  const auth = await authenticate(req, db, ALLOWED_ROLES, "Only an Admin or Category Manager can import performance data");
  if (auth.response) return auth.response;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const sheet = parseSheetUrl(body?.url);
  if (!sheet) return json(400, { error: "That doesn't look like a Google Sheets link (https://docs.google.com/spreadsheets/d/...)." });

  let res;
  try {
    res = await fetchImpl(`https://docs.google.com/spreadsheets/d/${sheet.id}/export?format=csv&gid=${sheet.gid}`, { redirect: "follow" });
  } catch (e) {
    console.error("fetch-sheet: google unreachable", e?.message);
    return json(502, { error: "Couldn't reach Google Sheets. Try again, or download the sheet as CSV and upload it." });
  }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || type.includes("text/html")) {
    return json(422, { error: "Couldn't read that sheet. In Google Sheets choose Share → General access → \"Anyone with the link\" (Viewer), then try again. Or download it as CSV and upload the file." });
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) return json(413, { error: "That sheet is too large to import this way (over 15 MB). Download it as CSV and upload the file." });
  return json(200, { ok: true, format: "csv", filename: `google-sheet-${sheet.id.slice(0, 8)}.csv`, base64: toBase64(bytes) });
}
