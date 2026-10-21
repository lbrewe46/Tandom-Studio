import React, { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  Plus, Minus, Trash2, ChevronLeft, ChevronRight, Settings2, Image as ImageIcon,
  RotateCw, X, Layers, Package, Boxes, Ruler, ArrowLeft, Check, Grid3x3,
  Pencil, Save, AlertTriangle, RefreshCw, Download, Upload, FileSpreadsheet, CalendarDays, TrendingUp,
  Maximize2, Minimize2, Store, ChevronDown, ChevronUp, AlignLeft, AlignCenter, AlignRight, Search, Eye, Printer, Copy,
  LogOut, Mail, Lock, ImageOff, Palette, ZoomIn, ZoomOut, Crosshair, Globe, HelpCircle, BarChart3, Sparkles, Users, Send, Link2
} from "lucide-react";
import {
  supabase, supabaseConfigured, pendingWriteListeners,
  safeGet, safeSet, safeDelete, loadIndexed, saveIndexed, deleteIndexed, waitForPendingWrites,
  loadPendingProposals, reviewProposal, loadProfileNames, loadActivity, loadProposal, applyProposal, invokeEdgeFunction,
  loadResetImpacts, loadEscalations, resolveEscalation,
} from "./lib/db.js";
import { buildContext, segmentTree, slowMovers, forecastFor, recommend, scopeOptions, DEFAULT_ASSUMPTIONS } from "../supabase/functions/_shared/assortment.js";

/* ------------------------------------------------------------------ */
/* Constants & helpers                                                 */
/* ------------------------------------------------------------------ */

const ORIENTATIONS = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "top", label: "Top" },
  { id: "bottom", label: "Bottom" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
];

const ROTATIONS = [0, 90, 180, 270];

const FIXTURE_TYPES = ["Shelf", "Pegboard", "Hook Rail", "Basket", "Divider Bar"];

// Planogram Lifecycle (version control for a planogram, in this app's terms). A planogram always
// carries one of these five statuses, in this order: WIP → Approved → Pending → Live →
// Historical. This is the data the future store-associate module will read to decide what
// layout is currently in force — and, for Approved→Pending specifically, what to publish out to
// stores so they can start marking down items being removed ahead of the reset.
const PLANOGRAM_STATUSES = ["wip", "approved", "pending", "live", "historical"];
const PLANOGRAM_STATUS_CONFIG = {
  wip: {
    label: "WIP",
    description: "Work in progress — a space planner is actively building and merchandising this layout.",
    badgeCls: "bg-violet-50 text-violet-700 border-violet-300",
  },
  approved: {
    label: "Approved",
    description: "Merchandising complete and approved — publishes to stores automatically 3 weeks before the event date.",
    badgeCls: "bg-blue-50 text-blue-700 border-blue-300",
  },
  pending: {
    label: "Pending",
    description: "Published to stores ahead of the reset, so items being removed can start being marked down.",
    badgeCls: "bg-slate-100 text-slate-600 border-slate-300",
  },
  live: {
    label: "Live",
    description: "Active now — this is the layout stores and supply chain should be using, effective as of the event date.",
    badgeCls: "bg-emerald-50 text-emerald-700 border-emerald-300",
  },
  historical: {
    label: "Historical",
    description: "Retired — replaced by a newer version. Kept for record-keeping.",
    badgeCls: "bg-slate-100 text-slate-400 border-slate-200",
  },
};

// how far ahead of the event date an Approved planogram publishes to Pending, giving stores a
// window to mark down items that are being discontinued in the reset
const PENDING_LEAD_DAYS = 21;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Adds (or subtracts, with a negative count) whole days to an ISO date string, staying entirely
// in UTC so this can't drift a day off depending on the browser's local timezone.
function addDaysISO(dateISO, days) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The status actually in force right now, applying both auto-transition rules in sequence —
// both driven off the single Event Date, no separate field needed:
// (1) Approved automatically publishes to Pending 3 weeks before the event date, so stores can
//     see what's coming and start marking down items being removed.
// (2) Pending automatically becomes Live exactly on the event date.
// WIP→Approved and Live→Historical are always explicit, manual actions.
// This is a pure function so it can be used identically for display and for the persisted-write
// check below; it never mutates anything itself. The two checks are sequential (not else-if) so
// a planogram that's gone unchecked long enough can correctly cascade through both in one pass.
function effectivePlanogramStatus(p) {
  let status = p.status || "wip";
  const today = todayISO();
  if (status === "approved" && p.eventDate && today >= addDaysISO(p.eventDate, -PENDING_LEAD_DAYS)) status = "pending";
  if (status === "pending" && p.eventDate && today >= p.eventDate) status = "live";
  return status;
}

// Planogram Versioning: the very first WIP a planogram is created as is its "master". Any copy
// made from it (or from one of its later versions) is linked back to that SAME master via
// masterId — a flat family, not a chain, so every version always points directly at the
// original regardless of which version it was actually copied from.
function getFamilyMasterId(p) {
  return p.masterId || p.id;
}
function getFamilyMembers(p, allPlanograms) {
  const masterId = getFamilyMasterId(p);
  return allPlanograms
    .filter((x) => getFamilyMasterId(x) === masterId)
    .sort((a, b) => (a.versionNumber || 1) - (b.versionNumber || 1));
}

// The Live sibling this planogram will replace (or already replaced), used to compute what's
// actually changing in the reset — the basis for the Store Assistant's New/Deleted/Keep items.
function getPredecessorPlanogram(planogram, allPlanograms) {
  const masterId = getFamilyMasterId(planogram);
  return allPlanograms.find((p) => p.id !== planogram.id && getFamilyMasterId(p) === masterId && (p.status || "wip") === "live") || null;
}

function getPlacedProductIdsForSection(section) {
  const ids = new Set();
  (section?.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => ids.add(pl.productId)));
  return ids;
}

function getPlacedProductIds(planogram) {
  const ids = new Set();
  (planogram?.sections || []).forEach((s) => getPlacedProductIdsForSection(s).forEach((id) => ids.add(id)));
  return ids;
}

// New Items = Get Inventory, Deleted Items = Remove from Shelf & Markdown, Keep Items = no
// change needed. Comparing against the predecessor's placements. With no predecessor (the first
// planogram for a space) there is nothing to compare, so all three lists are empty and callers
// show a "first planogram, no comparison available" notice instead of calling everything New.
function computeItemChanges(planogram, predecessor, products) {
  if (!predecessor) return { newItems: [], deletedItems: [], keepItems: [] };
  const currentIds = getPlacedProductIds(planogram);
  const previousIds = getPlacedProductIds(predecessor);
  const toProducts = (ids) => [...ids].map((id) => products.find((p) => p.id === id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return {
    newItems: toProducts([...currentIds].filter((id) => !previousIds.has(id))),
    deletedItems: toProducts([...previousIds].filter((id) => !currentIds.has(id))),
    keepItems: toProducts([...currentIds].filter((id) => previousIds.has(id))),
  };
}

// Deep-clones a planogram's merchandising content (sections → fixtures → placements) with
// entirely fresh ids at every level, so a new version can never accidentally share a live
// reference with the planogram it was copied from.
function cloneSectionsWithNewIds(sections) {
  return (sections || []).map((s) => ({
    ...s,
    id: uid("sec"),
    fixtures: (s.fixtures || []).map((fx) => ({
      ...fx,
      id: uid("fx"),
      placements: (fx.placements || []).map((pl) => ({ ...pl, id: uid("pl") })),
    })),
  }));
}

// Builds the next version of `source`: linked back to its family's master, next version number
// (computed from `existingList`, which need not be the latest React state — bulk creation relies
// on that), content deep-cloned with fresh ids, lifecycle reset to a clean WIP. Pure, so the
// app and the apply-proposal Edge Function (via scripts/sync-edge-core.mjs) build versions
// identically; `id` lets the server pass a deterministic id so a retried apply can't duplicate.
function makePlanogramVersion(source, existingList, id) {
  const masterId = getFamilyMasterId(source);
  const siblings = existingList.filter((p) => getFamilyMasterId(p) === masterId);
  const nextVersion = Math.max(1, ...siblings.map((p) => p.versionNumber || 1)) + 1;
  const baseName = source.name.replace(/\s*\(v\d+\)\s*$/i, "").trim();
  return {
    ...source,
    id: id || uid("pog"),
    name: `${baseName} (v${nextVersion})`,
    masterId,
    versionNumber: nextVersion,
    sections: cloneSectionsWithNewIds(source.sections),
    status: "wip",
    eventDate: "",
    publishedAt: undefined,
  };
}

function PlanogramStatusBadge({ status, className }) {
  const cfg = PLANOGRAM_STATUS_CONFIG[status] || PLANOGRAM_STATUS_CONFIG.wip;
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border ${cfg.badgeCls} ${className || ""}`} title={cfg.description}>
      {cfg.label}
    </span>
  );
}

// Store Assistant: a store's own execution progress on an assigned planogram — distinct from the
// planogram's own lifecycle status (WIP/Approved/Pending/Live/Historical). New → Reviewed →
// In Progress → Partially Completed / Completed / Rejected (with an explanation).
const STORE_EXECUTION_STATUS_CONFIG = {
  new: { label: "New", badgeCls: "bg-slate-100 text-slate-600 border-slate-300" },
  reviewed: { label: "Reviewed", badgeCls: "bg-blue-50 text-blue-700 border-blue-300" },
  in_progress: { label: "In Progress", badgeCls: "bg-amber-50 text-amber-700 border-amber-300" },
  partially_completed: { label: "Partially Completed", badgeCls: "bg-orange-50 text-orange-700 border-orange-300" },
  completed: { label: "Completed", badgeCls: "bg-emerald-50 text-emerald-700 border-emerald-300" },
  rejected: { label: "Rejected", badgeCls: "bg-red-50 text-red-700 border-red-300" },
};
function StoreExecutionStatusBadge({ status, className }) {
  const cfg = STORE_EXECUTION_STATUS_CONFIG[status] || STORE_EXECUTION_STATUS_CONFIG.new;
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border ${cfg.badgeCls} ${className || ""}`}>
      {cfg.label}
    </span>
  );
}

// Store Feedback (formerly just "Issues"): store conditions that impact a planogram or reset,
// reported back to the space planner with a structured type plus a free-text description.
const ISSUE_TYPES = [
  { id: "fixture_mismatch", label: "Fixture Mismatch (wrong size, height, or depth)" },
  { id: "physical_obstruction", label: "Physical Obstruction (pillar, electrical box, HVAC, etc.)" },
  { id: "shelf_overfilled", label: "Shelf Overfilled (too many products to fit)" },
  { id: "delayed_shipment", label: "Delayed Product Shipment" },
  { id: "other", label: "Other" },
];

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || "x").length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 48%, 62%)`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function getAttrByLabel(product, schema, labelCandidates) {
  const field = (schema || []).find((f) => labelCandidates.some((l) => f.label.trim().toLowerCase() === l));
  if (!field) return "";
  const v = product.attributes?.[field.id];
  return v === undefined || v === null || v === "" ? "" : String(v);
}

// resolves a product's (or parsed-row's) unique key per the global Product Primary Key setting
function getPrimaryKeyValue(item, schema, primaryKeyField) {
  if (primaryKeyField === "upc") {
    const v = getAttrByLabel(item, schema, ["upc"]);
    return v ? v.trim().toLowerCase() : "";
  }
  return (item.sku || "").trim().toLowerCase();
}

// same as getPrimaryKeyValue but preserves original casing — used for building filenames/URLs,
// where case may matter, rather than for case-insensitive matching
function getPrimaryKeyValueRaw(item, schema, primaryKeyField) {
  if (primaryKeyField === "upc") return (getAttrByLabel(item, schema, ["upc"]) || "").trim();
  return (item.sku || "").trim();
}

function hasUpcField(schema) {
  return (schema || []).some((f) => f.label.trim().toLowerCase() === "upc");
}

/* ------------------------------------------------------------------ */
/* Image repository lookup — auto-associates orientation images from a  */
/* local folder (served statically) or a cloud/CDN URL, by filename     */
/* convention, instead of manual per-image upload                      */
/* ------------------------------------------------------------------ */

// standard orientation-code convention: UPC.1 = Front, UPC.2 = Left, UPC.3 = Top,
// UPC.7 = Back, UPC.8 = Right, UPC.9 = Base/Bottom
const ORIENTATION_CODES = { front: "1", left: "2", top: "3", back: "7", right: "8", bottom: "9" };

const DEFAULT_IMAGE_REPO = {
  enabled: false,
  keyField: "upc", // "upc" | "sku" — which product field the lookup key comes from
  baseUrl: "/product-images/",
  pattern: "{key}.{code}",
  extensions: "jpg,jpeg,png,webp",
};

function buildImageCandidateUrls(repo, key, orientation) {
  if (!key) return [];
  const code = ORIENTATION_CODES[orientation];
  const pattern = repo.pattern || "{key}.{code}";
  if (pattern.includes("{code}") && code === undefined) return []; // no code defined for this orientation
  const base = repo.baseUrl.endsWith("/") ? repo.baseUrl : repo.baseUrl + "/";
  const filename = pattern.replace("{key}", key).replace("{orientation}", orientation).replace("{code}", code || "").replace("{size}", repo.size || "xlarge");
  const exts = (repo.extensions || "").split(",").map((s) => s.trim()).filter(Boolean);
  // a blank Extensions setting means the pattern already produces the complete path — some CDNs
  // (e.g. a retailer's own product-image URL) serve the image directly with no file extension
  if (exts.length === 0) return [`${base}${filename}`];
  return exts.map((ext) => `${base}${filename}.${ext}`);
}

// minWidth rejects a response that loads but is only a tracking pixel / tiny placeholder.
function testImageLoads(url, timeoutMs = 4000, minWidth = 0) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    img.onload = () => finish(img.naturalWidth >= minWidth);
    img.onerror = () => finish(false);
    setTimeout(() => finish(false), timeoutMs);
    img.src = url;
  });
}

// Retailer CDNs that serve several resolutions (a "{size}" segment in the pattern). Biggest first:
// the requested size is tried, then the next ones down as far as "medium" — never quietly
// settling for a thumbnail, which looks blurry once it is drawn at planogram scale.
const WEB_IMAGE_SIZES = ["xlarge", "large", "medium", "small", "thumbnail"];
function webImageSizeChain(size) {
  const i = Math.max(0, WEB_IMAGE_SIZES.indexOf(size || "xlarge"));
  return WEB_IMAGE_SIZES.slice(i, Math.max(i + 1, WEB_IMAGE_SIZES.indexOf("medium") + 1));
}
// A stored web-lookup image that came from one of the small renditions (earlier versions of the
// lookup defaulted to "thumbnail"); re-running the web lookup upgrades these in place.
function isLowResWebImage(url) {
  return typeof url === "string" && /\/product\/images\/(thumbnail|small)\//.test(url);
}

async function findRepositoryImage(repo, key, orientation) {
  const sized = (repo.pattern || "").includes("{size}");
  for (const size of sized ? webImageSizeChain(repo.size) : [undefined]) {
    for (const url of buildImageCandidateUrls({ ...repo, size }, key, orientation)) {
      if (await testImageLoads(url, 4000, sized ? 80 : 0)) return url;
    }
  }
  return null;
}

// fills in only the orientations a product doesn't already have an image for; returns
// {images, matchedCount} — images is the full updated map, matchedCount is how many were found.
// Uses repo.keyField (defaults to UPC) rather than the global product-matching primary key,
// since the image lookup key and the import-matching key don't have to be the same field.
async function matchProductImagesFromRepo(product, repo, schema) {
  const key = getPrimaryKeyValueRaw(product, schema, repo.keyField || "upc");
  const images = { ...product.images };
  let matchedCount = 0;
  if (!key) return { images, matchedCount };
  for (const o of ORIENTATIONS) {
    if (images[o.id]) continue;
    const found = await findRepositoryImage(repo, key, o.id);
    if (found) { images[o.id] = found; matchedCount++; }
  }
  return { images, matchedCount };
}

/* ------------------------------------------------------------------ */
/* Web (retailer CDN) image lookup — a second, independent image        */
/* source for when the Image Repository above has nothing for a         */
/* product yet, e.g. right after import when nobody has sourced images  */
/* for it. Works exactly like the Image Repository above (same          */
/* baseUrl/pattern/extensions shape, same <img>-load probing), just     */
/* pointed at a retailer's own public product-image URL pattern instead */
/* of an internal server. A JSON UPC-lookup API was tried first, but    */
/* every public one we checked (UPCitemdb included) locks its           */
/* Access-Control-Allow-Origin to its own domain, so a browser fetch()  */
/* from this app is always blocked by CORS — that's a hard server-side  */
/* restriction, nothing on our end can work around it. An <img> tag     */
/* load, by contrast, isn't subject to CORS at all (the browser allows  */
/* cross-origin images for plain display), so probing candidate image   */
/* URLs directly — the same trick the Repository above already uses —   */
/* sidesteps the problem entirely.                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_UPC_LOOKUP = {
  enabled: false,
  baseUrl: "https://www.kroger.com/product/images/",
  pattern: "{size}/{orientation}/{key}",
  size: "xlarge", // xlarge | large | medium | small | thumbnail — thumbnails look blurry at planogram scale
  extensions: "", // blank — this CDN serves the image directly at this path, no file extension
};

// Settings saved by earlier versions hard-wired the size into the Base URL (".../images/thumbnail/")
// and defaulted to the smallest one. Move those onto the {size} pattern, and upgrade an old
// thumbnail default to xlarge; a size someone deliberately picked (large, medium…) is kept.
function migrateUpcLookup(saved) {
  const m = (saved?.baseUrl || "").match(/^(.*\/product\/images\/)(thumbnail|small|medium|large|xlarge)\/?$/);
  if (!m || (saved.pattern || "{orientation}/{key}") !== "{orientation}/{key}") return saved;
  return { ...saved, baseUrl: m[1], pattern: "{size}/{orientation}/{key}", size: m[2] === "thumbnail" ? "xlarge" : m[2] };
}

// Kroger's image CDN keys images by a 13-digit code: the 10-digit "item reference" core of a UPC,
// zero-padded up front to 13. A standard 12-digit UPC-A is [number-system digit][10-digit item
// reference][check digit], so getting to that 10-digit core means dropping the leading digit from
// an 11-digit code, or both the leading and trailing digit from a 12-digit code. A 13-digit input
// is assumed to already be in the CDN's expected form and is used as-is.
function normalizeUpcForKrogerCdn(upc) {
  const digits = (upc || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 13) return digits;
  let core;
  if (digits.length === 10) core = digits;
  else if (digits.length === 11) core = digits.slice(1);
  else if (digits.length === 12) core = digits.slice(1, -1);
  else core = digits.length > 10 ? digits.slice(-10) : digits.padStart(10, "0"); // best-effort for anything else
  return "000" + core;
}

// Same shape as matchProductImagesFromRepo, but always keyed on UPC (this CDN has no notion of a
// SKU-based lookup) and runs the UPC through normalizeUpcForKrogerCdn first.
async function matchProductImagesFromWebCdn(product, repo, schema) {
  const rawUpc = getPrimaryKeyValueRaw(product, schema, "upc");
  const key = normalizeUpcForKrogerCdn(rawUpc);
  const images = { ...product.images };
  let matchedCount = 0;
  if (!key) return { images, matchedCount };
  for (const o of ORIENTATIONS) {
    if (images[o.id] && !isLowResWebImage(images[o.id])) continue; // keep good images; re-try thumbnails
    const found = await findRepositoryImage(repo, key, o.id);
    if (found && found !== images[o.id]) { images[o.id] = found; matchedCount++; }
  }
  return { images, matchedCount };
}

const inputCls =
  "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400";
const labelCls = "block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const btnGhost =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors";
const btnDanger =
  "inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors";
const btnIcon =
  "inline-flex items-center justify-center rounded-md border border-slate-300 bg-white w-7 h-7 text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed";

/* ------------------------------------------------------------------ */
/* Default configurable schemas                                        */
/* ------------------------------------------------------------------ */

const DEFAULT_PRODUCT_SCHEMA = [
  { id: uid("f"), label: "Brand", type: "text" },
  { id: uid("f"), label: "Category", type: "text" },
  { id: uid("f"), label: "Subcategory", type: "text" },
  { id: uid("f"), label: "UPC", type: "text" },
  { id: uid("f"), label: "Unit Cost", type: "number" },
  { id: uid("f"), label: "Retail Price", type: "number" },
  { id: uid("f"), label: "Case Pack", type: "number" },
  { id: uid("f"), label: "Size", type: "text" },
  { id: uid("f"), label: "Unit of Measure", type: "select", options: "EA, LB, OZ, CT, PK" },
  { id: uid("f"), label: "Vendor", type: "text" },
  { id: uid("f"), label: "Country of Origin", type: "text" },
];

const DEFAULT_FIXTURE_SCHEMA = [
  { id: uid("f"), label: "Material", type: "text" },
  { id: uid("f"), label: "Color", type: "text" },
  { id: uid("f"), label: "Manufacturer", type: "text" },
  { id: uid("f"), label: "Load Capacity (lb)", type: "number" },
  { id: uid("f"), label: "Adjustable", type: "boolean" },
];

/* ------------------------------------------------------------------ */
/* Storage layer — now backed by Supabase (see src/lib/db.js). Every    */
/* read/write in this file already goes through these six functions,   */
/* so swapping the backend here is the only change needed.             */
/* ------------------------------------------------------------------ */

const storageOk = supabaseConfigured;

/* ------------------------------------------------------------------ */
/* Full backup export / import — the safety net until real persistence */
/* (a hosted database) exists. Everything the app knows about goes     */
/* into one downloadable JSON file, and can be loaded back in whole.   */
/* ------------------------------------------------------------------ */

const BACKUP_VERSION = 1;

function downloadFullBackup({ productSchema, fixtureSchema, planogramSchema, storeSchema, primaryKeyField, products, fixtures, planograms, performance, stores }) {
  const payload = {
    app: "Tandom Studio",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    productSchema, fixtureSchema, planogramSchema, storeSchema, primaryKeyField, products, fixtures, planograms, performance, stores,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tandom-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseBackupObject(data) {
  if (!data || typeof data !== "object") throw new Error("Not a valid backup file.");
  return {
    productSchema: Array.isArray(data.productSchema) ? data.productSchema : DEFAULT_PRODUCT_SCHEMA,
    fixtureSchema: Array.isArray(data.fixtureSchema) ? data.fixtureSchema : DEFAULT_FIXTURE_SCHEMA,
    planogramSchema: Array.isArray(data.planogramSchema) ? data.planogramSchema : [],
    storeSchema: Array.isArray(data.storeSchema) ? data.storeSchema : [],
    primaryKeyField: data.primaryKeyField === "upc" ? "upc" : "sku",
    products: Array.isArray(data.products) ? data.products : [],
    fixtures: Array.isArray(data.fixtures) ? data.fixtures : [],
    planograms: Array.isArray(data.planograms) ? data.planograms : [],
    performance: data.performance && typeof data.performance === "object" ? data.performance : {},
    stores: Array.isArray(data.stores) ? data.stores : [],
    exportedAt: data.exportedAt || null,
  };
}

function parseBackupFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        resolve(parseBackupObject(JSON.parse(e.target.result)));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsText(file);
  });
}

function parseBackupText(text) {
  return parseBackupObject(JSON.parse(text));
}

/* ------------------------------------------------------------------ */
/* Small shared UI atoms                                               */
/* ------------------------------------------------------------------ */

function Field({ label, children }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

// commits on a pause in typing (or immediately on blur) instead of writing to storage on every keystroke
function DebouncedTextInput({ value, onCommit, delay = 600, className, placeholder, type = "text" }) {
  const [local, setLocal] = useState(value || "");
  const timerRef = useRef(null);

  useEffect(() => { setLocal(value || ""); }, [value]);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleChange = (e) => {
    const v = e.target.value;
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onCommit(v), delay);
  };
  const handleBlur = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    onCommit(local);
  };

  return <input type={type} value={local} onChange={handleChange} onBlur={handleBlur} className={className} placeholder={placeholder} />;
}

function AttrInput({ field, value, onChange }) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-slate-700 py-1.5">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="accent-amber-500 w-4 h-4" />
        {field.label}
      </label>
    );
  }
  if (field.type === "select") {
    const opts = (field.options || "").split(",").map((s) => s.trim()).filter(Boolean);
    return (
      <Field label={field.label}>
        <select className={inputCls} value={value || ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {opts.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <Field label={field.label}>
      <input
        type={field.type === "number" ? "number" : "text"}
        className={inputCls}
        value={value ?? ""}
        onChange={(e) => onChange(field.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
      />
    </Field>
  );
}

function TabButton({ active, onClick, icon: Icon, badge, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
        active ? "border-amber-500 text-slate-900" : "border-transparent text-slate-400 hover:text-slate-600"
      }`}
    >
      <Icon size={16} />
      {children}
      {!!badge && <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold">{badge}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Schema editor (configurable attribute fields)                       */
/* ------------------------------------------------------------------ */

function BackupRestorePanel({ dataBundle, onImport }) {
  const [confirming, setConfirming] = useState(null); // parsed backup awaiting confirmation
  const [status, setStatus] = useState(null); // {type, message}
  const [busy, setBusy] = useState(false);
  const [textBackup, setTextBackup] = useState(null); // the JSON string, shown when the download fallback is used
  const [copyStatus, setCopyStatus] = useState(null);
  const [pasteImportOpen, setPasteImportOpen] = useState(false);
  const [pasteImportText, setPasteImportText] = useState("");
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  const counts = (b) => `${b.planograms.length} planogram${b.planograms.length !== 1 ? "s" : ""}, ${b.products.length} product${b.products.length !== 1 ? "s" : ""}, ${b.fixtures.length} fixture${b.fixtures.length !== 1 ? "s" : ""}, ${b.stores.length} store${b.stores.length !== 1 ? "s" : ""}`;

  const handleFileChosen = async (file) => {
    if (!file) return;
    setStatus(null);
    try {
      const parsed = await parseBackupFile(file);
      setConfirming(parsed);
    } catch (err) {
      setStatus({ type: "error", message: "Couldn't read that file — make sure it's a backup exported from this app." });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handlePasteImport = () => {
    setStatus(null);
    try {
      const parsed = parseBackupText(pasteImportText);
      setConfirming(parsed);
      setPasteImportOpen(false);
      setPasteImportText("");
    } catch (err) {
      setStatus({ type: "error", message: "That doesn't look like valid backup JSON — check that you copied the whole thing." });
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    try {
      await onImport(confirming);
      setStatus({ type: "ok", message: `Restored ${counts(confirming)}.` });
    } catch (err) {
      setStatus({ type: "error", message: "Import failed partway through — some data may be inconsistent. Try again." });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const copyBackupToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(textBackup);
      setCopyStatus("Copied!");
    } catch (err) {
      // clipboard API can also be blocked in sandboxed contexts — fall back to select-all so the user can Ctrl/Cmd+C manually
      if (textareaRef.current) { textareaRef.current.focus(); textareaRef.current.select(); }
      setCopyStatus("Couldn't auto-copy — text is selected, press Ctrl/Cmd+C");
    }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <h3 className="font-bold text-slate-800 text-sm mb-1">Backup &amp; Restore</h3>
      <p className="text-xs text-slate-500 mb-3">
        Everything in this app lives in this browser's storage — nothing is on a real server yet. Export a backup regularly, and especially before closing this tab for good, so you never have to rebuild from scratch.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <button className={btnPrimary} onClick={() => downloadFullBackup(dataBundle)}><Download size={14} /> Export Full Backup</button>
        <button
          className={btnGhost}
          onClick={() => { setTextBackup(JSON.stringify({ app: "Tandom Studio", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), ...dataBundle }, null, 2)); setCopyStatus(null); }}
        >
          <FileSpreadsheet size={14} /> Download not working? Copy as text
        </button>
        <button className={btnGhost} onClick={() => fileInputRef.current && fileInputRef.current.click()}><Upload size={14} /> Import Backup</button>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={(e) => handleFileChosen(e.target.files[0])} />
        <button className={btnGhost} onClick={() => { setPasteImportOpen((o) => !o); setStatus(null); }}><FileSpreadsheet size={14} /> Or paste backup text</button>
      </div>

      {pasteImportOpen && (
        <div className="mt-3 border border-slate-200 rounded-md p-3 bg-slate-50">
          <p className="text-xs text-slate-500 mb-2">Paste the full backup JSON you copied earlier.</p>
          <textarea
            value={pasteImportText}
            onChange={(e) => setPasteImportText(e.target.value)}
            placeholder='{"app": "Tandom Studio", ...}'
            className="w-full h-32 text-[10px] font-mono border border-slate-300 rounded p-2 bg-white"
          />
          <div className="flex items-center gap-2 mt-2">
            <button className={btnGhost} onClick={() => { setPasteImportOpen(false); setPasteImportText(""); }}>Cancel</button>
            <button className={btnPrimary} disabled={!pasteImportText.trim()} onClick={handlePasteImport}>Use This Backup</button>
          </div>
        </div>
      )}

      {textBackup && (
        <div className="mt-3 border border-slate-200 rounded-md p-3 bg-slate-50">
          <p className="text-xs text-slate-500 mb-2">
            Select all the text below and copy it (or click "Copy to Clipboard"), then paste it into a plain text file on your computer and save it with a <code>.json</code> extension. That file is your backup — use "Import Backup" with it later to restore.
          </p>
          <textarea
            ref={textareaRef}
            readOnly
            value={textBackup}
            onClick={(e) => e.target.select()}
            className="w-full h-40 text-[10px] font-mono border border-slate-300 rounded p-2 bg-white"
          />
          <div className="flex items-center gap-2 mt-2">
            <button className={btnPrimary} onClick={copyBackupToClipboard}><Check size={13} /> Copy to Clipboard</button>
            <button className={btnGhost} onClick={() => { setTextBackup(null); setCopyStatus(null); }}>Close</button>
            {copyStatus && <span className="text-xs text-slate-500">{copyStatus}</span>}
          </div>
        </div>
      )}

      {status && (
        <div className={`text-sm rounded-md px-3 py-2 mt-3 ${status.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {status.message}
        </div>
      )}

      {confirming && (
        <div className="mt-3 text-sm rounded-md px-3 py-2 bg-amber-50 text-amber-800 border border-amber-200 space-y-2">
          <div className="flex items-start gap-1.5"><AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              This will <strong>replace everything currently in the app</strong> with the backup{confirming.exportedAt ? ` from ${new Date(confirming.exportedAt).toLocaleString()}` : ""} ({counts(confirming)}). Anything not in this backup will be gone. This can't be undone.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button className={btnGhost} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            <button className={btnDanger} disabled={busy} onClick={confirmImport}>{busy ? "Restoring…" : "Replace All Data"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* User-defined attributes on planograms and stores, and column lists   */
/* ------------------------------------------------------------------ */

// How an attribute value reads in a list, on a card, or in a report.
function attrDisplay(field, v) {
  if (v === undefined || v === null || v === "") return "";
  if (field?.type === "boolean") return v === true || v === "true" ? "Yes" : "No";
  return String(v);
}
const attrOptions = (field) => String(field?.options || "").split(",").map((o) => o.trim()).filter(Boolean);
// The value to store for what was typed/picked: numbers as numbers, Yes/No as booleans, blank clears it.
function attrCoerce(field, raw) {
  if (raw === "" || raw === undefined || raw === null) return "";
  if (field?.type === "number") { const n = Number(raw); return Number.isFinite(n) ? n : ""; }
  if (field?.type === "boolean") return raw === true || raw === "true";
  return String(raw).trim();
}

// One attribute input of the right kind. `live` edits on every keystroke (forms with a Save button);
// otherwise text and numbers are committed after a pause or on leaving the box (inline cells).
function AttributeInput({ field, value, onChange, live = false, className = "" }) {
  const cls = className || inputCls;
  if (field.type === "select") {
    return (
      <select className={cls} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {attrOptions(field).concat(value && !attrOptions(field).includes(String(value)) ? [String(value)] : []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <select className={cls} value={value === true || value === "true" ? "true" : value === false || value === "false" ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? "" : e.target.value === "true")}>
        <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
      </select>
    );
  }
  const t = field.type === "number" ? "number" : "text";
  if (live) return <input type={t} className={cls} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
  return <DebouncedTextInput type={t} className={cls} value={value === undefined || value === null ? "" : String(value)} onCommit={(v) => onChange(v)} />;
}

// A labelled grid of every attribute a schema defines, for the forms and the planogram editor.
function AttributeFields({ schema, values, onChange, live = true, columns = "grid-cols-2 sm:grid-cols-3" }) {
  if (!schema || schema.length === 0) return null;
  return (
    <div className={`grid ${columns} gap-3`}>
      {schema.map((f) => (
        <Field key={f.id} label={f.label}>
          <AttributeInput field={f} live={live} value={values?.[f.id]} onChange={(v) => onChange({ ...(values || {}), [f.id]: attrCoerce(f, v) })} />
        </Field>
      ))}
    </div>
  );
}

// Which columns a list shows. Built-in columns plus one column per attribute the schema defines; the choice is
// remembered per browser. Attribute columns start switched off.
function useColumnPrefs(storageKey, builtin, attrSchema) {
  const columns = React.useMemo(
    () => [...builtin, ...(attrSchema || []).map((f) => ({ id: `attr:${f.id}`, label: f.label, attr: f, editable: true, type: f.type, defaultOn: false }))],
    [builtin, attrSchema],
  );
  const [saved, setSaved] = useState(() => {
    try { const v = JSON.parse(window.localStorage.getItem(storageKey) || "null"); if (Array.isArray(v)) return v; } catch (e) { /* storage unavailable: defaults */ }
    return null;
  });
  const ids = saved || builtin.filter((c) => c.defaultOn).map((c) => c.id);
  const visible = columns.filter((c) => c.locked || ids.includes(c.id));
  const toggle = (id) => setSaved((prev) => {
    const base = prev || builtin.filter((c) => c.defaultOn).map((c) => c.id);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch (e) { /* ignore */ }
    return next;
  });
  return { columns, visible, toggle };
}

function ColumnMenu({ columns, visible, onToggle, label = "Columns" }) {
  const [open, setOpen] = useState(false);
  const shown = new Set(visible.map((c) => c.id));
  const builtin = columns.filter((c) => !c.attr), attrs = columns.filter((c) => c.attr);
  const row = (c) => (
    <label key={c.id} className={`flex items-center gap-2 text-xs px-1.5 py-1 rounded ${c.locked ? "text-slate-400" : "text-slate-700 hover:bg-slate-50 cursor-pointer"}`}>
      <input type="checkbox" className="accent-amber-500" disabled={c.locked} checked={c.locked || shown.has(c.id)} onChange={() => onToggle(c.id)} />
      {c.label}
    </label>
  );
  return (
    <div className="relative">
      <button className={btnGhost} onClick={() => setOpen((v) => !v)}><Settings2 size={13} /> {label}</button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 max-h-80 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg p-2" onClick={(e) => e.stopPropagation()}>
          {builtin.map(row)}
          {attrs.length > 0 && <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mt-2 mb-0.5 px-1.5">Your attributes</div>}
          {attrs.map(row)}
          {attrs.length === 0 && <div className="text-[11px] text-slate-400 mt-2 px-1.5">Add your own fields under Settings to show them here.</div>}
          <button className="text-xs text-slate-500 hover:underline mt-1 px-1.5" onClick={() => setOpen(false)}>Done</button>
        </div>
      )}
    </div>
  );
}

// Small "Label: value" chips for the attribute columns a card should show.
function AttributeChips({ columns, entity }) {
  const chips = columns.filter((c) => c.attr).map((c) => [c.label, attrDisplay(c.attr, entity.attributes?.[c.attr.id])]).filter(([, v]) => v);
  if (chips.length === 0) return null;
  return <div className="flex flex-wrap gap-1 mt-1.5">{chips.map(([l, v]) => <span key={l} className="text-[10px] rounded-full px-2 py-0.5 bg-slate-100 text-slate-600 border border-slate-200">{l}: {v}</span>)}</div>;
}

function SchemaEditor({ title, schema, onChange, max }) {
  const [draft, setDraft] = useState({ label: "", type: "text", options: "" });

  const addField = () => {
    if (!draft.label.trim()) return;
    onChange([...schema, { id: uid("f"), label: draft.label.trim(), type: draft.type, options: draft.options }]);
    setDraft({ label: "", type: "text", options: "" });
  };
  const removeField = (id) => onChange(schema.filter((f) => f.id !== id));
  const updateField = (id, patch) => onChange(schema.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-bold text-slate-800">{title}</h3>
        <span className="text-xs text-slate-400 font-mono">{schema.length} / {max} fields defined</span>
      </div>
      <p className="text-sm text-slate-500 mb-4">
        Define the characteristic fields your team tracks. Up to {max} fields are supported; add only what you need.
      </p>

      <div className="space-y-2 mb-4 max-h-72 overflow-y-auto pr-1">
        {schema.length === 0 && <p className="text-sm text-slate-400 italic">No fields defined yet.</p>}
        {schema.map((f) => (
          <div key={f.id} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5">
            <input
              className="flex-1 bg-transparent text-sm font-medium text-slate-700 focus:outline-none"
              value={f.label}
              onChange={(e) => updateField(f.id, { label: e.target.value })}
            />
            <select
              className="text-xs rounded border border-slate-200 bg-white px-1.5 py-1"
              value={f.type}
              onChange={(e) => updateField(f.id, { type: e.target.value })}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Yes / No</option>
              <option value="select">Dropdown</option>
            </select>
            {f.type === "select" && (
              <input
                className="text-xs rounded border border-slate-200 bg-white px-1.5 py-1 w-32"
                placeholder="opt1, opt2, opt3"
                value={f.options || ""}
                onChange={(e) => updateField(f.id, { options: e.target.value })}
              />
            )}
            <button onClick={() => removeField(f.id)} className="text-slate-400 hover:text-red-500">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 pt-3">
        <input
          className={inputCls + " flex-1"}
          placeholder="New field label…"
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && addField()}
        />
        <select
          className="text-sm rounded-md border border-slate-300 px-2 py-1.5"
          value={draft.type}
          onChange={(e) => setDraft({ ...draft, type: e.target.value })}
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Yes / No</option>
          <option value="select">Dropdown</option>
        </select>
        <button className={btnPrimary} disabled={schema.length >= max || !draft.label.trim()} onClick={addField}>
          <Plus size={14} /> Add
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Orientation image picker for a product                              */
/* ------------------------------------------------------------------ */

function OrientationImages({ images, onChange, repo, lookupKey, upcLookup, upc }) {
  const fileInputs = useRef({});
  const [urlDrafts, setUrlDrafts] = useState({});
  const [matching, setMatching] = useState(false);
  const [matchMsg, setMatchMsg] = useState(null);
  const [matchingWeb, setMatchingWeb] = useState(false);
  const [webMatchMsg, setWebMatchMsg] = useState(null);

  const handleFile = (orientationId, file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange({ ...images, [orientationId]: reader.result });
    reader.readAsDataURL(file);
  };

  const commitUrl = (orientationId) => {
    const url = (urlDrafts[orientationId] || "").trim();
    if (!url) return;
    onChange({ ...images, [orientationId]: url });
    setUrlDrafts({ ...urlDrafts, [orientationId]: "" });
  };

  const matchFromRepo = async () => {
    if (!repo?.enabled || !lookupKey) return;
    setMatching(true);
    setMatchMsg(null);
    try {
      const found = {};
      let count = 0;
      for (const o of ORIENTATIONS) {
        if (images[o.id]) continue;
        const url = await findRepositoryImage(repo, lookupKey, o.id);
        if (url) { found[o.id] = url; count++; }
      }
      if (count > 0) onChange({ ...images, ...found });
      setMatchMsg(count > 0 ? `Matched ${count} image${count !== 1 ? "s" : ""}.` : "No matching images found in the repository.");
    } finally {
      setMatching(false);
    }
  };

  const matchFromWeb = async () => {
    if (!upcLookup?.enabled || !upc) return;
    setMatchingWeb(true);
    setWebMatchMsg(null);
    try {
      const key = normalizeUpcForKrogerCdn(upc);
      const found = {};
      let count = 0;
      for (const o of ORIENTATIONS) {
        if (images[o.id] && !isLowResWebImage(images[o.id])) continue; // keep good images; re-try thumbnails
        const url = await findRepositoryImage(upcLookup, key, o.id);
        if (url && url !== images[o.id]) { found[o.id] = url; count++; }
      }
      if (count > 0) onChange({ ...images, ...found });
      setWebMatchMsg(count > 0 ? `Matched ${count} image${count !== 1 ? "s" : ""}.` : "No image found on the web for that UPC.");
    } finally {
      setMatchingWeb(false);
    }
  };

  return (
    <div>
      {(repo?.enabled || upcLookup?.enabled) && (
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {repo?.enabled && (
            <button type="button" className={btnGhost} disabled={matching || !lookupKey} onClick={matchFromRepo}>
              {matching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
              {matching ? "Matching…" : "Match from Repository"}
            </button>
          )}
          {upcLookup?.enabled && (
            <button type="button" className={btnGhost} disabled={matchingWeb || !upc} onClick={matchFromWeb}>
              {matchingWeb ? <RefreshCw size={13} className="animate-spin" /> : <Globe size={13} />}
              {matchingWeb ? "Searching…" : "Find on Web (UPC)"}
            </button>
          )}
          {repo?.enabled && !lookupKey && <span className="text-xs text-slate-400">Set a SKU/UPC first to enable repository lookup.</span>}
          {upcLookup?.enabled && !upc && <span className="text-xs text-slate-400">Set a UPC first to enable web lookup.</span>}
          {matchMsg && <span className="text-xs text-slate-500">{matchMsg}</span>}
          {webMatchMsg && <span className="text-xs text-slate-500">{webMatchMsg}</span>}
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
      {ORIENTATIONS.map((o) => (
        <div key={o.id} className="border border-slate-200 rounded-md p-2 bg-slate-50">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-slate-600">{o.label}</span>
            {images[o.id] && (
              <button onClick={() => onChange({ ...images, [o.id]: null })} className="text-slate-400 hover:text-red-500">
                <X size={12} />
              </button>
            )}
          </div>
          <div
            className="h-16 rounded bg-white border border-dashed border-slate-300 flex items-center justify-center cursor-pointer overflow-hidden"
            onClick={() => fileInputs.current[o.id] && fileInputs.current[o.id].click()}
          >
            {images[o.id] ? (
              <img src={images[o.id]} alt={o.label} className="max-h-full max-w-full object-contain" />
            ) : (
              <ImageIcon size={16} className="text-slate-300" />
            )}
          </div>
          <input
            ref={(el) => (fileInputs.current[o.id] = el)}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => handleFile(o.id, e.target.files[0])}
          />
          <div className="flex items-center gap-1 mt-1.5">
            <input
              type="text"
              placeholder="Paste image URL…"
              className="flex-1 min-w-0 text-[11px] rounded border border-slate-200 bg-white px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-amber-400"
              value={urlDrafts[o.id] || ""}
              onChange={(e) => setUrlDrafts({ ...urlDrafts, [o.id]: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && commitUrl(o.id)}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); commitUrl(o.id); }}
              disabled={!(urlDrafts[o.id] || "").trim()}
              className="shrink-0 text-slate-400 hover:text-amber-600 disabled:opacity-30 disabled:hover:text-slate-400"
              title="Use this URL"
            >
              <Check size={13} />
            </button>
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Product library                                                     */
/* ------------------------------------------------------------------ */

// Merchandising Styles — alternate dimension sets for how a product can be merchandised beyond
// a single unit (e.g. a full case is a much bigger footprint than one box). "Unit" is always the
// product's own base dims; these are the additional, optional styles a product may also have.
// Matches ProSpace's own merchandising-style set for full parity when importing from it.
const MERCH_STYLE_DEFS = [
  { id: "tray", label: "Tray" },
  { id: "case", label: "Case" },
  { id: "display", label: "Display" },
  { id: "alternate", label: "Alternate" },
  { id: "loose", label: "Loose" },
  { id: "logStack", label: "Log Stack" },
];
const EMPTY_MERCH_STYLE = { w: 1, h: 1, d: 1, numWide: 1, numHigh: 1, numDeep: 1, totalNumber: 1, maxHigh: 0 };

function MerchStylesEditor({ merchStyles, onChange }) {
  const toggleStyle = (styleId, enabled) => {
    if (enabled) {
      onChange({ ...merchStyles, [styleId]: merchStyles[styleId] || { ...EMPTY_MERCH_STYLE } });
    } else {
      const next = { ...merchStyles };
      delete next[styleId];
      onChange(next);
    }
  };
  const updateStyle = (styleId, patch) => {
    onChange({ ...merchStyles, [styleId]: { ...merchStyles[styleId], ...patch } });
  };
  const numField = (styleId, data, key, label, step) => (
    <Field label={label}>
      <input
        type="number"
        step={step || "1"}
        className={inputCls}
        value={data[key]}
        onChange={(e) => updateStyle(styleId, { [key]: Number(e.target.value) || 0 })}
      />
    </Field>
  );

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        Define alternate dimensions for how this product can be merchandised (e.g. a full case is much bigger than a single unit).
        Leave a style off if this product is never sold or placed that way.
      </p>
      {MERCH_STYLE_DEFS.map((style) => {
        const data = merchStyles[style.id];
        const enabled = !!data;
        return (
          <div key={style.id} className="border border-slate-200 rounded-lg p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => toggleStyle(style.id, e.target.checked)} className="accent-amber-500 w-4 h-4" />
              {style.label}
            </label>
            {enabled && (
              <div className="mt-3 grid grid-cols-4 gap-2">
                {numField(style.id, data, "w", "Width (in)", "0.1")}
                {numField(style.id, data, "h", "Height (in)", "0.1")}
                {numField(style.id, data, "d", "Depth (in)", "0.1")}
                {numField(style.id, data, "maxHigh", "Max Stack High")}
                {numField(style.id, data, "numWide", "Units # Wide")}
                {numField(style.id, data, "numHigh", "Units # High")}
                {numField(style.id, data, "numDeep", "Units # Deep")}
                {numField(style.id, data, "totalNumber", "Total Units")}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProductForm({ schema, initial, primaryKeyField, imageRepo, upcLookup, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [sku, setSku] = useState(initial?.sku || "");
  const [dims, setDims] = useState(initial?.dims || { w: 3, h: 6, d: 3 });
  const [attributes, setAttributes] = useState(initial?.attributes || {});
  const [images, setImages] = useState(initial?.images || {});
  const [overhangIn, setOverhangIn] = useState(initial?.overhangIn || 0);
  const [squeezePct, setSqueezePct] = useState(Math.round((initial?.squeezeFactor ?? 1) * 100));
  const [merchStyles, setMerchStyles] = useState(initial?.merchStyles || {});
  const [merchStylesOpen, setMerchStylesOpen] = useState(Object.keys(initial?.merchStyles || {}).length > 0);
  const [pendingApproval, setPendingApproval] = useState(!!initial?.pendingApproval);
  const [resetProtected, setResetProtected] = useState(!!initial?.resetProtected);
  const [casePack, setCasePack] = useState(initial?.casePack ? String(initial.casePack) : "");
  const [dosTargetDays, setDosTargetDays] = useState(initial?.dosTargetDays ? String(initial.dosTargetDays) : "");

  const lookupKey = getPrimaryKeyValueRaw({ sku, attributes }, schema, imageRepo?.keyField || "upc");
  // the web (UPC API) lookup always needs an actual UPC, independent of whatever field the
  // Image Repository above is currently keyed on
  const upcValue = (getAttrByLabel({ attributes }, schema, ["upc"]) || "").trim();

  const save = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || uid("prod"),
      name: name.trim(),
      sku: sku.trim(),
      dims: { w: Number(dims.w) || 1, h: Number(dims.h) || 1, d: Number(dims.d) || 1 },
      attributes,
      images,
      overhangIn: Math.max(0, Number(overhangIn) || 0),
      squeezeFactor: clamp((Number(squeezePct) || 100) / 100, 0.5, 1),
      merchStyles,
      pendingApproval,
      resetProtected,
      casePack: Math.round(Number(casePack)) >= 1 ? Math.round(Number(casePack)) : undefined,
      dosTargetDays: Number(dosTargetDays) > 0 ? Number(dosTargetDays) : undefined,
      importSource: initial?.importSource,
    });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
      {pendingApproval && (
        <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <p className="text-xs text-amber-700">
            <span className="font-semibold">Imported from {initial?.importSource || "an external system"} — pending approval.</span> Review the details below, then approve or delete this item.
          </p>
          <button className="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-slate-900 hover:bg-amber-400" onClick={() => setPendingApproval(false)}>
            <Check size={12} /> Approve
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Product Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="SKU / Item #">
          <input className={inputCls} value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
      </div>

      <div>
        <label className={labelCls}>Dimensions (inches, W × H × D — as faced to customer)</label>
        <div className="grid grid-cols-3 gap-3">
          <input type="number" min="0.1" step="0.1" className={inputCls} value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} placeholder="Width" />
          <input type="number" min="0.1" step="0.1" className={inputCls} value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} placeholder="Height" />
          <input type="number" min="0.1" step="0.1" className={inputCls} value={dims.d} onChange={(e) => setDims({ ...dims, d: e.target.value })} placeholder="Depth" />
        </div>
      </div>

      <div>
        <label className={labelCls}>Shelf Behavior</label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Overhang Allowance (in)">
            <input type="number" min="0" step="0.5" className={inputCls} value={overhangIn} onChange={(e) => setOverhangIn(e.target.value)} />
          </Field>
          <Field label="Squeeze Factor (%)">
            <input type="number" min="50" max="100" step="5" className={inputCls} value={squeezePct} onChange={(e) => setSqueezePct(e.target.value)} />
          </Field>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">
          Overhang: how far this product can safely hang past the shelf edge before it's flagged as overflow (e.g. a bag of chips). Squeeze: how tightly it packs against neighbors for space calculations — 100% = no compression, doesn't change how it renders.
        </p>
      </div>

      <div>
        <label className={labelCls}>Supply</label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Case Pack (units per case)">
            <input type="number" min="1" step="1" className={inputCls} value={casePack} onChange={(e) => setCasePack(e.target.value)} placeholder="e.g. 12" />
          </Field>
          <Field label="Days of Supply Target (override)">
            <input type="number" min="0" step="0.5" className={inputCls} value={dosTargetDays} onChange={(e) => setDosTargetDays(e.target.value)} placeholder="uses category target" />
          </Field>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">Case pack is how the product ships from the warehouse; the shelf fill and the Reset Drafting Agent compare it with what the shelf holds. The override replaces the category's days-of-supply target for this product only.</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={resetProtected} onChange={(e) => setResetProtected(e.target.checked)} />
        Core / Must-Carry — the Reset Drafting Agent never reduces, deletes, or substitutes this item, regardless of performance.
      </label>

      <div>
        <button
          type="button"
          onClick={() => setMerchStylesOpen((o) => !o)}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
        >
          {merchStylesOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />} Merchandising Styles
          {Object.keys(merchStyles).length > 0 && <span className="text-[10px] normal-case font-medium text-amber-600">({Object.keys(merchStyles).length} defined)</span>}
        </button>
        {merchStylesOpen && (
          <div className="mt-2">
            <MerchStylesEditor merchStyles={merchStyles} onChange={setMerchStyles} />
          </div>
        )}
      </div>

      {schema.length > 0 && (
        <div>
          <label className={labelCls}>Attributes</label>
          <div className="grid grid-cols-3 gap-3">
            {schema.map((f) => (
              <AttrInput key={f.id} field={f} value={attributes[f.id]} onChange={(v) => setAttributes({ ...attributes, [f.id]: v })} />
            ))}
          </div>
        </div>
      )}

      <div>
        <label className={labelCls}>Orientation Images</label>
        <OrientationImages images={images} onChange={setImages} repo={imageRepo} lookupKey={lookupKey} upcLookup={upcLookup} upc={upcValue} />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={save}><Save size={14} /> Save Product</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Excel template + bulk import for the product library                */
/* ------------------------------------------------------------------ */

const CORE_PRODUCT_HEADERS = ["Name", "SKU", "Width (in)", "Height (in)", "Depth (in)"];

function downloadProductTemplate(schema) {
  const headers = [...CORE_PRODUCT_HEADERS, ...schema.map((f) => f.label)];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Products");

  const instrRows = [
    ["Field", "Type", "Notes"],
    ["Name", "Text", "Required"],
    ["SKU", "Text", "Optional"],
    ["Width (in)", "Number", "Required — front-facing width"],
    ["Height (in)", "Number", "Required"],
    ["Depth (in)", "Number", "Required"],
    ...schema.map((f) => [
      f.label,
      f.type,
      f.type === "select" ? `Enter one of: ${f.options || "(no options defined)"}` : f.type === "boolean" ? "Enter Yes or No" : "",
    ]),
    [],
    ["Note:", "Fill in the Products sheet, one row per product. Product images are added afterward in the app (per orientation)."],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(instrRows);
  ws2["!cols"] = [{ wch: 20 }, { wch: 12 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Instructions");

  XLSX.writeFile(wb, "product_import_template.xlsx");
}

function parseProductsWorkbook(file, schema) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "products") || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

        const newProducts = rows
          .filter((r) => String(r["Name"] || "").trim())
          .map((r) => {
            const attributes = {};
            schema.forEach((f) => {
              const raw = r[f.label];
              if (raw === undefined || raw === "") return;
              if (f.type === "number") attributes[f.id] = Number(raw) || 0;
              else if (f.type === "boolean") attributes[f.id] = /^(y|yes|true|1)$/i.test(String(raw).trim());
              else attributes[f.id] = String(raw);
            });
            return {
              id: uid("prod"),
              name: String(r["Name"]).trim(),
              sku: String(r["SKU"] || "").trim(),
              dims: {
                w: Number(r["Width (in)"]) || 1,
                h: Number(r["Height (in)"]) || 1,
                d: Number(r["Depth (in)"]) || 1,
              },
              attributes,
              images: {},
            };
          });
        resolve(newProducts);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsArrayBuffer(file);
  });
}

/* ------------------------------------------------------------------ */
/* Performance data — weekly unit cost / price / movement per product   */
/* ------------------------------------------------------------------ */

const PERIOD_OPTIONS = [4, 13, 26, 52];

function toISODate(v) {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return "";
}

function downloadPerformanceTemplate(primaryKeyField, format = "xlsx") {
  const keyLabel = primaryKeyField === "upc" ? "UPC" : "SKU";
  const headers = ["Store Name", "Store Number", "Product Name", keyLabel, "Week Ending (YYYY-MM-DD)", "Unit Cost", "Retail Price", "Units Sold"];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(16, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Performance");
  const instrRows = [
    ["Field", "Notes"],
    ["Store Name", "Must match a store in your Store Library (or leave blank if Store Number is filled in)"],
    ["Store Number", "Preferred match key — used instead of Store Name when present"],
    ["Product Name", `Must match a product in your library (or leave blank if ${keyLabel} is filled in)`],
    [keyLabel, `Preferred match key (your Product Primary Key setting) — used instead of Name when present`],
    ["Week Ending (YYYY-MM-DD)", "One row per product per store per week"],
    ["Unit Cost", "Cost to the store for one unit, that week"],
    ["Retail Price", "Shelf price for one unit, that week"],
    ["Units Sold", "Movement for that product at that store that week"],
    [],
    ["Note:", "Leave Store Name/Number blank for chain-level or blended data with no store attribution. Load as many weeks of history as you have — the app rolls it up into 4/13/26/52-week views automatically."],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(instrRows);
  ws2["!cols"] = [{ wch: 24 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Instructions");
  if (format === "csv") {
    // CSV holds one sheet only: the header row to fill in (the field notes stay in the Excel versions)
    const blob = new Blob([XLSX.utils.sheet_to_csv(ws)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "performance_import_template.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (format === "xls") { XLSX.writeFile(wb, "performance_import_template.xls", { bookType: "biff8" }); return; }
  XLSX.writeFile(wb, "performance_import_template.xlsx");
}

function parsePerformanceWorkbook(file, products, stores, productSchema, primaryKeyField) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const isCsv = /\.csv$/i.test(file.name || "");
        const wb = XLSX.read(data, { type: "array", cellDates: true, raw: isCsv }); // CSV keeps cell text as-is (UPCs stay text)
        const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "performance") || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

        const keyLabel = primaryKeyField === "upc" ? "UPC" : "SKU";
        const byKey = {};
        const byName = {};
        products.forEach((p) => {
          const key = getPrimaryKeyValue(p, productSchema, primaryKeyField);
          if (key) byKey[key] = p.id;
          byName[p.name.trim().toLowerCase()] = p.id;
        });

        const storeByNumber = {};
        const storeByName = {};
        (stores || []).forEach((s) => {
          if (s.storeNumber) storeByNumber[s.storeNumber.trim().toLowerCase()] = s.id;
          storeByName[s.name.trim().toLowerCase()] = s.id;
        });

        const grouped = {}; // productId -> [{weekEnding, unitCost, price, units, storeId}]
        let matchedRows = 0;
        let unmatchedRows = 0;
        let unmatchedStoreRows = 0;

        rows.forEach((r) => {
          const key = String(r[keyLabel] || "").trim().toLowerCase();
          const name = String(r["Product Name"] || "").trim().toLowerCase();
          const productId = (key && byKey[key]) || (name && byName[name]) || null;
          const weekEnding = toISODate(r["Week Ending (YYYY-MM-DD)"] || r["Week Ending"]);
          if (!productId || !weekEnding) { unmatchedRows++; return; }

          const storeNum = String(r["Store Number"] || "").trim().toLowerCase();
          const storeName = String(r["Store Name"] || "").trim().toLowerCase();
          let storeId = "";
          if (storeNum || storeName) {
            storeId = (storeNum && storeByNumber[storeNum]) || (storeName && storeByName[storeName]) || null;
            if (storeId === null) { unmatchedStoreRows++; return; }
          }

          const rec = {
            weekEnding,
            unitCost: Number(r["Unit Cost"]) || 0,
            price: Number(r["Retail Price"]) || 0,
            units: Number(r["Units Sold"]) || 0,
            storeId: storeId || "",
          };
          if (!grouped[productId]) grouped[productId] = [];
          grouped[productId].push(rec);
          matchedRows++;
        });

        resolve({ grouped, matchedRows, unmatchedRows, unmatchedStoreRows, totalRows: rows.length });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsArrayBuffer(file);
  });
}

// merge newly-imported weekly records into a product's existing history, upserting by week+store
function mergePerformanceRecords(existing, incoming) {
  const byKey = {};
  const keyOf = (r) => `${r.weekEnding}|${r.storeId || ""}`;
  (existing || []).forEach((r) => { byKey[keyOf(r)] = r; });
  incoming.forEach((r) => { byKey[keyOf(r)] = r; });
  return Object.values(byKey).sort((a, b) => a.weekEnding.localeCompare(b.weekEnding) || (a.storeId || "").localeCompare(b.storeId || ""));
}

function getLatestWeekEnding(performanceMap) {
  let latest = null;
  Object.values(performanceMap).forEach((records) => {
    (records || []).forEach((r) => { if (!latest || r.weekEnding > latest) latest = r.weekEnding; });
  });
  return latest;
}

function getCutoffISO(latestISO, weeks) {
  if (!latestISO) return null;
  const d = new Date(latestISO + "T00:00:00");
  d.setDate(d.getDate() - weeks * 7 + 1);
  return d.toISOString().slice(0, 10);
}

// count distinct weeks actually loaded (optionally scoped to one store) — used to warn about
// and disable analysis periods (4/13/26/52 wks) that exceed the history you've uploaded
function countAvailableWeeks(performanceMap, storeId) {
  const weeks = new Set();
  Object.values(performanceMap).forEach((records) => {
    (records || []).forEach((r) => {
      if (storeId && r.storeId !== storeId) return;
      weeks.add(r.weekEnding);
    });
  });
  return weeks.size;
}

// aggregate one product's weekly records into period-level metrics.
// storeId: undefined/null = blended across all stores (and unattributed rows); a store id = that store only
function aggregateProductPerformance(productId, performanceMap, cutoffISO, storeId) {
  const records = performanceMap[productId] || [];
  let inWindow = cutoffISO ? records.filter((r) => r.weekEnding >= cutoffISO) : records;
  if (storeId) inWindow = inWindow.filter((r) => r.storeId === storeId);
  if (inWindow.length === 0) return null;
  const totalUnits = inWindow.reduce((s, r) => s + (r.units || 0), 0);
  // Total Revenue = Unit Price × Unit Movement
  const totalSales = inWindow.reduce((s, r) => s + (r.units || 0) * (r.price || 0), 0);
  // COGS = Unit Cost × Unit Movement
  const totalCost = inWindow.reduce((s, r) => s + (r.units || 0) * (r.unitCost || 0), 0);
  // Total Gross Profit = Revenue − COGS
  const grossProfit = totalSales - totalCost;
  const weeksOfData = inWindow.length;
  const avgUnitCost = totalUnits > 0 ? totalCost / totalUnits : inWindow.reduce((s, r) => s + (r.unitCost || 0), 0) / inWindow.length;
  const avgPrice = totalUnits > 0 ? totalSales / totalUnits : inWindow.reduce((s, r) => s + (r.price || 0), 0) / inWindow.length;
  // Profit Per Unit = Unit Price − Unit Cost
  const unitProfit = avgPrice - avgUnitCost;
  // Gross Margin % = Unit Profit / Unit Price × 100
  const grossMarginPct = avgPrice > 0 ? (unitProfit / avgPrice) * 100 : 0;
  return {
    productId, weeksOfData, totalUnits,
    avgWeeklyUnits: weeksOfData > 0 ? totalUnits / weeksOfData : 0,
    totalSales, totalCost, grossProfit, unitProfit, grossMarginPct, avgUnitCost, avgPrice,
  };
}

// Same as aggregateProductPerformance, but bounded on both ends (startISO..endISO inclusive)
// instead of an open-ended cutoff — used to pull one specific historical window (e.g. "the same
// 13 weeks, one year ago") for year-over-year comparisons.
function aggregateProductPerformanceRange(productId, performanceMap, startISO, endISO, storeId) {
  const records = performanceMap[productId] || [];
  let inWindow = records.filter((r) => (!startISO || r.weekEnding >= startISO) && (!endISO || r.weekEnding <= endISO));
  if (storeId) inWindow = inWindow.filter((r) => r.storeId === storeId);
  if (inWindow.length === 0) return { totalUnits: 0, totalSales: 0, totalCost: 0, grossProfit: 0, weeksOfData: 0 };
  const totalUnits = inWindow.reduce((s, r) => s + (r.units || 0), 0);
  const totalSales = inWindow.reduce((s, r) => s + (r.units || 0) * (r.price || 0), 0);
  const totalCost = inWindow.reduce((s, r) => s + (r.units || 0) * (r.unitCost || 0), 0);
  return { totalUnits, totalSales, totalCost, grossProfit: totalSales - totalCost, weeksOfData: inWindow.length };
}

// Percent change from `prior` to `current`; null when there's nothing to compare against
// (no prior-period data at all, as opposed to a genuine drop to zero).
function pctChange(current, prior) {
  if (!prior) return current > 0 ? null : 0;
  return ((current - prior) / prior) * 100;
}

// Reset Impact (see supabase/functions/_shared/reset-impact.js). Rolling store rows up into groups.
// A row carries weekly-average `pre`/`post` {sales, units, margin}, the `controlChange` of its
// planogram (what similar stores that did not reset did, as a fraction, or null) and that planogram's
// `space` {preLinearFt, postLinearFt}. Lift = actual after-total minus what the control trend predicts
// (pre x (1 + control change)), as points of the before-total, so groups of any mix add up correctly.
const IMPACT_METRICS = ["sales", "units", "margin"];
function rollupImpactRows(rows, label = "All stores") {
  const metrics = {};
  IMPACT_METRICS.forEach((m) => {
    const pre = rows.reduce((t, r) => t + r.pre[m], 0);
    const post = rows.reduce((t, r) => t + r.post[m], 0);
    const adj = rows.filter((r) => r.controlChange && r.controlChange[m] != null);
    const adjPre = adj.reduce((t, r) => t + r.pre[m], 0);
    const adjPost = adj.reduce((t, r) => t + r.post[m], 0);
    const expected = adj.reduce((t, r) => t + r.pre[m] * (1 + r.controlChange[m]), 0);
    metrics[m] = { pre, post, changePct: pre > 0 ? (post / pre - 1) * 100 : null, liftPp: adjPre > 0 ? ((adjPost - expected) / adjPre) * 100 : null };
  });
  const lfRows = rows.filter((r) => r.space && r.space.preLinearFt > 0 && r.space.postLinearFt > 0);
  const lfPre = lfRows.reduce((t, r) => t + r.space.preLinearFt, 0);
  const lfPost = lfRows.reduce((t, r) => t + r.space.postLinearFt, 0);
  const sPre = lfRows.reduce((t, r) => t + r.pre.sales, 0);
  const sPost = lfRows.reduce((t, r) => t + r.post.sales, 0);
  const salesPerLinearFt = lfPre > 0 && lfPost > 0 && sPre > 0 ? { pre: sPre / lfPre, post: sPost / lfPost, changePct: ((sPost / lfPost) / (sPre / lfPre) - 1) * 100 } : null;
  return { label, stores: new Set(rows.map((r) => r.storeId)).size, rows: rows.length, planograms: new Set(rows.map((r) => r.planogramId).filter(Boolean)).size, metrics, salesPerLinearFt };
}

const IMPACT_DIMENSIONS = [
  { id: "region", label: "Region" },
  { id: "store", label: "Store" },
  { id: "category", label: "Category" },
  { id: "department", label: "Department" },
  { id: "cluster", label: "Cluster" },
  { id: "format", label: "Store format" },
  { id: "planogram", label: "Planogram" },
];
// impacts: computeResetImpact results (status "ok"). Only stores with a full after-window ("measured") count;
// maturing stores are tallied separately so nobody reads a half-finished result as final.
// `lookup` (optional) lets a summary group by a user-defined attribute: { stores, planograms, fields }, where
// dimensions "sattr:<fieldId>" / "pattr:<fieldId>" read the store's / planogram's attributes.
function rollupResetImpact(impacts, dimension, lookup) {
  const attrLabel = (entity, fieldId) => {
    const v = entity && entity.attributes ? entity.attributes[fieldId] : undefined;
    return v === undefined || v === null || v === "" ? "" : v === true ? "Yes" : v === false ? "No" : String(v);
  };
  const byId = (list) => Object.fromEntries((list || []).map((x) => [x.id, x]));
  const storesById = lookup ? byId(lookup.stores) : {}, planogramsById = lookup ? byId(lookup.planograms) : {};
  const groups = new Map();
  let maturing = 0;
  (impacts || []).filter((i) => i && i.status === "ok").forEach((imp) => {
    (imp.rows || []).forEach((r) => {
      if (r.status === "maturing") maturing++;
      if (r.status !== "measured") return;
      const attrDim = typeof dimension === "string" && /^[sp]attr:/.test(dimension);
      const label = attrDim ? (dimension[0] === "s" ? attrLabel(storesById[r.storeId], dimension.slice(6)) : attrLabel(planogramsById[imp.planogramId], dimension.slice(6))) || `(No ${(lookup && lookup.fields && lookup.fields[dimension]) || "value"})` : ({
        region: r.region, store: `${r.storeName}${r.storeNumber ? ` (#${r.storeNumber})` : ""}`, format: r.format,
        category: imp.planogram.category, department: imp.planogram.department, cluster: imp.planogram.cluster, planogram: imp.planogram.name,
      }[dimension]) || `(No ${(IMPACT_DIMENSIONS.find((d) => d.id === dimension) || {}).label || dimension})`;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ ...r, planogramId: imp.planogramId, space: imp.space, controlChange: imp.control ? imp.control.change : null });
    });
  });
  const out = [...groups.entries()].map(([label, rows]) => rollupImpactRows(rows, label));
  out.sort((a, b) => (b.metrics.sales.post - b.metrics.sales.pre) - (a.metrics.sales.post - a.metrics.sales.pre));
  return { groups: out, total: out.length ? rollupImpactRows([...groups.values()].flat(), "All") : null, maturing };
}

const money = (n) => `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${Math.round(n || 0).toLocaleString()}`;

/* ------------------------------------------------------------------ */
/* Product overlay — configurable metrics + product details             */
/* shown directly on (or over) the product facing in the planogram      */
/* ------------------------------------------------------------------ */

const METRIC_FIELDS = [
  { id: "totalSales", label: "Total Revenue", format: (v) => money0(v) },
  { id: "totalCost", label: "COGS", format: (v) => money0(v) },
  { id: "grossProfit", label: "Total Gross Profit", format: (v) => money0(v) },
  { id: "unitProfit", label: "Profit Per Unit", format: (v) => money(v) },
  { id: "grossMarginPct", label: "Gross Margin %", format: (v) => `${v.toFixed(1)}%` },
];

const DEFAULT_OVERLAY_SETTINGS = {
  mode: "off", // off | always | noImageOnly
  metrics: ["totalSales", "grossMarginPct"],
  details: ["name"],
  layout: "compact", // compact | detailed
  position: "bottom", // top | bottom | center
  showLabels: true, // false = show just the value ("$1.24") instead of "Profit Per Unit: $1.24"
  wrapText: false, // true = wrap onto multiple lines instead of truncating with an ellipsis
};

function resolveOverlayLines(product, placement, metrics, schema, settings) {
  const detailLines = (settings.details || []).map((key) => {
    if (key === "name") return product.name;
    if (key === "sku") return product.sku || "";
    const field = (schema || []).find((f) => f.id === key);
    if (!field) return "";
    const v = product.attributes?.[field.id];
    return v === undefined || v === null || v === "" ? "" : String(v);
  }).filter(Boolean);

  // kept as {label, value} pairs rather than one pre-joined string, so rendering can choose to
  // show the value alone — the label by itself was sometimes already wide enough to fill the
  // whole box, truncating before the actual number ever appeared
  const metricLines = (settings.metrics || []).map((key) => {
    if (!metrics) return null;
    if (key === "facingProductivity") {
      const perFacing = (metrics.totalSales / metrics.weeksOfData) / (placement.facings || 1);
      return { label: "$/Facing/Wk", value: money(perFacing) };
    }
    const def = METRIC_FIELDS.find((m) => m.id === key);
    if (!def || metrics[key] === undefined) return null;
    return { label: def.label, value: def.format(metrics[key]) };
  }).filter(Boolean);

  return { detailLines, metricLines };
}

// Product Library List view — built-in (non-attribute) columns always available, in addition to
// any of the product's configurable attribute fields. Column selection is user-customizable so
// a long product library can be scanned much faster than paging through cards.
const PRODUCT_LIST_BASE_COLUMNS = [
  { id: "name", label: "Name" },
  { id: "sku", label: "SKU" },
  { id: "dims", label: "Dimensions" },
];
const DEFAULT_PRODUCT_LIST_COLUMNS = ["name", "sku", "dims"];

function getProductColumnLabel(columnId, schema) {
  const base = PRODUCT_LIST_BASE_COLUMNS.find((c) => c.id === columnId);
  if (base) return base.label;
  const field = schema.find((f) => f.id === columnId);
  return field ? field.label : columnId;
}

function getProductColumnValue(p, columnId, schema) {
  if (columnId === "name") return p.name;
  if (columnId === "sku") return p.sku || "—";
  if (columnId === "dims") return `${p.dims.w}×${p.dims.h}×${p.dims.d} in`;
  const field = schema.find((f) => f.id === columnId);
  if (!field) return "—";
  const v = p.attributes?.[columnId];
  if (v === undefined || v === null || v === "") return "—";
  if (field.type === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function ProductColumnsPopover({ schema, visibleColumns, onToggle, onReorder, onClose }) {
  const availableColumns = [...PRODUCT_LIST_BASE_COLUMNS.map((c) => c.id), ...schema.map((f) => f.id)].filter((id) => !visibleColumns.includes(id));
  return (
    <div
      className="absolute z-30 top-full right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg p-3 max-h-96 overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-slate-600">Visible columns</span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
      </div>
      {visibleColumns.length === 0 ? (
        <p className="text-[11px] text-slate-400 italic mb-2">No columns selected — add one below.</p>
      ) : (
        <div className="space-y-1 mb-3">
          {visibleColumns.map((colId, i) => (
            <div key={colId} className="flex items-center gap-1 text-xs bg-slate-50 border border-slate-200 rounded px-1.5 py-1">
              <div className="flex flex-col shrink-0">
                <button
                  disabled={i === 0}
                  onClick={() => onReorder(i, i - 1)}
                  title="Move up"
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-25 disabled:hover:text-slate-400 leading-none"
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  disabled={i === visibleColumns.length - 1}
                  onClick={() => onReorder(i, i + 1)}
                  title="Move down"
                  className="text-slate-400 hover:text-slate-700 disabled:opacity-25 disabled:hover:text-slate-400 leading-none"
                >
                  <ChevronDown size={12} />
                </button>
              </div>
              <span className="flex-1 truncate text-slate-700">{getProductColumnLabel(colId, schema)}</span>
              <button onClick={() => onToggle(colId)} title="Remove column" className="text-slate-300 hover:text-red-500 shrink-0"><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
      {availableColumns.length > 0 && (
        <>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 border-t border-slate-100 pt-2">Add a column</div>
          <div className="space-y-1">
            {availableColumns.map((colId) => (
              <button
                key={colId}
                onClick={() => onToggle(colId)}
                className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-amber-600 py-0.5 w-full text-left"
              >
                <Plus size={11} className="shrink-0" /> {getProductColumnLabel(colId, schema)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProductLibrary({ schema, products, primaryKeyField, imageRepo, upcLookup, onCreate, onUpdate, onDelete, isAdmin }) {
  const [editing, setEditing] = useState(null); // null | "new" | product
  const [importStatus, setImportStatus] = useState(null); // {type:'ok'|'error', message}
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null); // {current, total}
  const [matchingRepo, setMatchingRepo] = useState(false);
  const [matchProgress, setMatchProgress] = useState(null);
  const [matchStatus, setMatchStatus] = useState(null);
  const [matchingWeb, setMatchingWeb] = useState(false);
  const [webMatchProgress, setWebMatchProgress] = useState(null);
  const [webMatchStatus, setWebMatchStatus] = useState(null);
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_PRODUCT_LIST_COLUMNS);
  const [columnsPickerOpen, setColumnsPickerOpen] = useState(false);
  const toggleColumn = (colId) => setVisibleColumns((prev) => (prev.includes(colId) ? prev.filter((c) => c !== colId) : [...prev, colId]));
  const [columnWidths, setColumnWidths] = useState({}); // colId -> px; falls back to a default when unset
  const resizingRef = useRef(null);
  const [query, setQuery] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const pendingCount = React.useMemo(() => products.filter((p) => p.pendingApproval).length, [products]);
  // Admin-only bulk delete: checkbox selection, Select All (everything the current search/filter shows), Delete Selected
  const [selectedForDelete, setSelectedForDelete] = useState(() => new Set());
  const toggleSelectedForDelete = (id) => setSelectedForDelete((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // matches against name, SKU, AND every attribute value — not just name — so typing anything
  // that appears anywhere on the product (a size, a vendor, a color) filters it in immediately
  const filteredProducts = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (pendingOnly && !p.pendingApproval) return false;
      if (!q) return true;
      if (p.name && p.name.toLowerCase().includes(q)) return true;
      if (p.sku && String(p.sku).toLowerCase().includes(q)) return true;
      if (p.attributes) {
        for (const key in p.attributes) {
          const v = p.attributes[key];
          if (v !== undefined && v !== null && String(v).toLowerCase().includes(q)) return true;
        }
      }
      return false;
    });
  }, [products, query, pendingOnly]);
  const [sortColumn, setSortColumn] = useState(null); // colId, or null = unsorted (creation order)
  const [sortDirection, setSortDirection] = useState("asc");
  const handleColumnSortClick = (colId) => {
    if (sortColumn === colId) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(colId);
      setSortDirection("asc");
    }
  };
  // numeric compare when both sides genuinely look like numbers (so price/cost/case-pack columns
  // sort by magnitude, not lexicographically), text compare otherwise; empties always sort last
  // regardless of direction, since "unset" isn't meaningfully high or low
  const sortedProducts = React.useMemo(() => {
    if (!sortColumn) return filteredProducts;
    const dir = sortDirection === "desc" ? -1 : 1;
    return [...filteredProducts].sort((a, b) => {
      const va = getProductColumnValue(a, sortColumn, schema);
      const vb = getProductColumnValue(b, sortColumn, schema);
      const aEmpty = va === "—", bEmpty = vb === "—";
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const na = parseFloat(va), nb = parseFloat(vb);
      const bothNumeric = /^-?[\d.]+$/.test(va) && /^-?[\d.]+$/.test(vb);
      if (bothNumeric) return (na - nb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [filteredProducts, sortColumn, sortDirection, schema]);
  const reorderColumn = (fromIdx, toIdx) => {
    setVisibleColumns((prev) => {
      if (toIdx < 0 || toIdx >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };
  const handleColumnResizeStart = (e, colId) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = { colId, startX: e.clientX, startWidth: columnWidths[colId] || 160 };
    const handleMove = (e2) => {
      const d = resizingRef.current;
      if (!d) return;
      const nextWidth = Math.max(60, d.startWidth + (e2.clientX - d.startX));
      setColumnWidths((prev) => ({ ...prev, [d.colId]: nextWidth }));
    };
    const handleUp = () => {
      resizingRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };
  const fileInputRef = useRef(null);

  const approveAllPending = () => {
    products.filter((p) => p.pendingApproval).forEach((p) => onUpdate({ ...p, pendingApproval: false }));
    // the pending-only filter would otherwise keep showing an empty grid once nothing left matches it
    setPendingOnly(false);
  };
  const selectedProductIds = isAdmin ? filteredProducts.filter((p) => selectedForDelete.has(p.id)).map((p) => p.id) : [];
  const allShownSelected = filteredProducts.length > 0 && filteredProducts.every((p) => selectedForDelete.has(p.id));
  const toggleSelectAll = () => setSelectedForDelete(allShownSelected ? new Set() : new Set(filteredProducts.map((p) => p.id)));
  const deleteSelected = () => {
    if (!isAdmin) return;
    const ids = selectedProductIds;
    if (ids.length === 0) return;
    const msg = `Are you sure you want to delete ${ids.length === products.length ? "ALL " : ""}${ids.length} product${ids.length !== 1 ? "s" : ""} from the Product Library?\n\nThis can't be undone, and any placements of them on planograms will be affected.`;
    if (!window.confirm(msg)) return;
    ids.forEach((id) => onDelete(id));
    setSelectedForDelete(new Set());
  };
  const deleteAllPending = () => {
    const targets = products.filter((p) => p.pendingApproval);
    if (targets.length === 0) return;
    if (!window.confirm(`Delete all ${targets.length} pending product${targets.length !== 1 ? "s" : ""}? This can't be undone.`)) return;
    targets.forEach((p) => onDelete(p.id));
    // same reason — clear the filter so the (now empty of pending) library renders immediately
    setPendingOnly(false);
  };

  const matchAllFromRepo = async () => {
    if (!imageRepo?.enabled) return;
    const targets = products.filter((p) => ORIENTATIONS.some((o) => !p.images?.[o.id]));
    if (targets.length === 0) { setMatchStatus({ type: "ok", message: "Every product already has all 6 orientation images." }); return; }
    setMatchingRepo(true);
    setMatchStatus(null);
    setMatchProgress({ current: 0, total: targets.length });
    let productsMatched = 0;
    let imagesMatched = 0;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      const { images, matchedCount } = await matchProductImagesFromRepo(p, imageRepo, schema);
      if (matchedCount > 0) {
        onUpdate({ ...p, images });
        productsMatched++;
        imagesMatched += matchedCount;
      }
      setMatchProgress({ current: i + 1, total: targets.length });
    }
    setMatchingRepo(false);
    setMatchProgress(null);
    setMatchStatus({
      type: "ok",
      message: productsMatched > 0
        ? `Matched ${imagesMatched} image${imagesMatched !== 1 ? "s" : ""} across ${productsMatched} product${productsMatched !== 1 ? "s" : ""}.`
        : "No matching images found in the repository for any product missing one.",
    });
  };

  // Backfills the "front" image (the only view a UPC-lookup API can reliably return) for every
  // product that's missing one and has a UPC on file — the case that motivated this: images
  // aren't always ready when a planogram is first built, so this fills the gaps after the fact,
  // same as "Match Images from Repository" does for the internal repo.
  const matchAllFromWeb = async () => {
    if (!upcLookup?.enabled) return;
    const targets = products.filter((p) => ORIENTATIONS.some((o) => !p.images?.[o.id] || isLowResWebImage(p.images[o.id])) && (getAttrByLabel(p, schema, ["upc"]) || "").trim());
    if (targets.length === 0) { setWebMatchStatus({ type: "ok", message: "Every product either already has all 6 orientation images (none of them low-resolution) or has no UPC to look up." }); return; }
    setMatchingWeb(true);
    setWebMatchStatus(null);
    setWebMatchProgress({ current: 0, total: targets.length });
    let productsMatched = 0;
    let imagesMatched = 0;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      const { images, matchedCount } = await matchProductImagesFromWebCdn(p, upcLookup, schema);
      if (matchedCount > 0) {
        onUpdate({ ...p, images });
        productsMatched++;
        imagesMatched += matchedCount;
      }
      setWebMatchProgress({ current: i + 1, total: targets.length });
    }
    setMatchingWeb(false);
    setWebMatchProgress(null);
    setWebMatchStatus({
      type: "ok",
      message: productsMatched > 0
        ? `Matched ${imagesMatched} image${imagesMatched !== 1 ? "s" : ""} across ${productsMatched} product${productsMatched !== 1 ? "s" : ""} from the web.`
        : "No matches found on the web for any product missing an image.",
    });
  };

  const handleFileChosen = async (file) => {
    if (!file) return;
    setImporting(true);
    setImportStatus(null);
    setImportProgress({ current: 0, total: 0, phase: "reading" });
    try {
      const parsedProducts = await parseProductsWorkbook(file, schema);
      if (parsedProducts.length === 0) {
        setImportStatus({ type: "error", message: "No rows with a Name were found in that file." });
      } else {
        const byKey = {};
        const byName = {};
        products.forEach((p) => {
          const key = getPrimaryKeyValue(p, schema, primaryKeyField);
          if (key) byKey[key] = p;
          byName[p.name.trim().toLowerCase()] = p;
        });

        let createdCount = 0;
        let updatedCount = 0;
        setImportProgress({ current: 0, total: parsedProducts.length, phase: "importing" });
        for (let i = 0; i < parsedProducts.length; i++) {
          const parsed = parsedProducts[i];
          const key = getPrimaryKeyValue(parsed, schema, primaryKeyField);
          const nameKey = parsed.name.trim().toLowerCase();
          const existing = (key && byKey[key]) || byName[nameKey];
          if (existing) {
            // update in place — keep the existing id and images, refresh everything else from the file
            onUpdate({ ...existing, ...parsed, id: existing.id, images: existing.images });
            updatedCount++;
          } else {
            onCreate(parsed);
            createdCount++;
          }
          setImportProgress({ current: i + 1, total: parsedProducts.length, phase: "importing" });
          // yield a tick so React can paint the updated progress bar between rows
          await new Promise((res) => setTimeout(res, 0));
        }
        setImportStatus({
          type: "ok",
          message: `${createdCount > 0 ? `Created ${createdCount} product${createdCount !== 1 ? "s" : ""}.` : ""} ${updatedCount > 0 ? `Updated ${updatedCount} existing product${updatedCount !== 1 ? "s" : ""} (matched by SKU/Name).` : ""}`.trim(),
        });
      }
    } catch (err) {
      setImportStatus({ type: "error", message: "Couldn't read that file. Make sure it's a .xlsx file based on the template." });
    } finally {
      setImporting(false);
      setImportProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (editing) {
    return (
      <ProductForm
        schema={schema}
        initial={editing === "new" ? null : editing}
        primaryKeyField={primaryKeyField}
        imageRepo={imageRepo}
        upcLookup={upcLookup}
        onCancel={() => setEditing(null)}
        onSave={(p) => {
          editing === "new" ? onCreate(p) : onUpdate(p);
          setEditing(null);
        }}
      />
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-slate-800">Product Library</h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-full border border-slate-300 p-0.5 bg-white">
            <button
              onClick={() => setViewMode("grid")}
              className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "grid" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
            >
              Grid
            </button>
            <button
              onClick={() => setViewMode("list")}
              title="List view — a compact table, much faster to scan for a long product library"
              className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "list" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
            >
              List
            </button>
          </div>
          {viewMode === "list" && (
            <div className="relative">
              <button className={btnGhost} onClick={() => setColumnsPickerOpen((o) => !o)}>
                <Settings2 size={14} /> Columns
              </button>
              {columnsPickerOpen && (
                <ProductColumnsPopover schema={schema} visibleColumns={visibleColumns} onToggle={toggleColumn} onReorder={reorderColumn} onClose={() => setColumnsPickerOpen(false)} />
              )}
            </div>
          )}
          <button className={btnGhost} onClick={() => downloadProductTemplate(schema)}>
            <Download size={14} /> Download Template
          </button>
          <button className={btnGhost} disabled={importing} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
            <Upload size={14} />
            {importing
              ? importProgress?.phase === "importing"
                ? `Importing ${importProgress.current}/${importProgress.total}…`
                : "Reading file…"
              : "Upload Products"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => handleFileChosen(e.target.files[0])}
          />
          <button className={btnPrimary} onClick={() => setEditing("new")}><Plus size={14} /> New Product</button>
          {imageRepo?.enabled && (
            <button className={btnGhost} disabled={matchingRepo} onClick={matchAllFromRepo}>
              {matchingRepo ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
              {matchingRepo && matchProgress ? `Matching ${matchProgress.current}/${matchProgress.total}…` : "Match Images from Repository"}
            </button>
          )}
          {upcLookup?.enabled && (
            <button className={btnGhost} disabled={matchingWeb} onClick={matchAllFromWeb}>
              {matchingWeb ? <RefreshCw size={14} className="animate-spin" /> : <Globe size={14} />}
              {matchingWeb && webMatchProgress ? `Searching ${webMatchProgress.current}/${webMatchProgress.total}…` : "Backfill Missing Images from Web"}
            </button>
          )}
        </div>
      </div>
      {matchStatus && (
        <div className={`text-sm rounded-md px-3 py-2 mb-3 ${matchStatus.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {matchStatus.message}
        </div>
      )}
      {webMatchStatus && (
        <div className={`text-sm rounded-md px-3 py-2 mb-3 ${webMatchStatus.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {webMatchStatus.message}
        </div>
      )}
      <p className="text-xs text-slate-400 mb-3 flex items-center gap-1.5">
        <FileSpreadsheet size={13} /> The template's columns always match your current attribute fields — configure those under Settings first. Products are matched on import by <span className="font-semibold text-slate-500">{primaryKeyField === "upc" ? "UPC" : "SKU"}</span> (set in Settings).
      </p>
      {primaryKeyField === "upc" && !hasUpcField(schema) && (
        <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">
          Your Product Primary Key is set to UPC, but no "UPC" attribute field exists yet — add one under Settings or matching will always fail.
        </div>
      )}
      {importProgress && (
        <div className="mb-3">
          {importProgress.phase === "importing" ? (
            <>
              <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                <span>Importing products…</span>
                <span className="font-mono">{importProgress.current} / {importProgress.total}</span>
              </div>
              <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all duration-150"
                  style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <RefreshCw size={12} className="animate-spin" /> Reading file…
            </div>
          )}
        </div>
      )}
      {importStatus && (
        <div className={`text-sm rounded-md px-3 py-2 mb-3 ${importStatus.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {importStatus.message}
        </div>
      )}
      {products.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative max-w-sm flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className={inputCls + " pl-8"}
              placeholder="Search name, SKU, or any attribute…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {pendingCount > 0 && (
            <>
              <button
                onClick={() => setPendingOnly((v) => !v)}
                className={`text-xs font-medium rounded-full px-3 py-1.5 border ${pendingOnly ? "bg-amber-500 border-amber-500 text-slate-900" : "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"}`}
              >
                Pending Approval ({pendingCount})
              </button>
              <button
                onClick={approveAllPending}
                className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-3 py-1.5 border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
              >
                <Check size={12} /> Approve All
              </button>
              <button
                onClick={deleteAllPending}
                className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-3 py-1.5 border border-red-300 text-red-600 bg-red-50 hover:bg-red-100"
              >
                <Trash2 size={12} /> Delete All
              </button>
            </>
          )}
          {isAdmin && (
            <>
              <button
                onClick={toggleSelectAll}
                title="Select every product the current search/filter shows"
                className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-3 py-1.5 border border-slate-300 text-slate-600 bg-white hover:bg-slate-50"
              >
                <Check size={12} /> {allShownSelected ? "Clear Selection" : `Select All (${filteredProducts.length})`}
              </button>
              {selectedProductIds.length > 0 && (
                <button
                  onClick={deleteSelected}
                  className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-3 py-1.5 border border-red-300 text-red-600 bg-red-50 hover:bg-red-100"
                >
                  <Trash2 size={12} /> Delete Selected ({selectedProductIds.length})
                </button>
              )}
            </>
          )}
        </div>
      )}
      {products.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No products yet. Create one, or upload a filled-in template to bulk-add your library.
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          {pendingOnly ? "No products are pending approval." : `No products match "${query}".`}
        </div>
      ) : viewMode === "list" ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="text-xs" style={{ tableLayout: "fixed", width: "100%", minWidth: 480 + visibleColumns.length * 100 }}>
            <colgroup>
              {isAdmin && <col style={{ width: 32 }} />}
              <col style={{ width: 40 }} />
              {visibleColumns.map((colId) => <col key={colId} style={{ width: columnWidths[colId] || 160 }} />)}
              <col style={{ width: 110 }} />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {isAdmin && <th className="pl-3 py-2"><input type="checkbox" className="accent-amber-500" checked={allShownSelected} onChange={toggleSelectAll} title="Select all shown" /></th>}
                <th className="px-3 py-2"></th>
                {visibleColumns.map((colId) => (
                  <th key={colId} className="relative text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 overflow-hidden">
                    <button
                      onClick={() => handleColumnSortClick(colId)}
                      title="Click to sort by this column"
                      className="flex items-center gap-1 w-full text-left hover:text-slate-700 pr-2"
                    >
                      <span className="truncate">{getProductColumnLabel(colId, schema)}</span>
                      {sortColumn === colId && (sortDirection === "asc" ? <ChevronUp size={11} className="shrink-0" /> : <ChevronDown size={11} className="shrink-0" />)}
                    </button>
                    <div
                      onMouseDown={(e) => handleColumnResizeStart(e, colId)}
                      title="Drag to resize this column"
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-amber-400/60 active:bg-amber-500"
                    />
                  </th>
                ))}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedProducts.map((p) => (
                <tr key={p.id} className={selectedForDelete.has(p.id) && isAdmin ? "bg-red-50" : "hover:bg-slate-50"}>
                  {isAdmin && <td className="pl-3 py-2"><input type="checkbox" className="accent-amber-500" checked={selectedForDelete.has(p.id)} onChange={() => toggleSelectedForDelete(p.id)} /></td>}
                  <td className="px-3 py-2">
                    <div className="w-8 h-8 rounded bg-slate-50 border border-slate-200 flex items-center justify-center overflow-hidden">
                      {p.images?.front ? (
                        <img src={p.images.front} className="max-h-full max-w-full object-contain" />
                      ) : (
                        <div className="w-5 h-5 rounded" style={{ background: hashColor(p.name) }} />
                      )}
                    </div>
                  </td>
                  {visibleColumns.map((colId) => (
                    <td key={colId} className="px-3 py-2 text-slate-700 whitespace-nowrap overflow-hidden text-ellipsis" title={getProductColumnValue(p, colId, schema)}>
                      {getProductColumnValue(p, colId, schema)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button className="text-xs text-amber-600 font-medium hover:underline mr-3" onClick={() => setEditing(p)}>Edit</button>
                    <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(p.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredProducts.map((p) => (
            <div key={p.id} className={`bg-white rounded-lg border p-3 flex gap-3 ${isAdmin && selectedForDelete.has(p.id) ? "border-red-300 ring-1 ring-red-200" : "border-slate-200"}`}>
              {isAdmin && <input type="checkbox" className="accent-amber-500 self-start mt-1 shrink-0" checked={selectedForDelete.has(p.id)} onChange={() => toggleSelectedForDelete(p.id)} title="Select for deletion" />}
              <div className="w-14 h-14 rounded bg-slate-50 border border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                {p.images?.front ? (
                  <img src={p.images.front} className="max-h-full max-w-full object-contain" />
                ) : (
                  <div className="w-8 h-8 rounded" style={{ background: hashColor(p.name) }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-slate-800 truncate flex items-center gap-1.5">
                  {p.name}
                  {p.pendingApproval && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 border border-amber-300 rounded px-1 py-0.5">Pending</span>}
                </div>
                <div className="text-xs text-slate-400 font-mono">{p.sku || "—"}</div>
                <div className="text-xs text-slate-500 mt-0.5">{p.dims.w}×{p.dims.h}×{p.dims.d} in</div>
                <div className="flex gap-2 mt-1.5">
                  <button className="text-xs text-amber-600 font-medium hover:underline" onClick={() => setEditing(p)}>Edit</button>
                  <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(p.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fixture library                                                      */
/* ------------------------------------------------------------------ */

function FixtureForm({ schema, initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState(initial?.type || FIXTURE_TYPES[0]);
  const [dims, setDims] = useState(initial?.dims || { w: 48, h: 2, d: 18 });
  const [attributes, setAttributes] = useState(initial?.attributes || {});
  const [pendingApproval, setPendingApproval] = useState(!!initial?.pendingApproval);

  const save = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || uid("fix"),
      name: name.trim(),
      type,
      dims: { w: Number(dims.w) || 1, h: Number(dims.h) || 1, d: Number(dims.d) || 1 },
      attributes,
      pendingApproval,
      importSource: initial?.importSource,
    });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
      {pendingApproval && (
        <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <p className="text-xs text-amber-700">
            <span className="font-semibold">Imported from {initial?.importSource || "an external system"} — pending approval.</span> Review the details below, then approve or delete this item.
          </p>
          <button className="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-slate-900 hover:bg-amber-400" onClick={() => setPendingApproval(false)}>
            <Check size={12} /> Approve
          </button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fixture Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Fixture Type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
            {FIXTURE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <div>
        <label className={labelCls}>Dimensions (inches, W × H × D) — snapped to 1&quot; notches</label>
        <div className="grid grid-cols-3 gap-3">
          <input type="number" min="1" step="1" className={inputCls} value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} placeholder="Width" />
          <input type="number" min="1" step="1" className={inputCls} value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} placeholder="Height" />
          <input type="number" min="1" step="1" className={inputCls} value={dims.d} onChange={(e) => setDims({ ...dims, d: e.target.value })} placeholder="Depth" />
        </div>
      </div>
      {schema.length > 0 && (
        <div>
          <label className={labelCls}>Attributes</label>
          <div className="grid grid-cols-3 gap-3">
            {schema.map((f) => (
              <AttrInput key={f.id} field={f} value={attributes[f.id]} onChange={(v) => setAttributes({ ...attributes, [f.id]: v })} />
            ))}
          </div>
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={save}><Save size={14} /> Save Fixture</button>
      </div>
    </div>
  );
}

function FixtureLibrary({ schema, fixtures, onCreate, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  const [pendingOnly, setPendingOnly] = useState(false);
  const pendingCount = fixtures.filter((f) => f.pendingApproval).length;
  const approveAllPending = () => {
    fixtures.filter((f) => f.pendingApproval).forEach((f) => onUpdate({ ...f, pendingApproval: false }));
    // the pending-only filter would otherwise keep showing an empty grid once nothing left matches it
    setPendingOnly(false);
  };
  const deleteAllPending = () => {
    const targets = fixtures.filter((f) => f.pendingApproval);
    if (targets.length === 0) return;
    if (!window.confirm(`Delete all ${targets.length} pending fixture${targets.length !== 1 ? "s" : ""}? This can't be undone.`)) return;
    targets.forEach((f) => onDelete(f.id));
    // same reason — clear the filter so the (now empty of pending) library renders immediately
    setPendingOnly(false);
  };
  if (editing) {
    return (
      <FixtureForm
        schema={schema}
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSave={(f) => {
          editing === "new" ? onCreate(f) : onUpdate(f);
          setEditing(null);
        }}
      />
    );
  }
  const q = query.trim().toLowerCase();
  const filtered = fixtures.filter((f) => {
    if (pendingOnly && !f.pendingApproval) return false;
    if (!q) return true;
    return (f.name + " " + f.type).toLowerCase().includes(q);
  });
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-800">Fixture Library</h2>
        <div className="flex items-center gap-2">
          {fixtures.length > 0 && (
            <div className="flex items-center rounded-full border border-slate-300 p-0.5 bg-white">
              <button
                onClick={() => setViewMode("grid")}
                className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "grid" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Grid
              </button>
              <button
                onClick={() => setViewMode("list")}
                title="List view — a compact table, faster to scan for a long fixture library"
                className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "list" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
              >
                List
              </button>
            </div>
          )}
          <button className={btnPrimary} onClick={() => setEditing("new")}><Plus size={14} /> New Fixture</button>
        </div>
      </div>

      {fixtures.length > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className={inputCls + " pl-9"}
              placeholder="Search by name or type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {pendingCount > 0 && (
            <>
              <button
                onClick={() => setPendingOnly((v) => !v)}
                className={`text-xs font-medium rounded-full px-3 py-1.5 border ${pendingOnly ? "bg-amber-500 border-amber-500 text-slate-900" : "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"}`}
              >
                Pending Approval ({pendingCount})
              </button>
              <button
                onClick={approveAllPending}
                className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-3 py-1.5 border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
              >
                <Check size={12} /> Approve All
              </button>
              <button
                onClick={deleteAllPending}
                className="inline-flex items-center gap-1 text-xs font-medium rounded-full px-3 py-1.5 border border-red-300 text-red-600 bg-red-50 hover:bg-red-100"
              >
                <Trash2 size={12} /> Delete All
              </button>
            </>
          )}
        </div>
      )}

      {fixtures.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No fixtures yet. Create shelves, pegboards, or hooks to place on your planograms.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          {pendingOnly ? "No fixtures are pending approval." : `No fixtures match "${query}".`}
        </div>
      ) : viewMode === "list" ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Name</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Type</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Dimensions (W×H×D)</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((f) => (
                <tr key={f.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{f.name}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">{f.type}</span></td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{f.dims.w}×{f.dims.h}×{f.dims.d} in</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button className="text-xs text-amber-600 font-medium hover:underline mr-3" onClick={() => setEditing(f)}>Edit</button>
                    <button className="text-xs text-slate-500 font-medium hover:underline mr-3" onClick={() => onCreate({ ...f, id: uid("fix"), name: `${f.name} (Copy)` })}>Copy</button>
                    <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(f.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((f) => (
            <div key={f.id} className="bg-white rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-1.5">
                <div className="font-semibold text-sm text-slate-800 truncate flex items-center gap-1.5">
                  {f.name}
                  {f.pendingApproval && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 border border-amber-300 rounded px-1 py-0.5">Pending</span>}
                </div>
                <span className="shrink-0 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">{f.type}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">{f.dims.w}×{f.dims.h}×{f.dims.d} in</div>
              <div className="flex gap-2 mt-1.5">
                <button className="text-xs text-amber-600 font-medium hover:underline" onClick={() => setEditing(f)}>Edit</button>
                <button className="text-xs text-slate-500 font-medium hover:underline" onClick={() => onCreate({ ...f, id: uid("fix"), name: `${f.name} (Copy)` })}>Copy</button>
                <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(f.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Store library                                                        */
/* ------------------------------------------------------------------ */

const STORE_FORMATS = ["Supercenter", "Standard Grocery", "Express", "Fuel & Convenience", "Warehouse"];

// A store's operational status — distinct from a planogram's lifecycle status (Live/Pending
// there mean something else entirely: whether a specific layout has gone into effect). Here
// it's whether the store itself is trading normally, about to open, mid-remodel, etc. Existing
// stores saved before this field existed have no status at all, so they're always treated as
// "Live" (storeEffectiveStatus below) rather than silently dropping out of an "Live only" filter.
const STORE_STATUSES = ["Live", "Inactive", "Pending", "Closed", "Remodel"];
const STORE_STATUS_COLORS = {
  Live: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Inactive: "bg-slate-100 text-slate-500 border-slate-200",
  Pending: "bg-amber-50 text-amber-700 border-amber-200",
  Closed: "bg-red-50 text-red-600 border-red-200",
  Remodel: "bg-blue-50 text-blue-600 border-blue-200",
};
function storeEffectiveStatus(s) {
  return s.status || "Live";
}

function StoreForm({ initial, storeSchema, onSave, onCancel }) {
  const [attributes, setAttributes] = useState(initial?.attributes || {});
  const [name, setName] = useState(initial?.name || "");
  const [storeNumber, setStoreNumber] = useState(initial?.storeNumber || "");
  const [address, setAddress] = useState(initial?.address || "");
  const [region, setRegion] = useState(initial?.region || "");
  const [cluster, setCluster] = useState(initial?.cluster || "");
  const [format, setFormat] = useState(initial?.format || STORE_FORMATS[0]);
  const [squareFootage, setSquareFootage] = useState(initial?.squareFootage || "");
  const [status, setStatus] = useState(initial ? storeEffectiveStatus(initial) : "Live");

  const save = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || uid("store"),
      name: name.trim(),
      storeNumber: storeNumber.trim(),
      address: address.trim(),
      region: region.trim(),
      cluster: cluster.trim(),
      format,
      squareFootage: Number(squareFootage) || 0,
      status,
      attributes,
    });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4 max-w-lg">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Store Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Downtown Market" /></Field>
        <Field label="Store Number"><input className={inputCls} value={storeNumber} onChange={(e) => setStoreNumber(e.target.value)} placeholder="e.g. 4821" /></Field>
      </div>
      <Field label="Address"><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Region"><input className={inputCls} value={region} onChange={(e) => setRegion(e.target.value)} placeholder="e.g. Midwest" /></Field>
        <Field label="Cluster"><input className={inputCls} value={cluster} onChange={(e) => setCluster(e.target.value)} placeholder="e.g. Urban Large" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Format">
          <select className={inputCls} value={format} onChange={(e) => setFormat(e.target.value)}>
            {STORE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
        <Field label="Sq Footage"><input type="number" className={inputCls} value={squareFootage} onChange={(e) => setSquareFootage(e.target.value)} /></Field>
      </div>
      {storeSchema && storeSchema.length > 0 && (
        <div>
          <div className={labelCls}>Your attributes</div>
          <AttributeFields schema={storeSchema} values={attributes} onChange={setAttributes} columns="grid-cols-2" />
        </div>
      )}
      <Field label="Status">
        <div className="grid grid-cols-5 gap-1.5">
          {STORE_STATUSES.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatus(st)}
              className={`text-xs rounded-md py-1.5 border font-medium ${status === st ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {st}
            </button>
          ))}
        </div>
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={save}><Save size={14} /> Save Store</button>
      </div>
    </div>
  );
}

const STORE_LIST_COLUMNS = [
  { id: "name", label: "Name", locked: true, defaultOn: true },
  { id: "storeNumber", label: "Store #", defaultOn: true },
  { id: "status", label: "Status", defaultOn: true },
  { id: "format", label: "Format", defaultOn: true },
  { id: "address", label: "Address", defaultOn: true },
  { id: "region", label: "Region", defaultOn: true },
  { id: "cluster", label: "Cluster", defaultOn: false },
  { id: "squareFootage", label: "Sq Ft", defaultOn: true },
];

function StoreLibrary({ stores, storeSchema, onCreate, onUpdate, onDelete }) {
  const { columns, visible, toggle } = useColumnPrefs("tandom:storeListColumns", STORE_LIST_COLUMNS, storeSchema);
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  const [statusFilter, setStatusFilter] = useState("All");
  if (editing) {
    return (
      <StoreForm
        storeSchema={storeSchema}
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSave={(s) => { editing === "new" ? onCreate(s) : onUpdate(s); setEditing(null); }}
      />
    );
  }
  const q = query.trim().toLowerCase();
  const statusFiltered = statusFilter === "All" ? stores : stores.filter((s) => storeEffectiveStatus(s) === statusFilter);
  const filtered = !q ? statusFiltered : statusFiltered.filter((s) =>
    [s.name, s.storeNumber, s.address, s.region, s.cluster, s.format, ...Object.values(s.attributes || {})].filter((x) => x !== undefined && x !== null && x !== "").join(" ").toLowerCase().includes(q)
  );
  const statusCounts = {};
  stores.forEach((s) => { const st = storeEffectiveStatus(s); statusCounts[st] = (statusCounts[st] || 0) + 1; });
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-800">Store Library</h2>
        <div className="flex items-center gap-2">
          {stores.length > 0 && (
            <div className="flex items-center rounded-full border border-slate-300 p-0.5 bg-white">
              <button
                onClick={() => setViewMode("grid")}
                className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "grid" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
              >
                Grid
              </button>
              <button
                onClick={() => setViewMode("list")}
                title="List view — a compact table, faster to scan for a long store list"
                className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "list" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
              >
                List
              </button>
            </div>
          )}
          {stores.length > 0 && <ColumnMenu columns={columns} visible={visible} onToggle={toggle} label={viewMode === "list" ? "Columns" : "Card fields"} />}
          <button className={btnPrimary} onClick={() => setEditing("new")}><Plus size={14} /> New Store</button>
        </div>
      </div>

      {stores.length > 0 && (
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className={inputCls + " pl-9"}
            placeholder="Search by name, store #, address, or region…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {stores.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <button
            onClick={() => setStatusFilter("All")}
            className={`text-xs rounded-full px-3 py-1 border font-medium ${statusFilter === "All" ? "bg-slate-800 border-slate-800 text-white" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
          >
            All ({stores.length})
          </button>
          {STORE_STATUSES.map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`text-xs rounded-full px-3 py-1 border font-medium ${statusFilter === st ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              {st} ({statusCounts[st] || 0})
            </button>
          ))}
        </div>
      )}

      {stores.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No stores yet. Add the stores you'll be assigning planograms to.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No stores match{query ? ` "${query}"` : ""}{statusFilter !== "All" ? ` with status "${statusFilter}"` : ""}.
        </div>
      ) : viewMode === "list" ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {visible.map((c) => <th key={c.id} className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">{c.label}</th>)}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  {visible.map((c) => {
                    if (c.attr) return <td key={c.id} className="px-3 py-2 text-slate-600 whitespace-nowrap">{attrDisplay(c.attr, s.attributes?.[c.attr.id]) || "—"}</td>;
                    if (c.id === "name") return <td key={c.id} className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{s.name}</td>;
                    if (c.id === "storeNumber") return <td key={c.id} className="px-3 py-2 text-slate-500 font-mono whitespace-nowrap">#{s.storeNumber || "—"}</td>;
                    if (c.id === "status") return <td key={c.id} className="px-3 py-2 whitespace-nowrap"><span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border ${STORE_STATUS_COLORS[storeEffectiveStatus(s)] || STORE_STATUS_COLORS.Live}`}>{storeEffectiveStatus(s)}</span></td>;
                    if (c.id === "format") return <td key={c.id} className="px-3 py-2 whitespace-nowrap"><span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">{s.format || "—"}</span></td>;
                    if (c.id === "address") return <td key={c.id} className="px-3 py-2 text-slate-600 whitespace-nowrap max-w-[260px] truncate" title={s.address}>{s.address || "—"}</td>;
                    if (c.id === "squareFootage") return <td key={c.id} className="px-3 py-2 text-slate-500 whitespace-nowrap">{s.squareFootage ? s.squareFootage.toLocaleString() : "—"}</td>;
                    return <td key={c.id} className="px-3 py-2 text-slate-500 whitespace-nowrap">{s[c.id] || "—"}</td>;
                  })}
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button className="text-xs text-amber-600 font-medium hover:underline mr-3" onClick={() => setEditing(s)}>Edit</button>
                    <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(s.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((s) => (
            <div key={s.id} className="bg-white rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm text-slate-800">{s.name}</div>
                <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">{s.format}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border ${STORE_STATUS_COLORS[storeEffectiveStatus(s)] || STORE_STATUS_COLORS.Live}`}>{storeEffectiveStatus(s)}</span>
                <span className="text-xs text-slate-400 font-mono">#{s.storeNumber || "—"}</span>
              </div>
              <div className="text-xs text-slate-500 mt-1">{s.address}</div>
              <div className="text-xs text-slate-400 mt-1">{s.region}{s.squareFootage ? ` · ${s.squareFootage.toLocaleString()} sq ft` : ""}</div>
              <AttributeChips columns={visible} entity={s} />
              <div className="flex gap-2 mt-1.5">
                <button className="text-xs text-amber-600 font-medium hover:underline" onClick={() => setEditing(s)}>Edit</button>
                <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(s.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Store assignment — multi-select popover used in the planogram list  */
/* and editor to associate a planogram with one or more stores         */
/* ------------------------------------------------------------------ */

// A planogram's assigned stores that still exist, without duplicates. storeIds can hold ids of stores that were
// deleted or re-created, and those can't be seen or unchecked in the picker, so counts and edits use this list.
function validStoreIds(planogram, stores) {
  const known = new Set((stores || []).map((x) => x.id));
  return Array.from(new Set(planogram.storeIds || [])).filter((id) => known.has(id));
}

function StoreAssignmentPopover({ stores, selectedIds, onToggle, onClose }) {
  const [query, setQuery] = useState("");
  const filtered = stores.filter((s) => (s.name + " " + s.storeNumber).toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="absolute z-30 top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg p-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-2">
        <h5 className="font-bold text-xs text-slate-700">Assign to Stores</h5>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
      </div>
      {stores.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No stores yet — add some in the Stores tab.</p>
      ) : (
        <>
          <input className={inputCls + " mb-2 text-xs"} placeholder="Search stores…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="max-h-56 overflow-y-auto space-y-1">
            {filtered.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-xs text-slate-700 py-1 px-1.5 rounded hover:bg-slate-50 cursor-pointer">
                <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={selectedIds.includes(s.id)} onChange={() => onToggle(s.id)} />
                <span className="flex-1 min-w-0 truncate">{s.name}</span>
                <span className="text-slate-400 font-mono">#{s.storeNumber || "—"}</span>
              </label>
            ))}
            {filtered.length === 0 && <p className="text-xs text-slate-400 italic px-1.5">No matches.</p>}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Performance module — load history, view rolled-up metrics            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Category Analysis — chain-wide %Space / %Sales / %Units / %Profit,   */
/* broken down by Category, Brand, Manufacturer, Store, Region, or      */
/* Store Format                                                          */
/* ------------------------------------------------------------------ */

const ANALYSIS_GROUP_OPTIONS = [
  { id: "category", label: "Category" },
  { id: "brand", label: "Brand" },
  { id: "manufacturer", label: "Manufacturer" },
  { id: "store", label: "Store" },
  { id: "region", label: "Region" },
  { id: "format", label: "Store Format" },
];

const ANALYSIS_PERIODS = [4, 13, 26, 52];

// Space consumed by one placement, in inches: the product's (or merch-style's) width for
// whichever orientation it's rotated to, compressed by its squeeze factor, times facings.
// Mirrors the per-item width formula layoutFixtureBoxes uses to pack a shelf — this just sums
// it instead of positioning it, so a shelf's actual packed width and this report's "space"
// figure always agree. Used as the same approximation for Pegboard/Hook Rail placements too,
// since those don't pack linearly the way a shelf does.
function getPlacementSpaceIn(product, placement) {
  if (!product) return 0;
  const effectiveDims = getEffectiveDims(product, placement);
  const rotated = placement.rotation === 90 || placement.rotation === 270;
  const nominalW = (rotated ? effectiveDims.h : effectiveDims.w) || 1;
  const squeeze = product.squeezeFactor ?? 1;
  return nominalW * squeeze * (placement.facings || 1);
}

/* Days of supply and case pack.
   Shelf capacity = the units a placement holds (getStackDims: wide x high x deep, plus caps).
   Days of supply (DOS) = capacity / average daily unit sales. The target comes from the category's
   row in `schema:dosTargets` ([{category, days}]), unless the product carries its own
   `dosTargetDays`. No target = no DOS check. `casePack` on a product is units per warehouse case. */
const DOS_EXCESS_FACTOR = 2; // a shelf holding more than this many times its target is "over-supplied"
function getDosTargetDays(category, dosTargets, product) {
  const own = Number(product?.dosTargetDays);
  if (Number.isFinite(own) && own > 0) return own;
  const days = Number((dosTargets || []).find((t) => t.category === category)?.days);
  return Number.isFinite(days) && days > 0 ? days : null;
}
// null when there are no sales to measure against
function getDaysOfSupply(capacityUnits, weeklyUnits) {
  return weeklyUnits > 0 ? capacityUnits / (weeklyUnits / 7) : null;
}
// How a unit count lines up with the warehouse case. Stores receive whole cases, and the industry
// standard pack-out is a case or a case and a half: the shelf is "exact" when it holds a whole or half
// number of cases (1, 1.5, 2, 2.5...) and at least one full case. A half case only exists for an even
// case pack; an odd one has to be whole cases. null when the product has no case pack.
function getCasePackFill(units, casePack) {
  const cp = Math.round(Number(casePack) || 0);
  if (cp < 1) return null;
  const u = Math.max(0, Math.round(units));
  const step = cp % 2 === 0 ? cp / 2 : cp; // smallest increment a pack-out may use
  return {
    casePack: cp, step, units: u,
    cases: u / cp,                       // 1.5 = a case and a half
    wholeCases: Math.floor(u / cp), loose: u % cp, casesToFill: Math.ceil(u / cp),
    exact: u >= cp && u % step === 0,
  };
}

// Reset Drafting Agent — Sales/Space Index thresholds. A planogram's own Category (the field set
// in its toolbar, not a per-product attribute) selects the threshold row; chains without an
// override for that category fall back to the chain-wide default.
const DEFAULT_RESET_THRESHOLDS = { low: 70, high: 130 };
function getResetThreshold(category, resetThresholds) {
  const entry = (resetThresholds || []).find((t) => t.category === category);
  return entry ? { low: entry.low, high: entry.high } : DEFAULT_RESET_THRESHOLDS;
}

// Rolls up every product placed in a Live, store-assigned planogram against imported
// Performance data, then groups the result by the requested dimension. categoryFilter narrows
// to one category before grouping (ignored when groupField itself is "category").
function buildCategoryAnalysisRows(planograms, products, stores, performance, productSchema, cutoffISO, groupField, categoryFilter) {
  const productsById = {};
  products.forEach((p) => { productsById[p.id] = p; });
  const storesById = {};
  stores.forEach((s) => { storesById[s.id] = s; });

  // 1. Space (inches) per store × product, from every Live planogram's placements.
  const spaceByStoreProduct = {};
  planograms.forEach((pg) => {
    if (effectivePlanogramStatus(pg) !== "live") return;
    const storeIds = pg.storeIds || [];
    if (storeIds.length === 0) return;
    (pg.sections || []).forEach((section) => {
      (section.fixtures || []).forEach((fx) => {
        (fx.placements || []).forEach((pl) => {
          const product = productsById[pl.productId];
          if (!product) return;
          const spaceIn = getPlacementSpaceIn(product, pl);
          if (spaceIn <= 0) return;
          storeIds.forEach((storeId) => {
            if (!spaceByStoreProduct[storeId]) spaceByStoreProduct[storeId] = {};
            spaceByStoreProduct[storeId][product.id] = (spaceByStoreProduct[storeId][product.id] || 0) + spaceIn;
          });
        });
      });
    });
  });

  // 2. Join each store × product with its Performance figures for the selected period.
  const rawRows = [];
  Object.entries(spaceByStoreProduct).forEach(([storeId, byProduct]) => {
    Object.entries(byProduct).forEach(([productId, spaceIn]) => {
      const product = productsById[productId];
      if (!product) return;
      if (categoryFilter && categoryFilter !== "All" && groupField !== "category") {
        const cat = getAttrByLabel(product, productSchema, ["category"]) || "(Uncategorized)";
        if (cat !== categoryFilter) return;
      }
      const perf = aggregateProductPerformance(productId, performance, cutoffISO, storeId);
      rawRows.push({
        productId, storeId, spaceIn,
        sales: perf?.totalSales || 0,
        units: perf?.totalUnits || 0,
        profit: perf?.grossProfit || 0,
      });
    });
  });

  // 3. Group into rows by the chosen dimension and total everything.
  const groups = {};
  const bump = (key, label, row) => {
    if (!groups[key]) groups[key] = { key, label, spaceIn: 0, sales: 0, units: 0, profit: 0, members: [] };
    groups[key].spaceIn += row.spaceIn;
    groups[key].sales += row.sales;
    groups[key].units += row.units;
    groups[key].profit += row.profit;
    groups[key].members.push({ productId: row.productId, storeId: row.storeId });
  };
  rawRows.forEach((row) => {
    const product = productsById[row.productId];
    const store = storesById[row.storeId];
    let key, label;
    if (groupField === "store") {
      label = store ? store.name : "Unknown Store"; key = row.storeId;
    } else if (groupField === "region") {
      label = store?.region || "(No Region)"; key = label;
    } else if (groupField === "format") {
      label = store?.format || "(No Format)"; key = label;
    } else if (groupField === "brand") {
      label = getAttrByLabel(product, productSchema, ["brand"]) || "(No Brand)"; key = label;
    } else if (groupField === "manufacturer") {
      label = getAttrByLabel(product, productSchema, ["manufacturer"]) || "(No Manufacturer)"; key = label;
    } else {
      label = getAttrByLabel(product, productSchema, ["category"]) || "(Uncategorized)"; key = label;
    }
    bump(key, label, row);
  });

  const totals = Object.values(groups).reduce(
    (acc, g) => ({ spaceIn: acc.spaceIn + g.spaceIn, sales: acc.sales + g.sales, units: acc.units + g.units, profit: acc.profit + g.profit }),
    { spaceIn: 0, sales: 0, units: 0, profit: 0 }
  );

  const rows = Object.values(groups).map((g) => {
    const pctSpace = totals.spaceIn > 0 ? (g.spaceIn / totals.spaceIn) * 100 : 0;
    const pctSales = totals.sales > 0 ? (g.sales / totals.sales) * 100 : 0;
    const pctUnits = totals.units > 0 ? (g.units / totals.units) * 100 : 0;
    const pctProfit = totals.profit > 0 ? (g.profit / totals.profit) * 100 : 0;
    return {
      ...g, pctSpace, pctSales, pctUnits, pctProfit,
      salesToSpaceIndex: pctSpace > 0 ? (pctSales / pctSpace) * 100 : null,
    };
  });

  return { rows, totals };
}

// Product-level drill-down for one breakdown row (e.g. one Store, one Brand): current-period
// vs. same-period-last-year Sales/Units/Profit for every product that contributed to that row,
// summed only across the exact (productId, storeId) pairs the row is made of — so a Store
// drill-down is that store's own products, while a Category/Brand/etc. drill-down stays scoped
// to the same stores the summary row itself was built from.
function buildAnalysisDrillDownRows(members, products, performance, productSchema, currentStart, currentEnd, priorStart, priorEnd) {
  const productsById = {};
  products.forEach((p) => { productsById[p.id] = p; });

  const byProduct = {};
  (members || []).forEach(({ productId, storeId }) => {
    if (!byProduct[productId]) {
      byProduct[productId] = {
        productId,
        current: { sales: 0, units: 0, profit: 0 },
        prior: { sales: 0, units: 0, profit: 0 },
      };
    }
    const cur = aggregateProductPerformanceRange(productId, performance, currentStart, currentEnd, storeId);
    const pri = aggregateProductPerformanceRange(productId, performance, priorStart, priorEnd, storeId);
    byProduct[productId].current.sales += cur.totalSales;
    byProduct[productId].current.units += cur.totalUnits;
    byProduct[productId].current.profit += cur.grossProfit;
    byProduct[productId].prior.sales += pri.totalSales;
    byProduct[productId].prior.units += pri.totalUnits;
    byProduct[productId].prior.profit += pri.grossProfit;
  });

  const rows = Object.values(byProduct).map((r) => {
    const product = productsById[r.productId];
    return {
      productId: r.productId,
      name: product ? product.name : "(Deleted product)",
      category: product ? getAttrByLabel(product, productSchema, ["category"]) : "",
      sales: r.current.sales, priorSales: r.prior.sales, salesChangePct: pctChange(r.current.sales, r.prior.sales),
      units: r.current.units, priorUnits: r.prior.units, unitsChangePct: pctChange(r.current.units, r.prior.units),
      profit: r.current.profit, priorProfit: r.prior.profit, profitChangePct: pctChange(r.current.profit, r.prior.profit),
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      sales: acc.sales + r.sales, priorSales: acc.priorSales + r.priorSales,
      units: acc.units + r.units, priorUnits: acc.priorUnits + r.priorUnits,
      profit: acc.profit + r.profit, priorProfit: acc.priorProfit + r.priorProfit,
    }),
    { sales: 0, priorSales: 0, units: 0, priorUnits: 0, profit: 0, priorProfit: 0 }
  );

  return {
    rows,
    totals: {
      ...totals,
      salesChangePct: pctChange(totals.sales, totals.priorSales),
      unitsChangePct: pctChange(totals.units, totals.priorUnits),
      profitChangePct: pctChange(totals.profit, totals.priorProfit),
    },
  };
}

function ChangeBadge({ pct, size = "sm" }) {
  if (pct == null) return <span className="text-slate-300">— new</span>;
  const up = pct > 0.05, down = pct < -0.05;
  const cls = up ? "text-emerald-600" : down ? "text-red-500" : "text-slate-400";
  const arrow = up ? "▲" : down ? "▼" : "▬";
  return <span className={`${cls} ${size === "lg" ? "text-sm" : "text-xs"} font-semibold whitespace-nowrap`}>{arrow} {Math.abs(pct).toFixed(1)}%</span>;
}

function AnalysisDrillDownView({ drillDown, products, performance, productSchema, periodWeeks, latestISO, onBack }) {
  const currentEnd = latestISO;
  const currentStart = periodWeeks === "all" ? null : getCutoffISO(latestISO, periodWeeks);
  // "same period, one year ago": shift the whole window back 52 weeks (364 days) so it stays
  // aligned to the same week-of-year, rather than a straight calendar-year shift.
  const priorEnd = currentEnd ? addDaysISO(currentEnd, -364) : null;
  const priorStart = currentStart ? addDaysISO(currentStart, -364) : (priorEnd ? addDaysISO(priorEnd, -364) : null);

  const [sortKey, setSortKey] = useState("sales");
  const [sortDir, setSortDir] = useState("desc");

  const { rows, totals } = React.useMemo(
    () => buildAnalysisDrillDownRows(drillDown.members, products, performance, productSchema, currentStart, currentEnd, priorStart, priorEnd),
    [drillDown, products, performance, productSchema, currentStart, currentEnd, priorStart, priorEnd]
  );

  const hasAnyPriorData = rows.some((r) => r.priorSales > 0 || r.priorUnits > 0);

  const sortedRows = [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
    return sortDir === "asc" ? av - bv : bv - av;
  });

  const biggestGainer = rows.filter((r) => r.salesChangePct != null).sort((a, b) => (b.sales - b.priorSales) - (a.sales - a.priorSales))[0];
  const biggestDecliner = rows.filter((r) => r.salesChangePct != null).sort((a, b) => (a.sales - a.priorSales) - (b.sales - b.priorSales))[0];

  const sortHeader = (key, label) => (
    <th
      className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none"
      onClick={() => { if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc"); else { setSortKey(key); setSortDir("desc"); } }}
    >
      {label} {sortKey === key && (sortDir === "asc" ? "▲" : "▼")}
    </th>
  );

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1">
        <ChevronLeft size={13} /> Back to {drillDown.groupLabel} breakdown
      </button>

      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <h2 className="font-bold text-slate-800 text-base">{drillDown.label}</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {rows.length} product{rows.length !== 1 ? "s" : ""} · current period vs. the same {periodWeeks === "all" ? "" : `${periodWeeks}-week `}window one year earlier
          {currentStart && currentEnd ? ` (${currentStart} → ${currentEnd} vs. ${priorStart} → ${priorEnd})` : ""}.
        </p>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="rounded-md border border-slate-200 p-3">
            <div className="text-[11px] text-slate-400 uppercase tracking-wide">Sales</div>
            <div className="font-bold text-slate-800 text-lg">{money0(totals.sales)}</div>
            <ChangeBadge pct={totals.salesChangePct} size="lg" />
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <div className="text-[11px] text-slate-400 uppercase tracking-wide">Units</div>
            <div className="font-bold text-slate-800 text-lg">{Math.round(totals.units).toLocaleString()}</div>
            <ChangeBadge pct={totals.unitsChangePct} size="lg" />
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <div className="text-[11px] text-slate-400 uppercase tracking-wide">Gross Profit</div>
            <div className="font-bold text-slate-800 text-lg">{money0(totals.profit)}</div>
            <ChangeBadge pct={totals.profitChangePct} size="lg" />
          </div>
        </div>

        {!hasAnyPriorData && (
          <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mt-3">
            <AlertTriangle size={12} /> No Performance data found for a year ago — year-over-year change can't be computed yet for this {drillDown.groupLabel.toLowerCase()}, only the current period is shown.
          </div>
        )}

        {(biggestGainer || biggestDecliner) && hasAnyPriorData && (
          <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
            {biggestGainer && biggestGainer.sales - biggestGainer.priorSales > 0 && (
              <span className="rounded-full px-2.5 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700">
                Biggest gainer: <span className="font-semibold">{biggestGainer.name}</span> ({money0(biggestGainer.sales - biggestGainer.priorSales)})
              </span>
            )}
            {biggestDecliner && biggestDecliner.sales - biggestDecliner.priorSales < 0 && (
              <span className="rounded-full px-2.5 py-1 bg-red-50 border border-red-200 text-red-600">
                Biggest decliner: <span className="font-semibold">{biggestDecliner.name}</span> ({money0(biggestDecliner.sales - biggestDecliner.priorSales)})
              </span>
            )}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          No products with Performance data for this period.
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Product</th>
                {sortHeader("sales", "Sales")}
                <th className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Sales Δ YoY</th>
                {sortHeader("units", "Units")}
                <th className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Units Δ YoY</th>
                {sortHeader("profit", "Profit")}
                <th className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Profit Δ YoY</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr key={r.productId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">
                    {r.name}
                    {r.category && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-1.5 py-0.5 ml-1.5" style={{ background: hashColor(r.category) + "33", color: hashColor(r.category) }}>{r.category}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{money0(r.sales)}</td>
                  <td className="px-3 py-2 text-right"><ChangeBadge pct={r.salesChangePct} /></td>
                  <td className="px-3 py-2 text-right font-mono">{Math.round(r.units).toLocaleString()}</td>
                  <td className="px-3 py-2 text-right"><ChangeBadge pct={r.unitsChangePct} /></td>
                  <td className="px-3 py-2 text-right font-mono">{money0(r.profit)}</td>
                  <td className="px-3 py-2 text-right"><ChangeBadge pct={r.profitChangePct} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CategoryAnalysisModule({ products, planograms, stores, performance, productSchema }) {
  const [groupBy, setGroupBy] = useState("category");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [periodWeeks, setPeriodWeeks] = useState(13);
  const [sortKey, setSortKey] = useState("pctSales");
  const [sortDir, setSortDir] = useState("desc");
  const [drillDown, setDrillDown] = useState(null); // { key, label, groupLabel, members } | null

  const categories = React.useMemo(() => {
    const set = new Set();
    products.forEach((p) => {
      const c = getAttrByLabel(p, productSchema, ["category"]);
      if (c) set.add(c);
    });
    return Array.from(set).sort();
  }, [products, productSchema]);

  const latestISO = React.useMemo(() => getLatestWeekEnding(performance), [performance]);
  const availableWeeks = React.useMemo(() => countAvailableWeeks(performance), [performance]);
  const cutoffISO = periodWeeks === "all" ? null : getCutoffISO(latestISO, periodWeeks);

  const { rows } = React.useMemo(
    () => buildCategoryAnalysisRows(planograms, products, stores, performance, productSchema, cutoffISO, groupBy, groupBy !== "category" ? categoryFilter : "All"),
    [planograms, products, stores, performance, productSchema, cutoffISO, groupBy, categoryFilter]
  );

  const sortedRows = [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
    return sortDir === "asc" ? av - bv : bv - av;
  });

  const groupLabel = ANALYSIS_GROUP_OPTIONS.find((o) => o.id === groupBy)?.label || "Category";

  if (drillDown) {
    return (
      <AnalysisDrillDownView
        drillDown={drillDown}
        products={products}
        performance={performance}
        productSchema={productSchema}
        periodWeeks={periodWeeks}
        latestISO={latestISO}
        onBack={() => setDrillDown(null)}
      />
    );
  }

  const sortHeader = (key, label) => (
    <th
      className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap cursor-pointer select-none"
      onClick={() => { if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc"); else { setSortKey(key); setSortDir("desc"); } }}
    >
      {label} {sortKey === key && (sortDir === "asc" ? "▲" : "▼")}
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800 text-base">Category Analysis</h2>
            <p className="text-xs text-slate-500 mt-0.5 max-w-lg">
              %Space, %Sales, %Units, and %Profit across every store with a Live planogram, joined against imported Performance data.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">Period</label>
            <select className={inputCls + " w-auto text-xs py-1"} value={periodWeeks} onChange={(e) => setPeriodWeeks(e.target.value === "all" ? "all" : Number(e.target.value))}>
              {ANALYSIS_PERIODS.map((w) => (
                <option key={w} value={w} disabled={availableWeeks > 0 && availableWeeks < w}>Last {w} weeks</option>
              ))}
              <option value="all">All available</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          {ANALYSIS_GROUP_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setGroupBy(opt.id)}
              className={`text-xs rounded-full px-3 py-1.5 border font-medium ${groupBy === opt.id ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              By {opt.label}
            </button>
          ))}
          {groupBy !== "category" && categories.length > 0 && (
            <select className={inputCls + " w-auto text-xs py-1 ml-2"} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="All">All Categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">
          No data yet — this needs at least one Live planogram assigned to a store, with matching Performance data imported for the same period.
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{groupLabel}</th>
                {sortHeader("pctSpace", "% Space")}
                {sortHeader("pctUnits", "% Units")}
                {sortHeader("pctSales", "% Sales")}
                {sortHeader("pctProfit", "% Profit")}
                {sortHeader("salesToSpaceIndex", "Sales/Space Index")}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr
                  key={r.key}
                  onClick={() => setDrillDown({ key: r.key, label: r.label, groupLabel, members: r.members })}
                  className="border-b border-slate-100 last:border-0 hover:bg-amber-50 cursor-pointer"
                  title={`See ${r.label}'s products, year over year`}
                >
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap flex items-center gap-1">
                    {r.label} <ChevronRight size={12} className="text-slate-300" />
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.pctSpace.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right font-mono">{r.pctUnits.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right font-mono">{r.pctSales.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right font-mono">{r.pctProfit.toFixed(1)}%</td>
                  <td className={`px-3 py-2 text-right font-mono font-semibold ${r.salesToSpaceIndex == null ? "text-slate-300" : r.salesToSpaceIndex >= 105 ? "text-emerald-600" : r.salesToSpaceIndex <= 95 ? "text-red-500" : "text-slate-600"}`}>
                    {r.salesToSpaceIndex == null ? "—" : r.salesToSpaceIndex.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 border-t border-slate-200">
              <tr>
                <td className="px-3 py-2 font-bold text-slate-700">Total</td>
                <td className="px-3 py-2 text-right font-mono font-bold">100.0%</td>
                <td className="px-3 py-2 text-right font-mono font-bold">100.0%</td>
                <td className="px-3 py-2 text-right font-mono font-bold">100.0%</td>
                <td className="px-3 py-2 text-right font-mono font-bold">100.0%</td>
                <td className="px-3 py-2 text-right font-mono text-slate-300">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 p-3 text-[11px] text-slate-400 space-y-1">
        <p>Click any row to drill into its products — current vs. same-period-last-year Sales, Units, and Profit.</p>
        <p><span className="font-semibold text-slate-500">Sales/Space Index</span> = %Sales ÷ %Space × 100. Above 100 means {groupLabel.toLowerCase()} sells more than its shelf space would suggest; below 100 means it's over-spaced relative to its sales.</p>
        <p>Space is estimated from each product's placed width × facings (× squeeze factor), summed across every Live planogram's assigned stores — the same footprint math the shelf editor itself uses. Pegboard and Hook Rail placements use the same estimate since they don't pack linearly.</p>
      </div>
    </div>
  );
}

// Which planogram categories currently have Live coverage at which stores — one row per
// Category (as set on the planogram itself, not the product), counting how many of the store
// list currently have at least one Live planogram of that category assigned.
function buildCategoryCoverageRows(planograms, stores) {
  const categories = Array.from(new Set(planograms.map((p) => (p.category || "").trim()).filter(Boolean))).sort();
  const liveStoreIdsByCategory = {};
  planograms.forEach((pg) => {
    if (effectivePlanogramStatus(pg) !== "live") return;
    const cat = (pg.category || "").trim();
    if (!cat) return;
    if (!liveStoreIdsByCategory[cat]) liveStoreIdsByCategory[cat] = new Set();
    (pg.storeIds || []).forEach((id) => liveStoreIdsByCategory[cat].add(id));
  });
  return categories.map((category) => {
    const coveredIds = liveStoreIdsByCategory[category] || new Set();
    const missingStores = stores.filter((s) => !coveredIds.has(s.id));
    return {
      category,
      totalStores: stores.length,
      coveredCount: stores.length - missingStores.length,
      missingCount: missingStores.length,
      coveragePct: stores.length > 0 ? ((stores.length - missingStores.length) / stores.length) * 100 : 0,
      missingStores,
    };
  });
}

// Products that don't appear in a single placement on any planogram whose effective status is
// Live, Pending, or WIP (Approved and Historical don't count) — i.e. sitting in the library
// completely unused right now.
function buildOrphanProducts(planograms, products) {
  const activeStatuses = new Set(["live", "pending", "wip"]);
  const usedIds = new Set();
  planograms.forEach((pg) => {
    if (!activeStatuses.has(effectivePlanogramStatus(pg))) return;
    (pg.sections || []).forEach((section) => {
      (section.fixtures || []).forEach((fx) => {
        (fx.placements || []).forEach((pl) => usedIds.add(pl.productId));
      });
    });
  });
  return products.filter((p) => !usedIds.has(p.id));
}

function CoverageGapsModule({ products, planograms, stores, productSchema }) {
  const [storeSearch, setStoreSearch] = useState("");
  const [expandedCategory, setExpandedCategory] = useState(null);
  const [productSearch, setProductSearch] = useState("");
  const [productSortKey, setProductSortKey] = useState("name");
  const [productSortDir, setProductSortDir] = useState("asc");

  const liveCountByStore = React.useMemo(() => {
    const map = {};
    planograms.forEach((pg) => {
      if (effectivePlanogramStatus(pg) !== "live") return;
      (pg.storeIds || []).forEach((id) => { map[id] = (map[id] || 0) + 1; });
    });
    return map;
  }, [planograms]);

  const storesByRegion = React.useMemo(() => {
    const q = storeSearch.trim().toLowerCase();
    const filtered = stores.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.storeNumber || "").toLowerCase().includes(q));
    const groups = {};
    filtered.forEach((s) => {
      const region = s.region || "(No Region)";
      if (!groups[region]) groups[region] = [];
      groups[region].push(s);
    });
    return Object.entries(groups)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([region, list]) => ({ region, stores: [...list].sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [stores, storeSearch]);

  const coverageRows = React.useMemo(() => buildCategoryCoverageRows(planograms, stores), [planograms, stores]);

  const orphanProducts = React.useMemo(() => buildOrphanProducts(planograms, products), [planograms, products]);

  const filteredOrphans = React.useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    let rows = orphanProducts.map((p) => ({
      product: p,
      category: getAttrByLabel(p, productSchema, ["category"]) || "(Uncategorized)",
      brand: getAttrByLabel(p, productSchema, ["brand"]) || "",
    }));
    if (q) {
      rows = rows.filter((r) =>
        r.product.name.toLowerCase().includes(q) ||
        (r.product.sku || "").toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.brand.toLowerCase().includes(q)
      );
    }
    rows.sort((a, b) => {
      const av = productSortKey === "category" ? a.category : productSortKey === "brand" ? a.brand : a.product.name;
      const bv = productSortKey === "category" ? b.category : productSortKey === "brand" ? b.brand : b.product.name;
      const cmp = String(av).localeCompare(String(bv));
      return productSortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [orphanProducts, productSearch, productSortKey, productSortDir, productSchema]);

  const toggleProductSort = (key) => {
    if (productSortKey === key) setProductSortDir(productSortDir === "asc" ? "desc" : "asc");
    else { setProductSortKey(key); setProductSortDir("asc"); }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-bold text-slate-800 text-base">Store List by Region</h2>
          <input className={inputCls + " w-auto text-xs py-1 max-w-[220px]"} placeholder="Search stores…" value={storeSearch} onChange={(e) => setStoreSearch(e.target.value)} />
        </div>
        <p className="text-xs text-slate-500 mt-0.5 mb-3">{stores.length} store{stores.length !== 1 ? "s" : ""} total, grouped by Region. The badge shows how many Live planograms are currently assigned to each store.</p>
        <div className="space-y-4">
          {storesByRegion.map(({ region, stores: list }) => (
            <div key={region}>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
                {region} <span className="text-slate-300 font-normal">({list.length})</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                {list.map((s) => (
                  <div key={s.id} className="flex items-center justify-between text-xs rounded-md border border-slate-200 px-2.5 py-1.5">
                    <span className="truncate">
                      <span className="font-medium text-slate-700">{s.name}</span>
                      {s.storeNumber && <span className="text-slate-400"> · #{s.storeNumber}</span>}
                    </span>
                    <span className={`ml-2 shrink-0 rounded-full px-1.5 py-0.5 font-semibold ${(liveCountByStore[s.id] || 0) === 0 ? "bg-red-50 text-red-500" : "bg-slate-100 text-slate-500"}`}>
                      {liveCountByStore[s.id] || 0} live
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {storesByRegion.length === 0 && <div className="text-sm text-slate-400 italic text-center py-4">No stores match.</div>}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <h2 className="font-bold text-slate-800 text-base">Stores With No Live Planogram, by Category</h2>
        <p className="text-xs text-slate-500 mt-0.5 mb-3">For each planogram Category, how many of your {stores.length} stores currently have a Live planogram of that category assigned. Click a row to see which stores are missing it.</p>
        {coverageRows.length === 0 ? (
          <div className="text-sm text-slate-400 italic text-center py-4">No planograms have a Category set yet — add one in the planogram editor to track coverage here.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Category</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Covered</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Missing</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {coverageRows.map((r) => (
                  <React.Fragment key={r.category}>
                    <tr
                      onClick={() => setExpandedCategory(expandedCategory === r.category ? null : r.category)}
                      className="border-b border-slate-100 hover:bg-amber-50 cursor-pointer"
                    >
                      <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {expandedCategory === r.category ? <ChevronDown size={12} className="text-slate-400" /> : <ChevronRight size={12} className="text-slate-300" />}
                          {r.category}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{r.coveredCount} / {r.totalStores}</td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${r.missingCount > 0 ? "text-red-500" : "text-emerald-600"}`}>{r.missingCount}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.coveragePct.toFixed(0)}%</td>
                    </tr>
                    {expandedCategory === r.category && (
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <td colSpan={4} className="px-3 py-2.5">
                          {r.missingStores.length === 0 ? (
                            <div className="text-xs text-emerald-600">Every store has a Live "{r.category}" planogram.</div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {r.missingStores.map((s) => (
                                <span key={s.id} className="text-xs rounded-full px-2 py-0.5 border border-red-200 bg-red-50 text-red-600">
                                  {s.name}{s.region ? ` · ${s.region}` : ""}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-bold text-slate-800 text-base">Products Not on Any Active Planogram</h2>
          <input className={inputCls + " w-auto text-xs py-1 max-w-[220px]"} placeholder="Search products…" value={productSearch} onChange={(e) => setProductSearch(e.target.value)} />
        </div>
        <p className="text-xs text-slate-500 mt-0.5 mb-3">
          {orphanProducts.length} of {products.length} product{products.length !== 1 ? "s" : ""} aren't placed on any Live, Pending, or WIP planogram.
        </p>
        {filteredOrphans.length === 0 ? (
          <div className="text-sm text-slate-400 italic text-center py-4">{orphanProducts.length === 0 ? "Every product is placed on at least one active planogram." : "No matches."}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap" onClick={() => toggleProductSort("name")}>Product</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap" onClick={() => toggleProductSort("category")}>Category</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap" onClick={() => toggleProductSort("brand")}>Brand</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">SKU</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrphans.map(({ product, category, brand }) => (
                  <tr key={product.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{product.name}</td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{category}</td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{brand || "—"}</td>
                    <td className="px-3 py-2 text-slate-500 font-mono text-xs whitespace-nowrap">{product.sku || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function AnalysisModule({ products, planograms, stores, performance, productSchema }) {
  const [view, setView] = useState("performance"); // "performance" | "coverage"
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setView("performance")}
          className={`text-xs rounded-full px-3 py-1.5 border font-medium ${view === "performance" ? "bg-slate-800 border-slate-800 text-white" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
        >
          Category Performance
        </button>
        <button
          onClick={() => setView("coverage")}
          className={`text-xs rounded-full px-3 py-1.5 border font-medium ${view === "coverage" ? "bg-slate-800 border-slate-800 text-white" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
        >
          Coverage &amp; Gaps
        </button>
      </div>
      {view === "performance" ? (
        <CategoryAnalysisModule products={products} planograms={planograms} stores={stores} performance={performance} productSchema={productSchema} />
      ) : (
        <CoverageGapsModule products={products} planograms={planograms} stores={stores} productSchema={productSchema} />
      )}
    </div>
  );
}

function PerformanceModule({ products, performance, stores, productSchema, primaryKeyField, onSaveProductPerformance, onDeleteProductPerformance, onClearAllPerformance }) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const [showSheetLink, setShowSheetLink] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [sheetLink, setSheetLink] = useState("");
  const [sheetLinkError, setSheetLinkError] = useState("");
  const [fetchingSheet, setFetchingSheet] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [weeks, setWeeks] = useState(13);
  const [sortKey, setSortKey] = useState("totalSales");
  const [sortDir, setSortDir] = useState("desc"); // asc | desc — toggles when the same column is clicked again
  const [storeFilter, setStoreFilter] = useState("blended"); // "blended" | storeId
  const fileInputRef = useRef(null);

  const latestISO = getLatestWeekEnding(performance);
  const cutoffISO = getCutoffISO(latestISO, weeks);
  const activeStoreId = storeFilter === "blended" ? null : storeFilter;
  const availableWeeks = countAvailableWeeks(performance, activeStoreId);

  // which stores actually have performance data loaded, for the filter dropdown
  const storeIdsWithData = new Set();
  Object.values(performance).forEach((records) => (records || []).forEach((r) => { if (r.storeId) storeIdsWithData.add(r.storeId); }));
  const storesWithData = stores.filter((s) => storeIdsWithData.has(s.id));

  const rows = products
    .map((p) => ({ product: p, metrics: aggregateProductPerformance(p.id, performance, cutoffISO, activeStoreId) }))
    .filter((r) => r.metrics);

  rows.sort((a, b) => {
    const cmp = sortKey === "name" ? a.product.name.localeCompare(b.product.name) : (a.metrics[sortKey] || 0) - (b.metrics[sortKey] || 0);
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totals = rows.reduce(
    (acc, r) => ({
      totalUnits: acc.totalUnits + r.metrics.totalUnits,
      totalSales: acc.totalSales + r.metrics.totalSales,
      totalCost: acc.totalCost + r.metrics.totalCost,
      grossProfit: acc.grossProfit + r.metrics.grossProfit,
    }),
    { totalUnits: 0, totalSales: 0, totalCost: 0, grossProfit: 0 }
  );
  const blendedMarginPct = totals.totalSales > 0 ? (totals.grossProfit / totals.totalSales) * 100 : 0;

  const handleFileChosen = async (file) => {
    if (!file) return;
    setImporting(true); setImportStatus(null); setImportProgress({ current: 0, total: 0, phase: "reading" });
    try {
      const { grouped, matchedRows, unmatchedRows, unmatchedStoreRows } = await parsePerformanceWorkbook(file, products, stores, productSchema, primaryKeyField);
      const productIds = Object.keys(grouped);
      if (productIds.length === 0) {
        const reason = unmatchedStoreRows > 0 && unmatchedRows === 0
          ? "No rows matched — every row had a Store Name/Number that isn't in your Store Library. Check the Stores tab."
          : "No rows matched a product in your library. Check the Name/SKU columns.";
        setImportStatus({ type: "error", message: reason });
      } else {
        setImportProgress({ current: 0, total: productIds.length, phase: "importing" });
        for (let i = 0; i < productIds.length; i++) {
          const pid = productIds[i];
          const merged = mergePerformanceRecords(performance[pid], grouped[pid]);
          onSaveProductPerformance(pid, merged);
          setImportProgress({ current: i + 1, total: productIds.length, phase: "importing" });
          await new Promise((res) => setTimeout(res, 0));
        }
        const parts = [];
        if (unmatchedRows > 0) parts.push(`${unmatchedRows} row${unmatchedRows !== 1 ? "s" : ""} skipped — no matching product or missing date`);
        if (unmatchedStoreRows > 0) parts.push(`${unmatchedStoreRows} row${unmatchedStoreRows !== 1 ? "s" : ""} skipped — no matching store`);
        setImportStatus({
          type: "ok",
          message: `Loaded ${matchedRows} weekly row${matchedRows !== 1 ? "s" : ""} across ${productIds.length} product${productIds.length !== 1 ? "s" : ""}.` +
            (parts.length > 0 ? ` ${parts.join("; ")}.` : ""),
        });
      }
    } catch (err) {
      setImportStatus({ type: "error", message: "Couldn't read that file. Make sure it's an Excel (.xlsx/.xls) or CSV file laid out like the template." });
    } finally {
      setImporting(false); setImportProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Google Sheet link -> the fetch-sheet function reads it (the sheet must be shared "Anyone with the link") ->
  // the same import path as a chosen file.
  const importFromSheet = async () => {
    setSheetLinkError("");
    if (!sheetLink.trim()) return;
    setFetchingSheet(true);
    try {
      const res = await invokeEdgeFunction("fetch-sheet", { url: sheetLink.trim() });
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], res.filename || "google-sheet.csv", { type: "text/csv" });
      setShowSheetLink(false); setSheetLink("");
      await handleFileChosen(file);
    } catch (e) {
      setSheetLinkError(e?.message || "Couldn't read that sheet.");
    } finally {
      setFetchingSheet(false);
    }
  };

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc"); // name defaults A→Z, numeric metrics default highest-first
    }
  };
  const sortHeader = (key, label, align = "right") => (
    <th
      className={`px-3 py-2 cursor-pointer select-none whitespace-nowrap ${align === "right" ? "text-right" : "text-left"} ${sortKey === key ? "text-amber-600" : "text-slate-500"}`}
      onClick={() => handleSort(key)}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === "right" ? "flex-row-reverse" : ""}`}>
        {label}
        {sortKey === key && (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </span>
    </th>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-slate-800">Performance Data</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button className={btnGhost} onClick={() => setShowTemplateMenu((v) => !v)}><Download size={14} /> Download Template <ChevronDown size={12} /></button>
            {showTemplateMenu && (
              <div className="absolute right-0 z-30 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg p-1.5">
                {[
                  { id: "xlsx", label: "Excel (.xlsx)", hint: "with field instructions" },
                  { id: "xls", label: "Excel 97-2003 (.xls)", hint: "with field instructions" },
                  { id: "csv", label: "CSV (.csv)", hint: "header row only" },
                ].map((f) => (
                  <button key={f.id} className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-50" onClick={() => { downloadPerformanceTemplate(primaryKeyField, f.id); setShowTemplateMenu(false); }}>
                    <div className="text-xs font-medium text-slate-700">{f.label}</div>
                    <div className="text-[10px] text-slate-400">{f.hint}</div>
                  </button>
                ))}
                <div className="text-[10px] text-slate-400 px-2 pt-1 border-t border-slate-100 mt-1">For Google Sheets, open the CSV or Excel file in Sheets.</div>
              </div>
            )}
          </div>
          <button className={btnGhost} disabled={importing} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
            <Upload size={14} />
            {importing ? (importProgress?.phase === "importing" ? `Loading ${importProgress.current}/${importProgress.total}…` : "Reading file…") : "Upload Performance Data"}
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => handleFileChosen(e.target.files[0])} />
          <button className={btnGhost} disabled={importing} onClick={() => { setShowSheetLink((v) => !v); setSheetLinkError(""); }}>
            <Link2 size={14} /> From Google Sheet
          </button>
          {Object.keys(performance).length > 0 && (
            <button className={btnDanger} onClick={() => setConfirmingClear(true)}><Trash2 size={13} /> Clear All</button>
          )}
        </div>
      </div>

      {showSheetLink && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 mb-3 space-y-2">
          <div className="text-xs text-slate-500">
            Paste the link to a Google Sheet laid out like the template. The sheet must be shared as <span className="font-semibold">Anyone with the link → Viewer</span>.
            The tab in the link is the one that's read (open the right tab before copying the link).
          </div>
          <div className="flex items-center gap-2">
            <input className={inputCls} value={sheetLink} onChange={(e) => setSheetLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" onKeyDown={(e) => { if (e.key === "Enter") importFromSheet(); }} />
            <button className={btnPrimary} disabled={fetchingSheet || !sheetLink.trim()} onClick={importFromSheet}>{fetchingSheet ? "Reading…" : "Import"}</button>
            <button className={btnGhost} onClick={() => setShowSheetLink(false)}>Cancel</button>
          </div>
          {sheetLinkError && <div className="text-xs rounded-md px-2.5 py-1.5 bg-red-50 text-red-700 border border-red-200">{sheetLinkError}</div>}
        </div>
      )}

      {confirmingClear && (
        <div className="flex items-center justify-between gap-3 text-sm rounded-md px-3 py-2 mb-3 bg-red-50 text-red-700 border border-red-200">
          <span>Clear all performance data for {Object.keys(performance).length} product{Object.keys(performance).length !== 1 ? "s" : ""}? This can't be undone.</span>
          <div className="flex items-center gap-2 shrink-0">
            <button className={btnGhost} onClick={() => setConfirmingClear(false)}>Cancel</button>
            <button className={btnDanger} onClick={() => { onClearAllPerformance(); setConfirmingClear(false); }}>Clear All</button>
          </div>
        </div>
      )}
      <p className="text-xs text-slate-400 mb-3 flex items-center gap-1.5">
        <FileSpreadsheet size={13} /> Load weekly unit cost, retail price, and units sold per product per store from an Excel file (.xlsx/.xls), a CSV, or a Google Sheet link. Products are matched by <span className="font-semibold text-slate-500">{primaryKeyField === "upc" ? "UPC" : "SKU"}</span> (set in Settings).
      </p>
      {primaryKeyField === "upc" && !hasUpcField(productSchema) && (
        <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">
          Your Product Primary Key is set to UPC, but no "UPC" attribute field exists yet — add one under Settings or matching will always fail.
        </div>
      )}

      {importProgress && (
        <div className="mb-3">
          {importProgress.phase === "importing" ? (
            <>
              <div className="flex items-center justify-between text-xs text-slate-500 mb-1"><span>Loading products…</span><span className="font-mono">{importProgress.current} / {importProgress.total}</span></div>
              <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden"><div className="h-full bg-amber-500 transition-all" style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }} /></div>
            </>
          ) : <div className="flex items-center gap-2 text-xs text-slate-500"><RefreshCw size={12} className="animate-spin" /> Reading file…</div>}
        </div>
      )}
      {importStatus && (
        <div className={`text-sm rounded-md px-3 py-2 mb-3 ${importStatus.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>{importStatus.message}</div>
      )}

      {Object.keys(performance).length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No performance data loaded yet. Download the template, fill in weekly cost/price/units, and upload it.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-semibold text-slate-500 mr-1">Period:</span>
              {PERIOD_OPTIONS.map((w) => {
                const disabled = availableWeeks > 0 && w > availableWeeks;
                return (
                  <button
                    key={w}
                    disabled={disabled}
                    onClick={() => setWeeks(w)}
                    title={disabled ? `Only ${availableWeeks} week${availableWeeks !== 1 ? "s" : ""} of data loaded` : undefined}
                    className={`text-xs rounded-full px-3 py-1 border font-medium ${weeks === w ? "bg-amber-500 border-amber-500 text-slate-900" : disabled ? "border-slate-200 text-slate-300 cursor-not-allowed" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                  >
                    {w} wks
                  </button>
                );
              })}
              {latestISO && <span className="text-xs text-slate-400 ml-2 mr-1">through {latestISO}</span>}
              <span className="text-xs font-semibold text-slate-500 ml-2 mr-1 flex items-center gap-1"><Store size={12} /> Store:</span>
              <select className="text-xs rounded-md border border-slate-300 px-2 py-1" value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
                <option value="blended">All stores (blended)</option>
                {storesWithData.map((s) => <option key={s.id} value={s.id}>{s.name}{s.storeNumber ? ` (#${s.storeNumber})` : ""}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span><span className="font-semibold">{totals.totalUnits.toLocaleString()}</span> units</span>
              <span><span className="font-semibold">{money0(totals.totalSales)}</span> sales</span>
              <span><span className="font-semibold">{money0(totals.grossProfit)}</span> profit</span>
              <span><span className="font-semibold">{blendedMarginPct.toFixed(1)}%</span> margin</span>
            </div>
          </div>
          {availableWeeks > 0 && weeks > availableWeeks && (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mb-3">
              <AlertTriangle size={12} /> Only {availableWeeks} of {weeks} weeks selected have data loaded — figures reflect the {availableWeeks} week{availableWeeks !== 1 ? "s" : ""} available.
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  {sortHeader("name", "Product", "left")}
                  {sortHeader("avgWeeklyUnits", "Avg Wkly Units")}
                  {sortHeader("totalUnits", "Total Units")}
                  {sortHeader("avgUnitCost", "Avg Cost")}
                  {sortHeader("avgPrice", "Avg Price")}
                  {sortHeader("totalSales", "Total Sales $")}
                  {sortHeader("grossProfit", "Gross Profit $")}
                  {sortHeader("grossMarginPct", "Margin %")}
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ product, metrics }) => (
                  <tr key={product.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-700">{product.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{metrics.avgWeeklyUnits.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono">{metrics.totalUnits.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(metrics.avgUnitCost)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(metrics.avgPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money0(metrics.totalSales)}</td>
                    <td className="px-3 py-2 text-right font-mono">{money0(metrics.grossProfit)}</td>
                    <td className="px-3 py-2 text-right font-mono">{metrics.grossMarginPct.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right">
                      <button className="text-xs text-red-500 hover:underline" onClick={() => onDeleteProductPerformance(product.id)}>Clear</button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400 italic">No products have performance data within the last {weeks} weeks.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// Planner-side Store Feedback — every condition/issue reported by any store, across every
// planogram, in one place. This is what the header's "open issues" badge now links to.
/* ------------------------------------------------------------------ */
/* Help                                                                 */
/* ------------------------------------------------------------------ */

const HELP_SECTIONS = [
  {
    id: "overview",
    title: "Overview",
    blocks: [
      { type: "p", text: "Tandom Studio is an enterprise retail space-planning platform, used several ways. A separate **Event Planner** module coordinates resets, promos, and campaigns across the calendar that drives all planning and execution for merchandising planograms." },
      { type: "p", text: "Once Events are planned, Space Planners can create planograms that can be store-specific or cluster planograms, then publish to **Store Assistant** so store associates can track and execute a reset once it reaches their store." },
      { type: "p", text: "This guide walks through every screen, roughly in the order you'd use them. Use the search box on the left to jump straight to a topic." },
    ],
  },
  {
    id: "assortment",
    title: "Assortment",
    blocks: [
      { type: "p", text: "The **Assortment** tab (Admins and Category Managers) helps you decide which new items earn shelf space, and what comes out to make room. Choose a **Category**, who to **look at** (all stores, a region, a store cluster, a format or one store), the **Period** and what to **compare with**." },
      { type: "ul", items: [
        "**Segments:** list the product attributes in the order a shopper decides at the shelf (for cereal: Age group, then Sugar level, then Brand). The table splits the category that way and shows each segment's sales, share of sales, share of shelf space, space index (over 100 earns more than the room it takes), growth, and which segment holds the most space.",
        "**Slow movers:** every item ranked slowest first by units per store per week, with the bottom quarter flagged. Compare across regions, clusters, formats or stores to see where an item is slow in most places versus just one.",
        "**New items:** import what the category manager sent (Excel, CSV or a Google Sheet link; download the template first) or add items by hand. Each is added to the product library as Pending. Give it a forecast, or pick similar items and say how much it sells compared with them. It also needs its size, and a price (or a similar item's price).",
        "**Recommendations:** for each new item, every planogram in the category is checked. It goes into free space if there is any; otherwise the slowest items are removed, but only if the new item is expected to beat what is given up, and never so many that a segment loses all its variety. Untick a planogram to leave an item off it, lock an item to protect it, then press **Draft changes for review**.",
        "Drafts land in the **AI Draft Review Queue** on the Planograms tab like any other draft. Approving one builds a new Work-in-Progress version; live planograms are not touched.",
        "Growth needs sales history for both periods, so load at least twice the period's weeks on the Performance tab. Set each store's **Cluster** on the Stores tab to look at clusters.",
      ] },
    ],
  },
  {
    id: "customAttributes",
    title: "Planogram and Store Attributes",
    blocks: [
      { type: "p", text: "Planograms and stores can carry your own attributes, the same way products do. Define them under **Settings** (Planogram Attribute Fields and Store Attribute Fields) as text, number, Yes/No or dropdown fields, for example a planogram's *Assortment tier* or a store's *Foot traffic*." },
      { type: "ul", items: [
        "**Filling them in:** on the New Planogram and store forms, and on a planogram's Attributes tab.",
        "**Lists and cards:** press **Columns** (list view) or **Card fields** (grid view) on the Planograms and Stores tabs and tick the attributes to show. In the planogram list they can be edited in place and set on many selected planograms at once with **Set**.",
        "**Assortment:** look at stores by an attribute (or compare slow movers across it), and limit the analysis to planograms with a given attribute value.",
        "**Reset Impact:** Summarize by any store or planogram attribute.",
      ] },
    ],
  },
  {
    id: "resetImpact",
    title: "Reset Impact",
    blocks: [
      { type: "p", text: "The **Reset Impact** tab (Admins and Category Managers) shows how sales changed after a new planogram version went Live, using the Historical version as the baseline. Press **Measure all Live resets** to calculate it; the same figures appear as an **outcome** card in that planogram's Activity panel, including for resets that came from an approved AI proposal." },
      { type: "ul", items: [
        "**Before / after:** weekly averages for the weeks before each store completed the reset and the full weeks after. A store needs at least 4 weeks after to count; until then it shows as maturing and is left out of totals.",
        "**vs similar stores:** the change minus what stores that did not reset did over the same weeks, in percentage points, so a market-wide trend isn't credited to the reset.",
        "**Summarize by** Region, Store, Category, Department, Cluster, Store format or Planogram, and **Measure** Sales $, Units, Margin $ or Sales per linear foot (sales divided by the shelf space the category had before and after).",
      ] },
    ],
  },
  {
    id: "executionFollowup",
    title: "Execution Follow-up",
    blocks: [
      { type: "p", text: "The **Execution** tab (Admins and Category Managers) finds stores whose reset is **past its due date** (the planogram's Event Date) or **stuck in Partially Completed**. **Check stores** previews what would happen; nothing is sent until you confirm." },
      { type: "ul", items: [
        "Each late store gets one **Reset Follow-up** reminder in its Task Management list. A store is never sent a second reminder while the first is open.",
        "A store that is overdue (or stuck) by the **Escalate after** number of days is escalated to the Category Manager and listed under Escalations, flagged as a repeat when it was escalated before in the last 90 days.",
        "When a store finishes, running the check again closes its reminder and escalation.",
      ] },
    ],
  },
  {
    id: "askTandom",
    title: "Ask Tandom",
    blocks: [
      { type: "p", text: "**Ask Tandom** is a chat assistant. Planners and admins open it with the **Ask Tandom** button at the bottom right of the screen; store associates find it in the Store Assistant menu." },
      { type: "ul", items: [
        "Ask where a product goes, what changes in the next reset (new, deleted and changed items), which tasks are open, what a product's case pack is, or how to do something in the app.",
        "Store associates only see their own store's planograms, tasks and issues. Planners and admins can ask about anything.",
        "Ask it to mark a task complete (or reopen it) and it shows a confirmation card; the task only changes when you press **Confirm**.",
        "Open a planogram first and Ask Tandom knows which one you mean, so you can ask \"what changes in this planogram?\". Store associates get the same button inside the step-by-step execution guide.",
        "It looks answers up in your data rather than guessing, and says so when it can't find something. It can't edit planograms or products.",
      ] },
    ],
  },
  {
    id: "eventPlanner",
    title: "Event Planner",
    blocks: [
      { type: "p", text: "A separate full-screen module, reached from the top bar (**Event Planner** button), showing a monthly calendar of resets, promos, and campaigns with month/year navigation, search, and filter-by-type. Event types are fully customizable (defaults: Reset, Promo, Loyalty Campaign, Line Review, Vendor Collaboration, Clearance, Competitor Event, Line Extensions), each with its own label and color." },
      { type: "p", text: "Creating an event captures **Name**, **Type**, **Owner**, **Start/End Date**, **Lead Time** (in weeks), an optional list of linked planograms, and a **Category**." },
      { type: "ul", items: [
        "The **supplier deadline** — Start Date minus Lead Time — is computed live and flagged on the calendar as an alert for anything due within two weeks.",
        "**Promo conflict detection** flags pairs of Promo-type events in the same category whose date ranges overlap.",
      ] },
    ],
  },
  {
    id: "lifecycle",
    title: "Planogram Lifecycle & Versioning",
    blocks: [
      { type: "p", text: "Every planogram moves through five statuses: **WIP → Approved → Pending → Live → Historical.**" },
      { type: "p", text: "WIP and the Approved step are manual (an explicit \"Approve\" action); the two middle transitions run automatically off a single **Event Date** field: an Approved planogram becomes Pending 21 days before its Event Date, giving stores time to start markdown on items being discontinued, and a Pending planogram becomes Live exactly on the Event Date. Promoting to Live automatically retires any other Live member of the same version family to Historical in the same step, so exactly one Live layout exists per family at a time — a store marking its execution \"Completed\" also triggers this promotion." },
      { type: "p", text: "Versioning uses a flat family model: the first WIP a planogram is created as becomes that family's master, and every later copy points directly at the master rather than at whichever version it was copied from. \"Create Version\" clones the planogram (sections, fixtures, placements) with a new WIP status and no Event Date." },
      { type: "p", text: "The **Versions bar** atop the editor lists every family member as a clickable version pill with its own status badge; the planogram list also supports bulk multi-select with a \"Create Versions\" action to version several planograms at once, and nests non-master versions under their master in List view." },
    ],
  },
  {
    id: "editorBasics",
    title: "Planogram Editor Basics",
    blocks: [
      { type: "p", text: "A planogram is organized into **sections**, each holding a vertical stack of **fixtures** — Shelf, Pegboard, Hook Rail, Basket, or Divider Bar — snapped to 1-inch notches. Drag a fixture from the library into a section to add it, and drag it up or down to reslot it to a new notch position." },
      { type: "p", text: "Products come from the Product Library and are placed by dragging them onto a fixture. On a shelf, products pack left to right; on a pegboard, drop a product onto an open peg position." },
      { type: "p", text: "Each product's **Overhang Allowance** controls how far it can extend past a shelf's edge before being flagged as overflow, and its **Squeeze Factor** controls how tightly it can be compressed against neighbors when space is tight — both are set per product in the Product Library." },
    ],
  },
  {
    id: "multiSelect",
    title: "Multi-Select & Group Move",
    blocks: [
      { type: "p", text: "Hold **Ctrl** (**Cmd** on Mac) and drag anywhere in a section to draw a selection box. Anything the box touches gets selected:" },
      { type: "ul", items: [
        "Individual products, on any fixture — a shelf or a pegboard.",
        "Whole fixture bars — shelves and pegboards — if the box touches the bar itself.",
      ] },
      { type: "p", text: "Once something's selected:" },
      { type: "ul", items: [
        "Drag any selected product onto a different fixture, and the whole group moves together, in the order they were selected.",
        "Drag any selected fixture bar up or down, and every selected fixture moves together by the same amount, each one clamped to its own valid range.",
      ] },
      { type: "p", text: "Click anywhere empty to clear the selection — selecting something new also clears any previous group automatically." },
      { type: "p", text: "**Known limitations:**" },
      { type: "ul", items: [
        "Moving a group of pegboard-placed products to a *different* pegboard doesn't preserve their relative spacing — they're spread out from the drop point instead.",
        "Fixtures mounted directly onto a pegboard (the \"shelf on a pegboard backdrop\" pattern) aren't included in the selection box's hit-test yet — select those individually.",
      ] },
    ],
  },
  {
    id: "remainingSpace",
    title: "Remaining Space Label",
    blocks: [
      { type: "p", text: "The \"X in left\" / \"X in overhang\" badge on a shelf or pegboard bar only shows when you hover over or select that fixture, instead of always being visible — a cleaner canvas, especially when presenting to retailers. The red \"Over capacity\" warning is unaffected and still always shows. Turn this off entirely (along with capacity warnings generally) in Settings." },
    ],
  },
  {
    id: "psaImports",
    title: "PSA Imports from Blue Yonder",
    blocks: [
      { type: "p", text: "Planograms can be imported from Blue Yonder .psa file format." },
      { type: "p", text: "Products and fixtures brought in this way land flagged **Pending Approval**, the same as a manual import, and need review before they're fully part of the library — see Product Library Basics and Fixture Library below." },
    ],
  },
  {
    id: "productLibrary",
    title: "Product Library Basics",
    blocks: [
      { type: "p", text: "Products created or imported from an external system (like a PSA import) land flagged **Pending Approval**; a filter chip shows the count, and bulk \"Approve All\" / \"Delete All\" actions clear the queue." },
      { type: "p", text: "The library supports a **column picker** (toggle columns on/off, drag to reorder, drag to resize), Grid and List view toggles, full-text search across name/SKU/every attribute, and sortable columns." },
      { type: "p", text: "Bulk import/export runs through an Excel workbook: **Download Template** generates a spreadsheet with columns matching your current attribute schema, and **Upload Products** reads a filled-in workbook back in, matching existing products by SKU or UPC (whichever is set as your Primary Key) and creating anything new." },
    ],
  },
  {
    id: "imageRepo",
    title: "Product Images — Image Repository",
    blocks: [
      { type: "p", text: "Turn this on in Settings to have Tandom automatically find a product's orientation images from your own image server or CDN, matched by a filename pattern you define from the product's UPC or SKU. Configure:" },
      { type: "ul", items: [
        "**Lookup Key** — UPC or SKU",
        "**Base URL** — where your images live (a local folder or a cloud/CDN URL)",
        "**Filename Pattern** and **File Extensions** — how filenames are built from the key",
      ] },
      { type: "p", text: "Once enabled, a **Match from Repository** button appears in the product editor (fills in whichever of the 6 orientation views — Front, Back, Top, Bottom, Left, Right — it can find), and a **Match Images from Repository** bulk button appears in the Product Library toolbar to run it across every product still missing an image." },
    ],
  },
  {
    id: "webImageLookup",
    title: "Product Images — Web Image Lookup",
    blocks: [
      { type: "p", text: "A second, independent image source for when the Image Repository above has nothing yet — useful right after import, before anyone has sourced images. Rather than a JSON lookup API (every provider we tried blocks browser calls via CORS), this works by guessing a retailer's own public product-image URL pattern and using it if it loads — for example, Kroger's product-image CDN." },
      { type: "p", text: "Configure in Settings: **Base URL**, **Filename Pattern**, and **File Extensions**, the same shape as the Image Repository above. Retailer CDNs like Kroger's key their images by a specific 13-digit code rather than a raw UPC, so Tandom normalizes the UPC automatically before looking it up:" },
      { type: "ul", items: [
        "10-digit UPC → used as-is",
        "11-digit UPC → drop the leading digit",
        "12-digit UPC → drop the leading and trailing digit",
        "13-digit UPC → used as-is",
      ] },
      { type: "p", text: "Each of these is then zero-padded to 13 digits, so different digit-lengths for the same product all resolve to the same lookup key." },
      { type: "p", text: "Same two entry points as the Image Repository: **Find on Web (UPC)** in the product editor, and **Backfill Missing Images from Web** in the Product Library toolbar." },
      { type: "note", text: "This is a best-effort guess at an undocumented URL pattern, not an official API — it only finds images for products the retailer actually carries, and the retailer could change or block the pattern without notice. Treat the Image Repository as your primary, reliable source and this as a convenience for filling gaps." },
    ],
  },
  {
    id: "fixtureLibrary",
    title: "Fixture Library",
    blocks: [
      { type: "p", text: "A fixture is a reusable template: **Name**, **Type** (Shelf, Pegboard, Hook Rail, Basket, or Divider Bar), **Dimensions** (W × H × D in inches, snapped to 1\" notches), and any custom attributes from the Fixture Attribute Fields schema (configured in Settings)." },
      { type: "p", text: "Fixtures imported from an external system land flagged Pending Approval, the same as products, and need to be approved — individually or in bulk — before they're fully part of the library. The library offers Grid/List views and search by name or type." },
    ],
  },
  {
    id: "storeManagement",
    title: "Store Management",
    blocks: [
      { type: "p", text: "A store record holds **Name**, **Store Number**, **Address**, **Region**, **Format** (Supercenter, Standard Grocery, Express, Fuel & Convenience, or Warehouse), **Square Footage**, and **Status**." },
      { type: "p", text: "**Status** is the store's own operating status — separate from a planogram's Live/Pending lifecycle, which is about a layout, not the store itself. Options are **Live**, **Inactive**, **Pending**, **Closed**, and **Remodel**. A row of filter chips above the store list (All plus each status, with counts) narrows the list to just that status; a store saved before this field existed is treated as Live until you set it." },
      { type: "p", text: "Stores get linked to a planogram through an \"Assign Stores\" action on the planogram — that assignment is what makes a planogram appear in a given store's Store Assistant. The Store Library uses the same Grid/List and search pattern as Fixtures." },
    ],
  },
  {
    id: "storeAssistant",
    title: "Store Assistant",
    blocks: [
      { type: "p", text: "A separate app mode for store-level associates, entered from the top bar (**Store Assistant** button). A store-selector screen stands in for login — just a searchable list of stores to \"become.\"" },
      { type: "p", text: "The left-nav shell covers:" },
      { type: "ul", items: [
        "**My Store** — store profile and its assigned Live/Pending planograms",
        "**My Activities** — those same planograms with an execution status badge",
        "**Task Management**",
        "**Store Feedback**",
        "**Photo Collection**",
      ] },
      { type: "p", text: "Execution status runs **New → Reviewed → In Progress → Partially Completed / Completed / Rejected.** Opening a planogram's instructions auto-advances New to Reviewed; an associate can then mark it Complete, Partially Completed, or Reject (with a reason) — Completed also promotes the planogram to Live. A completed or rejected item can be reopened back to In Progress." },
      { type: "p", text: "The **Execution Guide** steps an associate through the reset: it compares the planogram against whatever was previously Live and buckets every product into **New Items** (\"Get Inventory\"), **Deleted Items** (\"Remove from Shelf & Markdown\"), or **Keep Items** (\"No Action Needed\") — each a checkable row, with per-section badges showing which changes belong to that section." },
      { type: "p", text: "**Store Feedback** reports a structured issue (Fixture Mismatch, Physical Obstruction, Shelf Overfilled, Delayed Shipment, Other) plus free text against a planogram." },
      { type: "p", text: "**Task Management** is the store's own operational to-do list, with a customizable task-type set (defaults: Inventory Audit, Pricing Audit, Fronting and Facing, Restocking, Damaged Good Processing, Other)." },
      { type: "p", text: "**Photo Collection** uploads a photo tagged with Category, \"Photo Represents\" (Compliance Photo, Issue, or Request), and Execution Date, browsable with a Grid/List toggle." },
    ],
  },
  {
    id: "performance",
    title: "Performance",
    blocks: [
      { type: "p", text: "The Performance tab imports per-product, per-store sales data (its own Excel template and upload, matched by SKU or UPC) and feeds the sales, margin, and unit-profit figures used by Tandom's analysis tools." },
    ],
  },
  {
    id: "categoryAnalysis",
    title: "Analysis — Category Analysis",
    blocks: [
      { type: "p", text: "Shows how a category is performing across the whole chain — **%Space**, **%Sales**, **%Units**, and **%Profit** — by joining every Live, store-assigned planogram against imported Performance data." },
      { type: "p", text: "Pick a **Period** (4/13/26/52 weeks, or all available Performance history), then break the numbers down **By Category**, **By Brand**, **By Manufacturer**, **By Store**, **By Region**, or **By Store Format**. When breaking down by anything other than Category, an optional Category filter narrows the view to just that category." },
      { type: "p", text: "**Sales/Space Index** = %Sales ÷ %Space × 100. Above 100 means that row is selling more than its shelf space would suggest; below 100 means it's over-spaced relative to its sales — a quick flag for space that could be reallocated." },
      { type: "p", text: "**Click any row** to drill into its products — a summary of current-period Sales, Units, and Gross Profit versus the same period one year earlier, with a callout for the biggest gainer and decliner, and a sortable per-product table showing each one's own year-over-year change. Clicking a Store row, for example, drills into that store's own products; clicking a Category row (while grouped by something else) drills into that category across whichever stores it appeared in." },
      { type: "note", text: "%Space is estimated from each placed product's width × facings (× squeeze factor), summed across every Live planogram's assigned stores — the same footprint math the shelf editor itself uses. Pegboard and Hook Rail placements use the same width-based estimate since they don't pack linearly the way a shelf does, so treat their %Space as a close approximation rather than an exact footprint." },
    ],
  },
  {
    id: "coverageGaps",
    title: "Analysis — Coverage & Gaps",
    blocks: [
      { type: "p", text: "A second view inside the **Analysis** tab (switch to it with the \"Coverage & Gaps\" toggle at the top) for spotting holes rather than measuring performance — three panels:" },
      { type: "ul", items: [
        "**Store List by Region** — every store grouped by Region, with a badge showing how many Live planograms are currently assigned to it (a red \"0 live\" badge is easy to spot).",
        "**Stores With No Live Planogram, by Category** — for each planogram Category, how many of your stores currently have a Live planogram of that category assigned. Click a row to see exactly which stores are missing it.",
        "**Products Not on Any Active Planogram** — every product that isn't placed on a single Live, Pending, or WIP planogram (Approved and Historical don't count) — a quick way to find items sitting unused in the library.",
      ] },
    ],
  },
  {
    id: "settingsReference",
    title: "Settings Reference",
    blocks: [
      { type: "p", text: "The **Settings** tab in the top nav is the full settings screen:" },
      { type: "ul", items: [
        "**Backup/Restore** — export or import the entire data set (schemas, products, fixtures, planograms, performance, stores) as one file.",
        "**Global Settings** — Product Primary Key (SKU or UPC, governs import/performance matching) and a Capacity Warnings toggle (controls the \"X in left/overhang\" badges and red \"Over capacity\" shelf warnings).",
        "**Image Repository** — auto-match product images from your own server/CDN by UPC or SKU.",
        "**Web Image Lookup (Retailer CDN)** — auto-match product images from a retailer's public image CDN, as a fallback when the Repository has nothing.",
        "**Product Attribute Fields** and **Fixture Attribute Fields** — define the custom attribute schema used throughout the product and fixture forms, columns, and templates.",
      ] },
    ],
  },
];

function renderHelpInline(text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-slate-800">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 1) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

function HelpBlock({ block }) {
  if (block.type === "ul") {
    return (
      <ul className="list-disc list-outside ml-5 space-y-1.5 text-sm text-slate-600 leading-relaxed">
        {block.items.map((item, i) => (
          <li key={i}>{renderHelpInline(item)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "note") {
    return (
      <p className="text-xs italic text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-3 py-2">
        {renderHelpInline(block.text)}
      </p>
    );
  }
  return <p className="text-sm text-slate-600 leading-relaxed">{renderHelpInline(block.text)}</p>;
}

function helpSectionMatches(section, q) {
  if (!q) return true;
  if (section.title.toLowerCase().includes(q)) return true;
  return section.blocks.some((b) => {
    if (b.type === "ul") return b.items.some((i) => i.toLowerCase().includes(q));
    return (b.text || "").toLowerCase().includes(q);
  });
}

function HelpScreen() {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(HELP_SECTIONS[0].id);

  const q = query.trim().toLowerCase();
  const filtered = HELP_SECTIONS.filter((s) => helpSectionMatches(s, q));
  const active = filtered.find((s) => s.id === activeId) || filtered[0] || HELP_SECTIONS[0];

  useEffect(() => {
    if (filtered.length > 0 && !filtered.some((s) => s.id === activeId)) {
      setActiveId(filtered[0].id);
    }
  }, [q]);

  return (
    <div className="grid grid-cols-[240px_1fr] gap-5 items-start">
      <div className="bg-white rounded-lg border border-slate-200 p-2 sticky top-4">
        <div className="relative mb-2">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md border border-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-400"
            placeholder="Search help…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav className="space-y-0.5 max-h-[70vh] overflow-y-auto">
          {filtered.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={`w-full text-left text-xs rounded-md px-2.5 py-1.5 transition-colors ${
                active?.id === s.id ? "bg-amber-500 text-slate-900 font-semibold" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {s.title}
            </button>
          ))}
          {filtered.length === 0 && <div className="text-xs text-slate-400 px-2.5 py-2">No results for "{query}".</div>}
        </nav>
      </div>
      <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-3 max-w-3xl">
        {active ? (
          <>
            <h2 className="font-bold text-slate-800 text-base flex items-center gap-2 pb-1 border-b border-slate-100">
              <HelpCircle size={16} className="text-amber-500 shrink-0" /> {active.title}
            </h2>
            <div className="space-y-3 pt-1">
              {active.blocks.map((b, i) => (
                <HelpBlock key={i} block={b} />
              ))}
            </div>
          </>
        ) : (
          <div className="text-sm text-slate-400">No help topic matches your search.</div>
        )}
      </div>
    </div>
  );
}

function StoreFeedbackView({ planograms, onResolveIssue, onOpenPlanogram }) {
  const [query, setQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("open"); // open | all | resolved
  const [filterType, setFilterType] = useState("All");

  const allFeedback = [];
  planograms.forEach((p) => {
    (p.issues || []).forEach((i) => allFeedback.push({ ...i, planogramId: p.id, planogramName: p.name }));
  });

  const q = query.trim().toLowerCase();
  const filtered = allFeedback
    .filter((i) => filterStatus === "all" || i.status === filterStatus)
    .filter((i) => filterType === "All" || i.type === filterType)
    .filter((i) => !q || (i.planogramName + " " + i.storeName + " " + i.message).toLowerCase().includes(q))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800 mb-1">Store Feedback</h2>
      <p className="text-sm text-slate-500 mb-4">Conditions stores have reported that impact a planogram or reset — fixture mismatches, physical obstructions, overfilled shelves, delayed shipments, and more.</p>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className={inputCls + " pl-8 text-xs py-1 w-56"} placeholder="Search planogram, store, or message…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className={inputCls + " w-auto text-xs py-1"} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="all">All</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className={inputCls + " w-auto text-xs py-1"} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="All">All Types</option>
          {ISSUE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          {allFeedback.length === 0 ? "No feedback has been reported yet." : "Nothing matches this filter."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((i) => (
            <div key={i.id} className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <button className="text-sm font-semibold text-slate-800 hover:text-amber-600 hover:underline text-left" onClick={() => onOpenPlanogram(i.planogramId)}>
                    {i.planogramName}
                  </button>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {i.storeName}{i.type && ` · ${ISSUE_TYPES.find((t) => t.id === i.type)?.label || i.type}`} · {new Date(i.createdAt).toLocaleString()}
                  </div>
                </div>
                <span className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border shrink-0 ${i.status === "resolved" ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-amber-50 text-amber-700 border-amber-300"}`}>
                  {i.status === "resolved" ? "Resolved" : "Open"}
                </span>
              </div>
              <p className="text-sm text-slate-600 mt-2">{i.message}</p>
              {i.status === "open" && (
                <button className="text-xs text-emerald-600 font-medium hover:underline mt-2" onClick={() => onResolveIssue(i.planogramId, i.id)}>Mark Resolved</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ProSpace (Blue Yonder / JDA) planogram import                        */
/*                                                                       */
/* .psa project files are CSV, one row per object (Project/Product/      */
/* Planogram/Segment/Fixture/Position/...), with the object type as the  */
/* first column and every other field in a fixed, documented order       */
/* (see ProSpace_Fields.txt — "Field order in data file"). There are no  */
/* foreign keys: the hierarchy is entirely positional — a Planogram's    */
/* Segments/Fixtures/Positions are simply the rows that follow it, until */
/* the next Planogram row. A project file can contain several            */
/* "Planogram" objects (ProSpace's way of letting a planner compare      */
/* e.g. an 8ft vs a 12ft version of the same set) — each is imported as  */
/* its own independent Tandom planogram, never as versions of each      */
/* other, since a single-planogram file is just as valid an input.       */
/*                                                                       */
/* Two format quirks worth calling out, both confirmed against a real    */
/* exported file before writing this:                                    */
/*  - Dimensions are in centimeters whenever Project.Measurement=1       */
/*    (Metric) and must be converted to inches for Tandom.               */
/*  - A Segment's own X/Y/Width/etc. fields are unused placeholders      */
/*    (always 0, or a flat 100) — a segment's REAL width and position    */
/*    come from summing segment widths in file order, and a Fixture's    */
/*    own (absolute, planogram-relative) X tells you which segment it    */
/*    falls into.                                                        */
/* ------------------------------------------------------------------ */

// RFC4180-ish CSV tokenizer — handles quoted fields, embedded commas, and "" escaped quotes,
// which a naive split(",") would mangle (product/planogram names can contain commas).
function parsePSACsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const PSA_CM_PER_IN = 2.54;
function psaNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function psaConv(v, metric) { const n = psaNum(v); return metric ? n / PSA_CM_PER_IN : n; }
// field-order idx (0-based, per ProSpace_Fields.txt) -> csv column = idx + 1 (col 0 is the tag)
function psaField(row, idx) { return row[idx + 1]; }

const PSA_FIXTURE_TYPE_MAP = {
  "0": "Shelf", "1": "Shelf", "2": "Shelf", "3": "Shelf",
  "4": "Hook Rail", "5": "Hook Rail", "6": "Hook Rail",
  "7": "Pegboard", "8": "Pegboard",
  "9": "Hook Rail", "10": "Divider Bar", "11": "Divider Bar", "12": "Shelf",
};
const PSA_MERCH_STYLE_MAP = { "0": "unit", "1": "tray", "2": "case", "3": "display", "4": "alternate", "5": "loose", "6": "logStack" };
// [face, rotation] for ProSpace's 24-value Position orientation enum (6 faces × 4 rotations)
const PSA_ORIENTATION_MAP = [
  ["front", 0], ["front", 90], ["left", 0], ["left", 90], ["top", 0], ["top", 90],
  ["back", 0], ["back", 90], ["right", 0], ["right", 90], ["bottom", 0], ["bottom", 90],
  ["front", 180], ["front", 270], ["left", 180], ["left", 270], ["top", 180], ["top", 270],
  ["back", 180], ["back", 270], ["right", 180], ["right", 270], ["bottom", 180], ["bottom", 270],
];

// Parses raw .psa text into an intermediate structure, already converted to inches, with the
// positional Segment/Fixture/Position hierarchy resolved. Does NOT touch Tandom's data model —
// see mapProSpaceImport for that.
function parsePSAFile(text) {
  const rows = parsePSACsv(text).filter((r) => r.length > 1 || (r[0] && r[0].trim()));
  const warnings = [];
  let metric = false;
  const products = [];
  const planograms = [];
  let curPlanogram = null;
  let curSegment = null;
  let curFixture = null;
  let segCumWidthCm = 0;

  for (const row of rows) {
    const tag = (row[0] || "").trim();
    if (tag === "Project") {
      metric = psaField(row, 11) === "1";
      continue;
    }
    if (tag === "Product") {
      const dims = { w: psaConv(psaField(row, 4), metric), h: psaConv(psaField(row, 5), metric), d: psaConv(psaField(row, 6), metric) };
      // ProSpace uses a degenerate 1×1×1 (cm) placeholder for a merch style that was never
      // actually defined for this product (as well as genuine 0s) — treat both as "not defined";
      // only keep a style whose size is real and meaningfully non-trivial.
      const styleDims = (wIdx, hIdx, dIdx) => {
        const rawW = psaNum(psaField(row, wIdx)), rawH = psaNum(psaField(row, hIdx)), rawD = psaNum(psaField(row, dIdx));
        if (rawW <= 0 || rawH <= 0 || rawD <= 0) return null;
        if (rawW <= 1 && rawH <= 1 && rawD <= 1) return null;
        return { w: psaConv(rawW, metric), h: psaConv(rawH, metric), d: psaConv(rawD, metric) };
      };
      const merchStyles = {};
      const tray = styleDims(45, 46, 47); if (tray) merchStyles.tray = tray;
      const kase = styleDims(53, 54, 55); if (kase) merchStyles.case = kase;
      const display = styleDims(61, 62, 63); if (display) merchStyles.display = display;
      const alternate = styleDims(69, 70, 71); if (alternate) merchStyles.alternate = alternate;
      const loose = styleDims(77, 78, 79); if (loose) merchStyles.loose = loose;
      products.push({
        upc: (psaField(row, 0) || "").trim(),
        prospaceId: (psaField(row, 1) || "").trim(),
        name: (psaField(row, 2) || "").trim() || "(unnamed product)",
        dims,
        category: (psaField(row, 12) || "").trim(),
        merchStyles,
      });
      continue;
    }
    if (tag === "Planogram") {
      if (curPlanogram) planograms.push(curPlanogram);
      curPlanogram = {
        name: (psaField(row, 0) || "Imported Planogram").trim(),
        key: (psaField(row, 1) || "").trim(),
        dims: { w: psaConv(psaField(row, 2), metric), h: psaConv(psaField(row, 3), metric), d: psaConv(psaField(row, 4), metric) },
        segments: [],
        // kept flat at the planogram level, NOT bucketed into a single owning segment — a real
        // gondola shelf often runs continuously across a section seam (see mapProSpaceImport,
        // which is where that's actually resolved: a fixture whose footprint spans more than one
        // segment gets split there instead of being force-fit, oversized, into just one).
        fixtures: [],
      };
      curSegment = null;
      curFixture = null;
      segCumWidthCm = 0;
      continue;
    }
    if (tag === "Performance") continue; // not imported — see the import summary's note about this
    if (tag === "Segment") {
      if (!curPlanogram) { warnings.push("Found a Segment before any Planogram — skipped."); continue; }
      const widthCm = psaNum(psaField(row, 3));
      const seg = {
        name: (psaField(row, 0) || "").trim() || `Section ${curPlanogram.segments.length + 1}`,
        width: psaConv(widthCm, metric) || 1,
        offsetXCm: segCumWidthCm,
      };
      segCumWidthCm += widthCm;
      curPlanogram.segments.push(seg);
      curSegment = seg;
      curFixture = null;
      continue;
    }
    if (tag === "Fixture") {
      if (!curPlanogram) { warnings.push("Found a Fixture before any Planogram — skipped."); continue; }
      const xCm = psaNum(psaField(row, 3));
      // Fixture X is absolute within the whole planogram — find which segment's cm range it
      // falls in (segments have no reliable X of their own; see file header comment above).
      let owner = null, acc = 0;
      for (const s of curPlanogram.segments) {
        const segWidthCm = s.width * (metric ? PSA_CM_PER_IN : 1);
        if (xCm >= acc - 0.001 && xCm < acc + segWidthCm - 0.001) { owner = s; break; }
        acc += segWidthCm;
      }
      if (!owner) owner = curSegment || curPlanogram.segments[curPlanogram.segments.length - 1];
      if (!owner) { warnings.push(`Fixture "${(psaField(row, 1) || "").trim()}" has no owning segment — skipped.`); continue; }
      const fx = {
        type: PSA_FIXTURE_TYPE_MAP[psaField(row, 0)] || "Shelf",
        name: (psaField(row, 1) || "Fixture").trim(),
        relativeX: psaConv(xCm - owner.offsetXCm, metric),
        // Position X/Y (below) are ALSO absolute within the whole planogram, same as a Fixture's
        // own X — so a peg's on-panel offset has to be found the same way: absolute minus the
        // owning fixture's own absolute origin. absoluteX/absoluteY capture that origin, in the
        // same (converted) units as Position.x/y, so Position parsing below can just subtract.
        absoluteX: psaConv(xCm, metric),
        width: psaConv(psaField(row, 4), metric) || 1,
        y: psaConv(psaField(row, 5), metric) || 0,
        height: psaConv(psaField(row, 6), metric) || 1,
        depth: psaConv(psaField(row, 8), metric) || 1,
        // ProSpace's per-fixture maximum merchandise height (Fixture field 22 in 2017 files, 23 in the 2008 dictionary); 0 = not set
        merchHeight: psaConv(psaField(row, 22), metric) || 0,
        positions: [],
      };
      curPlanogram.fixtures.push(fx);
      curFixture = fx;
      continue;
    }
    if (tag === "Position") {
      if (!curFixture) { warnings.push("Found a Position with no current Fixture — skipped."); continue; }
      const [face, rot] = PSA_ORIENTATION_MAP[psaNum(psaField(row, 28))] || ["front", 0];
      curFixture.positions.push({
        upc: (psaField(row, 0) || "").trim(),
        // relative to the owning fixture's own panel origin (see absoluteX comment above) — not
        // the raw absolute planogram coordinate, which is what these fields hold in the file.
        x: psaConv(psaField(row, 3), metric) - curFixture.absoluteX,
        y: psaConv(psaField(row, 5), metric) - curFixture.y,
        merchStyle: PSA_MERCH_STYLE_MAP[psaField(row, 12)] || "unit",
        hFacings: Math.max(1, Math.round(psaNum(psaField(row, 13)) || 1)),
        // Facings High / Deep (fields 14 and 15, verified against sample .psa totals).
        vFacings: Math.max(1, Math.round(psaNum(psaField(row, 14)) || 1)),
        dFacings: Math.max(1, Math.round(psaNum(psaField(row, 15)) || 1)),
        // Capping. Field numbers follow the ProSpace field dictionary (X cap num 16, Y cap num 20, Y cap
        // orientation 23, Z cap num 24 in these files; checked against the orientation defaults 4 = Top
        // at 23). A Y cap is units stacked on top of the position, the same product in its own orientation.
        // X (beside) and Z (behind) caps are counted so the import can say they were left out.
        yCap: Math.max(0, Math.round(psaNum(psaField(row, 20)) || 0)),
        yCapFace: (PSA_ORIENTATION_MAP[psaNum(psaField(row, 23))] || ["top", 0])[0],
        xCap: Math.max(0, Math.round(psaNum(psaField(row, 16)) || 0)),
        zCap: Math.max(0, Math.round(psaNum(psaField(row, 24)) || 0)),
        orientation: face,
        rotation: rot,
      });
      continue;
    }
  }
  if (curPlanogram) planograms.push(curPlanogram);
  return { metric, products, planograms, warnings };
}

function psaDimsClose(a, b, tol) {
  return Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol && Math.abs(a.d - b.d) <= tol;
}

// Maps a parsed .psa structure onto Tandom's data model: matches products/fixtures against the
// existing library where it reasonably can (by UPC/name for products, by type+dims for
// fixtures), and creates new ones — flagged pendingApproval — for anything it can't match, per
// the agreed approach ("add new products and fixtures but flag for approval"). Returns
// ready-to-create Tandom planogram/product/fixture objects; nothing is written to app state here.
function mapProSpaceImport(parsed, { existingProducts, existingFixtures, productSchema }) {
  const warnings = [...parsed.warnings];
  const schemaPatch = [];

  let upcField = (productSchema || []).find((f) => f.label.trim().toLowerCase() === "upc");
  if (!upcField) {
    upcField = { id: uid("f"), label: "UPC", type: "text" };
    schemaPatch.push(upcField);
  }
  const categoryField = (productSchema || []).find((f) => f.label.trim().toLowerCase() === "category");

  const productByUpc = {};
  const productByName = {};
  (existingProducts || []).forEach((p) => {
    const upc = (p.attributes?.[upcField.id] || "").toString().trim().toLowerCase();
    if (upc) productByUpc[upc] = p;
    productByName[p.name.trim().toLowerCase()] = p;
  });

  const newProducts = [];
  const upcToProductId = {};
  let matchedProductCount = 0;
  parsed.products.forEach((pp) => {
    const upcKey = pp.upc.trim().toLowerCase();
    const nameKey = pp.name.trim().toLowerCase();
    const existing = (upcKey && productByUpc[upcKey]) || productByName[nameKey];
    if (existing) { upcToProductId[pp.upc] = existing.id; matchedProductCount++; return; }
    const attributes = {};
    if (pp.upc) attributes[upcField.id] = pp.upc;
    if (categoryField && pp.category) attributes[categoryField.id] = pp.category;
    const draft = {
      id: uid("prod"),
      name: pp.name,
      sku: pp.prospaceId || "",
      dims: pp.dims,
      attributes,
      images: {},
      merchStyles: pp.merchStyles,
      pendingApproval: true,
      importSource: "ProSpace",
    };
    newProducts.push(draft);
    upcToProductId[pp.upc] = draft.id;
  });

  // dedupe new fixtures by type+dims "shape" so e.g. 55 identical shelves become 1 new fixture def
  const fixtureShapeKey = (type, dims) => `${type}|${dims.w.toFixed(1)}|${dims.h.toFixed(1)}|${dims.d.toFixed(1)}`;
  const fixtureIdByShape = {};
  const newFixtures = [];
  let matchedFixtureCount = 0;
  const resolveFixtureId = (type, dims) => {
    const key = fixtureShapeKey(type, dims);
    if (fixtureIdByShape[key]) return fixtureIdByShape[key];
    const existing = (existingFixtures || []).find((f) => f.type === type && psaDimsClose(f.dims, dims, 0.35));
    if (existing) { fixtureIdByShape[key] = existing.id; matchedFixtureCount++; return existing.id; }
    const draft = {
      id: uid("fix"),
      name: `${type} ${dims.w.toFixed(0)}×${dims.h.toFixed(0)}×${dims.d.toFixed(0)}in (ProSpace)`,
      type,
      dims,
      attributes: {},
      pendingApproval: true,
      importSource: "ProSpace",
    };
    newFixtures.push(draft);
    fixtureIdByShape[key] = draft.id;
    return draft.id;
  };

  // needed to convert a pegboard Position's X into Tandom's pegX below — looked up by id since
  // productId may point at either a just-matched existing product or a newly-created draft
  const productById = {};
  (existingProducts || []).forEach((p) => { productById[p.id] = p; });
  newProducts.forEach((p) => { productById[p.id] = p; });

  let placementCount = 0;
  let skippedPlacements = 0;
  let sideCapPositions = 0; // positions with X (beside) or Z (behind) caps, which aren't imported
  let merchHeightFixes = 0; // shelves whose source stacks run past the space above them
  const planogramDrafts = parsed.planograms.map((pg) => {
    // absolute-inch [start, end) range for every segment, used below to find which segment(s) a
    // fixture's physical footprint actually falls in — a real gondola shelf often runs
    // continuously across a section seam, so a fixture's footprint can span more than one of
    // these ranges.
    let cursorIn = 0;
    const segRanges = pg.segments.map((seg) => {
      const r = { startIn: cursorIn, endIn: cursorIn + (seg.width || 0) };
      cursorIn += seg.width || 0;
      return r;
    });
    const fixturesBySegment = pg.segments.map(() => []);
    // a segment's peg backboard often carries no positions at all — the retailer's real gondola
    // has one everywhere structurally, but it's only merchandised in some spots. An unused one
    // isn't a real interactive fixture worth importing (nothing is placed on it, so it has no
    // capacity/placements to manage); it's just the cosmetic look of the backwall, which the
    // section-level backboardStyle property now models directly instead.
    const segBackboardStyle = pg.segments.map(() => null);

    pg.fixtures.forEach((fx) => {
      const isPegboard = fx.type === "Pegboard";
      const fxStart = fx.absoluteX;
      const fxEnd = fx.absoluteX + fx.width;
      // real exports carry a little rounding noise around clean boundaries (a fixture landing at
      // e.g. x=11.97 instead of a true x=12 seam) — a sub-half-inch sliver of "overlap" from that
      // noise isn't a genuine cross-segment shelf, so it's ignored rather than triggering a split
      // over essentially nothing
      let overlapping = segRanges
        .map((r, idx) => ({ idx, startIn: Math.max(r.startIn, fxStart), endIn: Math.min(r.endIn, fxEnd) }))
        .filter((o) => o.endIn - o.startIn > 0.5);
      if (overlapping.length === 0) {
        // didn't cleanly land in any segment's range (bad/rounded data) — fall back to whichever
        // segment its left edge is closest to, rather than dropping the fixture entirely
        let best = 0, bestDist = Infinity;
        segRanges.forEach((r, idx) => { const d = Math.abs(r.startIn - fxStart); if (d < bestDist) { bestDist = d; best = idx; } });
        overlapping = [{ idx: best, startIn: segRanges[best] ? segRanges[best].startIn : 0, endIn: (segRanges[best] ? segRanges[best].startIn : 0) + fx.width }];
      }
      // a pegboard is kept single-segment even if its footprint technically bleeds past its own
      // section's edge — it already has its own dedicated cross-section "bleed" rendering as a
      // backdrop, and its 2D peg grid doesn't fit the 1D shelf-splitting/joining model below.
      if (isPegboard && overlapping.length > 1) overlapping = [overlapping[0]];
      const split = overlapping.length > 1;
      const groupId = split ? uid("psagrp") : null;

      const allPlacements = [];
      fx.positions.forEach((pos) => {
        const productId = upcToProductId[pos.upc];
        if (!productId) { skippedPlacements++; warnings.push(`A position referencing unknown UPC "${pos.upc}" was skipped.`); return; }
        const placement = {
          id: uid("pl"),
          productId,
          facings: pos.hFacings || 1,
          orientation: pos.orientation,
          rotation: pos.rotation,
          merchStyle: pos.merchStyle,
        };
        if (!isPegboard) {
          if (pos.vFacings > 1) placement.high = pos.vFacings;
          if (pos.dFacings > 1) placement.deep = pos.dFacings;
          if (pos.yCap > 0) placement.cap = { productId: null, count: pos.yCap, orientation: pos.yCapFace };
          if (pos.xCap > 0 || pos.zCap > 0) sideCapPositions++;
        }
        if (isPegboard) {
          // ProSpace's Position X is the item's LEFT edge on the panel — the same left-edge
          // convention every other X field in this format uses. Tandom's own pegX is the
          // physical peg/hook the item hangs CENTERED on, so shift by half the item's rendered
          // width to convert conventions. Without this, every item is drawn half a width too
          // far left — invisible for interior items, but a left-edge item (x=0) then hangs half
          // off the panel and trips the "pegs outside the panel" warning.
          const prod = productById[productId];
          const dims = (prod && pos.merchStyle && pos.merchStyle !== "unit" && prod.merchStyles?.[pos.merchStyle]) || prod?.dims || { w: 1, h: 1 };
          const rotated = pos.rotation === 90 || pos.rotation === 270;
          const wIn = (rotated ? dims.h : dims.w) || 1;
          const hIn = (rotated ? dims.w : dims.h) || 1;
          // Snapping that center to the nearest whole-inch hole (pegs are physically discrete —
          // see the comment on pegToOrigin) can round an already edge-flush item a hair past the
          // panel boundary. Clamp the candidate hole to the nearest one that still keeps the
          // item fully on the panel, rather than flagging a fraction-of-an-inch rounding
          // artifact as a real placement problem.
          let pegX = Math.round(pos.x + wIn / 2);
          const minPegX = Math.ceil(wIn / 2 - 0.001);
          const maxPegX = Math.floor(fx.width - wIn / 2 + 0.001);
          if (Number.isFinite(minPegX)) pegX = Math.max(pegX, minPegX);
          if (Number.isFinite(maxPegX)) pegX = Math.min(pegX, maxPegX);
          placement.pegX = pegX;
          // ProSpace's Position Y for a pegged item is its BOTTOM edge (confirmed directly
          // against JDA's own Position Properties dialog: Y=63.5in absolute for an item whose
          // relative Y is 10in above this panel's own 53.5in base — that matches this item's
          // bottom, not its top or the hook it hangs from). Tandom's own pegY is the physical
          // peg/hook position, which sits just ABOVE the item's top (see pegToOrigin's 0.25in
          // hang-hole offset) — so it's Y + the item's own rendered height + that offset, not Y
          // itself. Using Y directly (as if it were the hook) used to hang every item roughly one
          // item-height too low — invisible for a short item, but for a tall bag or box it put
          // the item's bottom edge below the panel entirely, overlapping whatever fixture sits
          // underneath the pegboard.
          placement.pegY = Math.round(pos.y + hIn + 0.25);
        }
        placementCount++;
        // absX is only used below to split a multi-segment shelf's items into the right member —
        // pegboard placements already carry their own on-panel pegX/pegY above
        allPlacements.push({ placement, absX: fx.absoluteX + pos.x });
      });

      if (isPegboard && allPlacements.length === 0) {
        segBackboardStyle[overlapping[0].idx] = "pegboard";
        return;
      }

      if (!split) {
        const fixtureId = resolveFixtureId(fx.type, { w: fx.width, h: fx.height, d: fx.depth });
        fixturesBySegment[overlapping[0].idx].push({
          id: uid("fxi"), fixtureId,
          notchY: Math.max(0, Math.round(fx.y)),
          xOffset: Math.max(0, Math.round(fx.relativeX)),
          alignment: "left",
          ...(fx.merchHeight > 0 ? { merchHeightIn: fx.merchHeight } : {}),
          placements: allPlacements.map((p) => p.placement),
        });
        return;
      }

      // split: one Tandom fixture instance per segment this fixture's footprint overlaps, each
      // sized to just its own portion (not the fixture's full original width), flush against its
      // section's left edge, and joined via a shared groupId — Tandom's existing cross-section
      // "join" feature — so computeJoinedGroupLayouts packs all their placements as one
      // continuous run instead of one oversized fixture bleeding over and burying whatever the
      // neighboring section actually owns.
      overlapping.forEach((o, idx) => {
        const portionWidthIn = Math.max(1, o.endIn - o.startIn);
        const memberFixtureId = resolveFixtureId(fx.type, { w: portionWidthIn, h: fx.height, d: fx.depth });
        const isLastMember = idx === overlapping.length - 1;
        // an item's LEFT edge decides which member it belongs to; the last member also catches
        // anything at/past its own start (rounding, or genuine overflow past the combined run),
        // same forgiving "catch everything beyond" behavior computeJoinedGroupLayouts itself uses
        const memberPlacements = allPlacements
          .filter((p) => isLastMember ? p.absX >= o.startIn - 0.05 : (p.absX >= o.startIn - 0.05 && p.absX < o.endIn - 0.05))
          .map((p) => p.placement);
        fixturesBySegment[o.idx].push({
          id: uid("fxi"), fixtureId: memberFixtureId,
          notchY: Math.max(0, Math.round(fx.y)),
          xOffset: 0,
          alignment: "left",
          groupId,
          ...(fx.merchHeight > 0 ? { merchHeightIn: fx.merchHeight } : {}),
          placements: memberPlacements,
        });
      });
    });

    const sections = pg.segments.map((seg, segIdx) => ({
      id: uid("sec"),
      name: seg.name,
      width: Math.round(seg.width) || 1,
      fixtures: fixturesBySegment[segIdx],
      ...(segBackboardStyle[segIdx] ? { backboardStyle: segBackboardStyle[segIdx] } : {}),
    }));
    // A source shelf may carry stacks taller than the space above it (ProSpace lets a top shelf run past
    // the bay). Take the source as right: that shelf's merchandise height is set to its tallest stack, so it
    // opens without red flags, and the height rule still applies to anything added afterwards.
    {
      const defs = [...(existingFixtures || []), ...newFixtures];
      const prods = Object.values(productById);
      const draftPog = { dims: { h: Math.round(pg.dims.h) || 84 }, base: 0, sections };
      sections.forEach((sec) => sec.fixtures.forEach((fxi) => {
        if (defs.find((d) => d.id === fxi.fixtureId)?.type === "Pegboard") return;
        const clearance = getShelfClearanceIn(draftPog, sec, fxi, defs);
        if (!Number.isFinite(clearance)) return;
        let tallest = 0;
        fxi.placements.forEach((pl) => {
          const prod = productById[pl.productId];
          if (prod) tallest = Math.max(tallest, getStackDims(prod, pl, prods).heightIn);
        });
        // only a shelf with nothing above it (clearance runs to the top of the bay) gets this; a stack that
        // is too tall for the shelf above it would collide with that shelf, so it stays flagged
        const def = defs.find((d) => d.id === fxi.fixtureId);
        const topGap = draftPog.dims.h - ((fxi.notchY || 0) + (def ? def.dims.h : 2));
        const nothingAbove = Math.abs(clearance - topGap) < 1e-6;
        if (nothingAbove && tallest > clearance + 1e-6) { fxi.merchHeightIn = Math.ceil(tallest * 100) / 100; merchHeightFixes++; }
      }));
    }
    return {
      id: uid("pog"),
      name: pg.name,
      category: "",
      eventDate: "",
      dims: { w: Math.round(pg.dims.w) || 48, h: Math.round(pg.dims.h) || 84, d: Math.round(pg.dims.d) || 20 },
      base: 0,
      sections,
      storeIds: [],
      status: "wip",
      masterId: null,
      versionNumber: 1,
      importSource: { system: "ProSpace", key: pg.key },
    };
  });

  if (parsed.planograms.length === 0) warnings.push("No Planogram objects were found in this file.");
  if (merchHeightFixes > 0) warnings.push(`${merchHeightFixes} top shel${merchHeightFixes === 1 ? "f" : "ves"} carried stacks taller than the bay in the source file (ProSpace allows that), so ${merchHeightFixes === 1 ? "its" : "their"} merchandise height was set to the tallest stack.`);
  if (sideCapPositions > 0) warnings.push(`${sideCapPositions} position${sideCapPositions === 1 ? "" : "s"} had caps beside or behind the stack (X / Z caps), which aren't imported yet; caps on top are.`);

  return {
    planogramDrafts,
    newProducts,
    newFixtures,
    schemaPatch,
    warnings,
    stats: {
      planogramCount: planogramDrafts.length,
      matchedProductCount,
      newProductCount: newProducts.length,
      matchedFixtureCount,
      newFixtureCount: newFixtures.length,
      placementCount,
      skippedPlacements,
    },
  };
}

function ProSpaceImportModal({ products, fixtures, productSchema, onClose, onImport }) {
  const [phase, setPhase] = useState("pick"); // pick | reading | error | preview
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // mapProSpaceImport output
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const fileInputRef = useRef(null);

  const [fileErrors, setFileErrors] = useState([]); // [{ name, message }] for files that couldn't be imported
  const [fileSummaries, setFileSummaries] = useState([]); // [{ name, planograms }] for files that were read

  const readText = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(String(e.target.result || ""));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsText(file, "windows-1252");
  });

  // Reads each chosen file in turn. Files are mapped one after another against a running copy of the library,
  // so a product or fixture that is new in the first file is matched, not duplicated, when it shows up again
  // in the next. One bad file doesn't stop the others; it is listed with its reason.
  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setPhase("reading");
    setError("");
    const errors = [];
    const summaries = [];
    const merged = { planogramDrafts: [], newProducts: [], newFixtures: [], schemaPatch: [], warnings: [], stats: { planogramCount: 0, matchedProductCount: 0, newProductCount: 0, matchedFixtureCount: 0, newFixtureCount: 0, placementCount: 0, skippedPlacements: 0 } };
    let runningProducts = products;
    let runningFixtures = fixtures;
    let runningSchema = productSchema;
    for (const file of files) {
      try {
        const parsed = parsePSAFile(await readText(file));
        // Cm→inch conversion (unit math only, not layout logic) hasn't been validated against a
        // real metric ProSpace export yet, so rather than silently convert and risk a subtly
        // wrong import, we block metric files here with a clear reason.
        if (parsed.metric) {
          errors.push({ name: file.name, message: "Uses Metric units (centimeters). Only Imperial (inch-based) files can be imported right now." });
          continue;
        }
        const mapped = mapProSpaceImport(parsed, { existingProducts: runningProducts, existingFixtures: runningFixtures, productSchema: runningSchema });
        mapped.planogramDrafts.forEach((pg) => { pg.sourceFileName = file.name; });
        runningProducts = [...runningProducts, ...mapped.newProducts];
        runningFixtures = [...runningFixtures, ...mapped.newFixtures];
        runningSchema = [...runningSchema, ...mapped.schemaPatch];
        merged.planogramDrafts.push(...mapped.planogramDrafts);
        merged.newProducts.push(...mapped.newProducts);
        merged.newFixtures.push(...mapped.newFixtures);
        merged.schemaPatch.push(...mapped.schemaPatch);
        merged.warnings.push(...mapped.warnings.map((w) => (files.length > 1 ? `${file.name}: ${w}` : w)));
        Object.keys(merged.stats).forEach((k) => { merged.stats[k] += mapped.stats[k] || 0; });
        summaries.push({ name: file.name, planograms: mapped.planogramDrafts.length });
      } catch (err) {
        errors.push({ name: file.name, message: "Couldn't parse it. Make sure it's a ProSpace .psa export." });
      }
    }
    setFileErrors(errors);
    setFileSummaries(summaries);
    if (merged.planogramDrafts.length === 0) {
      setError(errors.length ? "None of the files could be imported." : "No Planogram objects were found in the selected file(s).");
      setPhase("error");
      return;
    }
    setResult(merged);
    setSelectedIds(new Set(merged.planogramDrafts.map((p) => p.id)));
    setPhase("preview");
  };

  const toggleSelected = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const doImport = () => {
    if (!result) return;
    const chosen = result.planogramDrafts.filter((p) => selectedIds.has(p.id)).map(({ sourceFileName, ...pg }) => pg);
    if (chosen.length === 0) return;
    // only carry through new products/fixtures actually referenced by the chosen planograms
    const usedProductIds = new Set();
    const usedFixtureIds = new Set();
    chosen.forEach((pg) => pg.sections.forEach((s) => s.fixtures.forEach((fx) => {
      usedFixtureIds.add(fx.fixtureId);
      fx.placements.forEach((pl) => usedProductIds.add(pl.productId));
    })));
    const newProducts = result.newProducts.filter((p) => usedProductIds.has(p.id));
    const newFixtures = result.newFixtures.filter((f) => usedFixtureIds.has(f.id));
    onImport({ planograms: chosen, newProducts, newFixtures, schemaPatch: result.schemaPatch });
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg border border-slate-200 shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-800">Import .psa file</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {phase === "pick" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Choose one or more ProSpace/Blue Yonder <code>.psa</code> project files. Each Planogram they contain is imported as its own,
              independent Tandom planogram. Products and fixtures are matched against your existing library where possible
              (by UPC and by dimensions) — anything new is created and flagged <span className="font-semibold text-amber-600">Pending Approval</span> for
              you to review afterward.
            </p>
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
              Only Imperial (inch-based) ProSpace files are supported right now. A Metric (cm) file will be rejected with an
              explanation rather than auto-converted.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".psa,.txt,.csv"
              multiple
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
            />
            <button className={btnPrimary} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
              <Upload size={14} /> Choose .psa file(s)
            </button>
          </div>
        )}

        {phase === "reading" && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
            <RefreshCw size={16} className="animate-spin" /> Reading and parsing files…
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-2">
            <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</div>
            {fileErrors.map((fe) => <div key={fe.name} className="text-xs text-red-700"><span className="font-semibold">{fe.name}</span> — {fe.message}</div>)}
            <button className={btnGhost} onClick={() => { setPhase("pick"); setFileErrors([]); }}>Choose different files</button>
          </div>
        )}

        {phase === "preview" && result && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="bg-slate-50 border border-slate-200 rounded-md p-2 text-center">
                <div className="text-lg font-bold text-slate-800">{result.stats.planogramCount}</div>
                <div className="text-slate-500">Planogram{result.stats.planogramCount !== 1 ? "s" : ""} found</div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-md p-2 text-center">
                <div className="text-lg font-bold text-slate-800">{result.stats.matchedProductCount}</div>
                <div className="text-slate-500">Products matched</div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-md p-2 text-center">
                <div className="text-lg font-bold text-amber-700">{result.stats.newProductCount + result.stats.newFixtureCount}</div>
                <div className="text-amber-700">New items — pending approval</div>
              </div>
            </div>

            {fileErrors.length > 0 && (
              <div className="text-xs rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200 space-y-0.5">
                <div className="font-semibold">{fileErrors.length} file{fileErrors.length !== 1 ? "s" : ""} couldn't be imported:</div>
                {fileErrors.map((fe) => <div key={fe.name}><span className="font-semibold">{fe.name}</span> — {fe.message}</div>)}
              </div>
            )}
            {result.warnings.length > 0 && (
              <div className="text-xs rounded-md px-3 py-2 bg-amber-50 text-amber-700 border border-amber-200 space-y-0.5 max-h-28 overflow-y-auto">
                {result.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}
            <div className="space-y-2">
              {result.planogramDrafts.map((pg) => {
                const fixtureCount = pg.sections.reduce((s, sec) => s + sec.fixtures.length, 0);
                const placementCount = pg.sections.reduce((s, sec) => s + sec.fixtures.reduce((s2, fx) => s2 + fx.placements.length, 0), 0);
                return (
                  <label key={pg.id} className="flex items-start gap-2.5 border border-slate-200 rounded-md p-2.5 cursor-pointer hover:bg-slate-50">
                    <input type="checkbox" className="mt-0.5" checked={selectedIds.has(pg.id)} onChange={() => toggleSelected(pg.id)} />
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-slate-800">{pg.name}</div>
                      <div className="text-xs text-slate-500">
                        {fileSummaries.length > 1 && pg.sourceFileName ? `${pg.sourceFileName} · ` : ""}{pg.dims.w}×{pg.dims.h}×{pg.dims.d} in · {pg.sections.length} section{pg.sections.length !== 1 ? "s" : ""} · {fixtureCount} fixture{fixtureCount !== 1 ? "s" : ""} · {placementCount} placement{placementCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            {result.stats.skippedPlacements > 0 && (
              <div className="text-xs rounded-md px-3 py-2 bg-amber-50 text-amber-700 border border-amber-200">
                {result.stats.skippedPlacements} position{result.stats.skippedPlacements !== 1 ? "s" : ""} referenced a product not found anywhere in the file and were skipped.
              </div>
            )}
            <div className="text-xs text-slate-400">
              Note: ProSpace performance/movement data in this file was not imported — bring that in separately via Performance Data upload if needed.
              Pegboard hole positions are carried over directly and may need minor adjustment.
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button className={btnGhost} onClick={onClose}>Cancel</button>
              <button className={btnPrimary} disabled={selectedIds.size === 0} onClick={doImport}>
                <Check size={14} /> Import {selectedIds.size} Planogram{selectedIds.size !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Planogram list                                                       */
/* ------------------------------------------------------------------ */

function NewPlanogramForm({ existingCategories, planogramSchema, onCreate, onCancel }) {
  const [attributes, setAttributes] = useState({});
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [w, setW] = useState(96);
  const [h, setH] = useState(84);
  const [d, setD] = useState(20);
  const [base, setBase] = useState(4);

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4 max-w-lg">
      <Field label="Planogram Name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Beer Aisle — Gondola 12" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} list="category-suggestions" placeholder="e.g. Beer" />
          <datalist id="category-suggestions">
            {existingCategories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>
        <Field label="Event / Reset Date">
          <input type="date" className={inputCls} value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Gondola Width (in)"><input type="number" className={inputCls} value={w} onChange={(e) => setW(e.target.value)} /></Field>
        <Field label="Gondola Height (in)"><input type="number" className={inputCls} value={h} onChange={(e) => setH(e.target.value)} /></Field>
        <Field label="Depth (in)"><input type="number" className={inputCls} value={d} onChange={(e) => setD(e.target.value)} /></Field>
        <Field label="Base Height (in)"><input type="number" className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} /></Field>
      </div>
      <p className="text-xs text-slate-400">Base is the distance from the floor to where the first shelf notch begins (kick plate).</p>
      {planogramSchema && planogramSchema.length > 0 && (
        <div>
          <div className={labelCls}>Your attributes</div>
          <AttributeFields schema={planogramSchema} values={attributes} onChange={setAttributes} columns="grid-cols-2" />
        </div>
      )}
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button
          className={btnPrimary}
          disabled={!name.trim()}
          onClick={() =>
            onCreate({
              id: uid("pog"),
              name: name.trim(),
              category: category.trim(),
              eventDate: eventDate || "",
              dims: { w: Number(w) || 48, h: Number(h) || 84, d: Number(d) || 20 },
              base: Number(base) || 0,
              attributes,
              sections: [],
              storeIds: [],
              status: "wip", // every planogram starts here — see Planogram Lifecycle
              masterId: null, // this planogram IS the master of its version family
              versionNumber: 1,
            })
          }
        >
          <Plus size={14} /> Create Planogram
        </button>
      </div>
    </div>
  );
}

// Columns of the Planograms list view. `editable` columns can be changed in place; the rest are shown for reference.
const PLANOGRAM_LIST_COLUMNS = [
  { id: "name", label: "Name", editable: true, defaultOn: true, locked: true },
  { id: "status", label: "Status", defaultOn: true },
  { id: "category", label: "Category", editable: true, defaultOn: true },
  { id: "department", label: "Department", editable: true, defaultOn: true },
  { id: "cluster", label: "Cluster", editable: true, defaultOn: true },
  { id: "eventDate", label: "Event Date", editable: true, type: "date", defaultOn: true },
  { id: "sections", label: "# Sections", defaultOn: true },
  { id: "stores", label: "Stores assigned", defaultOn: true },
  { id: "dims", label: "Size (in)", defaultOn: false },
];

// Store name A→Z (case-insensitive, numbers in numeric order), then planogram name — for follow-up lists.
const byStoreThenPlanogram = (storeKey, planogramKey) => (a, b) =>
  String(a[storeKey] || "").localeCompare(String(b[storeKey] || ""), undefined, { numeric: true, sensitivity: "base" })
  || String(a[planogramKey] || "").localeCompare(String(b[planogramKey] || ""), undefined, { numeric: true, sensitivity: "base" });

function PlanogramList({ planograms, stores, products, fixtures, productSchema, planogramSchema, onCreate, onOpen, onDelete, onUpdate, onAssignStores, onCreateVersion, onCreateVersions, onImportProSpace, onDraftResetBulk, draftingReset, proposals, profileNames, currentUserId, onOpenProposal }) {
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bulkLookbackWeeks, setBulkLookbackWeeks] = useState(13);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [storeFilter, setStoreFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState(() => new Set()); // empty set = show all statuses
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState("name"); // name | eventDate | category | status
  const [assigningId, setAssigningId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set()); // for bulk actions (e.g. Create Versions)
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  const { columns, visible: visibleColumns, toggle: toggleColumn } = useColumnPrefs("tandom:planogramListColumns", PLANOGRAM_LIST_COLUMNS, planogramSchema);
  const [bulkField, setBulkField] = useState("category");
  const [bulkValue, setBulkValue] = useState("");

  const categories = Array.from(new Set(planograms.map((p) => p.category).filter(Boolean))).sort();
  const applyBulk = () => {
    const col = columns.find((c) => c.id === bulkField);
    if (!col || !col.editable || !onUpdate) return;
    if (col.id === "name") return;
    if (col.attr) {
      const value = attrCoerce(col.attr, typeof bulkValue === "string" ? bulkValue.trim() : bulkValue);
      planograms.filter((p) => selectedIds.has(p.id)).forEach((p) => onUpdate({ ...p, attributes: { ...(p.attributes || {}), [col.attr.id]: value } }));
    } else {
      const value = bulkValue.trim();
      planograms.filter((p) => selectedIds.has(p.id)).forEach((p) => onUpdate({ ...p, [col.id]: value }));
    }
    setBulkValue("");
  };

  if (creating) return <NewPlanogramForm existingCategories={categories} onCancel={() => setCreating(false)} onCreate={(p) => { onCreate(p); setCreating(false); onOpen(p.id); }} />;

  const toggleStatusFilter = (s) => setStatusFilter((prev) => {
    const next = new Set(prev);
    if (next.has(s)) next.delete(s); else next.add(s);
    return next;
  });
  const toggleSelected = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const filtered = planograms
    .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
    .filter((p) => categoryFilter === "All" || (p.category || "Uncategorized") === categoryFilter)
    .filter((p) => storeFilter === "All" || (p.storeIds || []).includes(storeFilter))
    .filter((p) => statusFilter.size === 0 || statusFilter.has(effectivePlanogramStatus(p)))
    .filter((p) => !dateFrom || (p.eventDate && p.eventDate >= dateFrom))
    .filter((p) => !dateTo || (p.eventDate && p.eventDate <= dateTo))
    .sort((a, b) => {
      // names compare case-insensitively and with numbers in numeric order, so "8FT" comes before "12FT"
      const byName = (a.name || "").localeCompare(b.name || "", undefined, { numeric: true, sensitivity: "base" });
      if (sortBy === "eventDate") return (a.eventDate || "9999-99-99").localeCompare(b.eventDate || "9999-99-99") || byName;
      if (sortBy === "category") return (a.category || "").localeCompare(b.category || "") || byName;
      if (sortBy === "status") {
        const order = PLANOGRAM_STATUSES.indexOf(effectivePlanogramStatus(a)) - PLANOGRAM_STATUSES.indexOf(effectivePlanogramStatus(b));
        return order || byName;
      }
      return byName;
    });

  const selectedCount = selectedIds.size;
  const allVisibleSelected = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));
  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => { const next = new Set(prev); filtered.forEach((p) => next.delete(p.id)); return next; });
    } else {
      setSelectedIds((prev) => { const next = new Set(prev); filtered.forEach((p) => next.add(p.id)); return next; });
    }
  };
  const bulkCreateVersions = () => {
    onCreateVersions(planograms.filter((p) => selectedIds.has(p.id)));
    setSelectedIds(new Set());
  };
  const bulkDraftReset = () => {
    onDraftResetBulk(planograms.filter((p) => selectedIds.has(p.id)), bulkLookbackWeeks);
    setSelectedIds(new Set());
  };

  // Groups the already-filtered-and-sorted list by version family (master + its versions), each
  // group internally ordered by version number — for the nested List view. A family's position
  // relative to other families is simply wherever its first matching member falls in `filtered`,
  // so this doesn't need its own separate sort logic; it just re-groups the existing order.
  const familyGroups = [];
  {
    const seen = new Set();
    filtered.forEach((p) => {
      const masterId = getFamilyMasterId(p);
      if (seen.has(masterId)) return;
      seen.add(masterId);
      const members = filtered.filter((x) => getFamilyMasterId(x) === masterId).sort((a, b) => (a.versionNumber || 1) - (b.versionNumber || 1));
      familyGroups.push(members);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-800">Planograms</h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-full border border-slate-300 p-0.5 bg-white">
            <button
              onClick={() => setViewMode("grid")}
              className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "grid" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
            >
              Grid
            </button>
            <button
              onClick={() => setViewMode("list")}
              title="List view — grouped by version family, with versions nested under their master"
              className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "list" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
            >
              List
            </button>
          </div>
          {planograms.length > 0 && <ColumnMenu columns={columns} visible={visibleColumns} onToggle={toggleColumn} label={viewMode === "list" ? "Columns" : "Card fields"} />}
          <button className={btnGhost} onClick={() => setImporting(true)}><Upload size={14} /> Import .psa file</button>
          <button className={btnPrimary} onClick={() => setCreating(true)}><Plus size={14} /> New Planogram</button>
        </div>
      </div>

      {importing && (
        <ProSpaceImportModal
          products={products}
          fixtures={fixtures}
          productSchema={productSchema}
          onClose={() => setImporting(false)}
          onImport={(payload) => { onImportProSpace(payload); setImporting(false); }}
        />
      )}

      <ResetDraftQueue planograms={planograms} proposals={proposals} profileNames={profileNames} currentUserId={currentUserId} onOpenDraft={onOpen} onOpenProposal={onOpenProposal} />

      {planograms.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[180px]">
              <label className={labelCls}>Search</label>
              <input className={inputCls} placeholder="Search by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Store</label>
              <select className={inputCls} value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)}>
                <option value="All">All stores</option>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.storeNumber ? ` (#${s.storeNumber})` : ""}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Event date from</label>
              <input type="date" className={inputCls} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Event date to</label>
              <input type="date" className={inputCls} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Sort by</label>
              <select className={inputCls} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                <option value="name">Name</option>
                <option value="eventDate">Event date</option>
                <option value="category">Category</option>
                <option value="status">Status</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setCategoryFilter("All")}
              className={`text-xs rounded-full px-3 py-1 border font-medium ${categoryFilter === "All" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategoryFilter(c)}
                className={`text-xs rounded-full px-3 py-1 border font-medium ${categoryFilter === c ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap border-t border-slate-100 pt-2.5">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mr-0.5">Status</span>
            <button
              onClick={() => setStatusFilter(new Set())}
              className={`text-xs rounded-full px-3 py-1 border font-medium ${statusFilter.size === 0 ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              All
            </button>
            {PLANOGRAM_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => toggleStatusFilter(s)}
                title="Click to toggle — you can select more than one status at once"
                className={`text-xs rounded-full px-3 py-1 border font-medium ${statusFilter.has(s) ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                {PLANOGRAM_STATUS_CONFIG[s].label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
          <span className="text-xs font-semibold text-amber-800">{selectedCount} selected</span>
          <button className={btnGhost} onClick={bulkCreateVersions}><Copy size={13} /> Create Versions</button>
          {onDraftResetBulk && (
            <>
              <select
                className="text-xs border border-slate-300 rounded-md px-1.5 py-1 bg-white"
                value={bulkLookbackWeeks}
                onChange={(e) => setBulkLookbackWeeks(Number(e.target.value))}
                title="Lookback window for performance data"
              >
                <option value={4}>4 weeks</option>
                <option value={8}>8 weeks</option>
                <option value={13}>13 weeks</option>
                <option value={26}>26 weeks</option>
                <option value={52}>52 weeks</option>
              </select>
              <button className={btnGhost} disabled={draftingReset} onClick={bulkDraftReset}>
                <Sparkles size={13} /> {draftingReset ? "Drafting…" : "Draft Reset with AI (Bulk)"}
              </button>
            </>
          )}
          {onUpdate && (
            <div className="flex items-center gap-1.5 border-l border-amber-200 pl-3">
              <span className="text-xs text-amber-800">Set</span>
              <select className="text-xs border border-slate-300 rounded-md px-1.5 py-1 bg-white" value={bulkField} onChange={(e) => { setBulkField(e.target.value); setBulkValue(""); }}>
                {columns.filter((c) => c.editable && c.id !== "name").map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              {(() => {
                const col = columns.find((c) => c.id === bulkField);
                const common = "text-xs border border-slate-300 rounded-md px-1.5 py-1 bg-white w-32";
                if (col?.attr && (col.attr.type === "select" || col.attr.type === "boolean")) {
                  const opts = col.attr.type === "boolean" ? [["true", "Yes"], ["false", "No"]] : attrOptions(col.attr).map((o) => [o, o]);
                  return <select className={common} value={String(bulkValue)} onChange={(e) => setBulkValue(e.target.value)}><option value="">blank clears it</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
                }
                return (
                  <input
                    type={bulkField === "eventDate" ? "date" : col?.attr?.type === "number" ? "number" : "text"}
                    className={common}
                    value={bulkValue}
                    onChange={(e) => setBulkValue(e.target.value)}
                    placeholder="blank clears it"
                    list={bulkField === "category" ? "planogram-category-options" : undefined}
                  />
                );
              })()}
              <button className={btnGhost} onClick={applyBulk} title={`Set ${columns.find((c) => c.id === bulkField)?.label} on all ${selectedCount} selected`}><Check size={13} /> Apply</button>
            </div>
          )}
          <button className="text-xs text-slate-500 hover:underline ml-auto" onClick={() => setSelectedIds(new Set())}>Clear selection</button>
        </div>
      )}

      {planograms.length > 0 && filtered.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-slate-500 mb-2 cursor-pointer w-fit">
          <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={allVisibleSelected} onChange={toggleSelectAllVisible} />
          Select all {filtered.length} shown
        </label>
      )}

      {planograms.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No planograms yet. Create your first gondola layout.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No planograms match your search or filters.
        </div>
      ) : viewMode === "list" ? (
        <div>
          <datalist id="planogram-category-options">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-400">{onUpdate ? "Click a cell to edit it. Changes save as you go." : ""}</span>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left">
                  <th className="w-8 px-3 py-2"></th>
                  {visibleColumns.map((c) => (
                    <th key={c.id} className="px-2 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{c.label}</th>
                  ))}
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {familyGroups.flatMap((members) => members.map((p, idx) => {
                  const cell = (c) => {
                    const cellInput = "w-full bg-transparent border border-transparent hover:border-slate-300 focus:border-amber-400 focus:bg-white rounded px-1.5 py-1 text-xs text-slate-800 outline-none";
                    if (c.id === "name") {
                      return (
                        <div className="flex items-center gap-1.5" style={{ paddingLeft: idx > 0 ? 20 : 0 }}>
                          {idx > 0 && <span className="text-slate-300 shrink-0">↳</span>}
                          {onUpdate
                            ? <DebouncedTextInput className={cellInput + " font-medium min-w-[160px]"} value={p.name} onCommit={(name) => { if (name.trim() && name !== p.name) onUpdate({ ...p, name: name.trim() }); }} />
                            : <span className="font-medium text-slate-800">{p.name}</span>}
                          {p.masterId && <span className="text-[10px] font-mono font-semibold text-slate-400 border border-slate-200 rounded px-1 shrink-0">v{p.versionNumber || 1}</span>}
                          {p.resetDraft && !p.resetDraft.reviewed && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-1.5 py-0.5 shrink-0 bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1"><Sparkles size={10} /> AI Draft</span>}
                        </div>
                      );
                    }
                    if (c.id === "status") return <PlanogramStatusBadge status={effectivePlanogramStatus(p)} />;
                    if (c.id === "sections") return <span className="text-slate-500">{p.sections.length}</span>;
                    if (c.id === "dims") return <span className="text-slate-500 font-mono">{p.dims.w}×{p.dims.h}×{p.dims.d}</span>;
                    if (c.id === "stores") {
                      const n = validStoreIds(p, stores).length;
                      return (
                        <div className="relative">
                          <button
                            onClick={() => setAssigningId(assigningId === p.id ? null : p.id)}
                            className={`text-xs font-medium flex items-center gap-1 rounded-full px-2 py-0.5 border whitespace-nowrap ${n > 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-500 hover:bg-slate-50"}`}
                          >
                            <Store size={11} /> {n} store{n !== 1 ? "s" : ""}
                          </button>
                          {assigningId === p.id && (
                            <StoreAssignmentPopover
                              stores={stores}
                              selectedIds={validStoreIds(p, stores)}
                              onToggle={(storeId) => {
                                const current = validStoreIds(p, stores);
                                onAssignStores(p.id, current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId]);
                              }}
                              onClose={() => setAssigningId(null)}
                            />
                          )}
                        </div>
                      );
                    }
                    if (c.attr) {
                      const val = p.attributes?.[c.attr.id];
                      if (!onUpdate) return <span className="text-slate-600">{attrDisplay(c.attr, val)}</span>;
                      return <AttributeInput field={c.attr} className={cellInput + " min-w-[100px]"} value={val} onChange={(v) => { const next = attrCoerce(c.attr, v); if ((val ?? "") !== next) onUpdate({ ...p, attributes: { ...(p.attributes || {}), [c.attr.id]: next } }); }} />;
                    }
                    if (!onUpdate) return <span className="text-slate-600">{p[c.id] || ""}</span>;
                    if (c.type === "date") {
                      return <input type="date" className={cellInput + " w-32"} value={p[c.id] || ""} onChange={(e) => onUpdate({ ...p, [c.id]: e.target.value })} />;
                    }
                    return <DebouncedTextInput className={cellInput + " min-w-[100px]"} value={p[c.id] || ""} onCommit={(v) => { if ((p[c.id] || "") !== v.trim()) onUpdate({ ...p, [c.id]: v.trim() }); }} />;
                  };
                  return (
                    <tr key={p.id} className={selectedIds.has(p.id) ? "bg-amber-50" : "hover:bg-slate-50"}>
                      <td className="px-3 py-1.5">
                        <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={selectedIds.has(p.id)} onChange={() => toggleSelected(p.id)} />
                      </td>
                      {visibleColumns.map((c) => (
                        <td key={c.id} className="px-1.5 py-1.5 align-middle">{cell(c)}</td>
                      ))}
                      <td className="px-2 py-1.5 whitespace-nowrap text-right">
                        <button className="text-xs text-amber-700 font-semibold hover:underline mr-2.5" onClick={() => onOpen(p.id)}>Open</button>
                        <button title="Create a new version of this planogram, linked back to its master" className="text-xs text-slate-500 font-medium hover:underline mr-2.5" onClick={() => onCreateVersion(p)}>Version</button>
                        <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDelete(p.id)}>Delete</button>
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((p) => (
            <div
              key={p.id}
              className={`relative bg-white rounded-lg border p-4 cursor-pointer transition-colors ${selectedIds.has(p.id) ? "border-amber-400 ring-1 ring-amber-300" : "border-slate-200 hover:border-amber-400"}`}
              onClick={() => onOpen(p.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="accent-amber-500 w-3.5 h-3.5 shrink-0"
                    checked={selectedIds.has(p.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelected(p.id)}
                  />
                  {p.name}
                  {p.masterId && <span className="text-[10px] font-mono font-semibold text-slate-400 border border-slate-200 rounded px-1">v{p.versionNumber || 1}</span>}
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <PlanogramStatusBadge status={effectivePlanogramStatus(p)} />
                  {p.resetDraft && !p.resetDraft.reviewed && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1"><Sparkles size={10} /> AI Draft Ready</span>}
                  {p.category && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5" style={{ background: hashColor(p.category) + "33", color: hashColor(p.category) }}>{p.category}</span>}
                </div>
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">{p.dims.w}×{p.dims.h}×{p.dims.d} in · base {p.base}in</div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-3">
                <span>{p.sections.length} section{p.sections.length !== 1 ? "s" : ""}</span>
                {p.eventDate && <span className="flex items-center gap-1"><CalendarDays size={11} /> {p.eventDate}</span>}
              </div>
              <AttributeChips columns={visibleColumns} entity={p} />
              <div className="flex items-center justify-between mt-2">
                <button
                  onClick={(e) => { e.stopPropagation(); setAssigningId(assigningId === p.id ? null : p.id); }}
                  className={`text-xs font-medium flex items-center gap-1 rounded-full px-2 py-0.5 border ${validStoreIds(p, stores).length > 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-500 hover:bg-slate-50"}`}
                >
                  <Store size={11} /> {validStoreIds(p, stores).length > 0 ? `${validStoreIds(p, stores).length} store${validStoreIds(p, stores).length !== 1 ? "s" : ""}` : "Assign stores"}
                </button>
                <div className="flex items-center gap-2.5">
                  <button
                    title="Create a new version of this planogram, linked back to its master"
                    className="text-xs text-slate-500 font-medium hover:underline flex items-center gap-1"
                    onClick={(e) => { e.stopPropagation(); onCreateVersion(p); }}
                  >
                    <Copy size={11} /> Version
                  </button>
                  <button className="text-xs text-red-500 font-medium hover:underline" onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}>Delete</button>
                </div>
              </div>
              {assigningId === p.id && (
                <StoreAssignmentPopover
                  stores={stores}
                  selectedIds={validStoreIds(p, stores)}
                  onToggle={(storeId) => {
                    const current = validStoreIds(p, stores);
                    const next = current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId];
                    onAssignStores(p.id, next);
                  }}
                  onClose={() => setAssigningId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Planogram editor — the graphical gondola builder                    */
/* ------------------------------------------------------------------ */

// Merchandising style support: a placement can be sold/displayed as something other than a
// single "Unit" (e.g. a full Tray or Case), which usually has very different dimensions than
// the base product. This resolves the dimensions that should actually drive layout/rendering
// for a given placement — falling back to the product's own base dims when the placement is
// "unit" (or an unset/no-longer-defined style), so nothing here ever throws on stale data.
function getEffectiveDims(product, placement) {
  const style = placement?.merchStyle;
  const styleData = style && style !== "unit" ? product?.merchStyles?.[style] : null;
  if (!styleData) return product.dims;
  return {
    w: styleData.w || product.dims.w,
    h: styleData.h || product.dims.h,
    d: styleData.d || product.dims.d,
  };
}

/* Stacking (ProSpace meanings). A placement's `facings` is Facings WIDE. On top of that:
     high — Facings HIGH: units stacked vertically (default 1)
     deep — Facings DEEP: units behind each front facing (default 1) — capacity only, no extra shelf width
     autoStack — true = High is worked out automatically from the headroom under the shelf (see
            refitAutoStacks); `high` is kept in sync so everything downstream just reads it
     cap  — Capping: { productId, count } units stacked on top of the stack, per wide facing. productId
            null/absent/the placement's own product = a same-product cap; any other product id = a
            different-product cap. productId "" = a different-product cap with no product chosen yet (draws
            nothing, counts nothing). Absent cap = no capping.
   Only Wide consumes shelf width; High/Cap consume headroom (getShelfClearanceIn), Deep consumes depth. */
// Width x height of the face a product shows toward the aisle for a given orientation, from its
// front-facing w/h/d: Front/Back = w x h, Top/Bottom = w x d (lying flat), Left/Right = d x h.
function getOrientedFaceDims(dims, orientation) {
  const w = dims?.w || 1, h = dims?.h || 1, d = dims?.d || dims?.w || 1;
  // d here is how far the unit reaches back into the shelf in that orientation
  if (orientation === "top" || orientation === "bottom") return { w, h: d, d: h };
  if (orientation === "left" || orientation === "right") return { w: d, h, d: w };
  return { w, h, d };
}

function getStackConfig(placement) {
  const toCount = (n) => Math.max(1, Math.round(Number(n) || 1));
  const capCount = placement?.cap ? Math.round(Number(placement.cap.count) || 0) : 0;
  return {
    wide: toCount(placement?.facings),
    high: toCount(placement?.high),
    deep: toCount(placement?.deep),
    cap: capCount > 0 && placement.cap.productId !== "" ? { productId: placement.cap.productId || null, count: capCount } : null,
  };
}

// Resolved stack geometry for one placement. unitHIn is one front-facing unit's height as it sits on
// the shelf (swaps at 90/270 rotation, exactly as ProductBox draws it). Unknown cap products degrade
// to "no cap" rather than throwing, so stale data never breaks a screen.
function getStackDims(product, placement, products) {
  const cfg = getStackConfig(placement);
  const eff = getEffectiveDims(product, placement);
  const rotated = placement?.rotation === 90 || placement?.rotation === 270;
  const unitHIn = (rotated ? eff.w : eff.h) || 1;
  let capProduct = null;
  let capUnitHIn = 0;
  let capUnitWIn = 0;
  let capUnitDIn = 0;
  const capOrientation = ORIENTATIONS.some((o) => o.id === placement?.cap?.orientation) ? placement.cap.orientation : "front";
  if (cfg.cap) {
    capProduct = !cfg.cap.productId || cfg.cap.productId === product.id ? product : (products || []).find((p) => p.id === cfg.cap.productId) || null;
    if (capProduct) {
      // The cap can sit in a different orientation than the front facing below it (e.g. one front on the
      // shelf, two caps showing the top). The face that points out sets the unit's width and height.
      const base = capProduct === product ? eff : capProduct.dims || {};
      const face = getOrientedFaceDims(base, capOrientation);
      capUnitHIn = capProduct === product && capOrientation === "front" ? unitHIn : face.h;
      capUnitWIn = capProduct === product && capOrientation === "front" ? (rotated ? eff.h : eff.w) || 1 : face.w;
      capUnitDIn = face.d;
    }
  }
  const capCount = capProduct ? cfg.cap.count : 0;
  const unitDIn = eff.d || 1;
  const stackDepthIn = unitDIn * cfg.deep;
  // a cap sits on top of the stack, so it can run only as far back as the stack does; a unit lying on
  // its side reaches further back (e.g. 10in), so fewer of them fit front-to-back than the stack has deep
  const capDeep = capProduct ? Math.max(1, Math.floor(stackDepthIn / (capUnitDIn || 1) + 1e-6)) : 0;
  const baseUnits = cfg.wide * cfg.high * cfg.deep;
  const capUnits = cfg.wide * capCount * capDeep;
  return {
    wide: cfg.wide, high: cfg.high, deep: cfg.deep,
    cap: capProduct ? { product: capProduct, count: capCount, sameProduct: capProduct === product, unitHIn: capUnitHIn, unitWIn: capUnitWIn, unitDIn: capUnitDIn, deep: capDeep, orientation: capOrientation } : null,
    unitHIn,
    heightIn: unitHIn * cfg.high + capUnitHIn * capCount,
    unitDIn, stackDepthIn,
    baseUnits, capUnits, units: baseUnits + capUnits,
  };
}

// Headroom above a shelf, in inches: from the shelf's top surface to the underside of the next
// fixture above it that overlaps it horizontally, or to the top of the planogram if nothing is
// above. Pegboard panels are a backdrop, not a ceiling. Fixtures mounted on a pegboard are
// positioned in the panel's own frame, so they report unlimited headroom (Infinity) instead.
function getShelfClearanceIn(planogram, section, fixtureInst, fixtureDefs) {
  if (!fixtureInst || fixtureInst.mountedOnId) return Infinity;
  const defOf = (fx) => (fixtureDefs || []).find((f) => f.id === fx.fixtureId);
  const def = defOf(fixtureInst);
  const w = def ? def.dims.w : 24;
  const top = (planogram?.base || 0) + (fixtureInst.notchY || 0) + (def ? def.dims.h : 2);
  let aboveBottom = null; // underside of the nearest overlapping fixture above, if any
  (section?.fixtures || []).forEach((o) => {
    if (o.id === fixtureInst.id || o.mountedOnId) return;
    const od = defOf(o);
    if (od?.type === "Pegboard") return;
    const ow = od ? od.dims.w : 24;
    const overlaps = (o.xOffset || 0) < (fixtureInst.xOffset || 0) + w && (o.xOffset || 0) + ow > (fixtureInst.xOffset || 0);
    const bottom = (planogram?.base || 0) + (o.notchY || 0);
    if (overlaps && bottom >= top - 1e-6) aboveBottom = aboveBottom === null ? bottom : Math.min(aboveBottom, bottom);
  });
  // merchHeightIn is the shelf's own maximum merchandise height (ProSpace's fixture "Merch" setting, or set in
  // the editor). It can only tighten the gap to a shelf above. With nothing above, it replaces the planogram
  // height as the limit: ProSpace lets a top shelf run past the bay, and an imported one should not be flagged for it.
  const merch = Number(fixtureInst.merchHeightIn) > 0 ? Number(fixtureInst.merchHeightIn) : 0;
  // Imported notches are snapped to whole inches, which can move two shelves a combined inch apart from where the
  // source had them; a shelf with a stated merchandise height gets that inch back so rounding is not reported as overflow.
  if (aboveBottom !== null) return Math.max(0, merch ? Math.min(aboveBottom - top + 1, merch) : aboveBottom - top);
  return Math.max(0, merch || (planogram?.dims?.h ?? Infinity) - top);
}

// null when the stack fits under the shelf above (or headroom is unknown), else a plain-English reason.
function getStackHeightProblem(product, placement, products, clearanceIn) {
  if (!Number.isFinite(clearanceIn)) return null;
  const s = getStackDims(product, placement, products);
  if (s.heightIn <= clearanceIn + 1e-6) return null;
  const f = (n) => (Math.round(n * 100) / 100).toString();
  return `Stack is ${f(s.heightIn)}in tall (${s.high} high${s.cap ? ` + ${s.cap.count} capped` : ""}) but this shelf only has ${f(clearanceIn)}in of clearance.`;
}

// null when the Deep stack fits the shelf's depth (or its depth is unknown), else a plain-English reason.
function getStackDepthProblem(product, placement, products, shelfDepthIn) {
  if (!Number.isFinite(shelfDepthIn) || !(shelfDepthIn > 0)) return null;
  const s = getStackDims(product, placement, products);
  if (s.stackDepthIn <= shelfDepthIn + 1e-6) return null;
  const f = (n) => (Math.round(n * 100) / 100).toString();
  return `${s.deep} deep reaches ${f(s.stackDepthIn)}in back but this shelf is only ${f(shelfDepthIn)}in deep.`;
}

// Auto-stack: how many units high a placement can go under the given headroom, leaving room for its
// cap (if any). Capped at AUTO_STACK_MAX so a short product under a tall opening doesn't become a tower.
// Unknown headroom (mounted shelves) leaves the current height alone.
const AUTO_STACK_MAX = 12;
function getAutoStackHigh(product, placement, products, clearanceIn) {
  const current = Math.max(1, Math.round(Number(placement?.high) || 1));
  if (!product || !Number.isFinite(clearanceIn)) return current;
  const s = getStackDims(product, { ...placement, high: 1 }, products);
  const capIn = s.heightIn - s.unitHIn;
  const fit = Math.floor((clearanceIn - capIn) / s.unitHIn + 1e-6);
  return Math.min(AUTO_STACK_MAX, Math.max(1, fit));
}

// Re-fits every placement marked autoStack to the headroom its shelf has right now, so stacks grow and
// shrink on their own when a shelf above moves or a product is moved/added. Returns the same
// planogram object when nothing changed. Pegboards are skipped (products hang, they don't stack).
function refitAutoStacks(planogram, fixtureDefs, products) {
  let changed = false;
  const sections = (planogram.sections || []).map((sec) => {
    let secChanged = false;
    const fixturesOut = (sec.fixtures || []).map((fx) => {
      if (!(fx.placements || []).some((p) => p.autoStack)) return fx;
      if ((fixtureDefs || []).find((f) => f.id === fx.fixtureId)?.type === "Pegboard") return fx;
      const clearance = getShelfClearanceIn(planogram, sec, fx, fixtureDefs);
      let fxChanged = false;
      const placements = fx.placements.map((pl) => {
        if (!pl.autoStack) return pl;
        const prod = (products || []).find((p) => p.id === pl.productId);
        const next = getAutoStackHigh(prod, pl, products, clearance);
        if (next === Math.max(1, Math.round(Number(pl.high) || 1))) return pl;
        fxChanged = true;
        const { high, ...rest } = pl;
        return next > 1 ? { ...rest, high: next } : rest;
      });
      if (!fxChanged) return fx;
      secChanged = true;
      return { ...fx, placements };
    });
    if (!secChanged) return sec;
    changed = true;
    return { ...sec, fixtures: fixturesOut };
  });
  return changed ? { ...planogram, sections } : planogram;
}

// One-line description of a placement's stacking for lists, guides and exports:
// "3 wide x 2 high x 2 deep = 12 units, capped 1 high with Brand X". A plain single facing reads "1 facing".
function describeStack(product, placement, products) {
  if (!product) return "";
  const st = getStackDims(product, placement, products);
  const plain = st.high === 1 && st.deep === 1 && !st.cap;
  if (plain) return `${st.wide} facing${st.wide !== 1 ? "s" : ""}`;
  const parts = [`${st.wide} wide`, `${st.high} high`, `${st.deep} deep`];
  let text = `${parts.join(" x ")} = ${st.units} unit${st.units !== 1 ? "s" : ""}`;
  if (st.cap) text += `, capped ${st.cap.count} high with ${st.cap.sameProduct ? "the same product" : st.cap.product.name}${st.cap.orientation !== "front" ? ` (${st.cap.orientation} facing)` : ""}`;
  return text;
}

function layoutFixtureBoxes(fixtureInst, fixtureDef, products) {
  const widthIn = fixtureDef ? fixtureDef.dims.w : 24;
  const alignment = fixtureInst.alignment || "left"; // "left" | "right" | "spread"

  // first pass: figure out each facing's effective width, in placement order.
  // squeezeFactor (default 1 = no compression) shrinks how much shelf space a compressible
  // product (e.g. a bag of chips) is counted as consuming, without changing how large it renders.
  // overhangIn (default 0) is how far THIS product may hang past the shelf edge before it's
  // treated as real overflow, rather than every product sharing one hard boundary.
  const items = [];
  (fixtureInst.placements || []).forEach((pl) => {
    const prod = products.find((p) => p.id === pl.productId);
    if (!prod) return;
    const effectiveDims = getEffectiveDims(prod, pl);
    const rotated = pl.rotation === 90 || pl.rotation === 270;
    const nominalW = (rotated ? effectiveDims.h : effectiveDims.w) || 1;
    const squeeze = prod.squeezeFactor ?? 1;
    const w = nominalW * squeeze;
    const overhangIn = prod.overhangIn || 0;
    const stack = getStackDims(prod, pl, products);
    for (let i = 0; i < (pl.facings || 1); i++) items.push({ placement: pl, product: prod, wIn: w, overhangIn, effectiveDims, stack });
  });

  const totalContentWidth = items.reduce((s, it) => s + it.wIn, 0);
  const boxes = [];
  const isOverflow = (cursor, it) => cursor + it.wIn > widthIn + it.overhangIn;

  if (alignment === "right") {
    let cursor = Math.max(0, widthIn - totalContentWidth);
    items.forEach((it) => {
      boxes.push({ placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: isOverflow(cursor, it), effectiveDims: it.effectiveDims, stack: it.stack });
      cursor += it.wIn;
    });
  } else if (alignment === "spread" && items.length > 1 && totalContentWidth < widthIn) {
    const gap = (widthIn - totalContentWidth) / (items.length - 1);
    let cursor = 0;
    items.forEach((it) => {
      boxes.push({ placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: isOverflow(cursor, it), effectiveDims: it.effectiveDims, stack: it.stack });
      cursor += it.wIn + gap;
    });
  } else {
    // left (default), and also the fallback when "spread" has nothing to spread (0-1 items, or content already overflows)
    let cursor = 0;
    items.forEach((it) => {
      boxes.push({ placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: isOverflow(cursor, it), effectiveDims: it.effectiveDims, stack: it.stack });
      cursor += it.wIn;
    });
  }

  return { boxes, totalWidth: totalContentWidth, widthIn };
}

/* ------------------------------------------------------------------ */
/* Reset Drafting Agent — the analysis itself (computeResetDraft, the   */
/* fit check, the Draft Score) runs server-side in the draft-reset Edge */
/* Function; only applying a returned draft lives in the browser.       */
/* ------------------------------------------------------------------ */

// Asks the draft-reset Edge Function to analyze planograms. The analysis (thresholds, protection
// rules, scoring) runs on the server against what is saved in the database, so any in-flight
// save is allowed to land first. Returns [{planogramId, ok, score, result} | {planogramId, ok:false, error}].
const DRAFT_RESET_CHUNK = 50; // mirrors MAX_PLANOGRAMS_PER_CALL in the Edge Function
async function invokeDraftReset(planogramIds, lookbackWeeks) {
  await waitForPendingWrites();
  const data = await invokeEdgeFunction("draft-reset", { planogramIds, lookbackWeeks });
  return data.results;
}

// Applies a computed draft's changes to a plain sections array (old ids, not yet cloned) — used
// right before makePlanogramVersion, which clones whatever sections it's given with fresh ids.
// Since Phase 4 this runs in the apply-proposal Edge Function (copied from here by
// scripts/sync-edge-core.mjs); it stays in this file as the single source of truth.
// Deletions and facing edits both key off placement id, so order between them doesn't matter.
function applyResetDraftChanges(sections, changes) {
  const next = JSON.parse(JSON.stringify(sections));
  const toDelete = new Set();
  const facingEdits = {}; // placementId -> newFacings
  const highEdits = {}; // placementId -> new Facings High (stack height)
  const deepEdits = {}; // placementId -> new Facings Deep (case-pack fit)
  const additions = []; // addProduct changes, applied per-fixture below
  changes.forEach((c) => {
    if (c.type === "delete") toDelete.add(c.placementId);
    else if (c.type === "reduceFacings" || c.type === "increaseFacings") facingEdits[c.placementId] = c.newFacings;
    else if (c.type === "increaseHigh" || c.type === "reduceHigh") highEdits[c.placementId] = c.newHigh;
    else if (c.type === "setDeep") deepEdits[c.placementId] = c.newDeep;
    else if (c.type === "addProduct") additions.push(c);
  });
  next.forEach((section) => {
    (section.fixtures || []).forEach((fixtureInst) => {
      fixtureInst.placements = (fixtureInst.placements || [])
        .filter((pl) => !toDelete.has(pl.id))
        .map((pl) => (facingEdits[pl.id] !== undefined ? { ...pl, facings: facingEdits[pl.id] } : pl))
        .map((pl) => {
          if (deepEdits[pl.id] === undefined) return pl;
          const { deep, ...rest } = pl;
          return deepEdits[pl.id] > 1 ? { ...rest, deep: deepEdits[pl.id] } : rest;
        })
        .map((pl) => {
          if (highEdits[pl.id] === undefined) return pl;
          // a High the agent chose on purpose replaces "stack to the headroom" for that placement
          const { high, autoStack, ...rest } = pl;
          return highEdits[pl.id] > 1 ? { ...rest, high: highEdits[pl.id] } : rest;
        });
      additions.filter((a) => a.fixtureInstId === fixtureInst.id).forEach((a) => {
        const added = { id: a.placementId, productId: a.productId, facings: a.newFacings, orientation: "front", rotation: 0, merchStyle: "unit" };
        if (a.newHigh > 1) { added.high = a.newHigh; added.autoStack = true; } else if (a.autoStack) added.autoStack = true;
        fixtureInst.placements.push(added);
      });
    });
  });
  return next;
}

// Pegboards use a true 2D peg grid (1-inch holes) rather than the 1D linear packing every other
// fixture type uses. pegX/pegY on each placement are the PHYSICAL PEG COORDINATE — a real hole
// on the 1-inch grid, exactly what a store associate would install hardware at. This is the
// stored, primary value; whole inches only, since a peg literally can't exist at a fractional
// position. The product's rendered origin (top-left corner) is always DERIVED from the peg via
// the known packaging hang-hole offset (centered horizontally, a quarter-inch below the top) —
// never stored directly, so it can never drift to a position no real peg could produce.
function pegToOrigin(pegX, pegY, w) {
  return { originX: pegX - w / 2, originY: pegY - 0.25 };
}

function layoutPegboardBoxes(fixtureInst, fixtureDef, products) {
  const widthIn = fixtureDef ? fixtureDef.dims.w : 24;
  const heightIn = fixtureDef ? fixtureDef.dims.h : 24;
  const boxes = [];
  (fixtureInst.placements || []).forEach((pl) => {
    const prod = products.find((p) => p.id === pl.productId);
    if (!prod) return;
    const effectiveDims = getEffectiveDims(prod, pl);
    const rotated = pl.rotation === 90 || pl.rotation === 270;
    const nominalW = (rotated ? effectiveDims.h : effectiveDims.w) || 1;
    const squeeze = prod.squeezeFactor ?? 1;
    const w = nominalW * squeeze;
    const overhangIn = prod.overhangIn || 0;
    const pegX = pl.pegX ?? 0; // physical peg column position (inches, whole numbers)
    const pegY = pl.pegY ?? heightIn; // physical peg row position (inches, whole numbers, from panel bottom)
    const { originX, originY } = pegToOrigin(pegX, pegY, w);
    let cursor = originX;
    for (let i = 0; i < (pl.facings || 1); i++) {
      const overflow = cursor < 0 || cursor + w > widthIn + overhangIn || originY > heightIn || originY < 0;
      boxes.push({ placement: pl, product: prod, xIn: cursor, wIn: w, pegYIn: originY, overflow, effectiveDims });
      cursor += w;
    }
  });
  return { boxes, widthIn, heightIn };
}

// Row 1 = top-most row, Column 1 = left-most column (both 1-indexed, matching the 1-inch grid) —
// this is now a direct read of the stored peg coordinate, not a calculation.
function derivePegRowColumn(pegX, pegY, panelHeightIn) {
  const column = Math.round(pegX) + 1;
  const row = Math.round(panelHeightIn - pegY) + 1;
  return { row, column };
}

/* ------------------------------------------------------------------ */
/* Store Assistant execution guide — read-only diagrams. These reuse    */
/* the same layout math as the editor (layoutFixtureBoxes/               */
/* layoutPegboardBoxes) so the picture is accurate, but are deliberately */
/* separate, non-interactive components — no drag handlers, no editing  */
/* — rather than reusing the editor's SectionColumn/FixtureBar directly, */
/* to keep this guide simple and safe from the editor's own complexity. */
/* ------------------------------------------------------------------ */

function ReadOnlyProductBox({ box, scale, pegYIn, newProductIds }) {
  const { placement, product, xIn, wIn, effectiveDims, stack } = box;
  const dims = effectiveDims || product.dims;
  const rotation = placement.rotation || 0;
  const rotated = rotation === 90 || rotation === 270;
  const footprintWpx = Math.max(wIn * scale - 1, 2);
  const footprintHpx = Math.max((rotated ? dims.w : dims.h) * scale - 1, 4);
  const naturalWpx = Math.max(dims.w * scale - 1, 2);
  const naturalHpx = Math.max(dims.h * scale - 1, 4);
  const img = product.images?.[placement.orientation];
  const hasPeg = pegYIn !== undefined && pegYIn !== null;
  const pegBottomPx = hasPeg ? (pegYIn - (rotated ? dims.w : dims.h)) * scale : undefined;
  const isNew = newProductIds && newProductIds.has(product.id);
  const highCount = stack?.high || 1;
  const cap = stack?.cap || null;
  const capUnitHpx = cap ? Math.max(cap.unitHIn * scale - 1, 4) : 0;
  const capWpx = cap ? Math.max(Math.min(cap.unitWIn * scale - 1, footprintWpx), 2) : 0;
  const capImg = cap ? cap.product.images?.[cap.orientation] || (cap.orientation === "front" ? null : cap.product.images?.front) || null : null;
  const stackTitle = describeStack(product, placement, [product, ...(cap ? [cap.product] : [])]);
  return (
    <div className={`absolute ${hasPeg ? "" : "bottom-0"}`} style={{ left: xIn * scale, width: footprintWpx, height: footprintHpx * highCount + (cap ? capUnitHpx * cap.count : 0), bottom: hasPeg ? pegBottomPx : undefined }}>
      {Array.from({ length: highCount }, (_, layer) => (
        <div key={layer} className="absolute left-0" style={{ bottom: layer * footprintHpx, width: footprintWpx, height: footprintHpx }}>
          <div
            className={`absolute top-1/2 left-1/2 overflow-hidden flex items-center justify-center ${isNew ? "border-2 border-emerald-500 ring-2 ring-emerald-300" : "border border-slate-400/60"}`}
            style={{ width: naturalWpx, height: naturalHpx, transform: `translate(-50%, -50%) rotate(${rotation}deg)`, background: img ? "#fff" : hashColor(product.name) }}
            title={`${isNew ? `${product.name} — New item` : product.name} · ${stackTitle}`}
          >
            {img && <img src={img} alt={product.name} className="absolute inset-0 w-full h-full object-cover" />}
          </div>
        </div>
      ))}
      {cap && Array.from({ length: cap.count }, (_, ci) => (
        <div
          key={"cap" + ci}
          className="absolute overflow-hidden border border-dashed border-slate-500"
          style={{ left: (footprintWpx - capWpx) / 2, width: capWpx, height: capUnitHpx, bottom: footprintHpx * highCount + ci * capUnitHpx, background: capImg ? "#fff" : hashColor(cap.product.name) }}
          title={`Cap: ${cap.product.name}`}
        >
          {capImg && <img src={capImg} alt={cap.product.name} className="absolute inset-0 w-full h-full object-cover" />}
        </div>
      ))}
    </div>
  );
}

function ReadOnlyFixtureDiagram({ fx, fixtureDef, products, scale, base, newProductIds }) {
  const isPegboard = fixtureDef?.type === "Pegboard";
  const widthIn = fixtureDef ? fixtureDef.dims.w : 24;
  const heightIn = fixtureDef ? fixtureDef.dims.h : 2;
  const bottomIn = base + fx.notchY;

  if (isPegboard) {
    const { boxes } = layoutPegboardBoxes(fx, fixtureDef, products);
    return (
      <>
        <div
          className="absolute"
          style={{
            left: fx.xOffset * scale, bottom: bottomIn * scale, width: widthIn * scale, height: heightIn * scale,
            background: "#c2b8a3", backgroundImage: "radial-gradient(circle, #8a7d63 1px, transparent 1.5px)", backgroundSize: `${scale}px ${scale}px`, border: "1px dashed #8a7d63",
          }}
        />
        <div className="absolute" style={{ left: fx.xOffset * scale, bottom: bottomIn * scale, width: widthIn * scale, height: heightIn * scale }}>
          {boxes.map((box, i) => <ReadOnlyProductBox key={box.placement.id + "_" + i} box={box} scale={scale} pegYIn={box.pegYIn} newProductIds={newProductIds} />)}
        </div>
      </>
    );
  }

  const { boxes } = layoutFixtureBoxes(fx, fixtureDef, products);
  return (
    <>
      <div className="absolute" style={{ left: fx.xOffset * scale, bottom: bottomIn * scale, width: widthIn * scale, height: Math.max(heightIn * scale, 3), background: "#94a3b8", borderTop: "1px solid #64748b" }} />
      <div className="absolute" style={{ left: fx.xOffset * scale, bottom: (bottomIn + heightIn) * scale, width: widthIn * scale, height: 14 * scale }}>
        {boxes.map((box, i) => <ReadOnlyProductBox key={box.placement.id + "_" + i} box={box} scale={scale} newProductIds={newProductIds} />)}
      </div>
    </>
  );
}

function ReadOnlySectionDiagram({ section, planogram, fixtures, products, scale, newProductIds }) {
  return (
    <div className="relative border-x border-slate-300 bg-gradient-to-b from-slate-100 to-slate-200 shrink-0" style={{ width: section.width * scale, height: planogram.dims.h * scale }}>
      <div className="absolute top-0.5 left-1 text-[10px] font-semibold text-slate-500 bg-white/70 px-1 rounded">{section.name}</div>
      {(section.fixtures || []).map((fx) => {
        const def = fixtures.find((f) => f.id === fx.fixtureId);
        return <ReadOnlyFixtureDiagram key={fx.id} fx={fx} fixtureDef={def} products={products} scale={scale} base={planogram.base} newProductIds={newProductIds} />;
      })}
    </div>
  );
}

// The step-by-step execution guide itself: an Overview step showing the whole planogram, then
// one step per section with an accurate diagram plus a plain-language, image-backed checklist of
// exactly what goes where — "side-by-side images" in the sense that mattered here (there's no
// "before" photo of what's currently on a given store's shelf to show, so the pairing is each
// product's own image next to a diagram of its exact position).
function PlanogramExecutionGuide({ planogram, products, fixtures, allPlanograms, storeId, onToggleItemCheck, onBack, askTandom }) {
  const [stepIdx, setStepIdx] = useState(0); // 0 = item changes, 1 = overview, 2..N+1 = one per section
  const sections = planogram.sections || [];
  const totalSteps = sections.length + 2;
  const isItemChanges = stepIdx === 0;
  const isOverview = stepIdx === 1;
  const section = isItemChanges || isOverview ? null : sections[stepIdx - 2];
  const scale = clamp(340 / Math.max(planogram.dims.w, 24), 2, 7);

  const predecessor = getPredecessorPlanogram(planogram, allPlanograms);
  const { newItems, deletedItems, keepItems } = computeItemChanges(planogram, predecessor, products);
  const checks = planogram.itemChecks?.[storeId] || {};

  const itemsForFixture = (fx, def) => {
    const isPeg = def?.type === "Pegboard";
    const boxes = isPeg ? layoutPegboardBoxes(fx, def, products).boxes : layoutFixtureBoxes(fx, def, products).boxes;
    const seen = new Set();
    return boxes.filter((b) => {
      if (seen.has(b.placement.id)) return false;
      seen.add(b.placement.id);
      return true;
    });
  };

  const CheckableProductRow = ({ product }) => (
    <label className="flex items-center gap-3 cursor-pointer py-1">
      <input
        type="checkbox"
        checked={!!checks[product.id]}
        onChange={() => onToggleItemCheck(planogram.id, storeId, product.id)}
        className="accent-amber-500 w-4 h-4 shrink-0"
      />
      <div className="w-8 h-8 rounded border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden shrink-0">
        {product.images?.front ? (
          <img src={product.images.front} alt={product.name} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="w-5 h-5 rounded" style={{ background: hashColor(product.name) }} />
        )}
      </div>
      <span className={`text-sm ${checks[product.id] ? "line-through text-slate-400" : "text-slate-800"}`}>{product.name}</span>
    </label>
  );

  const newItemIds = new Set(newItems.map((p) => p.id));
  const deletedItemIds = new Set(deletedItems.map((p) => p.id));

  // Per-section attribution: which New items actually land in THIS section, and which Deleted
  // items used to live in the predecessor's same-named section. Sections aren't matched by id
  // across versions (fresh ids every time a version is created), so name is the stable anchor.
  const sectionNewIds = section ? new Set([...getPlacedProductIdsForSection(section)].filter((id) => newItemIds.has(id))) : new Set();
  const predecessorSection = predecessor && section ? (predecessor.sections || []).find((s) => s.name === section.name) : null;
  const sectionDeletedProducts = predecessorSection
    ? [...getPlacedProductIdsForSection(predecessorSection)].filter((id) => deletedItemIds.has(id)).map((id) => products.find((p) => p.id === id)).filter(Boolean)
    : [];

  return (
    <div>
      <button onClick={onBack} className="text-xs text-slate-400 hover:underline mb-3 flex items-center gap-1"><ArrowLeft size={12} /> Back to My Activities</button>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">{planogram.name}</h2>
          <p className="text-sm text-slate-500">
            {isItemChanges ? "What's changing in this reset" : isOverview ? "Overview — the finished layout" : `Section ${stepIdx - 1} of ${sections.length}: ${section.name}`}
          </p>
        </div>
        <span className="text-xs text-slate-400 shrink-0">Step {stepIdx + 1} of {totalSteps}</span>
      </div>

      {isItemChanges ? (
        <div className="space-y-3 mb-4">
          {!predecessor && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="text-sm font-semibold text-blue-800 mb-1">First planogram for this space</div>
              <p className="text-sm text-blue-700">
                There's no previous version, so no comparison details are available — there are no New, Deleted or Keep items to list.
                Use the next steps to set up the whole planogram, {sections.length} section{sections.length !== 1 ? "s" : ""} in all.
              </p>
            </div>
          )}
          {predecessor && (<>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Plus size={13} /> New Items — Get Inventory</div>
            {newItems.length === 0 ? <p className="text-xs text-slate-400 italic">No new items in this reset.</p> : newItems.map((p) => <CheckableProductRow key={p.id} product={p} />)}
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2 flex items-center gap-1.5"><Trash2 size={13} /> Deleted Items — Remove from Shelf & Markdown</div>
            {deletedItems.length === 0 ? <p className="text-xs text-slate-400 italic">No items being removed.</p> : deletedItems.map((p) => <CheckableProductRow key={p.id} product={p} />)}
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Keep Items — No Action Needed</div>
            {keepItems.length === 0 ? <p className="text-xs text-slate-400 italic">No unchanged items.</p> : (
              <div className="flex flex-wrap gap-1.5">
                {keepItems.map((p) => <span key={p.id} className="text-xs bg-slate-50 border border-slate-200 rounded-full px-2 py-1 text-slate-600">{p.name}</span>)}
              </div>
            )}
          </div>
          </>)}
        </div>
      ) : isOverview ? (
        <div className="bg-white border border-slate-200 rounded-lg p-4 overflow-x-auto mb-4">
          <div className="flex gap-0 items-start mx-auto" style={{ width: "fit-content" }}>
            {sections.map((s) => <ReadOnlySectionDiagram key={s.id} section={s} planogram={planogram} fixtures={fixtures} products={products} scale={scale} newProductIds={newItemIds} />)}
            {sections.length === 0 && <p className="text-sm text-slate-400 italic p-6">This planogram has no sections yet.</p>}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4 items-start">
          {/* Left: instructions for this section */}
          <div className="space-y-3">
            {(section.fixtures || []).length === 0 && (
              <p className="text-sm text-slate-400 italic">This section has no fixtures.</p>
            )}
            {(section.fixtures || []).map((fx) => {
              const def = fixtures.find((f) => f.id === fx.fixtureId);
              const items = itemsForFixture(fx, def);
              return (
                <div key={fx.id} className="bg-white border border-slate-200 rounded-lg p-3">
                  <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                    {def?.name || "Fixture"}{def?.type === "Pegboard" ? " — Pegboard" : ` — ${fx.notchY}in from base`}
                  </div>
                  {items.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No products placed on this fixture.</p>
                  ) : (
                    <div className="space-y-2">
                      {items.map((b) => (
                        <div key={b.placement.id} className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded border flex items-center justify-center overflow-hidden shrink-0 ${sectionNewIds.has(b.product.id) ? "border-emerald-400 ring-1 ring-emerald-300" : "border-slate-200 bg-slate-50"}`}>
                            {b.product.images?.[b.placement.orientation] ? (
                              <img src={b.product.images[b.placement.orientation]} alt={b.product.name} className="max-h-full max-w-full object-contain" />
                            ) : (
                              <div className="w-6 h-6 rounded" style={{ background: hashColor(b.product.name) }} />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-800 truncate flex items-center gap-1.5">
                              {b.product.name}
                              {sectionNewIds.has(b.product.id) && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-1.5 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-300">New</span>}
                            </div>
                            <div className="text-xs text-slate-400">
                              {describeStack(b.product, b.placement, products)} · {ORIENTATIONS.find((o) => o.id === b.placement.orientation)?.label || b.placement.orientation}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Placeholder — will show products by exact shelf/location id (Shelf 1, Shelf 2, ...) */}
            <div className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-3">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Planogram Details</div>
              <p className="text-xs text-slate-400 italic">Product lists by exact shelf location (Shelf 1, Shelf 2, …) — coming soon.</p>
            </div>
          </div>

          {/* Right: this section's diagram, one at a time */}
          <div className="lg:sticky lg:top-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4 overflow-x-auto">
              <div className="flex justify-center" style={{ width: "fit-content", margin: "0 auto" }}>
                <ReadOnlySectionDiagram section={section} planogram={planogram} fixtures={fixtures} products={products} scale={scale} newProductIds={sectionNewIds} />
              </div>
            </div>
            <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-500">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm border-2 border-emerald-500 inline-block" /> New item</span>
            </div>
            {sectionDeletedProducts.length > 0 && (
              <div className="mt-3 bg-red-50 border border-red-200 rounded-lg p-3">
                <div className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1.5 flex items-center gap-1.5"><Trash2 size={12} /> Deleted from this section</div>
                <div className="flex flex-wrap gap-1.5">
                  {sectionDeletedProducts.map((p) => <span key={p.id} className="text-xs bg-white border border-red-200 rounded-full px-2 py-1 text-red-700">{p.name}</span>)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button className={btnGhost} disabled={stepIdx === 0} onClick={() => setStepIdx((s) => Math.max(0, s - 1))}><ChevronLeft size={14} /> Previous</button>
        <button className={btnPrimary} disabled={stepIdx >= totalSteps - 1} onClick={() => setStepIdx((s) => Math.min(totalSteps - 1, s + 1))}>Next <ChevronRight size={14} /></button>
      </div>
      {askTandom}
    </div>
  );
}

// given a hovered x-position (inches), find which slot between existing placements a drop would land in —
// returns the array index to insert at, plus the x-position (inches) to draw the insertion arrow
function computeInsertionPoint(fx, boxes, hoverXIn) {
  const ranges = (fx.placements || [])
    .map((pl) => {
      const own = boxes.filter((b) => b.placement.id === pl.id);
      if (own.length === 0) return null;
      return { placementId: pl.id, startIn: Math.min(...own.map((b) => b.xIn)), endIn: Math.max(...own.map((b) => b.xIn + b.wIn)) };
    })
    .filter(Boolean);

  if (ranges.length === 0) return { index: 0, xIn: 0 };
  for (let i = 0; i < ranges.length; i++) {
    const mid = (ranges[i].startIn + ranges[i].endIn) / 2;
    if (hoverXIn < mid) {
      const xIn = i === 0 ? ranges[i].startIn : (ranges[i - 1].endIn + ranges[i].startIn) / 2;
      return { index: i, xIn };
    }
  }
  const last = ranges[ranges.length - 1];
  return { index: ranges.length, xIn: last.endIn };
}

// finds fixtures in adjacent sections at the same notch height — candidates offered to the
// user for joining (joining is always a manual choice, never automatic)
function findJoinCandidates(planogram, sectionIndex, fx) {
  const candidates = [];
  [sectionIndex - 1, sectionIndex + 1].forEach((idx) => {
    const sec = planogram.sections[idx];
    if (!sec) return;
    sec.fixtures.forEach((otherFx) => {
      if (otherFx.id !== fx.id && otherFx.notchY === fx.notchY) {
        candidates.push({ section: sec, sectionIndex: idx, fx: otherFx });
      }
    });
  });
  return candidates;
}

// for every join group (2+ fixtures sharing a groupId), lays out all of their placements as one
// continuous left-to-right run across their combined width, then splits the result back into
// per-fixture box lists (with locally-relative x positions) so each FixtureBar can render its
// own slice — including any overflow that visually spills onto the next fixture in the group
function computeJoinedGroupLayouts(planogram, fixtures, products) {
  const groups = {}; // groupId -> [{ sectionIndex, fx, widthIn }]
  planogram.sections.forEach((section, sectionIndex) => {
    section.fixtures.forEach((fx) => {
      if (!fx.groupId) return;
      const def = fixtures.find((f) => f.id === fx.fixtureId);
      const widthIn = def ? def.dims.w : 24;
      if (!groups[fx.groupId]) groups[fx.groupId] = [];
      groups[fx.groupId].push({ sectionIndex, fx, widthIn });
    });
  });

  const result = {}; // fixtureInstanceId -> boxes[] (locally-relative x)
  Object.values(groups).forEach((members) => {
    if (members.length < 2) return; // a "group" of one is just a normal fixture
    members.sort((a, b) => a.sectionIndex - b.sectionIndex);
    const totalWidth = members.reduce((s, m) => s + m.widthIn, 0);

    const items = [];
    members.forEach((m) => {
      (m.fx.placements || []).forEach((pl) => {
        const prod = products.find((p) => p.id === pl.productId);
        if (!prod) return;
        const rotated = pl.rotation === 90 || pl.rotation === 270;
        const nominalW = (rotated ? prod.dims.h : prod.dims.w) || 1;
        const squeeze = prod.squeezeFactor ?? 1;
        const w = nominalW * squeeze;
        const overhangIn = prod.overhangIn || 0;
        const stack = getStackDims(prod, pl, products);
        for (let i = 0; i < (pl.facings || 1); i++) items.push({ placement: pl, product: prod, wIn: w, overhangIn, stack });
      });
    });

    let cursor = 0;
    const globalBoxes = items.map((it) => {
      // only the group's very last facing's own overhang tolerance matters here, since that's
      // the one actually sitting at the combined run's far edge
      const box = { placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: cursor + it.wIn > totalWidth + it.overhangIn, stack: it.stack };
      cursor += it.wIn;
      return box;
    });

    let memberStart = 0;
    members.forEach((m, idx) => {
      const memberEnd = memberStart + m.widthIn;
      const isLastMember = idx === members.length - 1;
      // the last member also catches anything beyond the group's combined width — otherwise
      // true overflow (more product than the whole joined run can hold) would silently vanish
      // instead of rendering (with the overflow flag) like it does on a normal single fixture
      result[m.fx.id] = globalBoxes
        .filter((b) => b.xIn >= memberStart && (isLastMember || b.xIn < memberEnd))
        .map((b) => ({ ...b, xIn: b.xIn - memberStart }));
      memberStart = memberEnd;
    });
  });

  return result;
}

// The product currently selected in the Product Library (or implied by the selected placement); every facing of it on
// the planogram draws a blue outline so the library and the shelf point at the same thing.
const LinkedProductContext = React.createContext(null);

function ProductBox({ box, scale, selected, groupSelected, onSelect, metrics, schema, overlaySettings, onDragStartPlacement, onDragEndPlacement, dragging, readOnly, capacityWarningsEnabled, hideImages, highlightField, zoomLevel, pegYIn, stackProblem }) {
  const { placement, product, xIn, wIn, overflow, effectiveDims, stack } = box;
  const linkedProductId = React.useContext(LinkedProductContext);
  const linked = !!linkedProductId && linkedProductId === product.id;
  const dims = effectiveDims || product.dims;
  const img = hideImages ? null : product.images?.[placement.orientation];
  const rotation = placement.rotation || 0;
  const rotated = rotation === 90 || rotation === 270;
  const showOverflowBorder = overflow && capacityWarningsEnabled !== false;
  // overlay/name text is otherwise a fixed tiny pixel size — scale it with zoom so zooming in
  // actually makes the financial/attribute details more legible, not just the boxes bigger
  const overlayFontSize = clamp(6 * (zoomLevel || 1), 6, 22);
  const nameFontSize = clamp(9 * (zoomLevel || 1), 9, 26);

  // attribute-based highlight — color derived from this product's value for the chosen field,
  // so planners can visually scan for correct brand/category/size grouping across the shelf
  const highlightValue = highlightField ? (product.attributes?.[highlightField] ?? "") : null;
  const hasHighlight = highlightField && String(highlightValue).trim() !== "";
  const highlightColor = hasHighlight ? hashColor(String(highlightValue)) : null;

  // footprint = the actual space this facing occupies on the shelf (swaps at 90/270)
  const footprintWpx = Math.max(wIn * scale - 1, 2);
  const footprintHpx = Math.max((rotated ? dims.w : dims.h) * scale - 1, 4);
  // natural = the product's own front-facing size (or its merch style's, if placed as one),
  // which then gets rotated as a whole block
  const naturalWpx = Math.max(dims.w * scale - 1, 2);
  const naturalHpx = Math.max(dims.h * scale - 1, 4);

  // how many characters of the name can actually fit on one line at this box's width/font size —
  // a rough average-glyph-width estimate, used to truncate with an explicit "…" rather than
  // letting a too-long name wrap onto multiple lines and then get silently clipped by the box's
  // own overflow, which used to leave a random, confusing MIDDLE fragment on screen (e.g. "PLANTERS
  // TRAIL MIX..." rendering as just "ANTE T") instead of a readable, predictable prefix
  const maxNameChars = Math.max(1, Math.floor((naturalWpx - 4) / (nameFontSize * 0.62)));
  const displayName = product.name.length > maxNameChars ? product.name.slice(0, Math.max(1, maxNameChars - 1)) + "…" : product.name;

  const settings = overlaySettings || DEFAULT_OVERLAY_SETTINGS;
  const showOverlay = settings.mode === "always" || (settings.mode === "noImageOnly" && !img);
  const { detailLines, metricLines } = showOverlay ? resolveOverlayLines(product, placement, metrics, schema, settings) : { detailLines: [], metricLines: [] };
  const hasOverlayContent = detailLines.length > 0 || metricLines.length > 0;
  // showLabels off = just the number ("$1.24") instead of "Profit Per Unit: $1.24" — much more
  // likely to actually fit. wrapText lets a line break onto a second line instead of truncating.
  const metricLineTexts = metricLines.map((m) => (settings.showLabels === false ? m.value : `${m.label}: ${m.value}`));
  const lineWrapCls = settings.wrapText ? "whitespace-normal break-words" : "truncate";

  const posCls = settings.position === "top" ? "top-0" : settings.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-0";

  // pegYIn (pegboard only): the peg hole sits at this height from the panel's bottom edge, and
  // the product hangs DOWN from it — so its own top, not its bottom, aligns to the peg
  const hasPeg = pegYIn !== undefined && pegYIn !== null;
  const pegBottomPx = hasPeg ? (pegYIn - (rotated ? dims.w : dims.h)) * scale : undefined;

  // stacking: `high` copies of the unit stacked from the shelf up, then any cap on top (see getStackDims)
  const highCount = stack?.high || 1;
  const deepCount = stack?.deep || 1;
  const cap = stack?.cap || null;
  const capUnitHpx = cap ? Math.max(cap.unitHIn * scale - 1, 4) : 0;
  const stackHpx = footprintHpx * highCount + (cap ? capUnitHpx * cap.count : 0);
  const capImg = cap && !hideImages ? (cap.product.images?.[cap.orientation] || (cap.orientation === "front" ? null : cap.product.images?.front)) || null : null;
  const capWpx = cap ? Math.max(Math.min(cap.unitWIn * scale - 1, footprintWpx), 2) : 0;

  const renderUnit = (layer) => (
    <div key={layer} className="absolute left-0" style={{ bottom: layer * footprintHpx, width: footprintWpx, height: footprintHpx }}>
      <div
        draggable={!readOnly}
        // a product is natively draggable (HTML5 DnD) unconditionally, which — if a Ctrl/Cmd+drag
        // for rubberband-select happens to start on/over a product, as it usually will on a
        // tightly-packed shelf — hijacks the gesture into a native drag before our own
        // mousemove/mouseup listeners ever see it, silently swallowing the rubberband. Suppressing
        // the native drag start specifically while Ctrl/Cmd is held lets the mousedown fall
        // through normally instead, so the section's rubberband handler gets it.
        onMouseDown={readOnly ? undefined : (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); }}
        onDragStart={readOnly ? undefined : (e) => { e.stopPropagation(); onDragStartPlacement(e, placement); }}
        onDragEnd={readOnly ? undefined : (e) => { e.stopPropagation(); onDragEndPlacement(); }}
        onClick={readOnly ? undefined : (e) => { e.stopPropagation(); onSelect(placement.id); }}
        className={`absolute top-1/2 left-1/2 flex items-center justify-center overflow-hidden border ${readOnly ? "" : "cursor-grab active:cursor-grabbing"} ${
          selected ? "ring-2 ring-amber-500 border-amber-500" : groupSelected ? "ring-2 ring-blue-500 border-blue-500" : showOverflowBorder ? "border-red-400" : hasHighlight ? "" : "border-slate-400/60"
        } ${dragging ? "opacity-30" : ""}`}
        style={{
          width: naturalWpx,
          height: naturalHpx,
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          background: img ? "#fff" : hasHighlight ? highlightColor : hashColor(product.name),
          ...(hasHighlight && !selected && !showOverflowBorder ? { borderColor: highlightColor, borderWidth: 2 } : {}),
        }}
      >
        {img ? (
          <img src={img} alt={product.name} className="absolute inset-0 w-full h-full object-cover" />
        ) : !hasOverlayContent || layer > 0 ? (
          <span className="block w-full leading-tight text-white font-semibold text-center px-0.5 whitespace-nowrap overflow-hidden text-ellipsis" style={{ fontSize: nameFontSize }}>
            {displayName}
          </span>
        ) : null}

        {layer === 0 && hasOverlayContent && settings.layout === "compact" && (
          <div className={`absolute ${posCls} left-0 max-w-full bg-black/70 text-white px-0.5 leading-tight overflow-hidden`} style={{ fontSize: overlayFontSize }}>
            {detailLines.slice(0, 1).map((l, i) => <div key={"d" + i} className={`font-semibold ${lineWrapCls}`}>{l}</div>)}
            {metricLineTexts.slice(0, 2).map((l, i) => <div key={"m" + i} className={lineWrapCls}>{l}</div>)}
          </div>
        )}
        {layer === 0 && hasOverlayContent && settings.layout === "detailed" && (
          <div className={`absolute ${posCls} left-0 right-0 bg-black/75 text-white px-0.5 py-0.5 leading-tight overflow-hidden`} style={{ fontSize: overlayFontSize }}>
            {detailLines.map((l, i) => <div key={"d" + i} className={`font-semibold ${lineWrapCls}`}>{l}</div>)}
            {metricLineTexts.map((l, i) => <div key={"m" + i} className={lineWrapCls}>{l}</div>)}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-placement-id={placement.id}
      className={`absolute ${hasPeg ? "" : "bottom-0"} ${selected ? "z-10" : ""}`}
      style={{ left: xIn * scale, width: footprintWpx, height: stackHpx, bottom: hasPeg ? pegBottomPx : undefined, pointerEvents: "auto", ...(linked && !selected ? { boxShadow: "0 0 0 2px #38bdf8", zIndex: 5 } : {}) }}
      title={`${product.name} · ${placement.orientation} · ${rotation}°${highCount > 1 ? ` · ${highCount} high` : ""}${deepCount > 1 ? ` · ${deepCount} deep` : ""}${cap ? ` · capped ${cap.count}× ${cap.sameProduct ? "same product" : cap.product.name}` : ""}`}
    >
      {Array.from({ length: highCount }, (_, layer) => renderUnit(layer))}
      {cap && Array.from({ length: cap.count }, (_, ci) => (
        <div
          key={"cap" + ci}
          onClick={readOnly ? undefined : (e) => { e.stopPropagation(); onSelect(placement.id); }}
          className={`absolute flex items-center justify-center overflow-hidden border border-dashed ${selected ? "border-amber-500" : "border-slate-500"}`}
          style={{ left: (footprintWpx - capWpx) / 2, width: capWpx, height: capUnitHpx, bottom: footprintHpx * highCount + ci * capUnitHpx, background: capImg ? "#fff" : hashColor(cap.product.name) }}
          title={`Cap: ${cap.product.name}`}
        >
          {capImg ? <img src={capImg} alt={cap.product.name} className="absolute inset-0 w-full h-full object-cover" /> : (
            <span className="block w-full leading-tight text-white font-semibold text-center px-0.5 whitespace-nowrap overflow-hidden text-ellipsis" style={{ fontSize: nameFontSize }}>{cap.sameProduct ? displayName : cap.product.name}</span>
          )}
        </div>
      ))}
      {deepCount > 1 && (
        <span className="absolute right-0 top-0 z-20 pointer-events-none bg-slate-900/80 text-white font-mono leading-none px-0.5 rounded-bl" style={{ fontSize: overlayFontSize }}>{deepCount}D</span>
      )}
      {stackProblem && (
        <div className="absolute inset-0 z-20 pointer-events-none border-2 border-dashed border-red-500" title={stackProblem} />
      )}
    </div>
  );
}

function FixtureBar({
  fx, fixtureDef, products, scale, base, maxNotchY, selected, sectionId, readOnly, joinedBoxes, capacityWarningsEnabled, hideImages, highlightField, zoomLevel, clearanceIn,
  onSelectFixture, selectedPlacementId, onSelectPlacement, onDragCommit, onDropProduct, onMovePlacement,
  performance, cutoffISO, storeId, schema, overlaySettings,
  // only passed for a top-level (unmounted) fixture — lets dragging this bar onto a pegboard panel
  // mount it there instead of just moving it up/down in its own section (see handleUp below)
  onMountOnPegboard,
  // section-wide rubberband multi-select (see SectionColumn) — groupSelected means THIS fixture's
  // own bar is part of a multi-fixture selection (drag moves all of them together, vertically);
  // groupSelectedPlacementIds/Items cover individual products selected across the whole section,
  // possibly spanning other fixtures too (drag carries the whole group to wherever it's dropped).
  onDragCommitGroup, groupSelected, groupSelectedPlacementIds, groupSelectedItems, onClearGroupSelection, onMoveGroupToFixture,
}) {
  const boxes = joinedBoxes || layoutFixtureBoxes(fx, fixtureDef, products).boxes;
  const widthIn = fixtureDef ? fixtureDef.dims.w : 24;
  const heightIn = fixtureDef ? fixtureDef.dims.h : 2;

  const [dragging, setDragging] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [draggingPlacementId, setDraggingPlacementId] = useState(null);
  const [dropInsertIndex, setDropInsertIndex] = useState(null);
  const [dropArrowXIn, setDropArrowXIn] = useState(0);
  const [liveNotchY, setLiveNotchY] = useState(fx.notchY);
  // the "Xin left" pill is only worth showing when the planner's actually looking at THIS shelf
  // (hovering or having it selected) — surfacing it for every shelf at once, all the time, was
  // more visual noise than help. Genuine warnings (over capacity, tight space) stay always-on.
  const [hovering, setHovering] = useState(false);
  const dragRef = useRef(null);

  // keep the displayed position in sync when not actively dragging (e.g. typed in the side panel)
  useEffect(() => { if (!dragging) setLiveNotchY(fx.notchY); }, [fx.notchY, dragging]);

  const handleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = d.startClientY - e.clientY; // moving mouse up = positive = higher notch
    if (Math.abs(deltaPx) > 3) d.moved = true;
    const deltaIn = Math.round(deltaPx / scale);
    const newNotch = clamp(d.startNotch + deltaIn, 0, maxNotchY);
    d.currentNotch = newNotch;
    setLiveNotchY(newNotch);
  };

  const handleUp = (e) => {
    const d = dragRef.current;
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(false);
    dragRef.current = null;
    if (d) {
      if (d.moved) {
        // released over a pegboard panel? mount this fixture there (cosmetics-wall pattern: a
        // shelf physically attached to a pegboard backdrop) instead of the usual vertical reslot
        const panelEl = onMountOnPegboard && e && document.elementFromPoint(e.clientX, e.clientY)?.closest?.("[data-pegboard-panel-id]");
        if (panelEl && panelEl.dataset.pegboardPanelId !== fx.id) {
          const rect = panelEl.getBoundingClientRect();
          const dropXOffset = Math.max(0, Math.round((e.clientX - rect.left) / scale));
          const dropNotchY = Math.max(0, Math.round((rect.bottom - e.clientY) / scale));
          onMountOnPegboard(panelEl.dataset.pegboardPanelId, dropXOffset, dropNotchY);
        } else if (groupSelected && onDragCommitGroup) {
          onDragCommitGroup(d.currentNotch - d.startNotch);
        } else {
          onDragCommit(d.currentNotch);
        }
        // a completed drag — grouped or not — ends the current multi-select; leaving it set would
        // keep showing a stale blue ring on whatever was last grouped, even once the user moves on
        // to selecting/dragging something else entirely
        onClearGroupSelection && onClearGroupSelection();
        onSelectFixture(fx.id);
      } else {
        onSelectFixture(fx.id);
      }
    }
  };

  const handleDown = (e) => {
    if (e.ctrlKey || e.metaKey) return; // let it bubble up to the section for rubberband-select
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startClientY: e.clientY, startNotch: fx.notchY, currentNotch: fx.notchY, moved: false };
    setDragging(true);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handlePlacementDragStart = (e, placement) => {
    e.dataTransfer.effectAllowed = "move";
    // dragging a placement that's part of the current section-wide selection carries the WHOLE
    // group along as one ordered block — handleDrop below re-inserts them together, preserving
    // that order, at wherever this lands (a different shelf, or back on this one to reorder)
    if (groupSelectedPlacementIds && groupSelectedPlacementIds.size > 1 && groupSelectedPlacementIds.has(placement.id)) {
      e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "shelfGroup", items: groupSelectedItems }));
    } else {
      onClearGroupSelection && onClearGroupSelection();
      e.dataTransfer.setData("text/plain", JSON.stringify({
        kind: "placement",
        sectionId,
        fixtureInstId: fx.id,
        placementId: placement.id,
        productId: placement.productId,
        rotation: placement.rotation || 0,
      }));
    }
    // anchor the drag ghost at its top-left corner, not wherever it was grabbed — matters if this
    // ends up dropped on a pegboard, where the cursor position must represent that corner exactly
    try { e.dataTransfer.setDragImage(e.currentTarget, 0, 0); } catch (err) {}
    setDraggingPlacementId(placement.id);
  };
  const handlePlacementDragEnd = () => setDraggingPlacementId(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dropHover) setDropHover(true);
    try {
      const rect = e.currentTarget.getBoundingClientRect();
      const hoverXIn = (e.clientX - rect.left) / scale;
      const { index, xIn } = computeInsertionPoint(fx, boxes, hoverXIn);
      setDropInsertIndex(index);
      setDropArrowXIn(xIn);
    } catch (err) {
      // insertion-arrow positioning is a visual nicety only — never let it block the drop itself
      setDropInsertIndex(null);
    }
  };
  const handleDragLeave = () => { setDropHover(false); setDropInsertIndex(null); };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHover(false);
    const insertIndex = dropInsertIndex;
    setDropInsertIndex(null);
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { kind: "product", productId: raw }; }
    if (payload.kind === "shelfGroup" && Array.isArray(payload.items)) {
      onMoveGroupToFixture(payload.items, { sectionId, fixtureInstId: fx.id }, insertIndex);
      onClearGroupSelection && onClearGroupSelection();
      return;
    }
    if (payload.kind === "pegGroup" && Array.isArray(payload.placementIds)) {
      // a peg-selected group dropped onto a plain shelf — it's leaving the pegboard, so it just
      // becomes an ordered block of shelf placements like any other group move
      const items = payload.placementIds.map((id) => ({ sectionId: payload.sectionId, fixtureInstId: payload.fixtureInstId, placementId: id }));
      onMoveGroupToFixture(items, { sectionId, fixtureInstId: fx.id }, insertIndex);
      onClearGroupSelection && onClearGroupSelection();
      return;
    }
    if (payload.kind === "placement") {
      onMovePlacement(
        { sectionId: payload.sectionId, fixtureInstId: payload.fixtureInstId, placementId: payload.placementId },
        { sectionId, fixtureInstId: fx.id },
        insertIndex
      );
    } else if (payload.productId) {
      onDropProduct(payload.productId, insertIndex);
    }
  };

  const bottomIn = base + liveNotchY;
  const dropZoneHeightIn = 14; // vertical hit-area above the shelf — generous but small enough not to cover a shelf stacked above it
  const arrowHeightIn = 10; // the insertion arrow is much shorter than the hit-area, so it doesn't tower over the shelf
  const hasOverflow = boxes.some((b) => b.overflow); // a genuine capacity problem — triggers the red "over capacity" warning
  // any box whose right edge extends past THIS fixture's own width needs elevated stacking so it
  // renders above the next section, regardless of whether it's a true overflow or just normal
  // mid-flow spillover from a joined neighbor (joining is supposed to look seamless, not broken)
  const spillsPastOwnWidth = boxes.some((b) => b.xIn + b.wIn > widthIn);
  // remaining space on THIS shelf — for a joined fixture, this naturally cascades correctly:
  // an earlier (donor) shelf that's full reads 0in left, while the shelf actually absorbing the
  // overflow reports the group's real leftover room, with no special-casing needed.
  // Left un-clamped (can go negative) so it can represent "using allowed overhang" rather than
  // just flattening to 0 the moment a compressible product's footprint edge touches the boundary.
  const usedWidthIn = boxes.reduce((s, b) => s + b.wIn, 0);
  const remainingIn = widthIn - usedWidthIn;
  const remainingTight = widthIn > 0 && remainingIn >= 0 && remainingIn / widthIn < 0.1;
  const showWarnings = capacityWarningsEnabled !== false; // default on
  const visualOverflow = showWarnings && hasOverflow; // hasOverflow itself stays true regardless — only its display is toggled
  const barRingCls = !readOnly && dropHover
    ? "ring-2 ring-amber-400 z-20"
    : visualOverflow
    ? "ring-2 ring-red-500 z-20"
    : !readOnly && (selected || dragging || groupSelected)
    ? "ring-2 ring-blue-500 z-20"
    : "";

  return (
    <>
      {/* the shelf/fixture bar itself — mousedown drags it up/down along notches, also accepts product drops */}
      <div
        onMouseDown={readOnly ? undefined : handleDown}
        onClick={readOnly ? undefined : (e) => { e.stopPropagation(); onClearGroupSelection && onClearGroupSelection(); }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onContextMenu={readOnly ? undefined : (e) => e.preventDefault()}
        onDragOver={readOnly ? undefined : handleDragOver}
        onDragLeave={readOnly ? undefined : handleDragLeave}
        onDrop={readOnly ? undefined : handleDrop}
        className={`absolute select-none ${readOnly ? "" : dragging ? "cursor-grabbing" : "cursor-grab"} ${barRingCls}`}
        style={{
          left: fx.xOffset * scale,
          bottom: bottomIn * scale,
          width: widthIn * scale,
          height: Math.max(heightIn * scale, 3),
          background: dragging ? "#60a5fa" : visualOverflow ? "#f87171" : "#94a3b8",
          borderTop: "1px solid #64748b",
          boxShadow: dragging ? "0 4px 10px rgba(0,0,0,0.25)" : "none",
          transition: dragging ? "none" : "bottom 80ms ease-out",
        }}
        title={
          visualOverflow
            ? "This shelf has more product than it can physically hold — remove facings, reduce sizes, or widen the fixture."
            : fixtureDef
            ? `${fixtureDef.name} (${fixtureDef.type}) — drag to reposition, drop a product here${onMountOnPegboard ? ", or drag onto a pegboard to mount it there" : ""}`
            : "Missing fixture"
        }
      />
      {visualOverflow && (
        <div
          className="absolute z-30 flex items-center gap-1 text-[10px] font-semibold bg-red-600 text-white rounded px-1.5 py-0.5 pointer-events-none"
          style={{ left: fx.xOffset * scale, bottom: bottomIn * scale + Math.max(heightIn * scale, 3) + 4 }}
        >
          <AlertTriangle size={10} /> Over capacity
        </div>
      )}
      {showWarnings && !visualOverflow && boxes.length > 0 && (hovering || selected || dragging) && (
        <div
          className={`absolute z-30 text-[10px] font-semibold rounded px-1.5 py-0.5 pointer-events-none ${remainingTight || remainingIn < 0 ? "bg-amber-500 text-slate-900" : "bg-slate-600 text-white"}`}
          style={{ left: fx.xOffset * scale, bottom: bottomIn * scale + Math.max(heightIn * scale, 3) + 4 }}
        >
          {remainingIn >= 0
            ? `${remainingIn.toFixed(remainingIn % 1 === 0 ? 0 : 1)}in left`
            : `${Math.abs(remainingIn).toFixed(remainingIn % 1 === 0 ? 0 : 1)}in overhang`}
        </div>
      )}
      {dragging && (
        <div
          className="absolute z-30 text-[10px] font-mono font-semibold bg-slate-900 text-white rounded px-1.5 py-0.5 pointer-events-none"
          style={{ left: fx.xOffset * scale, bottom: bottomIn * scale + Math.max(heightIn * scale, 3) + 4 }}
        >
          {liveNotchY}in from base
        </div>
      )}
      {/* products sitting on the fixture, plus a generous (invisible) drop-target band above it.
          When this shelf overflows, its facings visually spill past the section boundary into
          the next section's space — bump z-index so they render on top of that neighbor instead
          of sliding behind it (plain sibling sections otherwise stack purely by DOM order). */}
      <div
        className="absolute"
        style={{ left: fx.xOffset * scale, bottom: (bottomIn + heightIn) * scale, width: widthIn * scale, height: dropZoneHeightIn * scale, zIndex: spillsPastOwnWidth ? 30 : undefined }}
        onDragOver={readOnly ? undefined : handleDragOver}
        onDragLeave={readOnly ? undefined : handleDragLeave}
        onDrop={readOnly ? undefined : handleDrop}
      >
        {!readOnly && dropHover && (
          <div
            className="absolute bottom-0 flex flex-col items-center pointer-events-none"
            style={{ left: dropArrowXIn * scale, transform: "translateX(-50%)" }}
          >
            <ChevronDown size={12} className="text-amber-500 -mb-1" strokeWidth={3} />
            <div className="w-0.5 bg-amber-500" style={{ height: Math.max(arrowHeightIn * scale - 12, 4) }} />
          </div>
        )}
        {boxes.map((box, i) => (
          <ProductBox
            key={box.placement.id + "_" + i}
            box={box}
            scale={scale}
            selected={!readOnly && selectedPlacementId === box.placement.id}
            groupSelected={!readOnly && groupSelectedPlacementIds && groupSelectedPlacementIds.has(box.placement.id)}
            onSelect={(id) => { onClearGroupSelection && onClearGroupSelection(); onSelectPlacement(id); }}
            metrics={aggregateProductPerformance(box.product.id, performance, cutoffISO, storeId)}
            schema={schema}
            overlaySettings={overlaySettings}
            onDragStartPlacement={handlePlacementDragStart}
            onDragEndPlacement={handlePlacementDragEnd}
            dragging={draggingPlacementId === box.placement.id}
            readOnly={readOnly}
            capacityWarningsEnabled={capacityWarningsEnabled}
            hideImages={hideImages}
            highlightField={highlightField}
            zoomLevel={zoomLevel}
            stackProblem={getStackHeightProblem(box.product, box.placement, products, clearanceIn) || getStackDepthProblem(box.product, box.placement, products, fixtureDef?.dims?.d)}
          />
        ))}
      </div>
    </>
  );
}

// A pegboard/slatwall panel: a flat vertical surface with a 1-inch peg grid, mounted at a chosen
// height against the back wall — fundamentally different from a shelf. Instead of one linear row
// of facings auto-packed left-to-right, each product hangs from its own explicit (x, y) hole
// anywhere on the panel, so this gets its own dedicated rendering/interaction rather than reusing
// FixtureBar's shelf model.
function PegboardPanel({
  fx, fixtureDef, products, scale, base, maxNotchY, selected, sectionId, readOnly, capacityWarningsEnabled, hideImages, highlightField, zoomLevel,
  onSelectFixture, selectedFixtureId, selectedPlacementId, onSelectPlacement, onDragCommit, onDropProduct, onMovePlacement, onMoveGroup,
  performance, cutoffISO, storeId, schema, overlaySettings,
  // fixtures (e.g. shelves) physically mounted on this panel — the cosmetics-wall pattern of a
  // pegboard backdrop with a few shelves attached to it. Each carries its own xOffset/notchY
  // relative to THIS panel's own origin, so it tracks along if the panel itself moves.
  mountedFixtures, fixtures, onDragMountedFixture, onDropProductOnMounted,
  // section-wide rubberband multi-select (see SectionColumn) — groupSelected means THIS panel's
  // own bar is part of a multi-fixture selection (drag moves all of them together, vertically);
  // groupSelectedPlacementIds/Items cover individual products selected across the whole section,
  // possibly spanning other fixtures too (drag carries the whole group to wherever it's dropped).
  onDragCommitGroup, groupSelected, groupSelectedPlacementIds, groupSelectedItems, onClearGroupSelection, onMoveGroupToFixture,
}) {
  const widthIn = fixtureDef ? fixtureDef.dims.w : 24;
  const heightIn = fixtureDef ? fixtureDef.dims.h : 24;
  const { boxes } = layoutPegboardBoxes(fx, fixtureDef, products);

  const [dragging, setDragging] = useState(false);
  const [dropHoverXY, setDropHoverXY] = useState(null); // snapped {xIn, yIn} peg the drop would land on
  const [liveNotchY, setLiveNotchY] = useState(fx.notchY);
  const dragRef = useRef(null);

  // keep the displayed position in sync when not actively dragging (e.g. typed in the side panel)
  useEffect(() => { if (!dragging) setLiveNotchY(fx.notchY); }, [fx.notchY, dragging]);

  // dragging the panel itself repositions the whole thing vertically — same mechanic as a shelf,
  // since a pegboard is still mounted at a chosen height even though products within it are 2D-free
  const handleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = d.startClientY - e.clientY;
    if (Math.abs(deltaPx) > 3) d.moved = true;
    const deltaIn = Math.round(deltaPx / scale);
    const newNotch = clamp(d.startNotch + deltaIn, 0, maxNotchY);
    d.currentNotch = newNotch;
    setLiveNotchY(newNotch);
  };
  const handleUp = () => {
    const d = dragRef.current;
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(false);
    dragRef.current = null;
    if (d) {
      if (d.moved) {
        if (groupSelected && onDragCommitGroup) onDragCommitGroup(d.currentNotch - d.startNotch);
        else onDragCommit(d.currentNotch);
        // a completed drag — grouped or not — ends the current multi-select; leaving it set would
        // keep showing a stale blue ring on whatever was last grouped
        onClearGroupSelection && onClearGroupSelection();
        onSelectFixture(fx.id);
      } else onSelectFixture(fx.id);
    }
  };
  const handleDown = (e) => {
    if (e.ctrlKey || e.metaKey) return; // let it bubble up to the section for rubberband-select
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startClientY: e.clientY, startNotch: fx.notchY, currentNotch: fx.notchY, moved: false };
    setDragging(true);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const bottomIn = base + liveNotchY;

  // cursor position, snapped to the nearest whole inch, IS the physical peg coordinate —
  // directly matching a real hole on the 1-inch grid. The product's rendered origin (top-left
  // corner) is derived from this via the hang-hole offset at render time (see pegToOrigin above),
  // not computed here — dropping just needs to answer "which hole is closest to the cursor."
  const computeDropXY = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xIn = clamp(Math.round((e.clientX - rect.left) / scale), 0, widthIn);
    const yInFromTop = (e.clientY - rect.top) / scale;
    const yIn = clamp(Math.round(heightIn - yInFromTop), 0, heightIn);
    return { xIn, yIn };
  };
  const handlePanelDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    try {
      setDropHoverXY(computeDropXY(e));
    } catch (err) {
      setDropHoverXY(null);
    }
  };
  const handlePanelDragLeave = () => setDropHoverXY(null);
  const handlePanelDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // recompute from the actual drop event rather than trusting the last dragover's cached
    // state — the final dragover right before release doesn't always land exactly on the drop
    // point (e.g. crossing over a product already sitting on the panel), which was causing
    // drops to snap a few holes away from where the cursor actually was
    let xy;
    try { xy = computeDropXY(e); } catch (err) { xy = dropHoverXY || { xIn: 0, yIn: heightIn }; }
    setDropHoverXY(null);
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { kind: "product", productId: raw }; }

    const pegCoords = { pegX: xy.xIn, pegY: xy.yIn };

    if (payload.kind === "pegGroup") {
      // group move only within the SAME panel it was selected on — a rubberband selection is a
      // "move these together, right here" gesture, not a cross-panel one, so a drop elsewhere is
      // just ignored rather than silently breaking the group apart
      if (payload.sectionId === sectionId && payload.fixtureInstId === fx.id && Array.isArray(payload.placementIds) && onMoveGroup) {
        const dx = xy.xIn - payload.anchorPegX;
        const dy = xy.yIn - payload.anchorPegY;
        onMoveGroup(sectionId, fx.id, payload.placementIds, dx, dy);
      }
      onClearGroupSelection && onClearGroupSelection();
      return;
    }
    if (payload.kind === "shelfGroup" && Array.isArray(payload.items)) {
      // a shelf-selected group landing on a pegboard — it's becoming pegged, so give each item its
      // own hole rather than trying to preserve shelf ordering; simple left-to-right spread from
      // the drop point is enough to land them all visibly and non-overlapping
      payload.items.forEach((it, i) => {
        onMovePlacement(it, { sectionId, fixtureInstId: fx.id }, null, { pegX: clamp(Math.round(xy.xIn + i * 2), 0, widthIn), pegY: xy.yIn });
      });
      onClearGroupSelection && onClearGroupSelection();
      return;
    }
    if (payload.kind === "placement") {
      onMovePlacement(
        { sectionId: payload.sectionId, fixtureInstId: payload.fixtureInstId, placementId: payload.placementId },
        { sectionId, fixtureInstId: fx.id },
        null,
        pegCoords
      );
    } else if (payload.productId) {
      onDropProduct(payload.productId, null, pegCoords);
    }
  };

  const handlePlacementDragStart = (e, placement) => {
    e.dataTransfer.effectAllowed = "move";
    // dragging a placement that's part of the current rubberband selection carries the WHOLE
    // group along, anchored to this one item — handlePanelDrop computes the drop delta from this
    // item's new position and applies the same delta to every other selected placement
    const groupIds = groupSelectedPlacementIds || new Set();
    const inGroup = groupIds.size > 1 && groupIds.has(placement.id);
    // a pure single-pegboard-origin group keeps the precise dx/dy free-move (pegGroup); a group
    // that spans other fixtures too doesn't have a shared 2D space to move within, so it falls
    // back to the generic ordered-block move (shelfGroup) — same as dragging it onto a shelf
    const allMineOnThisFixture = inGroup && Array.from(groupIds).every((id) => (fx.placements || []).some((p) => p.id === id));
    if (allMineOnThisFixture) {
      e.dataTransfer.setData("text/plain", JSON.stringify({
        kind: "pegGroup",
        sectionId,
        fixtureInstId: fx.id,
        placementIds: Array.from(groupIds),
        anchorPegX: placement.pegX ?? 0,
        anchorPegY: placement.pegY ?? 0,
      }));
    } else if (inGroup) {
      e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "shelfGroup", items: groupSelectedItems }));
    } else {
      onClearGroupSelection && onClearGroupSelection();
      e.dataTransfer.setData("text/plain", JSON.stringify({
        kind: "placement",
        sectionId,
        fixtureInstId: fx.id,
        placementId: placement.id,
        productId: placement.productId,
        rotation: placement.rotation || 0,
      }));
    }
    // anchor the drag ghost at its top-left corner, not wherever it was grabbed — the cursor
    // position must represent that corner exactly for the peg calculation to land correctly
    try { e.dataTransfer.setDragImage(e.currentTarget, 0, 0); } catch (err) {}
  };

  const hasOverflow = boxes.some((b) => b.overflow);
  const showWarnings = capacityWarningsEnabled !== false;
  const visualOverflow = showWarnings && hasOverflow;
  // a pegboard panel is often much wider than its own section and visually bleeds across
  // neighboring sections' columns (by design — it's the backdrop those sections' shelves sit
  // in front of). Elevating it with z-20 just for being SELECTED would paint it over those
  // shelves/products, covering them, so only actively dragging it (a brief, attention-grabbing
  // state) gets the elevation — a merely-selected panel keeps its ring but stays in the back.
  const ringCls = !readOnly && dropHoverXY
    ? "ring-2 ring-amber-400 z-20"
    : visualOverflow
    ? "ring-2 ring-red-500 z-20"
    : !readOnly && dragging
    ? "ring-2 ring-blue-500 z-20"
    : !readOnly && (selected || groupSelected)
    ? "ring-2 ring-blue-500"
    : "";

  return (
    <>
      {/* the panel itself — mousedown drags it up/down along notches (repositioning the whole
          board), and it's a 2D drop target: any point on it accepts a product, snapped to the
          nearest 1in peg hole */}
      <div
        onMouseDown={readOnly ? undefined : handleDown}
        onClick={readOnly ? undefined : (e) => { e.stopPropagation(); onClearGroupSelection && onClearGroupSelection(); }}
        // on macOS, Ctrl+click is the system's secondary-click (right-click) gesture — without
        // this, it opens the browser's context menu instead of ever reaching handleDown/handleMove
        // as a normal drag, so a Ctrl+drag rubberband-select silently does nothing at all
        onContextMenu={readOnly ? undefined : (e) => e.preventDefault()}
        onDragOver={readOnly ? undefined : handlePanelDragOver}
        onDragLeave={readOnly ? undefined : handlePanelDragLeave}
        onDrop={readOnly ? undefined : handlePanelDrop}
        // hit-test target for dragging an ordinary shelf fixture onto this panel to mount it —
        // see FixtureBar's handleUp, which looks for these data attributes at the drop point
        data-pegboard-panel-id={fx.id}
        data-pegboard-section-id={sectionId}
        className={`absolute select-none ${readOnly ? "" : dragging ? "cursor-grabbing" : "cursor-grab"} ${ringCls}`}
        style={{
          left: fx.xOffset * scale,
          bottom: bottomIn * scale,
          width: widthIn * scale,
          height: heightIn * scale,
          background: "#c2b8a3",
          backgroundImage: "radial-gradient(circle, #8a7d63 1px, transparent 1.5px)",
          backgroundSize: `${scale}px ${scale}px`,
          border: "1px dashed #8a7d63",
          boxShadow: dragging ? "0 4px 10px rgba(0,0,0,0.25)" : "none",
          transition: dragging ? "none" : "bottom 80ms ease-out",
        }}
        title={fixtureDef ? `${fixtureDef.name} (Pegboard) — 1in peg grid; drop a product anywhere on the panel, drag the panel to reposition it, drag a shelf fixture onto it to mount that shelf here, or Ctrl/Cmd+drag anywhere in the section to rubberband-select several products or fixtures and move them together` : "Missing fixture"}
      >
        {!readOnly && dropHoverXY && (
          <div
            className="absolute rounded-full bg-amber-400 pointer-events-none border border-amber-600"
            style={{ left: dropHoverXY.xIn * scale - 4, bottom: dropHoverXY.yIn * scale - 4, width: 8, height: 8 }}
          />
        )}
      </div>
      {/* fixtures mounted on this panel (e.g. a shelf physically attached to the pegboard) —
          rendered as ordinary FixtureBars, opaque on top of the peg mesh, with their own
          xOffset/notchY combined with the panel's so they track along if the panel moves */}
      {(mountedFixtures || []).map((mfx) => {
        const mdef = fixtures && fixtures.find((f) => f.id === mfx.fixtureId);
        const mMaxNotchY = Math.max(0, (base + heightIn) - base - (mdef ? mdef.dims.h : 2));
        const displayFx = { ...mfx, xOffset: fx.xOffset + (mfx.xOffset || 0), notchY: liveNotchY + (mfx.notchY || 0) };
        return (
          <FixtureBar
            key={mfx.id}
            fx={displayFx}
            fixtureDef={mdef}
            products={products}
            scale={scale}
            base={base}
            maxNotchY={mMaxNotchY}
            selected={selectedFixtureId === mfx.id}
            sectionId={sectionId}
            readOnly={readOnly}
            capacityWarningsEnabled={capacityWarningsEnabled}
            hideImages={hideImages}
            highlightField={highlightField}
            zoomLevel={zoomLevel}
            onSelectFixture={onSelectFixture}
            selectedPlacementId={selectedPlacementId}
            onSelectPlacement={onSelectPlacement}
            // committed notch is in the SAME absolute frame as displayFx.notchY above — convert
            // back to panel-relative before storing, so it stays correct if the panel itself moves
            onDragCommit={(absNotchY) => onDragMountedFixture && onDragMountedFixture(mfx.id, absNotchY - fx.notchY)}
            onDropProduct={(productId, insertIndex) => onDropProductOnMounted && onDropProductOnMounted(mfx.id, productId, insertIndex)}
            onMovePlacement={onMovePlacement}
            groupSelectedPlacementIds={groupSelectedPlacementIds}
            groupSelectedItems={groupSelectedItems}
            onClearGroupSelection={onClearGroupSelection}
            onMoveGroupToFixture={onMoveGroupToFixture}
            performance={performance}
            cutoffISO={cutoffISO}
            storeId={storeId}
            schema={schema}
            overlaySettings={overlaySettings}
          />
        );
      })}
      {visualOverflow && (
        <div className="absolute z-30 flex items-center gap-1 text-[10px] font-semibold bg-red-600 text-white rounded px-1.5 py-0.5 pointer-events-none" style={{ left: fx.xOffset * scale, bottom: (bottomIn + heightIn) * scale + 4 }}>
          <AlertTriangle size={10} /> One or more pegs are outside the panel
        </div>
      )}
      {dragging && (
        <div className="absolute z-30 text-[10px] font-mono font-semibold bg-slate-900 text-white rounded px-1.5 py-0.5 pointer-events-none" style={{ left: fx.xOffset * scale, bottom: (bottomIn + heightIn) * scale + 4 }}>
          {liveNotchY}in from base
        </div>
      )}
      {/* hanging products — one shared overlay matching the panel's exact bounds, with pointer
          events disabled on the overlay itself (so empty panel area still gets clicks/drops) but
          re-enabled on each product so they stay individually draggable/selectable */}
      {/* z-index explicitly kept above the panel background's own hover/selection ring (which
          can reach z-20) — otherwise, while dragging a new product over the panel, the
          background would render on top of everything already placed, making them appear to
          vanish until the drag ends */}
      <div className="absolute" style={{ left: fx.xOffset * scale, bottom: bottomIn * scale, width: widthIn * scale, height: heightIn * scale, pointerEvents: "none", zIndex: 25 }}>
        {boxes.map((box, i) => (
          <ProductBox
            key={box.placement.id + "_" + i}
            box={box}
            scale={scale}
            selected={!readOnly && selectedPlacementId === box.placement.id}
            groupSelected={!readOnly && groupSelectedPlacementIds && groupSelectedPlacementIds.has(box.placement.id)}
            onSelect={(id) => { onClearGroupSelection && onClearGroupSelection(); onSelectPlacement(id); }}
            metrics={aggregateProductPerformance(box.product.id, performance, cutoffISO, storeId)}
            schema={schema}
            overlaySettings={overlaySettings}
            onDragStartPlacement={handlePlacementDragStart}
            onDragEndPlacement={() => {}}
            dragging={false}
            readOnly={readOnly}
            capacityWarningsEnabled={capacityWarningsEnabled}
            hideImages={hideImages}
            highlightField={highlightField}
            zoomLevel={zoomLevel}
            pegYIn={box.pegYIn}
          />
        ))}
      </div>
    </>
  );
}

function SectionColumn({
  section, index, total, planogram, fixtures, products, scale, readOnly, joinedLayouts, capacityWarningsEnabled, hideImages, highlightField, zoomLevel,
  onRename, onResize, onSetBackboard, onMove, onDelete, onAddFixture, onDragFixture, onDragFixtureGroup, onDropProductOnFixture, onMountFixture, onMovePlacement, onMoveGroup, onMoveGroupToFixture,
  selectedFixtureId, onSelectFixture, selectedPlacementId, onSelectPlacement, onDeselectAll,
  performance, cutoffISO, storeId, schema, overlaySettings,
}) {
  const heightPx = planogram.dims.h * scale;
  // section-wide rubberband multi-select: Ctrl/Cmd+drag over empty space, a shelf, or the
  // pegboard lassos whatever it touches — whole fixtures (by their bar) for a group reposition,
  // and/or individual products (on a shelf or a pegboard) for a group move to another fixture.
  // One unified selection mechanism for the whole section, not a separate one per panel, so the
  // gesture can start anywhere and still capture everything it passes over. Purely local/transient
  // UI state — it only matters for the next drag and clears once that drag lands or on a plain
  // click elsewhere.
  const [rubberband, setRubberband] = useState(null); // {x0,y0,x1,y1} in section-local pixels
  const [groupSelectedFixtureIds, setGroupSelectedFixtureIds] = useState(() => new Set());
  const [groupSelectedPlacementIds, setGroupSelectedPlacementIds] = useState(() => new Set());
  const [groupSelectedItems, setGroupSelectedItems] = useState([]); // [{sectionId,fixtureInstId,placementId}], stable order
  const rubberRef = useRef(null);

  const clearGroupSelection = () => {
    if (!groupSelectedFixtureIds.size && !groupSelectedPlacementIds.size) return;
    setGroupSelectedFixtureIds(new Set());
    setGroupSelectedPlacementIds(new Set());
    setGroupSelectedItems([]);
  };

  const handleRubberDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const startX = e.clientX - rect.left, startY = e.clientY - rect.top;
    rubberRef.current = { rect, startX, startY, curX: startX, curY: startY, moved: false };
    setRubberband({ x0: startX, y0: startY, x1: startX, y1: startY });
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleRubberMove);
    window.addEventListener("mouseup", handleRubberUp);
  };
  const handleRubberMove = (e) => {
    const r = rubberRef.current;
    if (!r) return;
    const curX = clamp(e.clientX - r.rect.left, 0, r.rect.width);
    const curY = clamp(e.clientY - r.rect.top, 0, r.rect.height);
    if (Math.abs(curX - r.startX) > 3 || Math.abs(curY - r.startY) > 3) r.moved = true;
    r.curX = curX; r.curY = curY;
    setRubberband({ x0: r.startX, y0: r.startY, x1: curX, y1: curY });
  };
  const handleRubberUp = () => {
    const r = rubberRef.current;
    window.removeEventListener("mousemove", handleRubberMove);
    window.removeEventListener("mouseup", handleRubberUp);
    document.body.style.userSelect = "";
    rubberRef.current = null;
    setRubberband(null);
    if (!r || !r.moved) return; // a bare Ctrl/Cmd-click with no drag — leave the current selection as-is
    // section pixels are top-down (CSS top), but every fixture's own inches are bottom-up (from
    // the planogram's own base) — flip Y here, once, for the whole section
    const heightInTotal = planogram.dims.h;
    const xMinIn = Math.min(r.startX, r.curX) / scale;
    const xMaxIn = Math.max(r.startX, r.curX) / scale;
    const yMinIn = heightInTotal - Math.max(r.startY, r.curY) / scale;
    const yMaxIn = heightInTotal - Math.min(r.startY, r.curY) / scale;

    const hitFixtures = new Set();
    const hitPlacementIds = new Set();
    const hitItems = [];
    const addPlacementHit = (fx, placementId) => {
      if (hitPlacementIds.has(placementId)) return;
      hitPlacementIds.add(placementId);
      hitItems.push({ sectionId: section.id, fixtureInstId: fx.id, placementId });
    };

    const topLevel = section.fixtures.filter((f) => !f.mountedOnId);
    topLevel.forEach((fx) => {
      const def = fixtures.find((f) => f.id === fx.fixtureId);
      const isPeg = def?.type === "Pegboard";
      const widthIn = def ? def.dims.w : 24;
      const heightIn = def ? def.dims.h : 2;
      const bottomIn = planogram.base + fx.notchY;

      // the fixture's own bar/panel footprint — touching this selects the WHOLE fixture, for a
      // group vertical reposition ("these three shelves move up together")
      const barX0 = fx.xOffset, barX1 = fx.xOffset + widthIn;
      const barY0 = bottomIn, barY1 = bottomIn + heightIn;
      if (barX1 > xMinIn && barX0 < xMaxIn && barY1 > yMinIn && barY0 < yMaxIn) hitFixtures.add(fx.id);

      // individual products on it — touching a product (even without touching the bar) selects
      // just that product, for a group product move
      if (isPeg) {
        const { boxes } = layoutPegboardBoxes(fx, def, products);
        boxes.forEach((b) => {
          const dims = b.effectiveDims || b.product.dims;
          const rotated = b.placement.rotation === 90 || b.placement.rotation === 270;
          const boxHIn = rotated ? dims.w : dims.h;
          const bxAbs0 = fx.xOffset + b.xIn, bxAbs1 = fx.xOffset + b.xIn + b.wIn;
          const by0 = bottomIn + b.pegYIn - boxHIn, by1 = bottomIn + b.pegYIn;
          if (bxAbs1 > xMinIn && bxAbs0 < xMaxIn && by1 > yMinIn && by0 < yMaxIn) addPlacementHit(fx, b.placement.id);
        });
      } else {
        const { boxes } = layoutFixtureBoxes(fx, def, products);
        boxes.forEach((b) => {
          const dims = b.effectiveDims || b.product.dims;
          const rotated = b.placement.rotation === 90 || b.placement.rotation === 270;
          const boxHIn = rotated ? dims.w : dims.h;
          const bxAbs0 = fx.xOffset + b.xIn, bxAbs1 = fx.xOffset + b.xIn + b.wIn;
          const by0 = bottomIn + heightIn, by1 = by0 + boxHIn;
          if (bxAbs1 > xMinIn && bxAbs0 < xMaxIn && by1 > yMinIn && by0 < yMaxIn) addPlacementHit(fx, b.placement.id);
        });
      }
    });

    setGroupSelectedFixtureIds(hitFixtures);
    setGroupSelectedPlacementIds(hitPlacementIds);
    setGroupSelectedItems(hitItems);
  };
  // fixtures mounted on a pegboard (a shelf physically attached to the peg panel) render inside
  // that panel, not stacked independently in the section's own flow — split them out here so the
  // normal per-fixture stack below only sees the top-level ones, and group the rest by host id so
  // each PegboardPanel can render whatever's attached to it.
  const topLevelFixtures = section.fixtures.filter((f) => !f.mountedOnId);
  const mountedByHost = {};
  section.fixtures.forEach((f) => {
    if (!f.mountedOnId) return;
    (mountedByHost[f.mountedOnId] = mountedByHost[f.mountedOnId] || []).push(f);
  });
  // every gondola physically has SOME backwall, but most sections don't need it modeled as an
  // actual merchandisable fixture — this is a purely cosmetic backdrop for realism. When a real
  // Pegboard fixture IS present, it already shows the peg texture (and is a real drop/mount
  // target), so the cosmetic backdrop stands down rather than competing with it.
  const hasRealPegboard = topLevelFixtures.some((fx) => fixtures.find((f) => f.id === fx.fixtureId)?.type === "Pegboard");
  const backboardStyle = !hasRealPegboard && section.backboardStyle && section.backboardStyle !== "none" ? section.backboardStyle : null;
  return (
    <div className="flex flex-col shrink-0" style={{ width: section.width * scale }}>
      <div className="flex items-center gap-1 mb-1.5 flex-wrap">
        {readOnly ? (
          <span className="text-xs font-bold text-slate-700">{section.name} <span className="font-normal text-slate-400">· {section.width}in</span></span>
        ) : (
          <>
            <input
              value={section.name}
              onChange={(e) => onRename(e.target.value)}
              className="text-xs font-bold text-slate-700 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-400 focus:outline-none w-20"
            />
            <input
              type="number"
              value={section.width}
              onChange={(e) => onResize(Number(e.target.value) || 1)}
              className="text-[10px] font-mono w-12 rounded border border-slate-200 px-1 py-0.5"
              title="Section width (in)"
            />
            <span className="text-[10px] text-slate-400">in</span>
            <select
              value={section.backboardStyle || "none"}
              onChange={(e) => onSetBackboard(e.target.value === "none" ? undefined : e.target.value)}
              className="text-[10px] font-mono rounded border border-slate-200 px-1 py-0.5 bg-white"
              title="Backboard appearance — a cosmetic backdrop for gondola realism; hidden automatically if this section also has a real Pegboard fixture"
            >
              <option value="none">No backdrop</option>
              <option value="pegboard">Pegboard</option>
              <option value="slatwall">Slatwall</option>
              <option value="solid">Solid</option>
            </select>
            <div className="ml-auto flex items-center gap-0.5">
              <button className={btnIcon} disabled={index === 0} onClick={() => onMove(-1)} title="Move left"><ChevronLeft size={14} /></button>
              <button className={btnIcon} disabled={index === total - 1} onClick={() => onMove(1)} title="Move right"><ChevronRight size={14} /></button>
              <button className={btnIcon} onClick={onDelete} title="Delete section"><Trash2 size={13} /></button>
            </div>
          </>
        )}
      </div>

      <div
        onMouseDown={readOnly ? undefined : (e) => { if (e.ctrlKey || e.metaKey) handleRubberDown(e); }}
        onClick={readOnly ? undefined : (e) => { if (groupSelectedFixtureIds.size || groupSelectedPlacementIds.size) { clearGroupSelection(); return; } onDeselectAll(); }}
        onContextMenu={readOnly ? undefined : (e) => e.preventDefault()}
        className="relative border-x border-slate-300 bg-gradient-to-b from-slate-100 to-slate-200"
        style={{ width: section.width * scale, height: heightPx }}
      >
        {/* cosmetic backdrop only — no capacity, no placements, not selectable/draggable, and
            always painted first so the base plate and every fixture naturally draw on top of it */}
        {backboardStyle && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={
              backboardStyle === "pegboard"
                ? {
                    background: "#c2b8a3",
                    backgroundImage: "radial-gradient(circle, #8a7d63 1px, transparent 1.5px)",
                    backgroundSize: `${scale}px ${scale}px`,
                  }
                : backboardStyle === "slatwall"
                ? {
                    background: "#cdc4b0",
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0px, transparent ${3 * scale - 1}px, #9b8f76 ${3 * scale - 1}px, #9b8f76 ${3 * scale}px)`,
                  }
                : { background: "#d9d3c4" }
            }
          />
        )}
        {/* base / kick plate */}
        <div
          className="absolute bottom-0 w-full bg-slate-700/80 flex items-center justify-center"
          style={{ height: planogram.base * scale }}
        >
          {planogram.base * scale > 14 && <span className="text-[8px] text-slate-200">BASE</span>}
        </div>

        {topLevelFixtures.map((fx) => {
          const def = fixtures.find((f) => f.id === fx.fixtureId);
          const maxNotchY = Math.max(0, planogram.dims.h - planogram.base - (def ? def.dims.h : 2));
          if (def?.type === "Pegboard") {
            return (
              <PegboardPanel
                key={fx.id}
                fx={fx}
                fixtureDef={def}
                products={products}
                scale={scale}
                base={planogram.base}
                maxNotchY={maxNotchY}
                selected={selectedFixtureId === fx.id}
                sectionId={section.id}
                readOnly={readOnly}
                capacityWarningsEnabled={capacityWarningsEnabled}
                hideImages={hideImages}
                highlightField={highlightField}
                zoomLevel={zoomLevel}
                onSelectFixture={onSelectFixture}
                selectedFixtureId={selectedFixtureId}
                selectedPlacementId={selectedPlacementId}
                onSelectPlacement={onSelectPlacement}
                onDragCommit={(notchY) => onDragFixture(fx.id, notchY)}
                onDragCommitGroup={(delta) => onDragFixtureGroup(section.id, Array.from(groupSelectedFixtureIds), delta)}
                groupSelected={groupSelectedFixtureIds.has(fx.id)}
                groupSelectedPlacementIds={groupSelectedPlacementIds}
                groupSelectedItems={groupSelectedItems}
                onClearGroupSelection={clearGroupSelection}
                onMoveGroupToFixture={onMoveGroupToFixture}
                onDropProduct={(productId, insertIndex, pegCoords) => onDropProductOnFixture(fx.id, productId, insertIndex, pegCoords)}
                onMovePlacement={onMovePlacement}
                onMoveGroup={onMoveGroup}
                performance={performance}
                cutoffISO={cutoffISO}
                storeId={storeId}
                schema={schema}
                overlaySettings={overlaySettings}
                mountedFixtures={mountedByHost[fx.id] || []}
                fixtures={fixtures}
                onDragMountedFixture={(mountedFxId, notchY) => onDragFixture(mountedFxId, notchY)}
                onDropProductOnMounted={(mountedFxId, productId, insertIndex) => onDropProductOnFixture(mountedFxId, productId, insertIndex)}
              />
            );
          }
          return (
            <FixtureBar
              key={fx.id}
              fx={fx}
              fixtureDef={def}
              products={products}
              scale={scale}
              base={planogram.base}
              maxNotchY={maxNotchY}
              selected={selectedFixtureId === fx.id}
              sectionId={section.id}
              readOnly={readOnly}
              joinedBoxes={joinedLayouts ? joinedLayouts[fx.id] : undefined}
              clearanceIn={getShelfClearanceIn(planogram, section, fx, fixtures)}
              capacityWarningsEnabled={capacityWarningsEnabled}
              hideImages={hideImages}
              highlightField={highlightField}
              zoomLevel={zoomLevel}
              onSelectFixture={onSelectFixture}
              selectedPlacementId={selectedPlacementId}
              onSelectPlacement={onSelectPlacement}
              onDragCommit={(notchY) => onDragFixture(fx.id, notchY)}
              onDragCommitGroup={(delta) => onDragFixtureGroup(section.id, Array.from(groupSelectedFixtureIds), delta)}
              groupSelected={groupSelectedFixtureIds.has(fx.id)}
              groupSelectedPlacementIds={groupSelectedPlacementIds}
              groupSelectedItems={groupSelectedItems}
              onClearGroupSelection={clearGroupSelection}
              onMoveGroupToFixture={onMoveGroupToFixture}
              onDropProduct={(productId, insertIndex) => onDropProductOnFixture(fx.id, productId, insertIndex)}
              onMovePlacement={onMovePlacement}
              performance={performance}
              cutoffISO={cutoffISO}
              storeId={storeId}
              schema={schema}
              overlaySettings={overlaySettings}
              onMountOnPegboard={onMountFixture ? (targetFixtureId, xOffset, notchY) => onMountFixture(section.id, fx.id, targetFixtureId, xOffset, notchY) : undefined}
            />
          );
        })}

        {topLevelFixtures.length === 0 && !readOnly && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-400 italic px-2 text-center">
            Empty section
          </div>
        )}
        {!readOnly && rubberband && (
          <div
            className="absolute border-2 border-blue-500 bg-blue-400/15 pointer-events-none z-40"
            style={{
              left: Math.min(rubberband.x0, rubberband.x1),
              top: Math.min(rubberband.y0, rubberband.y1),
              width: Math.abs(rubberband.x1 - rubberband.x0),
              height: Math.abs(rubberband.y1 - rubberband.y0),
            }}
          />
        )}
      </div>

      {!readOnly && (
        <button
          className="mt-1.5 text-xs text-amber-600 font-medium hover:underline flex items-center gap-1 justify-center"
          onClick={onAddFixture}
        >
          <Plus size={12} /> Add Fixture
        </button>
      )}
    </div>
  );
}

function AddFixturePopover({ fixtures, onAdd, onClose }) {
  const [fixtureId, setFixtureId] = useState(fixtures[0]?.id || "");
  const [notchY, setNotchY] = useState(12);
  const [xOffset, setXOffset] = useState(0);
  if (fixtures.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-lg text-sm text-slate-500">
        No fixtures in your library yet. Create one in the Fixtures tab first.
        <div className="mt-2 text-right"><button className={btnGhost} onClick={onClose}>Close</button></div>
      </div>
    );
  }
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-lg space-y-3 w-72">
      <h4 className="font-bold text-sm text-slate-800">Add Fixture to Section</h4>
      <Field label="Fixture">
        <select className={inputCls} value={fixtureId} onChange={(e) => setFixtureId(e.target.value)}>
          {fixtures.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.dims.w}×{f.dims.h}×{f.dims.d})</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Notch height (in from base)">
          <input type="number" step="1" min="0" className={inputCls} value={notchY} onChange={(e) => setNotchY(Math.round(Number(e.target.value)) || 0)} />
        </Field>
        <Field label="Horizontal offset (in)">
          <input type="number" step="1" min="0" className={inputCls} value={xOffset} onChange={(e) => setXOffset(Math.round(Number(e.target.value)) || 0)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button className={btnGhost} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={() => onAdd({ id: uid("fxi"), fixtureId, notchY, xOffset, placements: [] })}>
          <Plus size={14} /> Add
        </button>
      </div>
    </div>
  );
}

function PlacementInspector({ placement, product, metrics, weeks, onChange, onRemove, onClose, isPegboard, pegboardHeightIn, products, clearanceIn, shelfDepthIn, dosTargetDays }) {
  const [capQuery, setCapQuery] = useState("");
  const stack = product ? getStackDims(product, placement, products || []) : null;
  const clearance = isPegboard ? Infinity : clearanceIn;
  // a change that makes the stack taller than the shelf above allows is refused (the editor also
  // refuses it server-side of the click, in updatePlacement); changes that don't add height always pass
  const canApply = (patch) => {
    if (!product) return true;
    const probe = { ...placement, ...patch };
    const next = getStackDims(product, probe.autoStack ? { ...probe, high: 1 } : probe, products || []); // auto High re-fits itself
    const heightOk = !Number.isFinite(clearance) || next.heightIn <= clearance + 1e-6
      || next.heightIn <= (placement.autoStack ? getStackDims(product, { ...placement, high: 1 }, products || []).heightIn : (stack?.heightIn ?? 0)) + 1e-6;
    const depthOk = !Number.isFinite(shelfDepthIn) || next.stackDepthIn <= shelfDepthIn + 1e-6 || next.stackDepthIn <= (stack?.stackDepthIn ?? 0) + 1e-6;
    return heightOk && depthOk;
  };
  const f1 = (n) => (Math.round(n * 10) / 10).toString();
  const high = stack?.high || 1;
  const deep = stack?.deep || 1;
  const capMode = !placement.cap ? "none" : placement.cap.productId === "" || (placement.cap.productId && placement.cap.productId !== placement.productId) ? "other" : "same";
  const capMatches = capMode === "other" && capQuery.trim()
    ? (products || []).filter((p) => p.id !== placement.productId && String(p.name).toLowerCase().includes(capQuery.trim().toLowerCase())).slice(0, 30)
    : [];
  const stepper = (label, value, patchFor, minV) => (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-600">{label}</span>
      <div className="flex items-center gap-2">
        <button className={btnIcon} disabled={value <= minV} onClick={() => onChange({ ...placement, ...patchFor(value - 1) })}><Minus size={13} /></button>
        <span className="w-8 text-center font-mono text-sm">{value}</span>
        <button
          className={btnIcon + (canApply(patchFor(value + 1)) ? "" : " opacity-40 cursor-not-allowed")}
          disabled={!canApply(patchFor(value + 1))}
          title={canApply(patchFor(value + 1)) ? undefined : "Not enough clearance under the shelf above"}
          onClick={() => onChange({ ...placement, ...patchFor(value + 1) })}
        ><Plus size={13} /></button>
      </div>
    </div>
  );
  const pegLoc = isPegboard && pegboardHeightIn != null
    ? derivePegRowColumn(placement.pegX ?? 0, placement.pegY ?? pegboardHeightIn, pegboardHeightIn)
    : null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3 w-72">
      <div className="flex items-center justify-between">
        <h4 className="font-bold text-sm text-slate-800 truncate">{product?.name || "Unknown product"}</h4>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={15} /></button>
      </div>

      {isPegboard && (
        <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5 space-y-1">
          <div>
            Use the <span className="font-semibold">arrow keys</span> to nudge this peg one hole at a time (hold Shift to move 5 holes at once).
          </div>
          {pegLoc && (
            <div className="font-semibold text-slate-700">
              Install peg at Row {pegLoc.row}, Column {pegLoc.column}
            </div>
          )}
        </div>
      )}

      {metrics ? (
        <div className="bg-slate-50 border border-slate-200 rounded-md p-2.5 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-slate-600 mb-1.5"><TrendingUp size={12} /> Last {weeks} weeks</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-slate-700">
            <span>Total Revenue</span><span className="text-right">{money0(metrics.totalSales)}</span>
            <span>COGS</span><span className="text-right">{money0(metrics.totalCost)}</span>
            <span>Total Gross Profit</span><span className="text-right">{money0(metrics.grossProfit)}</span>
            <span>Profit Per Unit</span><span className="text-right">{money(metrics.unitProfit)}</span>
            <span>Gross Margin %</span><span className="text-right">{metrics.grossMarginPct.toFixed(1)}%</span>
            <span className="pt-1 border-t border-slate-200 mt-1">Units/wk</span><span className="text-right pt-1 border-t border-slate-200 mt-1">{metrics.avgWeeklyUnits.toFixed(1)}</span>
            <span>$/facing/wk</span><span className="text-right">{money((metrics.totalSales / metrics.weeksOfData) / (placement.facings || 1))}</span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-400 italic">No performance data loaded for this product.</div>
      )}

      <div>
        <label className={labelCls}>Merchandising Style</label>
        <select
          className={inputCls}
          value={placement.merchStyle || "unit"}
          onChange={(e) => onChange({ ...placement, merchStyle: e.target.value })}
        >
          <option value="unit">Unit</option>
          {MERCH_STYLE_DEFS.filter((s) => product?.merchStyles?.[s.id]).map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        {placement.merchStyle && placement.merchStyle !== "unit" && !product?.merchStyles?.[placement.merchStyle] && (
          <p className="text-[10px] text-amber-600 mt-1">This style isn't defined for this product anymore — using Unit dimensions instead.</p>
        )}
      </div>

      <div>
        <label className={labelCls}>Orientation</label>
        <div className="grid grid-cols-3 gap-1.5">
          {ORIENTATIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => onChange({ ...placement, orientation: o.id })}
              className={`text-xs rounded-md py-1.5 border ${placement.orientation === o.id ? "bg-amber-500 border-amber-500 text-slate-900 font-semibold" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={labelCls}>Rotation</label>
        <div className="grid grid-cols-4 gap-1.5">
          {ROTATIONS.map((r) => (
            <button
              key={r}
              onClick={() => onChange({ ...placement, rotation: r })}
              className={`text-xs rounded-md py-1.5 border flex items-center justify-center gap-1 ${(placement.rotation || 0) === r ? "bg-amber-500 border-amber-500 text-slate-900 font-semibold" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              <RotateCw size={11} /> {r}°
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className={labelCls}>Facings</label>
        <div className="space-y-1.5">
          {stepper("Wide", placement.facings || 1, (n) => ({ facings: n }), 1)}
          {!isPegboard && (placement.autoStack ? (
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-600">High</span>
              <span className="text-xs font-mono text-slate-700">{high} <span className="text-slate-400 font-sans">(auto)</span></span>
            </div>
          ) : stepper("High", high, (n) => ({ high: n > 1 ? n : undefined }), 1))}
          {!isPegboard && stepper("Deep", deep, (n) => ({ deep: n > 1 ? n : undefined }), 1)}
        </div>
        {!isPegboard && (
          <label className="flex items-center gap-2 mt-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={!!placement.autoStack}
              onChange={(e) => {
                if (e.target.checked) onChange({ ...placement, autoStack: true });
                else { const { autoStack, ...rest } = placement; onChange(rest); }
              }}
            />
            Stack automatically to the available height
          </label>
        )}
        {!isPegboard && stack && (
          <p className="text-[10px] text-slate-500 mt-1.5">
            {stack.units} unit{stack.units !== 1 ? "s" : ""} ({stack.wide} wide × {high} high × {deep} deep{stack.cap ? ` + ${stack.capUnits} capped` : ""}) · stack {f1(stack.heightIn)}in tall
            {Number.isFinite(clearance) ? ` of ${f1(clearance)}in clearance` : ""} · {f1(stack.stackDepthIn)}in back
            {Number.isFinite(shelfDepthIn) ? ` of ${f1(shelfDepthIn)}in shelf depth` : ""}
          </p>
        )}
        {!isPegboard && stack && Number.isFinite(clearance) && stack.heightIn > clearance + 1e-6 && (
          <p className="text-[10px] text-red-600 mt-1">{getStackHeightProblem(product, placement, products || [], clearance)} Reduce the stack to clear this.</p>
        )}
        {!isPegboard && stack && getStackDepthProblem(product, placement, products || [], shelfDepthIn) && (
          <p className="text-[10px] text-red-600 mt-1">{getStackDepthProblem(product, placement, products || [], shelfDepthIn)} Reduce Deep to clear this.</p>
        )}
      </div>

      {!isPegboard && (
        <div>
          <label className={labelCls}>Capping</label>
          <select
            className={inputCls}
            value={capMode}
            onChange={(e) => {
              const mode = e.target.value;
              if (mode === "none") { const { cap, ...rest } = placement; onChange(rest); return; }
              setCapQuery("");
              // productId "" = "different product, none chosen yet" (draws nothing until one is picked)
              const cap = { productId: mode === "same" ? null : "", count: Math.max(1, placement.cap?.count || 1), ...(placement.cap?.orientation ? { orientation: placement.cap.orientation } : {}) };
              if (canApply({ cap })) onChange({ ...placement, cap });
            }}
          >
            <option value="none">No capping</option>
            <option value="same">Same product on top</option>
            <option value="other">Different product on top</option>
          </select>
          {capMode === "other" && (
            <div className="mt-1.5 space-y-1.5">
              {placement.cap?.productId && placement.cap.productId !== placement.productId ? (
                <div className="flex items-center justify-between text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md px-2 py-1">
                  <span className="truncate">{(products || []).find((p) => p.id === placement.cap.productId)?.name || "Unknown product"}</span>
                  <button className="text-slate-400 hover:text-slate-600" onClick={() => onChange({ ...placement, cap: { productId: "", count: placement.cap.count } })}><X size={12} /></button>
                </div>
              ) : null}
              <input className={inputCls} placeholder="Search products to cap with…" value={capQuery} onChange={(e) => setCapQuery(e.target.value)} />
              {capMatches.length > 0 && (
                <select
                  className={inputCls}
                  size={Math.min(6, capMatches.length)}
                  onChange={(e) => {
                    const cap = { productId: e.target.value, count: Math.max(1, placement.cap?.count || 1) };
                    if (canApply({ cap })) { onChange({ ...placement, cap }); setCapQuery(""); }
                  }}
                >
                  {capMatches.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
          )}
          {placement.cap && (capMode === "same" || (placement.cap.productId && placement.cap.productId !== placement.productId)) && (
            <div className="mt-1.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-600">Cap facing</span>
                <select
                  className={inputCls + " !w-auto"}
                  value={placement.cap.orientation || "front"}
                  onChange={(e) => { const cap = { ...placement.cap, orientation: e.target.value }; if (canApply({ cap })) onChange({ ...placement, cap }); }}
                >
                  {ORIENTATIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </div>
              {stepper("Cap units high", placement.cap.count || 1, (n) => ({ cap: { ...placement.cap, count: n } }), 1)}
            </div>
          )}
        </div>
      )}

      {!isPegboard && stack && (() => {
        // what this placement holds against what it sells: capacity, days of supply, and the case pack
        const dos = metrics ? getDaysOfSupply(stack.units, metrics.avgWeeklyUnits) : null;
        const fill = getCasePackFill(stack.units, product?.casePack);
        if (dos === null && !fill && !dosTargetDays) return null;
        const status = dos === null || !dosTargetDays ? "text-slate-700" : dos < dosTargetDays ? "text-red-600" : dos > dosTargetDays * DOS_EXCESS_FACTOR ? "text-amber-600" : "text-emerald-600";
        return (
          <div className="bg-slate-50 border border-slate-200 rounded-md p-2.5 text-xs">
            <div className="font-semibold text-slate-600 mb-1.5">Supply (this placement)</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-slate-700">
              <span>On shelf</span><span className="text-right">{stack.units} units</span>
              {dos !== null && (<><span>Days of supply</span><span className={"text-right font-semibold " + status}>{f1(dos)}{dosTargetDays ? ` / ${dosTargetDays}` : ""}</span></>)}
              {fill && (<><span>Case pack</span><span className="text-right">{fill.casePack}</span></>)}
              {fill && (<><span>Pack-out</span><span className="text-right">{Math.round(fill.cases * 100) / 100} case{fill.cases === 1 ? "" : "s"}</span></>)}
            </div>
            {fill && !fill.exact && (
              <p className="text-[10px] text-red-600 mt-1.5">
                {fill.units < fill.casePack
                  ? `Less than one case (${fill.casePack}): a full-case delivery will not fit on this shelf and ends up in the back room.`
                  : `Not a case or half-case pack-out (${fill.step}-unit steps): a delivery leaves overage with nowhere to go but the back room.`}
              </p>
            )}
            {dos !== null && dosTargetDays && dos < dosTargetDays && <p className="text-[10px] text-red-600 mt-1.5">Below the {dosTargetDays}-day target at the current sales rate.</p>}
          </div>
        );
      })()}

      <button className={btnDanger + " w-full justify-center"} onClick={onRemove}><Trash2 size={13} /> Remove from fixture</button>
    </div>
  );
}

// Double-click a product in the library: everything about it in one place: details, how it sells, and where and
// how it sits on this planogram (stack, units, days of supply, pack-out).
function ProductSummaryModal({ product, schema, planogram, products, fixtures, performance, cutoffISO, storeId, dosTargets, weeks, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const m = aggregateProductPerformance(product.id, performance, cutoffISO, storeId);
  const where = [];
  (planogram.sections || []).forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    if (pl.productId !== product.id) return;
    const def = fixtures.find((f) => f.id === fx.fixtureId);
    where.push({ sec, fx, def, pl, st: getStackDims(product, pl, products) });
  })));
  const units = where.reduce((s, w) => s + w.st.units, 0);
  const dos = m ? getDaysOfSupply(units, m.avgWeeklyUnits) : null;
  const target = getDosTargetDays(planogram.category || "", dosTargets, product);
  const fill = getCasePackFill(units, product.casePack);
  const f1 = (n) => (Math.round(n * 10) / 10).toString();
  const attrs = (schema || []).map((f) => [f.label, product.attributes?.[f.id]]).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "");
  const img = product.images?.front;
  const Row = ({ k, v }) => (<><span className="text-slate-500">{k}</span><span className="text-right font-mono text-slate-800">{v}</span></>);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6 no-print" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-4 p-5 border-b border-slate-200">
          <div className="w-20 h-20 rounded border border-slate-200 bg-white flex items-center justify-center overflow-hidden shrink-0">
            {img ? <img src={img} alt={product.name} className="max-h-full max-w-full object-contain" /> : <div className="w-12 h-12 rounded" style={{ background: hashColor(product.name) }} />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold text-lg text-slate-800">{product.name}</h3>
            <p className="text-xs text-slate-500 font-mono">{product.sku ? `SKU ${product.sku} · ` : ""}{product.dims.w} × {product.dims.h} × {product.dims.d} in (W × H × D)</p>
            {product.resetProtected && <span className="inline-block mt-1 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-sky-50 text-sky-700 border border-sky-200">Core / Must-Carry</span>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="grid md:grid-cols-2 gap-5 p-5 text-sm">
          <div className="space-y-4">
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Product</h4>
              {attrs.length === 0 ? <p className="text-xs text-slate-400 italic">No attributes filled in.</p> : (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">{attrs.map(([k, v]) => <Row key={k} k={k} v={String(v)} />)}</div>
              )}
            </div>
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Supply</h4>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <Row k="Case pack" v={product.casePack ? `${product.casePack} units` : "not set"} />
                <Row k="Days-of-supply target" v={target ? `${target} days${product.dosTargetDays ? " (product)" : ""}` : "not set"} />
                <Row k="Squeeze / overhang" v={`${Math.round((product.squeezeFactor ?? 1) * 100)}% / ${product.overhangIn || 0}in`} />
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Performance, last {weeks} weeks</h4>
              {m ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <Row k="Revenue" v={money0(m.totalSales)} /><Row k="Gross profit" v={money0(m.grossProfit)} />
                  <Row k="Margin" v={`${m.grossMarginPct.toFixed(1)}%`} /><Row k="Units / week" v={f1(m.avgWeeklyUnits)} />
                </div>
              ) : <p className="text-xs text-slate-400 italic">No performance data loaded for this product.</p>}
            </div>
            <div>
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">On this planogram</h4>
              {where.length === 0 ? <p className="text-xs text-slate-400 italic">Not placed on this planogram.</p> : (
                <>
                  <div className="space-y-1.5 mb-2">
                    {where.map((w) => (
                      <div key={w.pl.id} className="text-xs bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5">
                        <div className="font-semibold text-slate-700">{w.sec.name} · {w.def?.name || "Fixture"}{w.def?.type === "Pegboard" ? "" : ` (${w.fx.notchY}in)`}</div>
                        <div className="text-slate-500">{describeStack(product, w.pl, products)}{w.pl.autoStack ? " · auto-stack" : ""}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <Row k="Units on shelf" v={units} />
                    {dos !== null && <Row k="Days of supply" v={`${f1(dos)}${target ? ` / ${target}` : ""}`} />}
                    {fill && <Row k="Pack-out" v={`${Math.round(fill.cases * 100) / 100} case${fill.cases === 1 ? "" : "s"}${fill.exact ? "" : " (not case / half-case)"}`} />}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductLibraryPanel({ products, schema, selectedId, placedCounts, onSelect, onOpenSummary }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const filtered = products.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  const thumbRefs = useRef({});
  const rowRefs = useRef({});

  // keep the selected product visible: clear a search that hides it, then scroll its row into view
  useEffect(() => {
    if (!selectedId) return;
    const p = products.find((x) => x.id === selectedId);
    if (p && query && !p.name.toLowerCase().includes(query.toLowerCase())) { setQuery(""); return; }
    rowRefs.current[selectedId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId, query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`shrink-0 bg-white border border-slate-200 rounded-lg p-3 h-fit sticky top-4 flex flex-col transition-all ${expanded ? "w-80 max-h-[85vh]" : "w-56 max-h-[75vh]"}`}>
      <div className="flex items-center justify-between mb-1">
        <h4 className="font-bold text-sm text-slate-800 flex items-center gap-1.5"><Package size={14} /> Product Library</h4>
        <button className="text-slate-400 hover:text-slate-600" onClick={() => setExpanded((e) => !e)} title={expanded ? "Collapse panel" : "Expand panel"}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      <p className="text-[11px] text-slate-400 mb-2">Drag a product onto a shelf to merchandise it. Click one to find it on the planogram; double-click for its summary.</p>
      <input
        className={inputCls + " mb-2 text-xs"}
        placeholder="Search products…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="space-y-1.5 overflow-y-auto pr-1">
        {products.length === 0 && (
          <p className="text-xs text-slate-400 italic">No products yet — add some in the Products tab.</p>
        )}
        {products.length > 0 && filtered.length === 0 && (
          <p className="text-xs text-slate-400 italic">No matches.</p>
        )}
        {filtered.map((p) => {
          const size = getAttrByLabel(p, schema, ["size"]);
          const uom = getAttrByLabel(p, schema, ["unit of measure", "uom"]);
          const tag = [size, uom].filter(Boolean).join(" ");
          return (
            <div
              key={p.id}
              ref={(el) => (rowRefs.current[p.id] = el)}
              onClick={(e) => { if (e.detail <= 1) onSelect && onSelect(p.id); }}
              onDoubleClick={() => onOpenSummary && onOpenSummary(p.id)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "product", productId: p.id }));
                e.dataTransfer.effectAllowed = "move";
                // use just the small thumbnail as the drag ghost — the whole card (with name/text)
                // renders far larger than the product actually is on the shelf. Anchor the ghost
                // at its top-left corner (not centered on the cursor) — pegboard placement relies
                // on the cursor position directly representing the product's top-left corner, so
                // wherever within the thumbnail this was grabbed must not shift that. Never let
                // this fail the drag.
                try {
                  const thumb = thumbRefs.current[p.id];
                  if (thumb) e.dataTransfer.setDragImage(thumb, 0, 0);
                } catch (err) {}
              }}
              className={`flex items-center gap-2 border rounded-md px-2 py-1.5 cursor-grab active:cursor-grabbing ${selectedId === p.id ? "border-sky-400 bg-sky-50 ring-1 ring-sky-300" : "border-slate-200 bg-slate-50 hover:bg-amber-50 hover:border-amber-300"}`}
              title="Click to find it on the planogram · double-click for details · drag onto a shelf"
            >
              <div
                ref={(el) => (thumbRefs.current[p.id] = el)}
                className={`rounded bg-white border border-slate-200 flex items-center justify-center overflow-hidden shrink-0 ${expanded ? "w-10 h-10" : "w-8 h-8"}`}
              >
                {p.images?.front ? (
                  <img src={p.images.front} className="max-h-full max-w-full object-contain" />
                ) : (
                  <div className="w-5 h-5 rounded" style={{ background: hashColor(p.name) }} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-slate-700 truncate">{p.name}</div>
                <div className="text-[10px] text-slate-400 font-mono">{tag || "—"}</div>
              </div>
              {placedCounts && placedCounts[p.id] > 0 && (
                <span className="shrink-0 text-[10px] font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5" title={`On this planogram in ${placedCounts[p.id]} place${placedCounts[p.id] === 1 ? "" : "s"}`}>{placedCounts[p.id]}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OverlaySettingsPanel({ settings, schema, onChange, onClose }) {
  const toggleInList = (listKey, value) => {
    const current = settings[listKey] || [];
    onChange({ [listKey]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] });
  };

  return (
    <div className="absolute z-30 top-full left-0 mt-1 w-80 bg-white border border-slate-200 rounded-lg shadow-lg p-3 space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h5 className="font-bold text-xs text-slate-700">Product Overlay</h5>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
      </div>

      <div>
        <label className={labelCls}>When to show</label>
        <div className="grid grid-cols-3 gap-1.5">
          <button onClick={() => onChange({ mode: "off" })} className={`text-[11px] rounded-md py-1.5 border font-medium ${settings.mode === "off" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>Off</button>
          <button onClick={() => onChange({ mode: "always" })} className={`text-[11px] rounded-md py-1.5 border font-medium ${settings.mode === "always" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>Over image</button>
          <button onClick={() => onChange({ mode: "noImageOnly" })} className={`text-[11px] rounded-md py-1.5 border font-medium ${settings.mode === "noImageOnly" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>No-image only</button>
        </div>
      </div>

      <div>
        <label className={labelCls}>Metrics to show</label>
        <div className="grid grid-cols-2 gap-1">
          {METRIC_FIELDS.map((m) => (
            <label key={m.id} className="flex items-center gap-1.5 text-xs text-slate-700">
              <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={(settings.metrics || []).includes(m.id)} onChange={() => toggleInList("metrics", m.id)} />
              {m.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className={labelCls}>Product details to show</label>
        <div className="grid grid-cols-2 gap-1 max-h-28 overflow-y-auto pr-1">
          <label className="flex items-center gap-1.5 text-xs text-slate-700">
            <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={(settings.details || []).includes("name")} onChange={() => toggleInList("details", "name")} />
            Name
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-700">
            <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={(settings.details || []).includes("sku")} onChange={() => toggleInList("details", "sku")} />
            SKU
          </label>
          {(schema || []).map((f) => (
            <label key={f.id} className="flex items-center gap-1.5 text-xs text-slate-700">
              <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={(settings.details || []).includes(f.id)} onChange={() => toggleInList("details", f.id)} />
              {f.label}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Layout">
          <select className={inputCls} value={settings.layout} onChange={(e) => onChange({ layout: e.target.value })}>
            <option value="compact">Compact tag</option>
            <option value="detailed">Detailed panel</option>
          </select>
        </Field>
        <Field label="Position">
          <select className={inputCls} value={settings.position} onChange={(e) => onChange({ position: e.target.value })}>
            <option value="top">Top</option>
            <option value="center">Center</option>
            <option value="bottom">Bottom</option>
          </select>
        </Field>
      </div>

      <div className="border-t border-slate-100 pt-2.5 space-y-1.5">
        <label className="flex items-center gap-1.5 text-xs text-slate-700">
          <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={settings.showLabels !== false} onChange={(e) => onChange({ showLabels: e.target.checked })} />
          Show labels (e.g. "Profit Per Unit: $1.24" vs. just "$1.24")
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-700">
          <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={!!settings.wrapText} onChange={(e) => onChange({ wrapText: e.target.checked })} />
          Wrap text instead of truncating (uses more vertical space)
        </label>
        <p className="text-[11px] text-slate-400">If values are getting cut off in narrow shelves, turn off labels and/or turn on wrap.</p>
      </div>
    </div>
  );
}

// lets the planner color-code every facing on the shelf by a chosen attribute (brand, category,
// size, manufacturer, or any other configured field) to visually audit merchandising groupings
function HighlightByPanel({ schema, value, onChange, onClose, products, planogram }) {
  const categoricalFields = schema.filter((f) => f.type === "text" || f.type === "select" || f.type === "boolean");

  const placedProductIds = Array.from(new Set(
    planogram.sections.flatMap((s) => s.fixtures.flatMap((f) => f.placements.map((p) => p.productId)))
  ));
  const placedProducts = placedProductIds.map((id) => products.find((p) => p.id === id)).filter(Boolean);

  const legendEntries = value
    ? Array.from(new Set(placedProducts.map((p) => String(p.attributes?.[value] ?? "").trim()).filter(Boolean)))
        .sort()
        .map((v) => ({ value: v, color: hashColor(v) }))
    : [];

  return (
    <div className="absolute z-30 top-full right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg p-3 space-y-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h5 className="font-bold text-xs text-slate-700">Highlight By Attribute</h5>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
      </div>
      <p className="text-[11px] text-slate-400">Color-codes every facing by this field so you can spot merchandising groupings at a glance.</p>
      <select className={inputCls} value={value || ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">None</option>
        {categoricalFields.length === 0 && <option value="" disabled>No text/select/boolean fields configured</option>}
        {categoricalFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
      {value && (
        legendEntries.length === 0 ? (
          <p className="text-[11px] text-slate-400 italic">No products currently on this planogram have a value set for this field.</p>
        ) : (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {legendEntries.map((entry) => (
              <div key={entry.value} className="flex items-center gap-2 text-xs text-slate-600">
                <span className="w-3 h-3 rounded-sm shrink-0 border border-black/10" style={{ background: entry.color }} />
                <span className="truncate">{entry.value}</span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// Planogram Lifecycle control — the version-control workflow for a planogram: WIP → Approved
// (manual, once merchandising is done) → Pending (auto, 3 weeks before the event date, so stores
// can start marking down items being removed) → Live (auto, exactly on the event date) →
// Historical. This is the surface a space planner uses to move a planogram from initial build
// through store execution, and it's the data the future store-associate module will read to
// know what layout is currently in force — and, via publishedAt, what's been sent to stores.
function PlanogramLifecycleBar({ planogram, onUpdate, onMakeLive }) {
  const rawStatus = planogram.status || "wip";
  const status = effectivePlanogramStatus(planogram); // what's actually in force right now
  const setStatus = (next) => onUpdate({ ...planogram, status: next });
  const publishNow = () => onUpdate({ ...planogram, status: "pending", publishedAt: planogram.publishedAt || new Date().toISOString() });

  return (
    <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-lg p-3 mb-4 no-print">
      <span className="text-xs font-semibold text-slate-500">Lifecycle:</span>
      <PlanogramStatusBadge status={status} />

      {status === "wip" && (
        <>
          <span className="text-[11px] text-slate-400 max-w-[260px]">Merchandise this planogram, then approve it once it's ready for store execution.</span>
          <button className={btnPrimary} onClick={() => setStatus("approved")}><Check size={13} /> Approve</button>
        </>
      )}

      {rawStatus === "approved" && status !== "pending" && status !== "live" && (
        <>
          <span className="text-[11px] text-slate-400 max-w-[260px]">
            {planogram.eventDate
              ? `Publishes to Pending automatically on ${addDaysISO(planogram.eventDate, -PENDING_LEAD_DAYS)} (3 weeks before the ${planogram.eventDate} event), and store assistant is notified.`
              : "Set an Event Date above to schedule the automatic publish, or publish it manually now."}
          </span>
          <button className={btnGhost} onClick={publishNow}>Publish to Pending Now</button>
        </>
      )}

      {status === "pending" && (
        <>
          {planogram.publishedAt && (
            <span className="text-[11px] text-slate-400">Published to store assistant {new Date(planogram.publishedAt).toLocaleDateString()}</span>
          )}
          <span className="text-[11px] text-slate-400">
            {planogram.eventDate ? `Goes live automatically on ${planogram.eventDate}` : "Set an Event Date to schedule going live"}
          </span>
          <button className={btnGhost} onClick={() => onMakeLive(planogram)}>Make Live Now</button>
        </>
      )}

      {status === "live" && rawStatus === "pending" && (
        <span className="text-[11px] text-emerald-600">Automatically activated on {planogram.eventDate}</span>
      )}

      {status === "live" && (
        <button className={btnGhost} onClick={() => setStatus("historical")}><Trash2 size={13} /> Retire (Mark Historical)</button>
      )}

      {status === "historical" && (
        <button className={btnGhost} onClick={() => setStatus("approved")}>Reactivate as Approved</button>
      )}

      {status !== "wip" && (
        <button className="text-xs text-slate-400 hover:underline ml-auto" onClick={() => setStatus("wip")}>Revert to WIP</button>
      )}
    </div>
  );
}

// Planogram Versioning control — shows every member of this planogram's version family (the
// original master plus every copy made from it), each labeled with its own status, and lets the
// planner jump between them or spin off a brand new version. A new version always links back to
// the family's ORIGINAL master, never to whichever version it was copied from, so the family
// stays a flat group rather than a chain.
// Surfaces open issues store teams have reported for this specific planogram (via Store
// Assistant), with a way to resolve them. Renders nothing when there's nothing open, so it
// doesn't add clutter to planograms nobody has flagged a problem with.
function PlanogramIssuesBar({ planogram, onResolveIssue }) {
  const openIssues = (planogram.issues || []).filter((i) => i.status === "open");
  if (openIssues.length === 0) return null;
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 no-print">
      <div className="text-xs font-semibold text-red-700 flex items-center gap-1.5 mb-2">
        <AlertTriangle size={13} /> {openIssues.length} open feedback item{openIssues.length !== 1 ? "s" : ""} from stores
      </div>
      <div className="space-y-1.5">
        {openIssues.map((i) => (
          <div key={i.id} className="flex items-start justify-between gap-2 text-xs bg-white border border-red-100 rounded px-2 py-1.5">
            <div>
              <span className="font-semibold text-slate-700">{i.storeName}</span>
              {i.type && <span className="text-slate-400"> · {ISSUE_TYPES.find((t) => t.id === i.type)?.label || i.type}</span>}
              <span className="text-slate-500"> — {i.message}</span>
            </div>
            <button className="text-red-500 hover:underline shrink-0" onClick={() => onResolveIssue(planogram.id, i.id)}>Resolve</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Bundled review of an AI-drafted reset: every proposed change, grouped by kind, each with its
// one-sentence reason. Phase 1 review is all-or-nothing (accept the whole draft or discard it) —
// per-change accept/reject is a later phase. "Keep as WIP" just marks the draft reviewed so this
// panel stops intercepting the editor; the planogram is already an ordinary WIP version at that
// point and goes through the normal Approve → Pending → Live path from there.
// Draft Score bands, matching the design doc's review guidance: a high score needs only a
// spot-check, a mid score means something was skipped and worth a look, a low score means the
// agent mostly couldn't finish the job on its own.
function resetDraftScoreBand(score) {
  if (score >= 95) return { label: "Spot-check", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  if (score >= 80) return { label: "Review skipped items", cls: "bg-amber-50 text-amber-700 border-amber-200" };
  return { label: "Review in full", cls: "bg-red-50 text-red-700 border-red-200" };
}

// The review queue: every AI draft still waiting on a person, lowest Draft Score first, so the
// planograms that most needed a human to finish the job float to the top of a bulk run.
// Two kinds of entry:
//  - a pending Proposal from the Reset Drafting Agent (the normal case since Phase 4): nothing
//    exists yet but the proposal; approving it is what creates the new WIP version;
//  - an older draft that already exists as a WIP version carrying `resetDraft` (made before
//    Phase 4). Those still open the in-place review. If the proposals couldn't be loaded, or one
//    was already decided elsewhere, drafts follow the Proposal's status when there is one, and
//    are never hidden just because the proposals table couldn't be read.
function buildResetDraftQueue(planograms, proposals) {
  const pendingRows = proposals.rows || [];
  const pendingById = Object.fromEntries(pendingRows.map((r) => [r.id, r]));
  const drafts = planograms
    .filter((p) => p.resetDraft && !p.resetDraft.reviewed)
    .filter((p) => !(p.resetDraft.proposalId && proposals.loaded && !pendingById[p.resetDraft.proposalId]))
    .map((p) => {
      const proposal = pendingById[p.resetDraft.proposalId];
      return { kind: "draft", planogram: p, proposal, score: proposal?.score ?? p.resetDraft.score ?? 100 };
    });
  const linked = new Set(planograms.map((p) => p.resetDraft?.proposalId).filter(Boolean));
  const fresh = pendingRows
    .filter((r) => (r.agent_id === "reset-drafting-agent" || r.agent_id === "assortment-agent") && r.target_type === "planogram_version" && !linked.has(r.id))
    .map((r) => ({ kind: "proposal", planogram: planograms.find((p) => p.id === r.target_id), proposal: r, score: r.score ?? 100 }))
    .filter((item) => item.planogram); // its source planogram was deleted: nothing left to review against
  return [...drafts, ...fresh].sort((a, b) => a.score - b.score);
}

function ResetDraftQueue({ planograms, proposals, profileNames, currentUserId, onOpenDraft, onOpenProposal }) {
  const all = buildResetDraftQueue(planograms, proposals);
  const [scope, setScope] = useState("mine"); // "mine" | "all"
  // Collapsed by default so a long queue never pushes the planogram list down; the choice is remembered per browser.
  const [open, setOpen] = useState(() => { try { return window.localStorage.getItem("tandom:draftQueueOpen") === "1"; } catch (e) { return false; } });
  const toggleOpen = () => setOpen((v) => { const n = !v; try { window.localStorage.setItem("tandom:draftQueueOpen", n ? "1" : "0"); } catch (e) { /* ignore */ } return n; });
  // Mine = drafts I asked for. Older in-place drafts carry no requester, so they only show under All.
  const isMine = (item) => !!currentUserId && item.proposal?.requested_by === currentUserId;
  const mine = all.filter(isMine);
  const pending = scope === "mine" ? mine : all;

  if (all.length === 0) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 mb-4">
      <button onClick={toggleOpen} className="w-full flex items-center gap-2 text-left">
        <Sparkles size={15} className="text-blue-900" />
        <span className="text-sm font-semibold text-blue-900">AI Draft Review Queue</span>
        <span className="text-xs text-blue-700">{mine.length} mine · {all.length} total</span>
        <span className="ml-auto text-blue-700">{open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
      </button>
      {open && <div className="mt-2">
      <div className="flex gap-1 mb-2">
        {[["mine", `My drafts (${mine.length})`], ["all", `All drafts (${all.length})`]].map(([id, label]) => (
          <button key={id} onClick={() => setScope(id)} className={`text-xs font-semibold rounded-full px-3 py-1 border ${scope === id ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-700 border-blue-200 hover:bg-blue-100"}`}>{label}</button>
        ))}
      </div>
      <p className="text-xs text-blue-700 mb-3">Sorted lowest score first — these are the drafts that most needed a human to finish the job.</p>
      {pending.length === 0 && <p className="text-xs text-blue-700 italic bg-white rounded-md border border-blue-100 px-3 py-3">{scope === "mine" ? "You haven't drafted anything awaiting review. Switch to All drafts to see your teammates'." : "Nothing is waiting for review."}</p>}
      <div className="divide-y divide-blue-100 bg-white rounded-md border border-blue-100 max-h-64 overflow-y-auto">
        {pending.map(({ kind, planogram: p, proposal, score }) => {
          const band = resetDraftScoreBand(score);
          const requester = proposal?.requested_by ? profileNames[proposal.requested_by] : null;
          const summary = kind === "draft"
            ? `${(p.resetDraft.changes || []).length} changes, ${(p.resetDraft.skipped || []).length} skipped`
            : (proposal.reason || "").replace(/ from the last .*$/, "").replace(/\.$/, "");
          return (
            <button key={proposal?.id || p.id} onClick={() => (kind === "proposal" ? onOpenProposal(proposal.id) : onOpenDraft(p.id))} className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-50">
              <span className={`text-xs font-bold rounded-full px-2 py-0.5 border shrink-0 ${band.cls}`}>{score}%</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-slate-800 truncate">{p.name}</span>
                {proposal && <span className="block text-[10px] text-slate-400 truncate">{requester ? `Requested by ${requester} · ` : ""}{new Date(proposal.created_at).toLocaleString()}</span>}
              </span>
              {p.category && <span className="text-[10px] text-slate-400 shrink-0">{p.category}</span>}
              <span className="text-[10px] text-slate-400 shrink-0">{summary}</span>
              <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 border shrink-0 ${band.cls}`}>{band.label}</span>
            </button>
          );
        })}
      </div>
      </div>}
    </div>
  );
}

// Reviews a pending Proposal before anything exists: shows what the agent wants to change and
// why, and Approve is what has the apply-proposal function create the new WIP version. Rejecting
// just records the decision. Reuses the same review layout as the older in-place drafts.
function ProposalReview({ proposalId, planograms, onBack, onApprove, onReject }) {
  const [state, setState] = useState({ status: "loading" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    loadProposal(proposalId).then((r) => { if (alive) setState(r.ok ? { status: "ready", proposal: r.row } : { status: "error", message: r.error }); });
    return () => { alive = false; };
  }, [proposalId]);

  const run = async (action, proposal) => {
    setBusy(true);
    try { await action(proposal); } finally { setBusy(false); }
  };

  if (state.status === "loading") return <p className="text-sm text-slate-400">Loading the proposal…</p>;
  if (state.status === "error" || state.proposal.status !== "pending") {
    return (
      <div className="max-w-3xl mx-auto">
        <button className={btnGhost + " mb-3"} onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <p className="text-sm text-slate-600">{state.status === "error" ? state.message : `This proposal was already ${state.proposal.status}.`}</p>
      </div>
    );
  }
  const { proposal } = state;
  const source = planograms.find((p) => p.id === proposal.target_id);
  return (
    <ResetDraftReviewPanel
      planogram={{ name: source?.name || "(planogram deleted)", resetDraft: proposal.proposed_change }}
      approveLabel="Approve — create WIP version"
      discardLabel="Reject"
      busy={busy}
      onBack={onBack}
      onApprove={() => run(onApprove, proposal)}
      onDiscard={() => run(onReject, proposal)}
    />
  );
}

function ResetDraftReviewPanel({ planogram, onApprove, onDiscard, onBack, approveLabel, discardLabel, busy }) {
  const draft = planogram.resetDraft || {};
  const changes = draft.changes || [];
  const skipped = draft.skipped || [];
  const reduced = changes.filter((c) => c.type === "reduceFacings" || c.type === "reduceHigh");
  const increased = changes.filter((c) => c.type === "increaseFacings" || c.type === "increaseHigh");
  const deleted = changes.filter((c) => c.type === "delete");
  const added = changes.filter((c) => c.type === "addProduct");
  const deepSet = changes.filter((c) => c.type === "setDeep");
  const notes = draft.notes || [];

  const Group = ({ title, icon: Icon, colorCls, items }) => {
    if (items.length === 0) return null;
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        <h3 className={`text-sm font-semibold flex items-center gap-1.5 mb-2 ${colorCls}`}><Icon size={15} /> {title} ({items.length})</h3>
        <div className="divide-y divide-slate-100">
          {items.map((c, i) => (
            <div key={i} className="py-2 text-sm">
              <div className="font-medium text-slate-800">{c.productName}</div>
              <div className="text-xs text-slate-500">{c.reason}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <button className={btnGhost} onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-1.5"><Sparkles size={17} className="text-amber-500" /> AI Draft Review — {planogram.name}</h2>
      </div>
      <p className="text-sm text-slate-600 mb-4">
        Drafted from the last {draft.lookbackWeeks} weeks of performance ({draft.startISO} to {draft.endISO}). {changes.length} change{changes.length === 1 ? "" : "s"} proposed{skipped.length ? `, ${skipped.length} item${skipped.length === 1 ? "" : "s"} skipped` : ""}.
      </p>
      {changes.length === 0 && (
        <p className="text-sm text-slate-500 mb-4">No changes met the thresholds for this window — nothing was proposed.</p>
      )}
      <Group title="Missing-Winner Additions" icon={Sparkles} colorCls="text-blue-700" items={added} />
      <Group title="Facing Reductions" icon={Minus} colorCls="text-amber-700" items={reduced} />
      <Group title="Facing / Stack Increases" icon={Plus} colorCls="text-emerald-700" items={increased} />
      <Group title="Depth / case-pack fit" icon={Package} colorCls="text-sky-700" items={deepSet} />
      <Group title="Deletions" icon={Trash2} colorCls="text-red-700" items={deleted} />
      <Group title="Skipped" icon={AlertTriangle} colorCls="text-slate-500" items={skipped} />
      <Group title="Supply notes (no change made)" icon={Package} colorCls="text-slate-600" items={notes} />
      <div className="flex items-center gap-2 mt-6">
        <button className={btnDanger} disabled={busy} onClick={onDiscard}><Trash2 size={13} /> {discardLabel || "Discard Draft"}</button>
        <button className={btnPrimary + " ml-auto"} disabled={busy} onClick={onApprove}><Check size={14} /> {busy ? "Working…" : approveLabel || "Keep as WIP — Continue to Approve"}</button>
      </div>
    </div>
  );
}

// One row per product on the planogram: what the shelf holds, how long that lasts at the current
// sales rate, how it compares with the category target, and whether it lines up with the case pack.
// Problems sort first (short of target, then pack-out that sends overage to the back room).
function buildSupplyReport(planogram, products, performance, cutoffISO, storeId, dosTargets) {
  const byProduct = {};
  (planogram.sections || []).forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    const product = products.find((p) => p.id === pl.productId);
    if (!product) return;
    const units = getStackDims(product, pl, products).units;
    (byProduct[product.id] ||= { product, units: 0, placements: 0 });
    byProduct[product.id].units += units;
    byProduct[product.id].placements += 1;
  })));
  const rows = Object.values(byProduct).map(({ product, units, placements }) => {
    const m = aggregateProductPerformance(product.id, performance, cutoffISO, storeId);
    const weekly = m ? m.avgWeeklyUnits : 0;
    const dos = getDaysOfSupply(units, weekly);
    const target = getDosTargetDays(planogram.category || "", dosTargets, product);
    const fill = getCasePackFill(units, product.casePack);
    const supply = dos === null ? "noSales" : !target ? "noTarget" : dos < target ? "short" : dos > target * DOS_EXCESS_FACTOR ? "over" : "ok";
    const pack = !fill ? "none" : fill.units < fill.casePack ? "belowCase" : fill.exact ? "ok" : "overage";
    return { product, units, placements, weekly, dos, target, fill, supply, pack };
  });
  const rank = (r) => (r.pack === "belowCase" ? 0 : r.supply === "short" ? 1 : r.pack === "overage" ? 2 : r.supply === "over" ? 3 : 4);
  return rows.sort((a, b) => rank(a) - rank(b) || a.product.name.localeCompare(b.product.name));
}

function SupplyReportModal({ planogram, products, performance, cutoffISO, storeId, dosTargets, weeks, onClose }) {
  const rows = React.useMemo(() => buildSupplyReport(planogram, products, performance, cutoffISO, storeId, dosTargets), [planogram, products, performance, cutoffISO, storeId, dosTargets]);
  const f1 = (n) => (Math.round(n * 10) / 10).toString();
  const problems = rows.filter((r) => r.pack === "belowCase" || r.pack === "overage" || r.supply === "short").length;
  const supplyCell = (r) => {
    if (r.supply === "noSales") return <span className="text-slate-400">no sales</span>;
    const cls = r.supply === "short" ? "text-red-600" : r.supply === "over" ? "text-amber-600" : r.supply === "ok" ? "text-emerald-600" : "text-slate-700";
    return <span className={"font-semibold " + cls}>{f1(r.dos)}{r.target ? ` / ${r.target}` : ""}</span>;
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6 no-print" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <h3 className="font-bold text-slate-800 flex items-center gap-1.5"><Package size={16} /> Supply report — {planogram.name}</h3>
            <p className="text-xs text-slate-500">Units on the shelf vs. sales over the last {weeks} weeks, and vs. how the product ships. {problems ? `${problems} item${problems === 1 ? "" : "s"} need attention.` : "Everything lines up."}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="overflow-auto px-5 py-3">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-200">
                <th className="py-1.5 pr-3">Product</th><th className="py-1.5 pr-3 text-right">On shelf</th><th className="py-1.5 pr-3 text-right">Units/wk</th>
                <th className="py-1.5 pr-3 text-right">Days of supply / target</th><th className="py-1.5 pr-3 text-right">Case pack</th><th className="py-1.5 pr-3 text-right">Pack-out</th><th className="py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product.id} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3 text-slate-800">{r.product.name}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.units}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.weekly ? f1(r.weekly) : "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{supplyCell(r)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.fill ? r.fill.casePack : "—"}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{r.fill ? `${Math.round(r.fill.cases * 100) / 100} cases` : "—"}</td>
                  <td className="py-1.5 text-xs">
                    {r.pack === "belowCase" && <span className="text-red-600 font-semibold">Less than one case — every delivery overflows</span>}
                    {r.pack === "overage" && <span className="text-red-600 font-semibold">Not a case / half-case pack-out — overage to the back room</span>}
                    {r.supply === "short" && <span className="text-red-600 block">Short of the {r.target}-day target</span>}
                    {r.supply === "over" && <span className="text-amber-600 block">Over {DOS_EXCESS_FACTOR}x the target</span>}
                    {r.pack !== "belowCase" && r.pack !== "overage" && r.supply !== "short" && r.supply !== "over" && <span className="text-slate-400">OK</span>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-slate-400 italic">No products on this planogram yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Settings panel for the Reset Drafting Agent's per-category Sales/Space Index thresholds. Lists
// every Category value found on a planogram (planogram.category — the field set in its own
// toolbar, not a per-product attribute); a category with no row here uses the chain-wide default.
function ResetThresholdsEditor({ planograms, resetThresholds, onChange }) {
  const categories = React.useMemo(() => {
    const set = new Set();
    (planograms || []).forEach((p) => { if (p.category) set.add(p.category); });
    return [...set].sort();
  }, [planograms]);

  const getRow = (cat) => resetThresholds.find((t) => t.category === cat) || { category: cat, low: DEFAULT_RESET_THRESHOLDS.low, high: DEFAULT_RESET_THRESHOLDS.high };

  const updateRow = (cat, field, value) => {
    const num = Number(value);
    if (Number.isNaN(num)) return;
    const row = getRow(cat);
    const rest = resetThresholds.filter((t) => t.category !== cat);
    onChange([...rest, { ...row, [field]: num }]);
  };

  if (categories.length === 0) {
    return <p className="text-sm text-slate-500">Set a Category on a planogram to configure Reset Drafting thresholds for it.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-200">
            <th className="py-1.5 pr-3">Category</th>
            <th className="py-1.5 pr-3">Underperform below</th>
            <th className="py-1.5 pr-3">Standout above</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((cat) => {
            const row = getRow(cat);
            return (
              <tr key={cat} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 text-slate-700">{cat}</td>
                <td className="py-1.5 pr-3"><input type="number" className={inputCls + " w-24"} value={row.low} onChange={(e) => updateRow(cat, "low", e.target.value)} /></td>
                <td className="py-1.5 pr-3"><input type="number" className={inputCls + " w-24"} value={row.high} onChange={(e) => updateRow(cat, "high", e.target.value)} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Settings panel for per-category days-of-supply targets (blank = no check for that category).
function DosTargetsEditor({ planograms, dosTargets, onChange }) {
  const categories = React.useMemo(() => {
    const set = new Set();
    (planograms || []).forEach((p) => { if (p.category) set.add(p.category); });
    return [...set].sort();
  }, [planograms]);
  const setDays = (cat, value) => {
    const rest = dosTargets.filter((t) => t.category !== cat);
    const days = value === "" ? null : Math.max(0, Number(value));
    onChange(days === null || Number.isNaN(days) ? rest : [...rest, { category: cat, days }]);
  };
  if (categories.length === 0) return <p className="text-sm text-slate-500">Set a Category on a planogram to configure a days-of-supply target for it.</p>;
  return (
    <table className="min-w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-slate-200">
          <th className="py-1.5 pr-3">Category</th>
          <th className="py-1.5 pr-3">Days of supply on shelf</th>
        </tr>
      </thead>
      <tbody>
        {categories.map((cat) => {
          const row = dosTargets.find((t) => t.category === cat);
          return (
            <tr key={cat} className="border-b border-slate-100">
              <td className="py-1.5 pr-3 text-slate-700">{cat}</td>
              <td className="py-1.5 pr-3"><input type="number" min="0" step="0.5" className={inputCls + " w-24"} placeholder="off" value={row?.days ?? ""} onChange={(e) => setDays(cat, e.target.value)} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Names for agent actors in the Activity log (agents aren't users, so they have no profile row).
const AGENT_DISPLAY_NAMES = { "reset-drafting-agent": "Reset Drafting Agent", "assortment-agent": "Assortment Agent", "reset-impact-agent": "Reset Impact Agent", "execution-followup-agent": "Execution Follow-up Agent" };

// One Activity row -> a sentence a person can read. Unknown actions still render (as the raw
// action name) so a newer agent's entries don't vanish from an older build of the app.
function describeActivity(row, names) {
  const d = row.detail || {};
  const actor = row.actor_type === "agent" ? (AGENT_DISPLAY_NAMES[row.actor_id] || row.actor_id) : (names[row.actor_id] || "A teammate");
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (row.action === "proposal_created") {
    const requester = d.requestedBy ? names[d.requestedBy] : null;
    return {
      icon: Sparkles, cls: "text-blue-600 bg-blue-50",
      title: `${actor} proposed ${plural(d.changes ?? 0, "change")}${d.skipped ? `, ${d.skipped} skipped` : ""}`,
      sub: [d.score != null ? `Draft Score ${d.score}%` : null, d.lookbackWeeks ? `last ${d.lookbackWeeks} weeks` : null, requester ? `requested by ${requester}` : null].filter(Boolean).join(" · "),
    };
  }
  if (row.action === "proposal_applied") return { icon: Check, cls: "text-emerald-600 bg-emerald-50", title: `${actor} approved the AI draft and created ${d.planogramName || "a new version"}`, sub: d.score != null ? `Draft Score ${d.score}%` : "" };
  if (row.action === "impact_measured") {
    const pct = d.salesChangePct, lift = d.liftPp;
    return {
      icon: TrendingUp, cls: "text-violet-600 bg-violet-50",
      title: `${actor} measured the reset: sales ${pct == null ? "change not available" : `${fmtPct(pct)} per week`}${lift == null ? "" : ` (${fmtPp(lift)} vs similar stores)`}`,
      sub: [d.goLiveDate ? `went live ${d.goLiveDate}` : null, `${d.measuredStores ?? 0} store${d.measuredStores === 1 ? "" : "s"} measured`, d.maturingStores ? `${d.maturingStores} still maturing` : null].filter(Boolean).join(" · "),
    };
  }
  if (row.action === "reminder_sent") return { icon: Mail, cls: "text-amber-600 bg-amber-50", title: `${actor} sent ${d.storeName || "a store"} a reminder task`, sub: d.reason || "" };
  if (row.action === "execution_escalated") return { icon: AlertTriangle, cls: "text-red-600 bg-red-50", title: `${actor} escalated ${d.storeName || "a store"} to the Category Manager`, sub: [d.daysOverdue != null ? `${d.daysOverdue} days overdue` : null, d.priorEscalations ? `repeat: ${d.priorEscalations} earlier in 90 days` : null].filter(Boolean).join(" · ") };
  if (row.action === "escalation_resolved") return { icon: Check, cls: "text-emerald-600 bg-emerald-50", title: `${d.storeName || "A store"} finished the reset — escalation closed`, sub: "" };
  if (row.action === "proposal_approved") return { icon: Check, cls: "text-emerald-600 bg-emerald-50", title: `${actor} approved the AI draft`, sub: d.note || "" };
  if (row.action === "proposal_rejected") return { icon: X, cls: "text-red-600 bg-red-50", title: `${actor} rejected the AI draft`, sub: d.note || "" };
  return { icon: AlertTriangle, cls: "text-slate-500 bg-slate-100", title: `${actor}: ${row.action}`, sub: "" };
}

// The Activity panel on a planogram: who (or which agent) did what to it, newest first. Reads the
// append-only activity_log; it covers this planogram and, for an AI draft, the version it was
// drafted from, since that is what the agent's proposal was recorded against.
function PlanogramActivity({ planogram }) {
  const ids = [planogram.id, planogram.resetDraft?.sourceId, planogram.aiDraft?.sourceId].filter(Boolean);
  const idsKey = ids.join("|");
  const [state, setState] = useState({ status: "loading", rows: [], names: {} });
  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "loading" }));
    const result = await loadActivity(idsKey.split("|"));
    setState(result.ok ? { status: "ready", rows: result.rows, names: result.names } : { status: "error", rows: [], names: {} });
  }, [idsKey]);
  useEffect(() => { load(); }, [load]);

  // How the reset turned out: this version's own measurement, or that of the version that replaced it
  const [outcomes, setOutcomes] = useState([]);
  const [measuring, setMeasuring] = useState(false);
  const loadOutcomes = useCallback(async () => {
    const r = await loadResetImpacts(idsKey.split("|"));
    setOutcomes(r.ok ? r.rows.filter((x) => x.result?.status === "ok") : []);
  }, [idsKey]);
  useEffect(() => { loadOutcomes(); }, [loadOutcomes]);
  const canMeasure = effectivePlanogramStatus(planogram) === "live";
  const measureThis = async () => {
    setMeasuring(true);
    try { await invokeEdgeFunction("reset-impact", { planogramIds: [planogram.id] }); await Promise.all([loadOutcomes(), load()]); } catch (e) { /* the card simply stays as it was */ } finally { setMeasuring(false); }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 no-print">
      {outcomes.map((o) => {
        const sum = o.result.summary;
        const sales = sum?.metrics.sales;
        return (
          <div key={o.planogram_id} className="mb-3 rounded-md border border-violet-200 bg-violet-50 px-3 py-2">
            <div className="text-xs font-semibold text-violet-800 flex items-center gap-1.5"><TrendingUp size={13} /> Reset outcome — {o.result.planogram?.name}{o.proposal_id ? " (from an approved AI proposal)" : ""}</div>
            {sum ? (
              <div className="text-sm text-slate-800 mt-0.5">
                Sales {fmtPct(sales.changePct)} per week{sales.liftPp != null ? <> — <span className={deltaCls(sales.liftPp)}>{fmtPp(sales.liftPp)}</span> vs similar stores that didn't reset</> : " (no comparison stores)"}
                <span className="text-xs text-slate-500"> · {o.result.counts.measured} store{o.result.counts.measured === 1 ? "" : "s"} measured{o.result.counts.maturing ? `, ${o.result.counts.maturing} still maturing` : ""} · live {o.go_live_date}</span>
              </div>
            ) : <div className="text-sm text-slate-600 mt-0.5">No store has enough weeks after the reset yet ({o.result.counts.maturing} maturing).</div>}
          </div>
        );
      })}
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><TrendingUp size={14} /> Activity</h3>
        {canMeasure && <button className={btnGhost} onClick={measureThis} disabled={measuring} title="Compare sales before and after this version went Live"><TrendingUp size={12} /> {measuring ? "Measuring…" : "Measure impact"}</button>}
        <button className={btnGhost + " ml-auto"} onClick={load} disabled={state.status === "loading"}><RefreshCw size={12} /> Refresh</button>
      </div>
      {state.status === "error" && <p className="text-sm text-amber-700">Activity couldn't be loaded. If the latest <code>supabase/schema.sql</code> hasn't been run yet, run it in the Supabase SQL Editor.</p>}
      {state.status === "loading" && state.rows.length === 0 && <p className="text-sm text-slate-400">Loading…</p>}
      {state.status === "ready" && state.rows.length === 0 && <p className="text-sm text-slate-500">Nothing recorded for this planogram yet. AI drafts and the decisions made on them will show up here.</p>}
      {state.rows.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {state.rows.map((row) => {
            const { icon: Icon, cls, title, sub } = describeActivity(row, state.names);
            return (
              <li key={row.id} className="flex items-start gap-3 py-2">
                <span className={`mt-0.5 w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${cls}`}><Icon size={13} /></span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-slate-800">{title}</span>
                  {sub && <span className="block text-xs text-slate-500">{sub}</span>}
                </span>
                <span className="text-[11px] text-slate-400 shrink-0">{new Date(row.created_at).toLocaleString()}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PlanogramVersionsBar({ planogram, allPlanograms, onCreateVersion, onOpenVersion, onDraftReset, draftingReset }) {
  const members = getFamilyMembers(planogram, allPlanograms);
  const isMaster = !planogram.masterId;
  const master = isMaster ? planogram : allPlanograms.find((p) => p.id === planogram.masterId);
  const [resetWeeks, setResetWeeks] = useState(13);
  const [showActivity, setShowActivity] = useState(false); // session-only view toggle

  return (
    <>
    <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-lg p-3 mb-4 no-print">
      <span className="text-xs font-semibold text-slate-500">
        Version {planogram.versionNumber || 1}{!isMaster && master ? ` of "${master.name}"` : " (master)"}:
      </span>
      {members.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {members.map((m) => (
            <button
              key={m.id}
              onClick={() => onOpenVersion(m.id)}
              title={m.name}
              className={`text-xs rounded-full pl-2.5 pr-1.5 py-0.5 border font-medium flex items-center gap-1.5 ${m.id === planogram.id ? "border-amber-400 bg-amber-50 text-slate-800" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              v{m.versionNumber || 1}
              <PlanogramStatusBadge status={effectivePlanogramStatus(m)} />
            </button>
          ))}
        </div>
      )}
      <div className="ml-auto flex items-center gap-2">
        {onDraftReset && (
          <>
            <select className={inputCls + " w-24 py-1"} value={resetWeeks} onChange={(e) => setResetWeeks(Number(e.target.value))} title="Performance lookback window">
              {[4, 13, 26, 52].map((w) => <option key={w} value={w}>{w} weeks</option>)}
            </select>
            <button className={btnGhost} disabled={draftingReset} onClick={() => onDraftReset(planogram, resetWeeks)} title="Reads Performance for this planogram and drafts the next version as a new WIP, with a reason attached to every change.">
              <Sparkles size={13} /> {draftingReset ? "Drafting…" : "Draft Reset with AI"}
            </button>
          </>
        )}
        <button className={btnGhost} onClick={() => onCreateVersion(planogram)}><Copy size={13} /> Create Version</button>
        <button className={btnGhost + (showActivity ? " bg-slate-100" : "")} onClick={() => setShowActivity((v) => !v)} aria-pressed={showActivity} title="Who proposed, approved or rejected what on this planogram"><TrendingUp size={13} /> Activity</button>
      </div>
    </div>
    {showActivity && <PlanogramActivity planogram={planogram} />}
    </>
  );
}

function PlanogramEditor({ planogram, products, fixtures, performance, productSchema, planogramSchema, resetThresholds, dosTargets, stores, capacityWarningsEnabled, onAssignStores, onUpdate, onBack, allPlanograms, onCreateVersion, onOpenVersion, onMakeLive, onResolveIssue, onDraftReset, draftingReset, onApproveResetDraft, onDiscardResetDraft }) {
  const [presentMode, setPresentMode] = useState(false);
  const [hideImages, setHideImages] = useState(false); // session-only view toggle, not saved with the planogram
  const [highlightField, setHighlightField] = useState(null); // attribute field id, or null = off
  const [highlightPanelOpen, setHighlightPanelOpen] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false); // session-only, not saved
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false); // session-only, not saved
  const [topBarCollapsed, setTopBarCollapsed] = useState(false); // session-only, not saved
  const [editorTab, setEditorTab] = useState(null); // which of Analyze / Planogram Attributes / Lifecycle / Versions is open; null = all closed (session-only)
  const canvasScrollRef = useRef(null);
  const recenterCanvas = () => {
    const el = canvasScrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
  };
  // collapsing/expanding a side panel changes how much room the canvas has, so the planogram
  // can end up off-center or scrolled oddly relative to the new width — recenter automatically
  // once the layout has actually settled into its new size. Double-rAF: a single frame isn't
  // always enough for the flex layout to have fully resolved its new widths before we measure.
  useEffect(() => {
    let raf2;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(recenterCanvas); });
    return () => { cancelAnimationFrame(raf1); if (raf2) cancelAnimationFrame(raf2); };
  }, [leftPanelCollapsed, rightPanelCollapsed]);
  const [selectedSectionForAdd, setSelectedSectionForAdd] = useState(null); // section id showing add-fixture popover
  const [selectedFixtureId, setSelectedFixtureId] = useState(null);
  const [selectedPlacement, setSelectedPlacement] = useState(null); // {sectionId, fixtureInstId, placementId}
  const [quickAddProductId, setQuickAddProductId] = useState(products[0]?.id || "");
  const [analysisWeeks, setAnalysisWeeks] = useState(planogram.analysisPeriodWeeks || 13);
  const [analysisStoreId, setAnalysisStoreId] = useState(planogram.analysisStoreId || "blended");
  const [assigningStores, setAssigningStores] = useState(false);
  const [overlayPanelOpen, setOverlayPanelOpen] = useState(false);
  const overlaySettings = planogram.overlaySettings || DEFAULT_OVERLAY_SETTINGS;
  const updateOverlaySettings = (patch) => onUpdate({ ...planogram, overlaySettings: { ...overlaySettings, ...patch } });
  const [zoomLevel, setZoomLevel] = useState(1); // session-only canvas zoom, not saved with the planogram

  const baseScale = clamp(820 / Math.max(planogram.dims.w, 24), 1.5, 5.5);
  const scale = baseScale * zoomLevel;
  const totalSectionsWidth = planogram.sections.reduce((s, sec) => s + sec.width, 0);
  const joinedLayouts = computeJoinedGroupLayouts(planogram, fixtures, products);

  const latestISO = getLatestWeekEnding(performance);
  const cutoffISO = getCutoffISO(latestISO, analysisWeeks);
  const activeStoreId = analysisStoreId === "blended" ? null : analysisStoreId;
  const availableWeeks = countAvailableWeeks(performance, activeStoreId);
  const setAnalysisWeeksAndSave = (w) => { setAnalysisWeeks(w); onUpdate({ ...planogram, analysisPeriodWeeks: w }); };
  const setAnalysisStoreIdAndSave = (id) => { setAnalysisStoreId(id); onUpdate({ ...planogram, analysisStoreId: id }); };
  // stores relevant to this planogram — its own assignments if any, otherwise every store in the library
  const assignedStores = stores.filter((s) => (planogram.storeIds || []).includes(s.id));
  const analysisStoreOptions = assignedStores.length > 0 ? assignedStores : stores;

  // distinct products currently placed anywhere on this planogram
  const placedProductIds = Array.from(new Set(
    planogram.sections.flatMap((s) => s.fixtures.flatMap((f) => f.placements.map((p) => p.productId)))
  ));
  const planogramMetrics = placedProductIds
    .map((pid) => aggregateProductPerformance(pid, performance, cutoffISO, activeStoreId))
    .filter(Boolean);
  const planogramTotals = planogramMetrics.reduce(
    (acc, m) => ({ totalSales: acc.totalSales + m.totalSales, totalCost: acc.totalCost + m.totalCost, grossProfit: acc.grossProfit + m.grossProfit, totalUnits: acc.totalUnits + m.totalUnits }),
    { totalSales: 0, totalCost: 0, grossProfit: 0, totalUnits: 0 }
  );
  const planogramMarginPct = planogramTotals.totalSales > 0 ? (planogramTotals.grossProfit / planogramTotals.totalSales) * 100 : 0;
  const planogramUnitProfit = planogramTotals.totalUnits > 0 ? planogramTotals.grossProfit / planogramTotals.totalUnits : 0;

  const mutateSections = (fn) => onUpdate(refitAutoStacks({ ...planogram, sections: fn(planogram.sections) }, fixtures, products));

  const addSection = () => {
    mutateSections((secs) => [...secs, { id: uid("sec"), name: `Sec ${secs.length + 1}`, width: 48, fixtures: [] }]);
  };
  const renameSection = (id, name) => mutateSections((secs) => secs.map((s) => (s.id === id ? { ...s, name } : s)));
  const resizeSection = (id, width) => mutateSections((secs) => secs.map((s) => (s.id === id ? { ...s, width } : s)));
  // cosmetic-only gondola backdrop (pegboard/slatwall/solid), independent of whether the section
  // also has a real, merchandisable Pegboard fixture — see SectionColumn, which suppresses this
  // when a real Pegboard fixture is present so the two never visually compete.
  const setSectionBackboard = (id, style) => mutateSections((secs) => secs.map((s) => (s.id === id ? { ...s, backboardStyle: style } : s)));
  const deleteSection = (id) => mutateSections((secs) => secs.filter((s) => s.id !== id));
  const moveSection = (idx, dir) => mutateSections((secs) => {
    const next = [...secs];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return next;
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });

  const addFixtureToSection = (sectionId, fx) => {
    mutateSections((secs) => secs.map((s) => (s.id === sectionId ? { ...s, fixtures: [...s.fixtures, fx] } : s)));
    setSelectedSectionForAdd(null);
  };
  const deleteFixture = (sectionId, fxId) => {
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              // anything mounted on the fixture being deleted (e.g. a shelf sitting on a pegboard)
              // falls back to a normal top-level spot in the section rather than disappearing —
              // losing the panel it was attached to shouldn't silently lose the shelf and its products too
              fixtures: s.fixtures
                .filter((f) => f.id !== fxId)
                .map((f) => (f.mountedOnId === fxId ? { ...f, mountedOnId: undefined, xOffset: 0, notchY: 0 } : f)),
            }
          : s
      )
    );
    setSelectedFixtureId(null);
  };
  const updateFixtureInst = (sectionId, fxId, patch) => {
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId ? { ...s, fixtures: s.fixtures.map((f) => (f.id === fxId ? { ...f, ...patch } : f)) } : s
      )
    );
  };

  // attaches an existing fixture (e.g. a shelf) to a pegboard so it renders sitting on top of the
  // peg mesh instead of stacked in its own section slot — the classic cosmetics-wall layout where
  // a wide pegboard is the backdrop and a few shelves are mounted directly onto it. xOffset/notchY
  // on the moved fixture become relative to the HOST PANEL's own origin (not the section's), so it
  // tracks along automatically if the host panel itself is later dragged to a new height.
  const mountFixtureOnPegboard = (sourceSectionId, sourceFixtureId, targetSectionId, targetFixtureId, xOffset, notchY) => {
    if (sourceFixtureId === targetFixtureId) return; // can't mount a panel on itself
    mutateSections((secs) => {
      let moved = null;
      const withoutSource = secs.map((s) => {
        if (s.id !== sourceSectionId) return s;
        return {
          ...s,
          fixtures: s.fixtures.filter((f) => {
            if (f.id === sourceFixtureId) { moved = f; return false; }
            return true;
          }),
        };
      });
      if (!moved) return secs;
      const mounted = { ...moved, mountedOnId: targetFixtureId, xOffset, notchY };
      return withoutSource.map((s) => (s.id === targetSectionId ? { ...s, fixtures: [...s.fixtures, mounted] } : s));
    });
    setSelectedFixtureId(sourceFixtureId);
  };
  // detaches a mounted fixture back into a normal, independently-stacked slot in its own section
  const unmountFixture = (sectionId, fxId) => {
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId
          ? { ...s, fixtures: s.fixtures.map((f) => (f.id === fxId ? { ...f, mountedOnId: undefined, xOffset: 0, notchY: 0 } : f)) }
          : s
      )
    );
  };

  // duplicates a fixture — same type, position offset, alignment, and merchandising — as a quick
  // starting point when a planner needs several similar shelves. Placed just above the original
  // (or below, if there's no room above); never auto-joined to whatever the original was joined to.
  const copyFixture = (sectionId, fx) => {
    const fixtureDef = fixtures.find((f) => f.id === fx.fixtureId);
    const heightIn = fixtureDef ? fixtureDef.dims.h : 2;
    const maxNotchY = Math.max(0, planogram.dims.h - planogram.base - heightIn);
    const gap = 2; // inches of breathing room between the original and the copy
    let newNotchY = fx.notchY + heightIn + gap;
    if (newNotchY > maxNotchY) newNotchY = fx.notchY - heightIn - gap;
    if (newNotchY < 0) newNotchY = fx.notchY; // no room above or below — drop it at the same height, user can drag it
    newNotchY = clamp(Math.round(newNotchY), 0, maxNotchY);

    const newFixture = {
      id: uid("fxi"),
      fixtureId: fx.fixtureId,
      notchY: newNotchY,
      xOffset: fx.xOffset,
      alignment: fx.alignment,
      groupId: null,
      mountedOnId: fx.mountedOnId, // a copy of a mounted fixture stays mounted on the same host panel
      placements: (fx.placements || []).map((p) => ({ ...p, id: uid("pl") })),
    };

    mutateSections((secs) =>
      secs.map((s) => (s.id === sectionId ? { ...s, fixtures: [...s.fixtures, newFixture] } : s))
    );
    setSelectedFixtureId(newFixture.id);
    setSelectedPlacement(null);
  };

  const applyAlignmentToAllFixtures = (alignment) => {
    mutateSections((secs) =>
      secs.map((s) => ({ ...s, fixtures: s.fixtures.map((f) => ({ ...f, alignment })) }))
    );
  };

  // joins two fixtures (always a manual, explicit choice) so their facings flow continuously
  // across the section boundary instead of each fixture overflowing independently
  const joinFixtures = (fxA, fxB) => {
    const groupId = fxA.groupId || fxB.groupId || uid("grp");
    const oldGroupIdOfB = fxB.groupId;
    mutateSections((secs) =>
      secs.map((s) => ({
        ...s,
        fixtures: s.fixtures.map((f) => {
          // snap both joining fixtures flush to their section's left edge — a joined run only
          // looks continuous if there's no gap between where one shelf ends and the next begins
          if (f.id === fxA.id || f.id === fxB.id) return { ...f, groupId, xOffset: 0 };
          // if B was already in a different group, bring the rest of that group along too
          if (oldGroupIdOfB && f.groupId === oldGroupIdOfB) return { ...f, groupId, xOffset: 0 };
          return f;
        }),
      }))
    );
  };

  const unjoinFixture = (sectionId, fxId) => {
    mutateSections((secs) => {
      const target = secs.flatMap((s) => s.fixtures).find((f) => f.id === fxId);
      const groupId = target?.groupId;
      let next = secs.map((s) => ({
        ...s,
        fixtures: s.fixtures.map((f) => (f.id === fxId ? { ...f, groupId: null } : f)),
      }));
      // if that leaves only one fixture in the group, dissolve it too — a "group" of one is meaningless
      if (groupId) {
        const remaining = next.flatMap((s) => s.fixtures).filter((f) => f.groupId === groupId);
        if (remaining.length === 1) {
          next = next.map((s) => ({
            ...s,
            fixtures: s.fixtures.map((f) => (f.groupId === groupId ? { ...f, groupId: null } : f)),
          }));
        }
      }
      return next;
    });
  };

  const addPlacement = (sectionId, fxId, productId, insertIndex, pegCoords) => {
    if (!productId) return;
    const newId = uid("pl");
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              fixtures: s.fixtures.map((f) => {
                if (f.id !== fxId) return f;
                const arr = [...f.placements];
                const newPlacement = { id: newId, productId, facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" };
                // shelf products stack to the available height on their own; the planner can switch it off per product
                if (!pegCoords) newPlacement.autoStack = true;
                if (pegCoords) { newPlacement.pegX = pegCoords.pegX; newPlacement.pegY = pegCoords.pegY; }
                const idx = insertIndex == null ? arr.length : clamp(insertIndex, 0, arr.length);
                arr.splice(idx, 0, newPlacement);
                return { ...f, placements: arr };
              }),
            }
          : s
      )
    );
    // for a pegboard drop specifically, select the new placement immediately so arrow-key
    // nudging is available right away — no need to click it again to fine-tune its position
    if (pegCoords) {
      setSelectedPlacement({ sectionId, fixtureInstId: fxId, placementId: newId });
      setSelectedFixtureId(null);
    }
  };
  const quickAddProduct = (sectionId, fxId) => addPlacement(sectionId, fxId, quickAddProductId);

  // Stacking guard: a stack taller than the headroom under the shelf above is refused. Edits that
  // don't add height always go through, so a stack that is already too tall (imported, or drafted
  // before the shelf above moved) can still be reduced. Only stacked placements (more than one
  // high, or capped) are held to this on moves/drops — a lone tall product keeps its old behavior.
  const [stackNotice, setStackNotice] = useState("");
  const [supplyReportOpen, setSupplyReportOpen] = useState(false);
  const [libraryProductId, setLibraryProductId] = useState(null); // product highlighted in the library and on the shelf
  const [summaryProductId, setSummaryProductId] = useState(null);
  useEffect(() => {
    if (!stackNotice) return undefined;
    const t = setTimeout(() => setStackNotice(""), 6000);
    return () => clearTimeout(t);
  }, [stackNotice]);
  const findFixtureCtx = (sectionId, fxId) => {
    const sec = planogram.sections.find((s) => s.id === sectionId);
    const fx = sec?.fixtures.find((f) => f.id === fxId);
    return sec && fx ? { sec, fx, def: fixtures.find((d) => d.id === fx.fixtureId) } : null;
  };
  const stackBlockReason = (placement, destSectionId, destFxId, mode) => {
    const product = products.find((p) => p.id === placement.productId);
    const dest = findFixtureCtx(destSectionId, destFxId);
    if (!product || !dest || dest.def?.type === "Pegboard") return null;
    const cfg = getStackConfig(placement);
    if (mode === "move" && placement.autoStack) return null; // it re-fits itself to the new shelf
    if (mode === "move" && cfg.high <= 1 && !cfg.cap && cfg.deep <= 1) return null;
    const height = getStackHeightProblem(product, placement, products, getShelfClearanceIn(planogram, dest.sec, dest.fx, fixtures));
    // moving onto a shelf too shallow for the Deep stack is refused as well (edits check depth separately)
    return height || (mode === "move" ? getStackDepthProblem(product, placement, products, dest.def?.dims?.d) : null);
  };

  const updatePlacement = (sectionId, fxId, placementId, patch) => {
    const current = findFixtureCtx(sectionId, fxId)?.fx.placements.find((p) => p.id === placementId);
    const product = current && products.find((p) => p.id === current.productId);
    if (current && product) {
      // an auto-stacked placement re-fits its own High, so judge it at 1 high (cap + one unit must fit)
      const judged = patch.autoStack ? { ...patch, high: 1 } : patch;
      const reason = stackBlockReason(judged, sectionId, fxId, "edit");
      if (reason && getStackDims(product, judged, products).heightIn > getStackDims(product, current.autoStack ? { ...current, high: 1 } : current, products).heightIn + 1e-6) {
        setStackNotice(reason + " The change wasn't applied.");
        return;
      }
      const depthReason = getStackDepthProblem(product, patch, products, findFixtureCtx(sectionId, fxId)?.def?.dims?.d);
      if (depthReason && getStackDims(product, patch, products).stackDepthIn > getStackDims(product, current, products).stackDepthIn + 1e-6) {
        setStackNotice(depthReason + " The change wasn't applied.");
        return;
      }
    }
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId
          ? {
              ...s,
              fixtures: s.fixtures.map((f) =>
                f.id === fxId ? { ...f, placements: f.placements.map((p) => (p.id === placementId ? { ...patch } : p)) } : f
              ),
            }
          : s
      )
    );
  };
  const removePlacement = (sectionId, fxId, placementId) => {
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId
          ? { ...s, fixtures: s.fixtures.map((f) => (f.id === fxId ? { ...f, placements: f.placements.filter((p) => p.id !== placementId) } : f)) }
          : s
      )
    );
    setSelectedPlacement(null);
  };

  // move an existing placement from one fixture to another, preserving its orientation/rotation/facings
  const movePlacement = (source, dest, insertIndex, pegCoords) => {
    const movingPl = findFixtureCtx(source.sectionId, source.fixtureInstId)?.fx.placements.find((p) => p.id === source.placementId);
    if (movingPl) {
      const reason = stackBlockReason(movingPl, dest.sectionId, dest.fixtureInstId, "move");
      if (reason) { setStackNotice(reason + " It wasn't moved."); return; }
    }
    mutateSections((secs) => {
      let moved = null;
      const withoutSource = secs.map((s) => {
        if (s.id !== source.sectionId) return s;
        return {
          ...s,
          fixtures: s.fixtures.map((f) => {
            if (f.id !== source.fixtureInstId) return f;
            const found = f.placements.find((p) => p.id === source.placementId);
            if (found) moved = found;
            return { ...f, placements: f.placements.filter((p) => p.id !== source.placementId) };
          }),
        };
      });
      if (!moved) return secs;
      if (pegCoords) {
        moved = { ...moved, pegX: pegCoords.pegX, pegY: pegCoords.pegY };
      } else if (moved.pegX !== undefined || moved.pegY !== undefined) {
        // moving into a non-pegboard fixture — clear stale peg coordinates from wherever it came
        // from, so it doesn't secretly remember a position from a different panel
        const { pegX, pegY, ...rest } = moved;
        moved = rest;
      }
      return withoutSource.map((s) => {
        if (s.id !== dest.sectionId) return s;
        return {
          ...s,
          fixtures: s.fixtures.map((f) => {
            if (f.id !== dest.fixtureInstId) return f;
            const arr = [...f.placements];
            const idx = insertIndex == null ? arr.length : clamp(insertIndex, 0, arr.length);
            arr.splice(idx, 0, moved);
            return { ...f, placements: arr };
          }),
        };
      });
    });
    setSelectedPlacement({ sectionId: dest.sectionId, fixtureInstId: dest.fixtureInstId, placementId: source.placementId });
    setSelectedFixtureId(null);
  };

  // rubberband-drag several pegged products at once (see PegboardPanel's "pegGroup" drag
  // payload) — shifts every selected placement's own peg by the same (dx, dy), preserving their
  // layout relative to each other. Always within one fixture, so this can update pegX/pegY in
  // place rather than movePlacement's remove-then-reinsert (which would also scramble array order
  // for no benefit here, since a pegboard's 2D layout doesn't care about placement array order).
  const moveGroupOnPegboard = (sectionId, fixtureInstId, placementIds, dx, dy) => {
    if (!dx && !dy) return;
    const idSet = new Set(placementIds);
    mutateSections((secs) => secs.map((s) => {
      if (s.id !== sectionId) return s;
      return {
        ...s,
        fixtures: s.fixtures.map((f) => {
          if (f.id !== fixtureInstId) return f;
          return {
            ...f,
            placements: f.placements.map((p) =>
              idSet.has(p.id) ? { ...p, pegX: Math.round((p.pegX ?? 0) + dx), pegY: Math.round((p.pegY ?? 0) + dy) } : p
            ),
          };
        }),
      };
    }));
  };

  // rubberband-drag several whole FIXTURES at once (a shelf's own bar, not its products) — shifts
  // every selected fixture's notchY by the same delta, each clamped to its own valid range so a
  // short fixture in the group can't be dragged further than its own height allows even if a
  // taller groupmate could go further.
  const dragFixtureGroup = (sectionId, fxIds, deltaNotchY) => {
    if (!deltaNotchY) return;
    const idSet = new Set(fxIds);
    mutateSections((secs) => secs.map((s) => {
      if (s.id !== sectionId) return s;
      return {
        ...s,
        fixtures: s.fixtures.map((f) => {
          if (!idSet.has(f.id)) return f;
          const def = fixtures.find((d) => d.id === f.fixtureId);
          const heightIn = def ? def.dims.h : 2;
          const maxNotchY = Math.max(0, planogram.dims.h - planogram.base - heightIn);
          return { ...f, notchY: clamp(f.notchY + deltaNotchY, 0, maxNotchY) };
        }),
      };
    }));
  };

  // rubberband-drag several PRODUCTS at once onto a (possibly different) shelf — e.g. "grab
  // everything on this shelf and move it to that one." Unlike moveGroupOnPegboard (which just
  // nudges pegX/pegY in place), this removes each item from wherever it started — one shelf, a
  // pegboard, or a mix — and reinserts them together as one ordered block at the drop point,
  // preserving the relative order they were selected in. Any stale peg coordinates are dropped
  // (a shelf placement doesn't have a 2D position), matching movePlacement's own behavior when
  // crossing into a non-pegboard fixture.
  const moveGroupToFixture = (items, dest, insertIndex) => {
    if (!items || items.length === 0) return;
    for (const it of items) {
      const pl = findFixtureCtx(it.sectionId, it.fixtureInstId)?.fx.placements.find((p) => p.id === it.placementId);
      const reason = pl && stackBlockReason(pl, dest.sectionId, dest.fixtureInstId, "move");
      if (reason) { setStackNotice(reason + " Nothing was moved."); return; }
    }
    mutateSections((secs) => {
      const movedById = {};
      let next = secs.map((s) => ({
        ...s,
        fixtures: s.fixtures.map((f) => {
          const toRemove = items.filter((it) => it.sectionId === s.id && it.fixtureInstId === f.id);
          if (toRemove.length === 0) return f;
          const removeIds = new Set(toRemove.map((it) => it.placementId));
          const kept = [];
          f.placements.forEach((p) => {
            if (removeIds.has(p.id)) {
              const { pegX, pegY, ...rest } = p;
              movedById[p.id] = rest;
            } else kept.push(p);
          });
          return { ...f, placements: kept };
        }),
      }));
      const block = items.map((it) => movedById[it.placementId]).filter(Boolean);
      if (block.length === 0) return secs;
      next = next.map((s) => {
        if (s.id !== dest.sectionId) return s;
        return {
          ...s,
          fixtures: s.fixtures.map((f) => {
            if (f.id !== dest.fixtureInstId) return f;
            const arr = [...f.placements];
            const idx = insertIndex == null ? arr.length : clamp(insertIndex, 0, arr.length);
            arr.splice(idx, 0, ...block);
            return { ...f, placements: arr };
          }),
        };
      });
      return next;
    });
    setSelectedFixtureId(null);
    setSelectedPlacement(null);
  };

  // find current selected placement object + product
  let placementCtx = null;
  if (selectedPlacement) {
    const sec = planogram.sections.find((s) => s.id === selectedPlacement.sectionId);
    const fx = sec?.fixtures.find((f) => f.id === selectedPlacement.fixtureInstId);
    const pl = fx?.placements.find((p) => p.id === selectedPlacement.placementId);
    if (pl) {
      const product = products.find((p) => p.id === pl.productId);
      placementCtx = { sec, fx, pl, product, metrics: aggregateProductPerformance(pl.productId, performance, cutoffISO, activeStoreId) };
    }
  }

  // Library <-> planogram sync. Selecting a placement points the library at its product; clicking a product in
  // the library selects (and scrolls to) its next placement on the planogram, cycling when it is placed more than once.
  useEffect(() => {
    if (placementCtx?.product) setLibraryProductId(placementCtx.product.id);
  }, [placementCtx?.product?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const placedCounts = React.useMemo(() => {
    const counts = {};
    planogram.sections.forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => { counts[pl.productId] = (counts[pl.productId] || 0) + 1; })));
    return counts;
  }, [planogram]);
  const selectLibraryProduct = (productId) => {
    setLibraryProductId(productId);
    const all = [];
    planogram.sections.forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
      if (pl.productId === productId) all.push({ sectionId: sec.id, fixtureInstId: fx.id, placementId: pl.id });
    })));
    if (all.length === 0) { setSelectedPlacement(null); return; }
    const at = selectedPlacement ? all.findIndex((x) => x.placementId === selectedPlacement.placementId) : -1;
    const next = all[(at + 1) % all.length]; // not currently selected (-1) starts at the first
    setSelectedPlacement(next);
    setSelectedFixtureId(null);
    requestAnimationFrame(() => document.querySelector(`[data-placement-id="${next.placementId}"]`)?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" }));
  };

  // arrow-key nudging for a selected pegboard placement — moves the peg itself, one real hole
  // at a time (a peg can't occupy a fractional position, so quarter-inch steps never made sense)
  useEffect(() => {
    if (!placementCtx || !placementCtx.product) return;
    const fxDef = fixtures.find((f) => f.id === placementCtx.fx.fixtureId);
    if (fxDef?.type !== "Pegboard") return;

    const handleKeyDown = (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return; // don't hijack form field navigation
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1; // whole holes only — hold Shift to cross the panel faster
      const panelWidthIn = fxDef.dims.w;
      const panelHeightIn = fxDef.dims.h;
      const curX = placementCtx.pl.pegX ?? 0;
      const curY = placementCtx.pl.pegY ?? panelHeightIn;
      let nextX = curX;
      let nextY = curY;
      // the peg can be at any hole on the panel's own grid — whether the resulting product
      // placement fits or overflows is handled separately by the overflow-flag system, not by
      // preventing the peg itself from reaching a particular hole
      if (e.key === "ArrowLeft") nextX = clamp(curX - step, 0, panelWidthIn);
      if (e.key === "ArrowRight") nextX = clamp(curX + step, 0, panelWidthIn);
      if (e.key === "ArrowUp") nextY = clamp(curY + step, 0, panelHeightIn);
      if (e.key === "ArrowDown") nextY = clamp(curY - step, 0, panelHeightIn);
      updatePlacement(placementCtx.sec.id, placementCtx.fx.id, placementCtx.pl.id, { ...placementCtx.pl, pegX: nextX, pegY: nextY });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // depend on the actual values the handler reads, not the freshly-recreated placementCtx
    // object itself (a new object every render would tear down/re-add this listener on every
    // unrelated re-render, and is a real source of dropped keypresses under rapid key-repeat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    placementCtx?.sec?.id,
    placementCtx?.fx?.id,
    placementCtx?.fx?.fixtureId,
    placementCtx?.pl?.id,
    placementCtx?.pl?.pegX,
    placementCtx?.pl?.pegY,
    placementCtx?.pl?.rotation,
    placementCtx?.product?.id,
    placementCtx?.product?.squeezeFactor,
    fixtures,
  ]);

  // An AI-drafted reset lands as an ordinary WIP version, but one that needs a bundled human
  // review before anyone works with it in the gondola builder — show that review in place of the
  // normal editor until it's been Approved or Discarded, rather than inserting it as one more
  // panel among the rest.
  if (planogram.resetDraft && !planogram.resetDraft.reviewed) {
    return (
      <div className="p-6 max-w-[1400px] mx-auto">
        <ResetDraftReviewPanel
          planogram={planogram}
          onBack={onBack}
          onApprove={() => onApproveResetDraft(planogram)}
          onDiscard={() => onDiscardResetDraft(planogram)}
        />
      </div>
    );
  }

  // find fixture currently selected for the toolbar (position editing / quick add)
  let fixtureCtx = null;
  if (selectedFixtureId) {
    for (let i = 0; i < planogram.sections.length; i++) {
      const s = planogram.sections[i];
      const fx = s.fixtures.find((f) => f.id === selectedFixtureId);
      if (fx) { fixtureCtx = { section: s, sectionIndex: i, fx, joinCandidates: findJoinCandidates(planogram, i, fx) }; break; }
    }
  }

  return (
    <LinkedProductContext.Provider value={libraryProductId}>
    <div>
      <div className="flex items-center gap-3 mb-4 no-print">
        <button className={btnGhost} onClick={onBack}><ArrowLeft size={14} /> All Planograms</button>
        {presentMode ? (
          <span className="text-lg font-bold text-slate-800">{planogram.name}</span>
        ) : (
          <DebouncedTextInput
            value={planogram.name}
            onCommit={(name) => onUpdate({ ...planogram, name })}
            className="text-lg font-bold text-slate-800 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-amber-400 focus:outline-none"
          />
        )}
        <PlanogramStatusBadge status={effectivePlanogramStatus(planogram)} />
        <div className="ml-auto flex items-center gap-2">
          {presentMode && (
            <button className={btnGhost} onClick={() => window.print()}><Printer size={14} /> Print / Save as PDF</button>
          )}
          <button className={btnPrimary} onClick={() => setPresentMode((p) => !p)}>
            {presentMode ? <><X size={14} /> Exit Presentation</> : <><Eye size={14} /> Present</>}
          </button>
        </div>
      </div>

      {!presentMode && <PlanogramIssuesBar planogram={planogram} onResolveIssue={onResolveIssue} />}

      {!presentMode && (
        <>
          {/* The four panels that used to stack above the canvas are tabs now: nothing opens until it is picked,
              and picking the open tab again closes it, so the shelf gets the room. */}
          <div className="flex items-end gap-1 border-b border-slate-200 mb-3 no-print" role="tablist">
            {[
              { id: "analyze", label: "Analyze", icon: TrendingUp, warn: availableWeeks > 0 && analysisWeeks > availableWeeks },
              { id: "attributes", label: "Planogram Attributes", icon: Ruler },
              { id: "lifecycle", label: "Lifecycle", icon: CalendarDays },
              { id: "versions", label: "Versions", icon: Layers },
            ].map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={editorTab === t.id}
                onClick={() => setEditorTab((cur) => (cur === t.id ? null : t.id))}
                className={`-mb-px flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-t-md border border-b-0 ${editorTab === t.id ? "bg-white border-slate-200 text-slate-800" : "bg-transparent border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-100"}`}
              >
                <t.icon size={13} /> {t.label}
                {t.warn && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title={`Only ${availableWeeks} of ${analysisWeeks} weeks selected have data loaded`} />}
              </button>
            ))}
          </div>
          {editorTab === "versions" && (
            <div className="mb-4">
              <PlanogramVersionsBar planogram={planogram} allPlanograms={allPlanograms} onCreateVersion={onCreateVersion} onOpenVersion={onOpenVersion} onDraftReset={onDraftReset} draftingReset={draftingReset} />
            </div>
          )}
          {editorTab === "lifecycle" && (
            <div className="mb-4">
              <PlanogramLifecycleBar planogram={planogram} onUpdate={onUpdate} onMakeLive={onMakeLive} />
            </div>
          )}

          {editorTab === "attributes" && (
          <div className="flex flex-wrap items-end gap-3 mb-4 bg-white border border-slate-200 rounded-lg p-3">
            <Field label="Category"><DebouncedTextInput className={inputCls + " w-32"} value={planogram.category || ""} onCommit={(category) => onUpdate({ ...planogram, category })} placeholder="e.g. Beer" /></Field>
            <Field label="Department"><DebouncedTextInput className={inputCls + " w-36"} value={planogram.department || ""} onCommit={(department) => onUpdate({ ...planogram, department })} placeholder="e.g. Grocery" /></Field>
            <Field label="Cluster"><DebouncedTextInput className={inputCls + " w-36"} value={planogram.cluster || ""} onCommit={(cluster) => onUpdate({ ...planogram, cluster })} placeholder="e.g. Urban Large" /></Field>
            <Field label="Event Date"><input type="date" className={inputCls + " w-36"} value={planogram.eventDate || ""} onChange={(e) => onUpdate({ ...planogram, eventDate: e.target.value })} /></Field>
            {(planogramSchema || []).map((f) => (
              <Field key={f.id} label={f.label}>
                <AttributeInput field={f} className={inputCls + " w-36"} value={planogram.attributes?.[f.id]} onChange={(v) => onUpdate({ ...planogram, attributes: { ...(planogram.attributes || {}), [f.id]: attrCoerce(f, v) } })} />
              </Field>
            ))}
            <div className="relative">
              <label className={labelCls}>Stores</label>
              <button
                onClick={() => setAssigningStores((s) => !s)}
                className={`text-xs font-medium flex items-center gap-1.5 rounded-md px-2.5 py-1.5 border ${validStoreIds(planogram, stores).length > 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                <Store size={13} /> {validStoreIds(planogram, stores).length > 0 ? `${validStoreIds(planogram, stores).length} assigned` : "Assign"}
              </button>
              {assigningStores && (
                <StoreAssignmentPopover
                  stores={stores}
                  selectedIds={validStoreIds(planogram, stores)}
                  onToggle={(storeId) => {
                    const current = validStoreIds(planogram, stores);
                    const next = current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId];
                    onAssignStores(next);
                  }}
                  onClose={() => setAssigningStores(false)}
                />
              )}
            </div>
            <Field label="Section Count"><div className={inputCls + " w-24 bg-slate-50 font-mono text-slate-700"} title="Add or remove sections with Add Section and each section's own controls">{planogram.sections.length}</div></Field>
            <Field label="Width (in)"><input type="number" className={inputCls + " w-24"} value={planogram.dims.w} onChange={(e) => onUpdate({ ...planogram, dims: { ...planogram.dims, w: Number(e.target.value) || 1 } })} /></Field>
            <Field label="Height (in)"><input type="number" className={inputCls + " w-24"} value={planogram.dims.h} onChange={(e) => onUpdate({ ...planogram, dims: { ...planogram.dims, h: Number(e.target.value) || 1 } })} /></Field>
            <Field label="Depth (in)"><input type="number" className={inputCls + " w-24"} value={planogram.dims.d} onChange={(e) => onUpdate({ ...planogram, dims: { ...planogram.dims, d: Number(e.target.value) || 1 } })} /></Field>
            <Field label="Base (in)"><input type="number" className={inputCls + " w-24"} value={planogram.base} onChange={(e) => onUpdate({ ...planogram, base: Number(e.target.value) || 0 })} /></Field>
            <div className={`text-xs font-mono px-2 py-1 rounded ${totalSectionsWidth > planogram.dims.w ? "bg-red-50 text-red-600" : "bg-slate-50 text-slate-500"}`}>
              Sections used: {totalSectionsWidth} / {planogram.dims.w} in
            </div>
            <button className={btnPrimary + " ml-auto"} onClick={addSection}><Plus size={14} /> Add Section</button>
          </div>
          )}

          {editorTab === "analyze" && (
          <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4 bg-white border border-slate-200 rounded-lg p-3">
            <div className="flex items-center gap-1.5 relative">
              <span className="text-xs font-semibold text-slate-500 mr-1 flex items-center gap-1"><TrendingUp size={13} /> Analyze:</span>
              {PERIOD_OPTIONS.map((w) => {
                const disabled = availableWeeks > 0 && w > availableWeeks;
                return (
                  <button
                    key={w}
                    disabled={disabled}
                    onClick={() => setAnalysisWeeksAndSave(w)}
                    title={disabled ? `Only ${availableWeeks} week${availableWeeks !== 1 ? "s" : ""} of data loaded` : undefined}
                    className={`text-xs rounded-full px-3 py-1 border font-medium ${analysisWeeks === w ? "bg-amber-500 border-amber-500 text-slate-900" : disabled ? "border-slate-200 text-slate-300 cursor-not-allowed" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                  >
                    {w} wks
                  </button>
                );
              })}
              {latestISO && <span className="text-xs text-slate-400 ml-1">through {latestISO}</span>}
              <span className="text-xs font-semibold text-slate-500 ml-2 mr-1 flex items-center gap-1"><Store size={12} /> Store:</span>
              <select className="text-xs rounded-md border border-slate-300 px-2 py-1" value={analysisStoreId} onChange={(e) => setAnalysisStoreIdAndSave(e.target.value)}>
                <option value="blended">All stores (blended)</option>
                {analysisStoreOptions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.storeNumber ? ` (#${s.storeNumber})` : ""}</option>)}
              </select>
              <button
                onClick={() => setOverlayPanelOpen((o) => !o)}
                className={`text-xs font-medium flex items-center gap-1.5 rounded-full px-2.5 py-1 border ml-2 ${overlaySettings.mode !== "off" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                <Layers size={12} /> Product Overlay
              </button>
              {overlayPanelOpen && (
                <OverlaySettingsPanel settings={overlaySettings} schema={productSchema} onChange={updateOverlaySettings} onClose={() => setOverlayPanelOpen(false)} />
              )}
              <button
                onClick={() => setHideImages((v) => !v)}
                title="Temporarily hide product images to focus on the financials/overlay data"
                className={`text-xs font-medium flex items-center gap-1.5 rounded-full px-2.5 py-1 border ${hideImages ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                <ImageOff size={12} /> {hideImages ? "Images Hidden" : "Hide Images"}
              </button>
              <button
                onClick={() => setSupplyReportOpen(true)}
                title="Units on the shelf vs. sales (days of supply) and vs. the warehouse case pack"
                className="text-xs font-medium flex items-center gap-1.5 rounded-full px-2.5 py-1 border border-slate-300 text-slate-600 hover:bg-slate-50"
              >
                <Package size={12} /> Supply Report
              </button>
              <div className="relative">
                <button
                  onClick={() => setHighlightPanelOpen((o) => !o)}
                  className={`text-xs font-medium flex items-center gap-1.5 rounded-full px-2.5 py-1 border ${highlightField ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                >
                  <Palette size={12} /> {highlightField ? `Highlighting: ${productSchema.find((f) => f.id === highlightField)?.label || "…"}` : "Highlight By"}
                </button>
                {highlightPanelOpen && (
                  <HighlightByPanel
                    schema={productSchema}
                    value={highlightField}
                    onChange={setHighlightField}
                    onClose={() => setHighlightPanelOpen(false)}
                    products={products}
                    planogram={planogram}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {planogramMetrics.length > 0 ? (
                <div className="flex items-center gap-4 text-xs text-slate-600">
                  <span><span className="font-semibold">{planogramTotals.totalUnits.toLocaleString()}</span> units</span>
                  <span><span className="font-semibold">{money0(planogramTotals.totalSales)}</span> sales</span>
                  <span><span className="font-semibold">{money0(planogramTotals.grossProfit)}</span> profit</span>
                  <span><span className="font-semibold">{planogramMarginPct.toFixed(1)}%</span> margin</span>
                </div>
              ) : (
                <span className="text-xs text-slate-400 italic">No performance data for the products on this planogram yet.</span>
              )}
            </div>
          </div>
          {availableWeeks > 0 && analysisWeeks > availableWeeks && (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mb-4 -mt-2">
              <AlertTriangle size={12} /> Only {availableWeeks} of {analysisWeeks} weeks selected have data loaded — figures reflect the {availableWeeks} week{availableWeeks !== 1 ? "s" : ""} available.
            </div>
          )}
          </>
          )}
        </>
      )}

      {presentMode && (
        <div className="mb-4 bg-white border border-slate-200 rounded-lg p-4 print-area">
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold text-slate-800">{planogram.name}</h2>
                {planogram.category && (
                  <span className="text-xs font-semibold uppercase tracking-wide rounded-full px-2 py-0.5" style={{ background: hashColor(planogram.category) + "33", color: hashColor(planogram.category) }}>
                    {planogram.category}
                  </span>
                )}
                {planogram.department && <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-slate-100 text-slate-600 border border-slate-200">Dept: {planogram.department}</span>}
                {planogram.cluster && <span className="text-xs font-semibold rounded-full px-2 py-0.5 bg-slate-100 text-slate-600 border border-slate-200">Cluster: {planogram.cluster}</span>}
              </div>
              <div className="text-sm text-slate-500 mt-1.5 flex items-center gap-4 flex-wrap">
                <span className="font-mono">{planogram.dims.w}×{planogram.dims.h}×{planogram.dims.d} in · base {planogram.base}in</span>
                {planogram.eventDate && <span className="flex items-center gap-1.5"><CalendarDays size={13} /> {planogram.eventDate}</span>}
                {validStoreIds(planogram, stores).length > 0 && (
                  <span className="flex items-center gap-1.5"><Store size={13} /> {stores.filter((s) => planogram.storeIds.includes(s.id)).map((s) => s.name).join(", ")}</span>
                )}
              </div>
            </div>
            {planogramMetrics.length > 0 && (
              <div className="flex items-center gap-5 text-sm text-slate-700">
                <div className="text-right"><div className="text-[11px] text-slate-400 uppercase tracking-wide">Revenue</div><div className="font-bold">{money0(planogramTotals.totalSales)}</div></div>
                <div className="text-right"><div className="text-[11px] text-slate-400 uppercase tracking-wide">Profit</div><div className="font-bold">{money0(planogramTotals.grossProfit)}</div></div>
                <div className="text-right"><div className="text-[11px] text-slate-400 uppercase tracking-wide">Margin</div><div className="font-bold">{planogramMarginPct.toFixed(1)}%</div></div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-4">
        {!presentMode && (
          leftPanelCollapsed ? (
            <button
              onClick={() => setLeftPanelCollapsed(false)}
              className="shrink-0 w-6 flex items-start justify-center pt-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 no-print"
              title="Show product library"
            >
              <ChevronRight size={16} className="text-slate-400" />
            </button>
          ) : (
            <div className="relative shrink-0">
              <button
                onClick={() => setLeftPanelCollapsed(true)}
                className="absolute -right-2.5 top-3 z-10 w-5 h-5 rounded-full bg-white border border-slate-300 flex items-center justify-center hover:bg-slate-50 no-print"
                title="Collapse product library"
              >
                <ChevronLeft size={12} className="text-slate-500" />
              </button>
              <ProductLibraryPanel products={products} schema={productSchema} selectedId={libraryProductId} placedCounts={placedCounts} onSelect={selectLibraryProduct} onOpenSummary={setSummaryProductId} />
            </div>
          )
        )}

        <div ref={canvasScrollRef} className="flex-1 overflow-x-auto bg-slate-50 border border-slate-200 rounded-lg p-4 print-area">
          {!presentMode && (
            topBarCollapsed ? (
              <div className="flex justify-center mb-2 no-print">
                <button onClick={() => setTopBarCollapsed(false)} className="text-slate-400 hover:text-slate-600 rounded-full border border-slate-200 bg-white px-3 py-0.5" title="Show performance window / zoom controls">
                  <ChevronDown size={14} />
                </button>
              </div>
            ) : (
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className={`inline-flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2.5 py-1 ${latestISO ? "bg-amber-100 text-amber-800 border border-amber-200" : "bg-slate-100 text-slate-400 border border-slate-200"}`}>
                <TrendingUp size={12} />
                {latestISO ? (
                  <>Performance window: last {analysisWeeks} weeks (through {latestISO}) · {activeStoreId ? (stores.find((s) => s.id === activeStoreId)?.name || "Store") : "All stores (blended)"}</>
                ) : "No performance data loaded"}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 no-print">
                <button className={btnIcon} onClick={recenterCanvas} title="Recenter the planogram in the available space"><Crosshair size={14} /></button>
                <div className="flex items-center gap-0.5 rounded-full border border-slate-300 px-1 py-0.5 bg-white">
                  <button className={btnIcon} disabled={zoomLevel <= 0.5} onClick={() => setZoomLevel((z) => clamp(Math.round((z - 0.25) * 100) / 100, 0.5, 3))} title="Zoom out"><ZoomOut size={14} /></button>
                  <button
                    className="text-xs font-mono text-slate-500 w-11 text-center hover:text-slate-700"
                    onClick={() => setZoomLevel(1)}
                    title="Reset zoom to 100%"
                  >
                    {Math.round(zoomLevel * 100)}%
                  </button>
                  <button className={btnIcon} disabled={zoomLevel >= 3} onClick={() => setZoomLevel((z) => clamp(Math.round((z + 0.25) * 100) / 100, 0.5, 3))} title="Zoom in"><ZoomIn size={14} /></button>
                </div>
                <button className={btnIcon} onClick={() => setTopBarCollapsed(true)} title="Collapse performance window / zoom controls"><ChevronUp size={14} /></button>
              </div>
            </div>
            )
          )}
          {planogram.sections.length === 0 ? (
            <div className="text-sm text-slate-400 italic p-8 text-center">Add a section (e.g. a 48in / 4ft segment) to begin merchandising.</div>
          ) : (
            <div className="flex gap-0 items-start mx-auto" style={{ width: "fit-content" }}>
              {planogram.sections.map((section, idx) => (
                <div key={section.id} className="relative">
                  <SectionColumn
                    section={section}
                    index={idx}
                    total={planogram.sections.length}
                    planogram={planogram}
                    fixtures={fixtures}
                    products={products}
                    scale={scale}
                    readOnly={presentMode}
                    capacityWarningsEnabled={capacityWarningsEnabled}
                    hideImages={hideImages}
                    highlightField={highlightField}
                    zoomLevel={zoomLevel}
                    joinedLayouts={joinedLayouts}
                    onRename={(v) => renameSection(section.id, v)}
                    onResize={(v) => resizeSection(section.id, v)}
                    onSetBackboard={(v) => setSectionBackboard(section.id, v)}
                    onMove={(dir) => moveSection(idx, dir)}
                    onDelete={() => deleteSection(section.id)}
                    onAddFixture={() => setSelectedSectionForAdd(section.id)}
                    onDragFixture={(fxId, notchY) => updateFixtureInst(section.id, fxId, { notchY })}
                    onDragFixtureGroup={dragFixtureGroup}
                    onDropProductOnFixture={(fxId, productId, insertIndex, pegCoords) => addPlacement(section.id, fxId, productId, insertIndex, pegCoords)}
                    onMountFixture={(sourceSectionId, sourceFixtureId, targetFixtureId, xOffset, notchY) => mountFixtureOnPegboard(sourceSectionId, sourceFixtureId, section.id, targetFixtureId, xOffset, notchY)}
                    onMovePlacement={movePlacement}
                    onMoveGroup={moveGroupOnPegboard}
                    onMoveGroupToFixture={moveGroupToFixture}
                    performance={performance}
                    cutoffISO={cutoffISO}
                    storeId={activeStoreId}
                    schema={productSchema}
                    overlaySettings={overlaySettings}
                    selectedFixtureId={selectedFixtureId}
                    onSelectFixture={(id) => { setSelectedFixtureId(id === selectedFixtureId ? null : id); setSelectedPlacement(null); }}
                    selectedPlacementId={placementCtx?.pl?.id}
                    onSelectPlacement={(placementId) => {
                      const fx = section.fixtures.find((f) => f.placements.some((p) => p.id === placementId));
                      if (fx) { setSelectedPlacement({ sectionId: section.id, fixtureInstId: fx.id, placementId }); setSelectedFixtureId(null); }
                    }}
                    onDeselectAll={() => { setSelectedFixtureId(null); setSelectedPlacement(null); }}
                  />
                  {!presentMode && selectedSectionForAdd === section.id && (
                    <div className="absolute top-6 left-0 z-20">
                      <AddFixturePopover fixtures={fixtures} onClose={() => setSelectedSectionForAdd(null)} onAdd={(fx) => addFixtureToSection(section.id, fx)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {!presentMode && (
          rightPanelCollapsed ? (
            <button
              onClick={() => setRightPanelCollapsed(false)}
              className="shrink-0 w-6 flex items-start justify-center pt-3 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 no-print"
              title="Show details panel"
            >
              <ChevronLeft size={16} className="text-slate-400" />
            </button>
          ) : (
        <div className="w-72 shrink-0 space-y-3 no-print relative">
          <button
            onClick={() => setRightPanelCollapsed(true)}
            className="absolute -left-2.5 top-0 z-10 w-5 h-5 rounded-full bg-white border border-slate-300 flex items-center justify-center hover:bg-slate-50"
            title="Collapse details panel"
          >
            <ChevronRight size={12} className="text-slate-500" />
          </button>

          {summaryProductId && products.find((p) => p.id === summaryProductId) && (
            <ProductSummaryModal product={products.find((p) => p.id === summaryProductId)} schema={productSchema} planogram={planogram} products={products} fixtures={fixtures} performance={performance} cutoffISO={cutoffISO} storeId={activeStoreId} dosTargets={dosTargets} weeks={analysisWeeks} onClose={() => setSummaryProductId(null)} />
          )}
          {supplyReportOpen && (
            <SupplyReportModal planogram={planogram} products={products} performance={performance} cutoffISO={cutoffISO} storeId={activeStoreId} dosTargets={dosTargets} weeks={analysisWeeks} onClose={() => setSupplyReportOpen(false)} />
          )}
          {stackNotice && (
            <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-md bg-red-600 text-white text-xs font-semibold rounded-lg shadow-lg px-4 py-2.5 flex items-start gap-2 no-print">
              <AlertTriangle size={14} className="shrink-0 mt-px" />
              <span>{stackNotice}</span>
              <button onClick={() => setStackNotice("")} className="shrink-0 opacity-80 hover:opacity-100"><X size={13} /></button>
            </div>
          )}
          {placementCtx ? (
            <PlacementInspector
              placement={placementCtx.pl}
              product={placementCtx.product}
              metrics={placementCtx.metrics}
              weeks={analysisWeeks}
              isPegboard={fixtures.find((f) => f.id === placementCtx.fx.fixtureId)?.type === "Pegboard"}
              pegboardHeightIn={fixtures.find((f) => f.id === placementCtx.fx.fixtureId)?.dims?.h}
              products={products}
              clearanceIn={getShelfClearanceIn(planogram, placementCtx.sec, placementCtx.fx, fixtures)}
              shelfDepthIn={fixtures.find((f) => f.id === placementCtx.fx.fixtureId)?.dims?.d}
              dosTargetDays={getDosTargetDays(planogram.category || "", dosTargets, placementCtx.product)}
              onChange={(patch) => updatePlacement(placementCtx.sec.id, placementCtx.fx.id, placementCtx.pl.id, patch)}
              onRemove={() => removePlacement(placementCtx.sec.id, placementCtx.fx.id, placementCtx.pl.id)}
              onClose={() => setSelectedPlacement(null)}
            />
          ) : fixtureCtx ? (
            <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-bold text-sm text-slate-800">Fixture Position</h4>
                <button onClick={() => setSelectedFixtureId(null)} className="text-slate-400 hover:text-slate-600"><X size={15} /></button>
              </div>
              {fixtureCtx.fx.mountedOnId && (
                <div className="flex items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 text-xs text-amber-700">
                  <span>Mounted on a pegboard — position below is relative to that panel.</span>
                  <button
                    className="shrink-0 font-semibold hover:underline"
                    onClick={() => unmountFixture(fixtureCtx.section.id, fixtureCtx.fx.id)}
                  >
                    Detach
                  </button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field label={fixtureCtx.fx.mountedOnId ? "Notch Y (in from panel base)" : "Notch Y (in from base)"}>
                  <input type="number" step="1" className={inputCls} value={fixtureCtx.fx.notchY} onChange={(e) => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { notchY: Math.round(Number(e.target.value)) || 0 })} />
                </Field>
                <Field label={fixtureCtx.fx.mountedOnId ? "X Offset (in, on panel)" : "X Offset (in)"}>
                  <input type="number" step="1" className={inputCls} value={fixtureCtx.fx.xOffset} onChange={(e) => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { xOffset: Math.round(Number(e.target.value)) || 0 })} />
                </Field>
              </div>

              {!fixtureCtx.fx.mountedOnId && fixtures.find((f) => f.id === fixtureCtx.fx.fixtureId)?.type !== "Pegboard" && (
                <Field label="Max merchandise height (in, blank = up to the shelf above)">
                  <input
                    type="number" min="0" step="0.5" className={inputCls}
                    value={fixtureCtx.fx.merchHeightIn ?? ""}
                    onChange={(e) => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { merchHeightIn: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                  />
                </Field>
              )}
              {!fixtureCtx.fx.mountedOnId && fixtures.find((f) => f.id === fixtureCtx.fx.fixtureId)?.type !== "Pegboard" && (
                <button
                  className={btnGhost + " w-full justify-center"}
                  title="Turn on automatic stacking for every product on this shelf"
                  onClick={() => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { placements: fixtureCtx.fx.placements.map((pl) => ({ ...pl, autoStack: true })) })}
                >
                  <Layers size={13} /> Auto-stack this shelf
                </button>
              )}

              <button
                className={btnGhost + " w-full justify-center"}
                onClick={() => copyFixture(fixtureCtx.section.id, fixtureCtx.fx)}
              >
                <Copy size={13} /> Copy Fixture
              </button>

              <div>
                <label className={labelCls}>Facing Alignment</label>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    onClick={() => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { alignment: "left" })}
                    className={`flex flex-col items-center gap-1 text-[11px] rounded-md py-1.5 border font-medium ${(fixtureCtx.fx.alignment || "left") === "left" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  >
                    <AlignLeft size={14} /> Left
                  </button>
                  <button
                    onClick={() => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { alignment: "spread" })}
                    className={`flex flex-col items-center gap-1 text-[11px] rounded-md py-1.5 border font-medium ${fixtureCtx.fx.alignment === "spread" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  >
                    <AlignCenter size={14} /> Spread
                  </button>
                  <button
                    onClick={() => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { alignment: "right" })}
                    className={`flex flex-col items-center gap-1 text-[11px] rounded-md py-1.5 border font-medium ${fixtureCtx.fx.alignment === "right" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  >
                    <AlignRight size={14} /> Right
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">How facings pack across this shelf's width.</p>
                <button
                  className="text-xs text-amber-600 font-medium hover:underline mt-1.5"
                  onClick={() => applyAlignmentToAllFixtures(fixtureCtx.fx.alignment || "left")}
                >
                  Apply to all shelves in this planogram
                </button>
              </div>

              <div className="border-t border-slate-100 pt-3">
                <label className={labelCls}>Join Fixture</label>
                <p className="text-[11px] text-slate-400 mb-2">Lets facings flow onto a neighboring section's shelf at the same height, instead of overflowing. Always your choice — never automatic.</p>
                {(() => {
                  const fxDef = fixtures.find((f) => f.id === fixtureCtx.fx.fixtureId);
                  const spansSection = fxDef && fxDef.dims.w >= fixtureCtx.section.width;
                  return !spansSection ? (
                    <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mb-2">
                      This fixture ({fxDef ? fxDef.dims.w : "?"}in) is narrower than its section ({fixtureCtx.section.width}in) — joining will still leave a visible gap on this side, even flush at the left edge.
                    </div>
                  ) : null;
                })()}
                {fixtureCtx.fx.groupId ? (
                  <button className={btnDanger} onClick={() => unjoinFixture(fixtureCtx.section.id, fixtureCtx.fx.id)}>
                    <X size={13} /> Unjoin this shelf
                  </button>
                ) : fixtureCtx.joinCandidates.length > 0 ? (
                  <div className="space-y-1.5">
                    {fixtureCtx.joinCandidates.map((cand) => (
                      <button
                        key={cand.fx.id}
                        className={btnGhost + " w-full justify-center"}
                        onClick={() => joinFixtures(fixtureCtx.fx, cand.fx)}
                      >
                        Join with "{cand.section.name}" shelf at this height
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-slate-400 italic">No fixture at this same height in an adjacent section yet.</p>
                )}
              </div>

              <div className="border-t border-slate-100 pt-3">
                <label className={labelCls}>Merchandise a product</label>
                {fixtures.find((f) => f.id === fixtureCtx.fx.fixtureId)?.type === "Pegboard" ? (
                  <p className="text-[11px] text-slate-400 italic">
                    Pegboards don't use this — every product needs its own peg position. Drag a product from the library and drop it directly onto the panel wherever you want it to hang.
                  </p>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <select className={inputCls} value={quickAddProductId} onChange={(e) => setQuickAddProductId(e.target.value)}>
                        {products.length === 0 && <option value="">No products yet</option>}
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <button className={btnPrimary} disabled={!quickAddProductId} onClick={() => quickAddProduct(fixtureCtx.section.id, fixtureCtx.fx.id)}><Plus size={14} /></button>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Adds one facing; click the product on the shelf to set orientation, rotation & facing count.</p>
                  </>
                )}
              </div>

              <button className={btnDanger + " w-full justify-center"} onClick={() => deleteFixture(fixtureCtx.section.id, fixtureCtx.fx.id)}><Trash2 size={13} /> Remove fixture</button>
            </div>
          ) : (
            <div className="bg-white border border-dashed border-slate-300 rounded-lg p-4 text-sm text-slate-400">
              <Ruler size={16} className="mb-1.5 text-slate-300" />
              Click a fixture bar to reposition it, or click a product facing to change its orientation and rotation.
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-lg p-3 text-xs text-slate-500 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-slate-600"><Grid3x3 size={13} /> Legend</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-slate-400 inline-block rounded-sm" /> Fixture / shelf</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-slate-700/80 inline-block rounded-sm" /> Base / kick plate</div>
            <div className="flex items-center gap-2"><span className="w-3 h-3 border border-red-400 inline-block rounded-sm" /> Overflows fixture width</div>
          </div>
        </div>
          )
        )}
      </div>
    </div>
    </LinkedProductContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Root application                                                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Store Assistant — the standalone-feeling module store teams use to   */
/* see what needs to be executed. Phase 1: navigation shell, a store    */
/* selector standing in for real store-user login, and My Activities    */
/* wired to the real Pending/Live planogram lifecycle data. Execution   */
/* status and issues are stored directly on the planogram (keyed by     */
/* store id) so they ride the exact same persistence path as everything */
/* else here — no new backend table needed for this phase.              */
/* ------------------------------------------------------------------ */

function StoreSelectorScreen({ stores, onSelectStore, onExitToPlanner, onSignOut }) {
  const [query, setQuery] = useState("");
  const filtered = stores.filter((s) => (s.name + " " + (s.storeNumber || "")).toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm">T</div>
          <span className="font-bold text-slate-800">Store Assistant</span>
        </div>
        <p className="text-sm text-slate-500 mb-4">Select your store to see what needs to be executed.</p>
        <input className={inputCls + " mb-3"} placeholder="Search stores…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <div className="max-h-80 overflow-y-auto space-y-1.5">
          {filtered.map((s) => (
            <button key={s.id} onClick={() => onSelectStore(s.id)} className="w-full text-left border border-slate-200 rounded-lg px-3 py-2 hover:border-amber-400 hover:bg-amber-50/50">
              <div className="font-medium text-sm text-slate-800">{s.name}</div>
              <div className="text-xs text-slate-400">#{s.storeNumber || "—"}{s.address ? ` · ${s.address}` : ""}</div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-slate-400 italic text-center py-4">
              {stores.length === 0 ? "No stores set up yet — add some from Tandom Studio first." : "No matches."}
            </p>
          )}
        </div>
        {onExitToPlanner && <button onClick={onExitToPlanner} className="text-xs text-slate-400 hover:underline mt-4">← Back to Tandom Studio</button>}
        {onSignOut && <button onClick={onSignOut} className="text-xs text-slate-400 hover:underline mt-4 block">Sign out</button>}
      </div>
    </div>
  );
}

const STORE_EXECUTION_STATUS_ORDER = ["new", "reviewed", "in_progress", "partially_completed", "completed", "rejected"];

function MyStoreView({ store, planograms }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState("eventDate");
  const [sortDir, setSortDir] = useState("asc");
  const [columnWidths, setColumnWidths] = useState({});
  const resizingRef = useRef(null);

  const handleColumnResizeStart = (e, colId, defaultWidth) => {
    e.preventDefault();
    resizingRef.current = { colId, startX: e.clientX, startWidth: columnWidths[colId] || defaultWidth };
    const handleMove = (e2) => {
      const d = resizingRef.current;
      if (!d) return;
      const nextWidth = Math.max(60, d.startWidth + (e2.clientX - d.startX));
      setColumnWidths((prev) => ({ ...prev, [d.colId]: nextWidth }));
    };
    const handleUp = () => {
      resizingRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  const sortHeader = (key, label, defaultWidth) => (
    <th
      className="relative px-3 py-2 overflow-hidden"
      style={{ width: columnWidths[key] || defaultWidth }}
    >
      <button onClick={() => handleSort(key)} className={`flex items-center gap-0.5 text-left font-semibold uppercase tracking-wide whitespace-nowrap ${sortKey === key ? "text-amber-600" : "text-slate-500"}`}>
        {label}
        {sortKey === key && (sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
      </button>
      <div onMouseDown={(e) => handleColumnResizeStart(e, key, defaultWidth)} className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-amber-400/60 active:bg-amber-500" />
    </th>
  );

  // Only current Live and Pending planograms — this list automatically updates as the
  // lifecycle moves: completing a Pending planogram promotes it to Live (see
  // completeStoreExecution), and the sibling that WAS Live drops off this list the moment it's
  // retired to Historical, since Historical is never included here.
  const q = query.trim().toLowerCase();
  const assigned = planograms
    .filter((p) => (p.storeIds || []).includes(store.id))
    .filter((p) => ["pending", "live"].includes(effectivePlanogramStatus(p)))
    .filter((p) => !q || (p.name + " " + (p.category || "")).toLowerCase().includes(q))
    .sort((a, b) => {
      let cmp;
      if (sortKey === "category") cmp = (a.category || "").localeCompare(b.category || "");
      else if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "eventDate") cmp = (a.eventDate || "9999-99-99").localeCompare(b.eventDate || "9999-99-99");
      else if (sortKey === "status") cmp = PLANOGRAM_STATUSES.indexOf(effectivePlanogramStatus(a)) - PLANOGRAM_STATUSES.indexOf(effectivePlanogramStatus(b));
      else if (sortKey === "storeStatus") cmp = STORE_EXECUTION_STATUS_ORDER.indexOf(a.execution?.[store.id]?.status || "new") - STORE_EXECUTION_STATUS_ORDER.indexOf(b.execution?.[store.id]?.status || "new");
      else cmp = 0;
      return sortDir === "asc" ? cmp : -cmp;
    });

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800 mb-4">My Store</h2>
      <div className="bg-white border border-slate-200 rounded-lg px-5 py-3 mb-6 flex flex-wrap items-center gap-x-8 gap-y-2">
        <div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Store Name</div>
          <div className="text-sm text-slate-800 font-medium whitespace-nowrap">{store.name}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Store #</div>
          <div className="text-sm text-slate-800 font-mono whitespace-nowrap">#{store.storeNumber || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Address</div>
          <div className="text-sm text-slate-800 whitespace-nowrap">{store.address || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Region</div>
          <div className="text-sm text-slate-800 whitespace-nowrap">{store.region || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Format</div>
          <div className="text-sm text-slate-800 whitespace-nowrap">{store.format || "—"}</div>
        </div>
        {store.squareFootage ? (
          <div>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Sq Ft</div>
            <div className="text-sm text-slate-800 whitespace-nowrap">{store.squareFootage.toLocaleString()}</div>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-slate-700">Assigned Planograms</h3>
        {planograms.length > 0 && (
          <div className="relative w-56">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className={inputCls + " pl-8 py-1 text-xs"} placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
      </div>
      {assigned.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">
          {query ? `No assigned planograms match "${query}".` : "No planograms currently assigned to this store."}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="text-xs" style={{ tableLayout: "fixed", width: "100%", minWidth: 640 }}>
            <colgroup>
              <col style={{ width: columnWidths.category || 130 }} />
              <col style={{ width: columnWidths.name || 220 }} />
              <col style={{ width: columnWidths.status || 110 }} />
              <col style={{ width: columnWidths.eventDate || 120 }} />
              <col style={{ width: columnWidths.storeStatus || 130 }} />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                {sortHeader("category", "Category", 130)}
                {sortHeader("name", "Planogram Name", 220)}
                {sortHeader("status", "Status", 110)}
                {sortHeader("eventDate", "Event Date", 120)}
                {sortHeader("storeStatus", "Store Status", 130)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {assigned.map((p) => {
                const exec = p.execution?.[store.id]?.status || "new";
                return (
                  <tr key={p.id}>
                    <td className="px-3 py-2 text-slate-600 overflow-hidden text-ellipsis whitespace-nowrap">{p.category || "—"}</td>
                    <td className="px-3 py-2 font-medium text-slate-800 overflow-hidden text-ellipsis whitespace-nowrap">
                      {p.name}
                      {p.masterId && <span className="ml-1.5 text-[10px] font-mono font-semibold text-slate-400 border border-slate-200 rounded px-1">v{p.versionNumber || 1}</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap"><PlanogramStatusBadge status={effectivePlanogramStatus(p)} /></td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{p.eventDate || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap"><StoreExecutionStatusBadge status={exec} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MyActivitiesView({ store, planograms, products, fixtures, onSetExecutionStatus, onCompleteExecution, onMarkReviewed, onToggleItemCheck, onAddIssue, onTaskSynced }) {
  const [reportingFor, setReportingFor] = useState(null); // planogram id currently showing the feedback form
  const [issueType, setIssueType] = useState(ISSUE_TYPES[0].id);
  const [issueText, setIssueText] = useState("");
  const [rejectingFor, setRejectingFor] = useState(null); // planogram id currently showing the reject-explanation form
  const [rejectReason, setRejectReason] = useState("");
  const [viewingGuideFor, setViewingGuideFor] = useState(null); // planogram currently showing the execution guide

  const activities = planograms
    .filter((p) => (p.storeIds || []).includes(store.id))
    .filter((p) => ["pending", "live"].includes(effectivePlanogramStatus(p)))
    .sort((a, b) => (a.eventDate || "9999-99-99").localeCompare(b.eventDate || "9999-99-99"));

  const submitIssue = (planogramId) => {
    if (!issueText.trim()) return;
    onAddIssue(planogramId, store.id, store.name, issueType, issueText.trim());
    setIssueType(ISSUE_TYPES[0].id);
    setIssueText("");
    setReportingFor(null);
  };

  const submitReject = (planogramId) => {
    if (!rejectReason.trim()) return;
    onSetExecutionStatus(planogramId, store.id, "rejected", rejectReason.trim());
    setRejectReason("");
    setRejectingFor(null);
  };

  const openInstructions = (p) => {
    onMarkReviewed(p.id, store.id); // "anything opened will be Reviewed" — a no-op if already past New
    setViewingGuideFor(p);
  };

  if (viewingGuideFor) {
    // re-find the live copy so this reflects checks/status made while the guide is open
    const current = planograms.find((p) => p.id === viewingGuideFor.id) || viewingGuideFor;
    return (
      <PlanogramExecutionGuide
        planogram={current}
        products={products}
        fixtures={fixtures}
        allPlanograms={planograms}
        storeId={store.id}
        onToggleItemCheck={onToggleItemCheck}
        onBack={() => setViewingGuideFor(null)}
        askTandom={<AskTandomLauncher onTaskSynced={onTaskSynced} storeId={store.id} storeName={store.name} planogram={{ id: current.id, name: current.name || "Untitled planogram" }} />}
      />
    );
  }

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800 mb-1">My Activities</h2>
      <p className="text-sm text-slate-500 mb-4">Planograms assigned to {store.name} that need to be executed.</p>
      {activities.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          Nothing needs execution right now — you're all caught up.
        </div>
      ) : (
        <div className="space-y-3">
          {activities.map((p) => {
            const status = effectivePlanogramStatus(p);
            const exec = p.execution?.[store.id]?.status || "new";
            const isFinal = exec === "completed" || exec === "rejected";
            const openIssues = (p.issues || []).filter((i) => i.storeId === store.id && i.status === "open");
            return (
              <div key={p.id} className="bg-white border border-slate-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                      {p.name}
                      {p.masterId && <span className="text-[10px] font-mono font-semibold text-slate-400 border border-slate-200 rounded px-1">v{p.versionNumber || 1}</span>}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-3">
                      {p.eventDate && <span className="flex items-center gap-1"><CalendarDays size={11} /> Event: {p.eventDate}</span>}
                      {p.category && <span>{p.category}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <PlanogramStatusBadge status={status} />
                    <StoreExecutionStatusBadge status={exec} />
                  </div>
                </div>
                {exec === "rejected" && p.execution?.[store.id]?.rejectionReason && (
                  <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                    <span className="font-semibold">Rejected:</span> {p.execution[store.id].rejectionReason}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button className={btnGhost} onClick={() => openInstructions(p)}><Layers size={13} /> View Planogram</button>
                  {!isFinal && (
                    <>
                      <button className={btnPrimary} onClick={() => onCompleteExecution(p.id, store.id)}><Check size={13} /> Mark Complete</button>
                      <button className={btnGhost} onClick={() => onSetExecutionStatus(p.id, store.id, "partially_completed")}>Mark Partially Completed</button>
                      <button className="text-xs text-red-600 font-medium hover:underline" onClick={() => setRejectingFor(rejectingFor === p.id ? null : p.id)}>Reject</button>
                    </>
                  )}
                  {isFinal && (
                    <button className="text-xs text-slate-400 hover:underline" onClick={() => onSetExecutionStatus(p.id, store.id, "in_progress")}>Reopen</button>
                  )}
                  <button className="text-xs text-red-500 font-medium hover:underline flex items-center gap-1" onClick={() => setReportingFor(reportingFor === p.id ? null : p.id)}>
                    <AlertTriangle size={11} /> Report Store Feedback
                  </button>
                </div>
                {rejectingFor === p.id && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <label className={labelCls}>Reason for rejecting (required)</label>
                    <textarea
                      className={inputCls + " text-sm"}
                      rows={2}
                      placeholder="Explain why this reset can't be executed as planned…"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      autoFocus
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button className={btnGhost} onClick={() => { setRejectingFor(null); setRejectReason(""); }}>Cancel</button>
                      <button className={btnDanger} disabled={!rejectReason.trim()} onClick={() => submitReject(p.id)}>Confirm Reject</button>
                    </div>
                  </div>
                )}
                {reportingFor === p.id && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <label className={labelCls}>Feedback Type</label>
                    <select className={inputCls + " mb-2"} value={issueType} onChange={(e) => setIssueType(e.target.value)}>
                      {ISSUE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    <textarea
                      className={inputCls + " text-sm"}
                      rows={3}
                      placeholder="Describe the condition affecting this planogram or reset…"
                      value={issueText}
                      onChange={(e) => setIssueText(e.target.value)}
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button className={btnGhost} onClick={() => { setReportingFor(null); setIssueText(""); }}>Cancel</button>
                      <button className={btnPrimary} disabled={!issueText.trim()} onClick={() => submitIssue(p.id)}>Submit</button>
                    </div>
                  </div>
                )}
                {openIssues.length > 0 && (
                  <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    {openIssues.length} open feedback item{openIssues.length !== 1 ? "s" : ""} reported for this planogram
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StoreFeedbackViewSA({ store, planograms }) {
  const issues = [];
  planograms.forEach((p) => {
    (p.issues || []).filter((i) => i.storeId === store.id).forEach((i) => issues.push({ ...i, planogramName: p.name }));
  });
  issues.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800 mb-1">Store Feedback</h2>
      <p className="text-sm text-slate-500 mb-4">Conditions you've reported to space planners.</p>
      {issues.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No feedback reported yet.
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((i) => (
            <div key={i.id} className="bg-white border border-slate-200 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm text-slate-800">{i.planogramName}</span>
                <span className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border ${i.status === "resolved" ? "bg-emerald-50 text-emerald-700 border-emerald-300" : "bg-amber-50 text-amber-700 border-amber-300"}`}>
                  {i.status === "resolved" ? "Resolved" : "Open"}
                </span>
              </div>
              {i.type && <div className="text-[10px] text-slate-400 mt-0.5">{ISSUE_TYPES.find((t) => t.id === i.type)?.label || i.type}</div>}
              <p className="text-sm text-slate-600 mt-1">{i.message}</p>
              <div className="text-xs text-slate-400 mt-1">{new Date(i.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StoreAssistantComingSoon({ title }) {
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800 mb-1">{title}</h2>
      <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center mt-3">
        {title} is coming in a future update.
      </div>
    </div>
  );
}

// Store Assistant Task Management — day-to-day operational tasks a store creates for itself,
// distinct from My Activities (which is specifically about planogram resets). This is the
// default seed for a customizable list, kept and persisted the same way Event Types are.
const DEFAULT_TASK_TYPES = [
  { id: "inventory_audit", label: "Inventory Audit" },
  { id: "pricing_audit", label: "Pricing Audit" },
  { id: "fronting_facing", label: "Fronting and Facing" },
  { id: "restocking", label: "Restocking" },
  { id: "damaged_goods", label: "Damaged Good Processing" },
  { id: "reset_followup", label: "Reset Follow-up" },
  { id: "other", label: "Other" },
];

function TaskTypeManagerModal({ taskTypes, onSave, onClose }) {
  const [draft, setDraft] = useState(taskTypes);
  const addType = () => setDraft((prev) => [...prev, { id: uid("ttype"), label: "New Task Type" }]);
  const updateType = (id, label) => setDraft((prev) => prev.map((t) => (t.id === id ? { ...t, label } : t)));
  const removeType = (id) => setDraft((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="max-w-md w-full bg-white rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-800 mb-3">Manage Task Types</h3>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {draft.map((t) => (
            <div key={t.id} className="flex items-center gap-2">
              <input className={inputCls + " text-xs"} value={t.label} onChange={(e) => updateType(t.id, e.target.value)} />
              <button onClick={() => removeType(t.id)} className="text-slate-300 hover:text-red-500 shrink-0" title="Remove type"><X size={16} /></button>
            </div>
          ))}
          {draft.length === 0 && <p className="text-xs text-slate-400 italic">No task types — add at least one.</p>}
        </div>
        <button onClick={addType} className="text-xs text-amber-600 font-medium hover:underline mt-3 flex items-center gap-1"><Plus size={12} /> Add Type</button>
        <div className="flex justify-end gap-2 mt-4">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={draft.length === 0} onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
}

const PHOTO_PURPOSES = [
  { id: "compliance", label: "Compliance Photo" },
  { id: "issue", label: "Issue" },
  { id: "request", label: "Request" },
];

// Shared read-only grid + filters + lightbox, used by both the Photo Collection (management)
// and Photo Gallery (browse-only) tabs so the two stay visually identical apart from whether
// upload/delete controls are present.
// Store Assistant Task Management — a store creates and tracks its own operational tasks
// (inventory audits, pricing audits, restocking, etc.), separate from planogram execution.
// Tasks are stored on the store entity, the same way photos and issues already are here.
function TaskManagementView({ store, taskTypes, onAddTask, onUpdateTask, onDeleteTask, onUpdateTaskTypes }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null); // task being edited in the shared form, or null when adding
  const [taskType, setTaskType] = useState(taskTypes[0]?.id || "");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [filterStatus, setFilterStatus] = useState("open"); // open | all | completed
  const [managingTypes, setManagingTypes] = useState(false);

  const tasks = (store.tasks || []).slice().sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
  const filtered = tasks.filter((t) => filterStatus === "all" || t.status === filterStatus);

  const cancelAdd = () => {
    setShowAdd(false);
    setEditingId(null);
    setTaskType(taskTypes[0]?.id || "");
    setDescription("");
    setDueDate("");
  };

  const startEdit = (task) => {
    setEditingId(task.id);
    setTaskType(task.type || taskTypes[0]?.id || "");
    setDescription(task.description || "");
    setDueDate(task.dueDate || "");
    setShowAdd(true);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { /* ignore */ }
  };

  const submitAdd = () => {
    if (!description.trim()) return;
    if (editingId) {
      const existing = (store.tasks || []).find((t) => t.id === editingId);
      if (existing) onUpdateTask(store.id, { ...existing, type: taskType, description: description.trim(), dueDate });
      cancelAdd();
      return;
    }
    onAddTask(store.id, {
      id: uid("task"),
      type: taskType,
      description: description.trim(),
      dueDate,
      status: "open",
      createdAt: new Date().toISOString(),
      completedAt: null,
    });
    cancelAdd();
  };

  const toggleComplete = (task) => {
    onUpdateTask(store.id, {
      ...task,
      status: task.status === "completed" ? "open" : "completed",
      completedAt: task.status === "completed" ? null : new Date().toISOString(),
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-slate-800">Task Management</h2>
        <div className="flex items-center gap-2">
          <button className={btnGhost} onClick={() => setManagingTypes(true)}><Settings2 size={14} /> Manage Types</button>
          <button className={btnPrimary} onClick={() => { if (showAdd) cancelAdd(); else setShowAdd(true); }}><Plus size={14} /> Add Task</button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">Day-to-day operational tasks for {store.name}.</p>

      {showAdd && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 space-y-3">
          {editingId && <div className="text-xs font-semibold text-amber-700">Editing task</div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Task Type">
              <select className={inputCls} value={taskType} onChange={(e) => setTaskType(e.target.value)}>
                {taskType && !taskTypes.some((t) => t.id === taskType) && <option value={taskType}>{taskType === "reset_followup" ? "Reset Follow-up" : taskType}</option>}
                {taskTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Due Date (optional)">
              <input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Description">
            <textarea
              className={inputCls}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Count backstock for aisle 4"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={cancelAdd}>Cancel</button>
            <button className={btnPrimary} disabled={!description.trim()} onClick={submitAdd}>{editingId ? "Save Changes" : "Add Task"}</button>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <select className={inputCls + " w-auto text-xs py-1"} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="all">All</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">No tasks yet.</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">Nothing matches this filter.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((task) => (
            <div key={task.id} className="bg-white border border-slate-200 rounded-lg p-3 flex items-start gap-3">
              <input
                type="checkbox"
                checked={task.status === "completed"}
                onChange={() => toggleComplete(task)}
                className="accent-amber-500 w-4 h-4 mt-0.5 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-slate-100 text-slate-600 border border-slate-200">
                    {taskTypes.find((t) => t.id === task.type)?.label || (task.type === "reset_followup" ? "Reset Follow-up" : task.type)}
                  </span>
                  {task.dueDate && <span className="text-[10px] text-slate-400 flex items-center gap-1"><CalendarDays size={10} /> Due {task.dueDate}</span>}
                </div>
                <p className={`text-sm mt-1 ${task.status === "completed" ? "line-through text-slate-400" : "text-slate-800"}`}>{task.description}</p>
              </div>
              <button className="text-xs text-slate-600 font-medium hover:underline shrink-0" onClick={() => startEdit(task)}>Edit</button>
              <button className="text-xs text-red-500 font-medium hover:underline shrink-0" onClick={() => onDeleteTask(store.id, task.id)}>Delete</button>
            </div>
          ))}
        </div>
      )}

      {managingTypes && (
        <TaskTypeManagerModal
          taskTypes={taskTypes}
          onSave={(next) => { onUpdateTaskTypes(next); setManagingTypes(false); }}
          onClose={() => setManagingTypes(false)}
        />
      )}
    </div>
  );
}

function PhotoGrid({ photos, categories, showDelete, onDeletePhoto }) {
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterPurpose, setFilterPurpose] = useState("All");
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [viewMode, setViewMode] = useState("grid"); // grid | list

  const filteredPhotos = photos
    .filter((p) => filterCategory === "All" || p.category === filterCategory)
    .filter((p) => filterPurpose === "All" || p.purpose === filterPurpose);

  return (
    <>
      {photos.length > 0 && (
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <div className="flex items-center gap-2">
            <select className={inputCls + " w-auto text-xs py-1"} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="All">All Categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className={inputCls + " w-auto text-xs py-1"} value={filterPurpose} onChange={(e) => setFilterPurpose(e.target.value)}>
              <option value="All">All Types</option>
              {PHOTO_PURPOSES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="flex items-center rounded-full border border-slate-300 p-0.5 bg-white">
            <button
              onClick={() => setViewMode("grid")}
              className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "grid" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
            >
              Grid
            </button>
            <button
              onClick={() => setViewMode("list")}
              title="List view — more compact for browsing many photos"
              className={`text-xs font-medium rounded-full px-3 py-1 ${viewMode === "list" ? "bg-amber-500 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
            >
              List
            </button>
          </div>
        </div>
      )}

      {photos.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No photos uploaded yet.
        </div>
      ) : filteredPhotos.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No photos match this filter.
        </div>
      ) : viewMode === "list" ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="w-14 px-3 py-2"></th>
                <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Category</th>
                <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Type</th>
                <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Execution Date</th>
                <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">Uploaded</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredPhotos.map((photo) => (
                <tr key={photo.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <button className="block w-10 h-10 rounded border border-slate-200 bg-slate-50 overflow-hidden" onClick={() => setLightboxPhoto(photo)}>
                      <img src={photo.imageData} alt={photo.category} className="w-full h-full object-cover" />
                    </button>
                  </td>
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{photo.category}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{PHOTO_PURPOSES.find((p) => p.id === photo.purpose)?.label || photo.purpose}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{photo.executionDate || "—"}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{new Date(photo.uploadedAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {showDelete && <button className="text-xs text-red-500 font-medium hover:underline" onClick={() => onDeletePhoto(photo.id)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filteredPhotos.map((photo) => (
            <div key={photo.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <button className="block w-full aspect-square bg-slate-50" onClick={() => setLightboxPhoto(photo)}>
                <img src={photo.imageData} alt={photo.category} className="w-full h-full object-cover" />
              </button>
              <div className="p-2">
                <div className="text-xs font-medium text-slate-800 truncate">{photo.category}</div>
                <div className="text-[10px] text-slate-400 truncate">{PHOTO_PURPOSES.find((p) => p.id === photo.purpose)?.label || photo.purpose}</div>
                {photo.executionDate && <div className="text-[10px] text-slate-400">Executed {photo.executionDate}</div>}
                <div className="text-[10px] text-slate-400">Uploaded {new Date(photo.uploadedAt).toLocaleDateString()}</div>
                {showDelete && <button className="text-[10px] text-red-500 font-medium hover:underline mt-1" onClick={() => onDeletePhoto(photo.id)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {lightboxPhoto && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6" onClick={() => setLightboxPhoto(null)}>
          <div className="max-w-2xl max-h-full w-full bg-white rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxPhoto.imageData} alt={lightboxPhoto.category} className="max-h-[65vh] w-full object-contain bg-slate-100" />
            <div className="p-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-slate-800">{lightboxPhoto.category}</div>
                <div className="text-xs text-slate-400">
                  {PHOTO_PURPOSES.find((p) => p.id === lightboxPhoto.purpose)?.label || lightboxPhoto.purpose}
                  {lightboxPhoto.executionDate && ` · Executed ${lightboxPhoto.executionDate}`}
                  {" · Uploaded "}{new Date(lightboxPhoto.uploadedAt).toLocaleString()}
                </div>
              </div>
              <button className={btnGhost} onClick={() => setLightboxPhoto(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Store Assistant "Photo Collection" — where a store uploads a photo of the finished reset (or
// an issue/request photo) as the final step of execution, tagged with a planogram category,
// what the photo represents, and the date it was executed. Also where all uploaded photos are
// browsed (grid or list) — a separate "gallery" tab would just show the same history twice, so
// this one tab covers both uploading and reviewing. Photos are stored on the store entity, not
// a new backend kind.
function PhotoCollectionView({ store, planograms, onAddPhoto, onDeletePhoto }) {
  const [showUpload, setShowUpload] = useState(false);
  const [pendingFile, setPendingFile] = useState(null); // { name, dataUrl }
  const [category, setCategory] = useState("");
  const [purpose, setPurpose] = useState("compliance");
  const [executionDate, setExecutionDate] = useState(() => todayISO());
  const fileInputRef = useRef(null);

  const categories = Array.from(new Set(
    planograms.filter((p) => (p.storeIds || []).includes(store.id)).map((p) => p.category).filter(Boolean)
  )).sort();

  const photos = (store.photos || []).slice().sort((a, b) => (b.uploadedAt || "").localeCompare(a.uploadedAt || ""));

  const handleFileChosen = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingFile({ name: file.name, dataUrl: reader.result });
    reader.readAsDataURL(file);
  };

  const cancelUpload = () => {
    setShowUpload(false);
    setPendingFile(null);
    setCategory("");
    setPurpose("compliance");
    setExecutionDate(todayISO());
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const submitUpload = () => {
    if (!pendingFile || !category) return;
    onAddPhoto(store.id, {
      id: uid("photo"),
      category,
      purpose,
      executionDate,
      imageData: pendingFile.dataUrl,
      fileName: pendingFile.name,
      uploadedAt: new Date().toISOString(),
    });
    cancelUpload();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-slate-800">Photo Collection</h2>
        <button className={btnPrimary} onClick={() => setShowUpload((s) => !s)}><Plus size={14} /> Upload Photo</button>
      </div>
      <p className="text-sm text-slate-500 mb-4">Upload and manage photos for {store.name}.</p>

      {showUpload && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 space-y-3">
          <div>
            <label className={labelCls}>Photo</label>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={(e) => handleFileChosen(e.target.files[0])} className="text-sm text-slate-600" />
            {pendingFile && (
              <div className="mt-2 w-28 h-28 rounded border border-slate-200 overflow-hidden">
                <img src={pendingFile.dataUrl} alt={pendingFile.name} className="w-full h-full object-cover" />
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Select Category</label>
              <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Choose a category…</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Photo Represents</label>
              <select className={inputCls} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                {PHOTO_PURPOSES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Execution Date</label>
              <input type="date" className={inputCls} value={executionDate} onChange={(e) => setExecutionDate(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={cancelUpload}>Cancel</button>
            <button className={btnPrimary} disabled={!pendingFile || !category} onClick={submitUpload}>Upload</button>
          </div>
        </div>
      )}

      <PhotoGrid photos={photos} categories={categories} showDelete onDeletePhoto={(photoId) => onDeletePhoto(store.id, photoId)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ask Tandom — chat assistant. Answers run server-side in the         */
/* ask-tandom Edge Function (read-only lookups); the one thing it can  */
/* do, mark a store task open/completed, is shown as a confirmation    */
/* card and only happens when the person presses Confirm.              */
/* ------------------------------------------------------------------ */

const ASK_TANDOM_SUGGESTIONS_STORE = [
  "What changes in my next reset?",
  "Which tasks are open?",
  "Where does the new product go?",
];
const ASK_TANDOM_SUGGESTIONS_THIS_STORE = [
  "What changes in this planogram?",
  "Where does each new product go?",
  "Summarize this planogram",
];
const ASK_TANDOM_SUGGESTIONS_THIS_PLANNER = [
  "Summarize this planogram",
  "What's different from the live version?",
  "What are the case packs of the products on it?",
];
const ASK_TANDOM_SUGGESTIONS_PLANNER = [
  "Which planograms go live soon?",
  "How do planogram versions work?",
  "What is the case pack for a product?",
];

function AskTandomPanel({ storeId, storeName, planogram, onTaskSynced, compact, onClose }) {
  const [messages, setMessages] = useState([]); // [{role, content, actions?: [{...action, state: "pending"|"working"|"done"|"dismissed"|"error", error?}]}]
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages, busy]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setError("");
    const next = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const data = await invokeEdgeFunction("ask-tandom", { messages: next.map((m) => ({ role: m.role, content: m.content })), storeId: storeId || undefined, planogramId: planogram?.id || undefined });
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply || "…", actions: (data.actions || []).map((a) => ({ ...a, state: "pending" })) }]);
    } catch (e) {
      setError(e?.message || "Ask Tandom couldn't answer just now.");
    } finally {
      setBusy(false);
    }
  };

  const setActionState = (mi, ai, patch) => setMessages((prev) => prev.map((m, i) => (i !== mi ? m : { ...m, actions: m.actions.map((a, j) => (j !== ai ? a : { ...a, ...patch })) })));

  const confirm = async (mi, ai) => {
    const a = messages[mi].actions[ai];
    setActionState(mi, ai, { state: "working", error: "" });
    try {
      const data = await invokeEdgeFunction("ask-tandom", { storeId: storeId || undefined, confirmAction: { type: a.type, storeId: a.storeId, taskId: a.taskId, status: a.toStatus } });
      setActionState(mi, ai, { state: "done" });
      if (onTaskSynced && data?.task) onTaskSynced(a.storeId, data.task);
    } catch (e) {
      setActionState(mi, ai, { state: "error", error: e?.message || "Couldn't update the task." });
    }
  };

  const suggestions = planogram ? (storeId ? ASK_TANDOM_SUGGESTIONS_THIS_STORE : ASK_TANDOM_SUGGESTIONS_THIS_PLANNER) : storeId ? ASK_TANDOM_SUGGESTIONS_STORE : ASK_TANDOM_SUGGESTIONS_PLANNER;

  return (
    <div className={`flex flex-col bg-white ${compact ? "h-full" : "border border-slate-200 rounded-lg h-[calc(100vh-8rem)] min-h-[360px]"}`}>
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2 shrink-0">
        <Sparkles size={16} className="text-amber-500" />
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-slate-800">Ask Tandom</div>
          <div className="text-[11px] text-slate-400 truncate">{storeName ? `Answering for ${storeName}` : "Answering across all planograms"}</div>
          {planogram && <div className="text-[11px] text-amber-700 truncate" title={planogram.name}>About: {planogram.name}</div>}
        </div>
        {messages.length > 0 && <button className="text-[11px] text-slate-400 hover:text-slate-600" onClick={() => { setMessages([]); setError(""); }}>New chat</button>}
        {onClose && <button className="text-slate-400 hover:text-slate-600" onClick={onClose} title="Close"><X size={16} /></button>}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div>
            <p className="text-sm text-slate-500 mb-3">Ask about resets, where products go, tasks, case packs, or how to do something in Tandom.{storeId ? " I can also mark a task done when you ask." : ""}</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((t) => (
                <button key={t} onClick={() => send(t)} className="text-xs rounded-full border border-amber-300 bg-amber-50 text-amber-800 px-3 py-1.5 hover:bg-amber-100">{t}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, mi) => (
          <div key={mi} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-800"}`}>
              {m.content}
              {(m.actions || []).map((a, ai) => (
                <div key={ai} className="mt-2 rounded-md border border-amber-300 bg-amber-50 text-slate-800 p-2.5 text-xs whitespace-normal">
                  <div className="font-semibold mb-0.5">Mark this task {a.toStatus === "completed" ? "completed" : "open"}?</div>
                  <div className="text-slate-600 mb-2">{a.taskDescription}{a.storeName ? ` · ${a.storeName}` : ""}</div>
                  {a.state === "pending" && (
                    <div className="flex gap-2">
                      <button className={btnPrimary + " !py-1 !text-xs"} onClick={() => confirm(mi, ai)}><Check size={12} /> Confirm</button>
                      <button className={btnGhost + " !py-1 !text-xs"} onClick={() => setActionState(mi, ai, { state: "dismissed" })}>Cancel</button>
                    </div>
                  )}
                  {a.state === "working" && <span className="text-slate-500 flex items-center gap-1"><RefreshCw size={11} className="animate-spin" /> Updating…</span>}
                  {a.state === "done" && <span className="text-emerald-700 font-medium">Done — task is now {a.toStatus}.</span>}
                  {a.state === "dismissed" && <span className="text-slate-400">Cancelled — nothing changed.</span>}
                  {a.state === "error" && (
                    <div className="text-red-600">{a.error} <button className="underline ml-1" onClick={() => confirm(mi, ai)}>Try again</button></div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {busy && <div className="flex justify-start"><div className="bg-slate-100 text-slate-500 rounded-lg px-3 py-2 text-sm flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Looking that up…</div></div>}
        {error && <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</div>}
        <div ref={endRef} />
      </div>
      <form className="px-3 py-3 border-t border-slate-200 flex gap-2 shrink-0" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input className={inputCls} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question…" disabled={busy} maxLength={1000} />
        <button type="submit" className={btnPrimary} disabled={busy || !input.trim()} title="Send"><Send size={14} /></button>
      </form>
    </div>
  );
}

// Planner-side launcher: a floating button that opens the same chat in a corner panel.
function AskTandomLauncher({ onTaskSynced, planogram, storeId, storeName }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="no-print">
      {open ? (
        <div className="fixed bottom-4 right-4 z-40 w-[26rem] max-w-[calc(100vw-2rem)] h-[34rem] max-h-[calc(100vh-2rem)] rounded-lg shadow-2xl border border-slate-300 overflow-hidden">
          <AskTandomPanel compact key={planogram?.id || "none"} planogram={planogram} storeId={storeId} storeName={storeName} onClose={() => setOpen(false)} onTaskSynced={onTaskSynced} />
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-amber-500 text-slate-900 font-semibold text-sm px-4 py-2.5 shadow-lg hover:bg-amber-400">
          <Sparkles size={16} /> Ask Tandom
        </button>
      )}
    </div>
  );
}

const STORE_ASSISTANT_NAV = [
  { id: "myStore", label: "My Store", icon: Store },
  { id: "myActivities", label: "My Activities", icon: Layers },
  { id: "taskManagement", label: "Task Management", icon: Check },
  { id: "storeFeedback", label: "Store Feedback", icon: AlertTriangle },
  { id: "photoCollection", label: "Photo Collection", icon: ImageIcon },
  { id: "askTandom", label: "Ask Tandom", icon: Sparkles },
];

function StoreAssistantModule({ isRegional, lockedStore, onSignOut, stores, planograms, products, fixtures, selectedStoreId, onSelectStore, onExitToPlanner, onSetExecutionStatus, onCompleteExecution, onMarkReviewed, onToggleItemCheck, onAddIssue, onAddPhoto, onDeletePhoto, onAddTask, onUpdateTask, onDeleteTask, onTaskSynced, taskTypes, onUpdateTaskTypes }) {
  const [section, setSection] = useState("myActivities");
  const store = stores.find((s) => s.id === selectedStoreId);

  if (!store) {
    return <StoreSelectorScreen stores={stores} onSelectStore={onSelectStore} onExitToPlanner={onExitToPlanner} onSignOut={onSignOut} />;
  }

  return (
    <div className="min-h-screen flex bg-slate-100">
      <div className="w-56 bg-slate-900 text-white flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-slate-800 flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm shrink-0">T</div>
          <span className="font-bold text-sm">Store Assistant</span>
        </div>
        <nav className="flex-1 py-2">
          {(isRegional ? [...STORE_ASSISTANT_NAV, { id: "escalations", label: "Escalations", icon: AlertTriangle }] : STORE_ASSISTANT_NAV).map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-left ${section === item.id ? "bg-slate-800 text-amber-400 border-r-2 border-amber-500" : "text-slate-300 hover:bg-slate-800/60"}`}
            >
              <item.icon size={16} /> {item.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-slate-800 space-y-2">
          <div className="text-xs">
            <div className="font-semibold text-slate-200">{store.name}</div>
            <div className="text-slate-400">#{store.storeNumber || "—"}</div>
          </div>
          {!lockedStore && (
            <button onClick={() => onSelectStore(null)} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
              <RefreshCw size={11} /> Switch store
            </button>
          )}
          {onExitToPlanner && (
            <button onClick={onExitToPlanner} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
              <LogOut size={11} /> Exit to Tandom Studio
            </button>
          )}
          {onSignOut && (
            <button onClick={onSignOut} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
              <LogOut size={11} /> Sign out
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 p-6 max-w-4xl">
        {section === "myStore" && <MyStoreView store={store} planograms={planograms} />}
        {section === "myActivities" && <MyActivitiesView store={store} planograms={planograms} products={products} fixtures={fixtures} onSetExecutionStatus={onSetExecutionStatus} onCompleteExecution={onCompleteExecution} onMarkReviewed={onMarkReviewed} onToggleItemCheck={onToggleItemCheck} onAddIssue={onAddIssue} onTaskSynced={onTaskSynced} />}
        {section === "taskManagement" && <TaskManagementView store={store} taskTypes={taskTypes} onAddTask={onAddTask} onUpdateTask={onUpdateTask} onDeleteTask={onDeleteTask} onUpdateTaskTypes={onUpdateTaskTypes} />}
        {section === "storeFeedback" && <StoreFeedbackViewSA store={store} planograms={planograms} />}
        {section === "photoCollection" && <PhotoCollectionView store={store} planograms={planograms} onAddPhoto={onAddPhoto} onDeletePhoto={onDeletePhoto} />}
        {section === "escalations" && <RegionalEscalationsView />}
        {section === "askTandom" && <AskTandomPanel storeId={store.id} storeName={store.name} onTaskSynced={onTaskSynced} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Event Planner — a separate module (like Store Assistant) for         */
/* category managers to schedule reset/promo/etc events on a calendar.  */
/* Connected to planograms via an optional link on each event. Events   */
/* and the customizable event-type list are both persisted as JSON      */
/* blobs through the generic settings store (safeGet/safeSet) — there's */
/* no dedicated "events" backend table, so this reuses the exact same   */
/* mechanism already used for the customizable product/fixture schemas. */
/* ------------------------------------------------------------------ */

const DEFAULT_EVENT_TYPES = [
  { id: "reset", label: "Reset", color: "#3b82f6" },
  { id: "promo", label: "Promo", color: "#f59e0b" },
  { id: "loyalty_campaign", label: "Loyalty Campaign", color: "#8b5cf6" },
  { id: "line_review", label: "Line Review", color: "#06b6d4" },
  { id: "vendor_collaboration", label: "Vendor Collaboration", color: "#10b981" },
  { id: "clearance", label: "Clearance", color: "#ef4444" },
  { id: "competitor_event", label: "Competitor Event", color: "#ec4899" },
  { id: "line_extensions", label: "Line Extensions", color: "#84cc16" },
];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function EventTypeManagerModal({ eventTypes, onSave, onClose }) {
  const [draft, setDraft] = useState(eventTypes);
  const addType = () => setDraft((prev) => [...prev, { id: uid("etype"), label: "New Type", color: hashColor(String(Math.random())) }]);
  const updateType = (id, patch) => setDraft((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const removeType = (id) => setDraft((prev) => prev.filter((t) => t.id !== id));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="max-w-md w-full bg-white rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-slate-800 mb-3">Manage Event Types</h3>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {draft.map((t) => (
            <div key={t.id} className="flex items-center gap-2">
              <input type="color" value={t.color} onChange={(e) => updateType(t.id, { color: e.target.value })} className="w-7 h-7 rounded border border-slate-200 shrink-0 cursor-pointer" />
              <input className={inputCls + " text-xs"} value={t.label} onChange={(e) => updateType(t.id, { label: e.target.value })} />
              <button onClick={() => removeType(t.id)} className="text-slate-300 hover:text-red-500 shrink-0" title="Remove type"><X size={16} /></button>
            </div>
          ))}
          {draft.length === 0 && <p className="text-xs text-slate-400 italic">No event types — add at least one.</p>}
        </div>
        <button onClick={addType} className="text-xs text-amber-600 font-medium hover:underline mt-3 flex items-center gap-1"><Plus size={12} /> Add Type</button>
        <div className="flex justify-end gap-2 mt-4">
          <button className={btnGhost} onClick={onClose}>Cancel</button>
          <button className={btnPrimary} disabled={draft.length === 0} onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Dynamic lead time: the date suppliers need to have everything ready by, computed as the
// event's start date minus its lead time in weeks. Recomputed live wherever it's shown — never
// stored — so editing either start date or lead time always keeps it correct automatically.
function getSupplierDeadline(event) {
  if (!event?.startDate) return null;
  return addDaysISO(event.startDate, -((event.leadTimeWeeks || 0) * 7));
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// Flags pairs of Promo events in the SAME assigned category whose date ranges overlap — if two
// date ranges overlap at all, they necessarily share at least one calendar week, which is what
// "scheduled during the same week" is checking for. Matches on the type id "promo" (stable even
// if someone has renamed the type's display label via Manage Types).
function findPromoConflicts(events) {
  const promos = events.filter((e) => e.type === "promo" && e.category && e.startDate && e.endDate);
  const conflicts = [];
  for (let i = 0; i < promos.length; i++) {
    for (let j = i + 1; j < promos.length; j++) {
      const a = promos[i], b = promos[j];
      if (a.category === b.category && rangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)) {
        conflicts.push([a, b]);
      }
    }
  }
  return conflicts;
}

function EventForm({ event, eventTypes, planograms, onSave, onCancel, onDelete }) {
  const [name, setName] = useState(event?.name || "");
  const [type, setType] = useState(event?.type || eventTypes[0]?.id || "");
  const [category, setCategory] = useState(event?.category || "");
  const [ownerId, setOwnerId] = useState(event?.ownerId || "");
  const [startDate, setStartDate] = useState(event?.startDate || todayISO());
  const [endDate, setEndDate] = useState(event?.endDate || todayISO());
  const [leadTimeWeeks, setLeadTimeWeeks] = useState(event?.leadTimeWeeks ?? 3);
  const [linkedPlanogramIds, setLinkedPlanogramIds] = useState(event?.linkedPlanogramIds || []);

  const categories = Array.from(new Set(planograms.map((p) => p.category).filter(Boolean))).sort();
  const canSave = name.trim() && type && startDate && endDate && startDate <= endDate;
  const supplierDeadline = startDate ? getSupplierDeadline({ startDate, leadTimeWeeks: Number(leadTimeWeeks) || 0 }) : null;

  const togglePlanogram = (id) => setLinkedPlanogramIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: event?.id || uid("event"),
      name: name.trim(),
      type,
      category,
      ownerId: ownerId.trim(),
      startDate,
      endDate,
      leadTimeWeeks: Number(leadTimeWeeks) || 0,
      linkedPlanogramIds,
    });
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-white border border-slate-200 rounded-lg p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-4">{event ? "Edit Event" : "New Event"}</h2>
        <div className="space-y-3">
          <Field label="Event Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 Snacks Reset" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Event Type">
              <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
                {eventTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Owner ID">
              <input className={inputCls} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="e.g. jsmith" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Date">
              <input type="date" className={inputCls} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
            <Field label="End Date">
              <input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </Field>
          </div>
          {startDate > endDate && <p className="text-xs text-red-500">End date can't be before the start date.</p>}
          <Field label="Lead Time (Weeks)">
            <input type="number" min="0" className={inputCls} value={leadTimeWeeks} onChange={(e) => setLeadTimeWeeks(e.target.value)} />
          </Field>
          {supplierDeadline && (
            <div className="text-xs bg-blue-50 border border-blue-200 text-blue-700 rounded-lg px-3 py-2 flex items-center gap-1.5">
              <CalendarDays size={12} /> Supplier deadline: <span className="font-semibold">{supplierDeadline}</span>
              <span className="text-blue-500">({leadTimeWeeks || 0} week{Number(leadTimeWeeks) !== 1 ? "s" : ""} before start)</span>
            </div>
          )}
          <Field label="Linked Planograms (optional)">
            <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg p-2 space-y-1">
              {planograms.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No planograms yet.</p>
              ) : planograms.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={linkedPlanogramIds.includes(p.id)} onChange={() => togglePlanogram(p.id)} className="accent-amber-500 w-3.5 h-3.5" />
                  {p.name}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Category">
            <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Choose a category…</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div className="flex items-center justify-between mt-5">
          <div>
            {onDelete && <button className="text-xs text-red-500 font-medium hover:underline" onClick={onDelete}>Delete Event</button>}
          </div>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={onCancel}>Cancel</button>
            <button className={btnPrimary} disabled={!canSave} onClick={handleSave}>Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EventPlannerModule({ onSignOut, events, eventTypes, planograms, onCreateEvent, onUpdateEvent, onDeleteEvent, onUpdateEventTypes, onExitToPlanner }) {
  const today = new Date();
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-11
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState("All");
  const [editingEvent, setEditingEvent] = useState(null); // null | "new" | event
  const [managingTypes, setManagingTypes] = useState(false);

  const getTypeConfig = (typeId) => eventTypes.find((t) => t.id === typeId) || { label: typeId, color: "#94a3b8" };

  const filteredEvents = events
    .filter((e) => !query.trim() || e.name.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((e) => filterType === "All" || e.type === filterType);

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const startWeekday = firstOfMonth.getDay();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const eventsForDay = (day) => {
    if (!day) return [];
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return filteredEvents.filter((e) => e.startDate <= dateStr && e.endDate >= dateStr);
  };

  const goPrevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth((m) => m - 1); };
  const goNextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth((m) => m + 1); };
  const yearOptions = Array.from({ length: 8 }, (_, i) => today.getFullYear() - 2 + i);

  // Dynamic lead time alerts: events not yet started whose supplier deadline (start date minus
  // lead time) is already here or within the next 2 weeks — sorted soonest first.
  const todayStr = todayISO();
  const deadlineAlerts = events
    .map((e) => ({ event: e, deadline: getSupplierDeadline(e) }))
    .filter((x) => x.deadline && x.event.startDate >= todayStr && x.deadline <= addDaysISO(todayStr, 14))
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  const promoConflicts = findPromoConflicts(events);

  if (editingEvent) {
    return (
      <EventForm
        event={editingEvent === "new" ? null : editingEvent}
        eventTypes={eventTypes}
        planograms={planograms}
        onSave={(ev) => { editingEvent === "new" ? onCreateEvent(ev) : onUpdateEvent(ev); setEditingEvent(null); }}
        onCancel={() => setEditingEvent(null)}
        onDelete={editingEvent !== "new" ? () => { onDeleteEvent(editingEvent.id); setEditingEvent(null); } : null}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="bg-slate-900 text-white px-6 py-3.5 flex items-center gap-3 no-print">
        <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm">T</div>
        <span className="font-bold tracking-tight">Event Planner</span>
        <span className="text-xs text-slate-400 hidden sm:inline">— reset, promo & campaign scheduling</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setManagingTypes(true)}
            className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-full px-3 py-1.5 border border-slate-700"
          >
            <Settings2 size={13} /> Manage Types
          </button>
          <button
            onClick={() => setEditingEvent("new")}
            className="text-xs flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold rounded-full px-3 py-1.5"
          >
            <Plus size={13} /> New Event
          </button>
          {onExitToPlanner && (
            <button
              onClick={onExitToPlanner}
              className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-full px-3 py-1.5 border border-slate-700"
            >
              <LogOut size={13} /> Exit to Tandom Studio
            </button>
          )}
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-full px-3 py-1.5 border border-slate-700"
            >
              <LogOut size={13} /> Sign out
            </button>
          )}
        </div>
      </div>

      <div className="p-6 max-w-6xl mx-auto">
        {(deadlineAlerts.length > 0 || promoConflicts.length > 0) && (
          <div className="space-y-1.5 mb-4">
            {deadlineAlerts.map(({ event: ev, deadline }) => {
              const overdue = deadline < todayStr;
              return (
                <button
                  key={ev.id}
                  onClick={() => setEditingEvent(ev)}
                  className={`w-full flex items-center justify-between gap-3 text-xs rounded-lg px-3 py-2 border text-left ${overdue ? "bg-red-50 border-red-200 text-red-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}
                >
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle size={12} />
                    Supplier deadline for "{ev.name}" {overdue ? "was" : "is"} <span className="font-semibold">{deadline}</span>{overdue ? " — overdue" : ""}
                  </span>
                  <span className="underline shrink-0">View</span>
                </button>
              );
            })}
            {promoConflicts.map(([a, b], i) => (
              <div key={i} className="flex items-center gap-1.5 text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-700">
                <AlertTriangle size={12} className="shrink-0" />
                Conflicting Promo events in "{a.category}": "{a.name}" ({a.startDate}–{a.endDate}) overlaps "{b.name}" ({b.startDate}–{b.endDate})
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <button className={btnGhost} onClick={goPrevMonth}><ChevronLeft size={14} /></button>
            <select className={inputCls + " w-auto"} value={viewMonth} onChange={(e) => setViewMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => <option key={i} value={i}>{m}</option>)}
            </select>
            <select className={inputCls + " w-auto"} value={viewYear} onChange={(e) => setViewYear(Number(e.target.value))}>
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button className={btnGhost} onClick={goNextMonth}><ChevronRight size={14} /></button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={inputCls + " pl-8 text-xs py-1 w-48"} placeholder="Filter by event name…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <select className={inputCls + " w-auto text-xs py-1"} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="All">All Types</option>
              {eventTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap mb-3">
          {eventTypes.map((t) => (
            <span key={t.id} className="text-[10px] font-medium flex items-center gap-1 text-slate-600">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: t.color }} /> {t.label}
            </span>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide text-center py-2">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const dayEvents = eventsForDay(day);
              const isToday = day && viewMonth === today.getMonth() && viewYear === today.getFullYear() && day === today.getDate();
              return (
                <div key={i} className={`min-h-[92px] border-b border-r border-slate-100 p-1 ${!day ? "bg-slate-50/50" : ""}`}>
                  {day && <div className={`text-[10px] mb-1 ${isToday ? "text-amber-600 font-bold" : "text-slate-400"}`}>{day}</div>}
                  <div className="space-y-0.5">
                    {dayEvents.slice(0, 3).map((ev) => (
                      <button
                        key={ev.id}
                        onClick={() => setEditingEvent(ev)}
                        className="block w-full text-left text-[10px] font-medium text-white rounded px-1 py-0.5 truncate"
                        style={{ background: getTypeConfig(ev.type).color }}
                        title={ev.name}
                      >
                        {ev.name}
                      </button>
                    ))}
                    {dayEvents.length > 3 && <div className="text-[9px] text-slate-400 px-1">+{dayEvents.length - 3} more</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {managingTypes && (
        <EventTypeManagerModal
          eventTypes={eventTypes}
          onSave={(next) => { onUpdateEventTypes(next); setManagingTypes(false); }}
          onClose={() => setManagingTypes(false)}
        />
      )}
    </div>
  );
}

const USER_ROLES = [
  { id: "admin", label: "Admin", hint: "Everything, including users and roles", landing: "Tandom Studio" },
  { id: "category_manager", label: "Category Manager", hint: "Planograms, products, fixtures, stores, reports", landing: "Tandom Studio" },
  { id: "regional_manager", label: "Regional Manager", hint: "Store Assistant for every store in their regions", landing: "Store Assistant" },
  { id: "event_planner", label: "Event Planner", hint: "Event Planner; can view planograms and stores", landing: "Event Planner" },
  { id: "store_associate", label: "Store Associate", hint: "Store Assistant for their one store", landing: "Store Assistant" },
];

// Admin-only. Invite people by email (role and store/regions set up front) and manage who has which role.
// Sign-up is closed: an account exists only because an Admin invited it here. The database restricts role,
// store and region changes to Admins; the checks here just stop an admin locking themselves out.
function UserRolesPanel({ currentUserId, stores }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [form, setForm] = useState({ email: "", displayName: "", role: "store_associate", storeId: "", regions: [] });
  const [inviting, setInviting] = useState(false);

  const regionOptions = [...new Set((stores || []).map((x) => (x.region || "").trim()).filter(Boolean))].sort();
  const storeOptions = (stores || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const load = useCallback(async () => {
    let r = await supabase.from("profiles").select("id, email, display_name, role, store_id, regions, created_at").order("created_at", { ascending: true });
    if (r.error) r = await supabase.from("profiles").select("id, email, display_name, role, created_at").order("created_at", { ascending: true });
    if (r.error) { setError(`Couldn't load users: ${r.error.message}`); return; }
    setUsers(r.data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const adminCount = (users || []).filter((u) => u.role === "admin").length;

  // patch: any of { role, store_id, regions }. Moving to a role that doesn't use a store/regions clears them.
  const update = async (user, patch) => {
    setError(""); setNotice("");
    const next = { ...user, ...patch };
    if (patch.role && patch.role !== "store_associate") next.store_id = null;
    if (patch.role && patch.role !== "regional_manager") next.regions = [];
    if (user.id === currentUserId && patch.role && patch.role !== user.role) { setError("You can't change your own role — ask another admin."); return; }
    if (patch.role && user.role === "admin" && patch.role !== "admin" && adminCount <= 1) { setError("There must always be at least one Admin."); return; }
    setSavingId(user.id);
    const { error: err } = await supabase.from("profiles").update({ role: next.role, store_id: next.store_id || null, regions: next.regions || [] }).eq("id", user.id);
    setSavingId(null);
    if (err) { setError(`Couldn't update ${user.email || "user"}: ${err.message}`); return; }
    setUsers((prev) => prev.map((u) => (u.id === user.id ? next : u)));
    if (next.role === "store_associate" && !next.store_id) setNotice(`${user.email || "This person"} has no store yet — they can't use Store Assistant until you choose one.`);
    if (next.role === "regional_manager" && (next.regions || []).length === 0) setNotice(`${user.email || "This person"} has no regions yet — pick at least one.`);
  };

  const toggleRegion = (list, r) => (list.includes(r) ? list.filter((x) => x !== r) : [...list, r]);

  const invite = async (e) => {
    e.preventDefault();
    setError(""); setNotice("");
    if (form.role === "store_associate" && !form.storeId) { setError("Choose the store this person works in."); return; }
    if (form.role === "regional_manager" && form.regions.length === 0) { setError("Choose at least one region."); return; }
    setInviting(true);
    try {
      await invokeEdgeFunction("manage-users", {
        action: "invite", email: form.email.trim(), displayName: form.displayName.trim(), role: form.role,
        storeId: form.role === "store_associate" ? form.storeId : undefined,
        regions: form.role === "regional_manager" ? form.regions : undefined,
        redirectTo: window.location.origin,
      });
      setNotice(`Invitation sent to ${form.email.trim()}. They'll get an email with a link to set their password.`);
      setForm({ email: "", displayName: "", role: form.role, storeId: "", regions: [] });
      await load();
    } catch (err) {
      setError(err?.message || "The invitation couldn't be sent.");
    } finally { setInviting(false); }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 mt-6">
      <h3 className="text-sm font-semibold text-slate-800 mb-1 flex items-center gap-1.5"><Users size={15} className="text-amber-500" /> Users &amp; Roles</h3>
      <p className="text-xs text-slate-500 mb-3">
        Accounts are created by invitation only. Each role lands on its own screen: {USER_ROLES.map((r) => `${r.label} → ${r.landing}`).join(" · ")}. Role changes take effect the next time that person loads the app.
      </p>
      {error && <div className="text-sm rounded-md px-3 py-2 mb-3 bg-red-50 text-red-700 border border-red-200">{error}</div>}
      {notice && <div className="text-sm rounded-md px-3 py-2 mb-3 bg-emerald-50 text-emerald-700 border border-emerald-200">{notice}</div>}

      <form onSubmit={invite} className="border border-slate-200 rounded-md p-3 mb-4 bg-slate-50">
        <div className="text-xs font-semibold text-slate-600 mb-2">Invite someone</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input className={inputCls} type="email" required placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={inputCls} placeholder="Name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {USER_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          {form.role === "store_associate" && (
            <select className={inputCls} required value={form.storeId} onChange={(e) => setForm({ ...form, storeId: e.target.value })}>
              <option value="">Choose their store…</option>
              {storeOptions.map((x) => <option key={x.id} value={x.id}>{x.name}{x.storeNumber ? ` (#${x.storeNumber})` : ""}</option>)}
            </select>
          )}
        </div>
        {form.role === "regional_manager" && (
          <div className="mt-2 flex flex-wrap gap-2 items-center">
            <span className="text-xs text-slate-500">Regions:</span>
            {regionOptions.length === 0 && <span className="text-xs text-amber-700">No store has a Region yet — set one on your stores first.</span>}
            {regionOptions.map((r) => (
              <label key={r} className={`text-xs rounded-full border px-2.5 py-1 cursor-pointer ${form.regions.includes(r) ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-600 bg-white"}`}>
                <input type="checkbox" className="hidden" checked={form.regions.includes(r)} onChange={() => setForm({ ...form, regions: toggleRegion(form.regions, r) })} />{r}
              </label>
            ))}
          </div>
        )}
        <div className="mt-2 text-[11px] text-slate-400">{USER_ROLES.find((r) => r.id === form.role)?.hint}</div>
        <button type="submit" disabled={inviting} className={btnPrimary + " mt-2"}><Mail size={14} /> {inviting ? "Sending…" : "Send invitation"}</button>
      </form>

      {users === null && !error && <p className="text-xs text-slate-400 italic">Loading users…</p>}
      {users && (
        <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
          {users.map((u) => (
            <div key={u.id} className="px-3 py-2">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <div className="text-sm text-slate-800 truncate">{u.display_name || u.email}{u.id === currentUserId && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">You</span>}</div>
                  {u.display_name && u.display_name !== u.email && <div className="text-xs text-slate-400 truncate">{u.email}</div>}
                </div>
                <select className={inputCls + " w-44"} value={u.role || "store_associate"} disabled={savingId === u.id || u.id === currentUserId}
                  title={u.id === currentUserId ? "You can't change your own role" : undefined} onChange={(e) => update(u, { role: e.target.value })}>
                  {USER_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                {u.role === "store_associate" && (
                  <select className={inputCls + " w-52"} value={u.store_id || ""} disabled={savingId === u.id} onChange={(e) => update(u, { store_id: e.target.value })}>
                    <option value="">No store yet…</option>
                    {storeOptions.map((x) => <option key={x.id} value={x.id}>{x.name}{x.storeNumber ? ` (#${x.storeNumber})` : ""}</option>)}
                  </select>
                )}
              </div>
              {u.role === "regional_manager" && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 items-center">
                  <span className="text-[11px] text-slate-400">Regions:</span>
                  {regionOptions.map((r) => (
                    <label key={r} className={`text-[11px] rounded-full border px-2 py-0.5 cursor-pointer ${(u.regions || []).includes(r) ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-300 text-slate-500 bg-white"}`}>
                      <input type="checkbox" className="hidden" disabled={savingId === u.id} checked={(u.regions || []).includes(r)} onChange={() => update(u, { regions: toggleRegion(u.regions || [], r) })} />{r}
                    </label>
                  ))}
                  {(u.regions || []).length === 0 && <span className="text-[11px] text-amber-700">none yet</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Reset Impact — how each reset performed once its version went Live. */
/* Computed server-side by the reset-impact Edge Function; here we only */
/* group and show it. "vs similar stores" is the lift over stores that  */
/* did not reset, so a market-wide trend isn't credited to the reset.   */
/* ------------------------------------------------------------------ */

const IMPACT_METRIC_OPTIONS = [
  { id: "sales", label: "Sales $", fmt: money0, perWeek: true },
  { id: "units", label: "Units", fmt: (n) => Math.round(n || 0).toLocaleString(), perWeek: true },
  { id: "margin", label: "Margin $", fmt: money0, perWeek: true },
  { id: "perLf", label: "Sales per linear ft", fmt: (n) => money(n), perWeek: true },
];

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}
function fmtPp(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)} pp`;
}
const deltaCls = (n) => (n == null || !Number.isFinite(n) ? "text-slate-400" : n > 0.05 ? "text-emerald-600" : n < -0.05 ? "text-red-600" : "text-slate-500");

// one group's figures for the chosen metric -> { pre, post, changePct, liftPp }
function impactFigures(group, metricId) {
  if (metricId === "perLf") {
    const v = group.salesPerLinearFt;
    return v ? { pre: v.pre, post: v.post, changePct: v.changePct, liftPp: null } : { pre: null, post: null, changePct: null, liftPp: null };
  }
  return group.metrics[metricId];
}

function ImpactRowsTable({ impact, metricId }) {
  const opt = IMPACT_METRIC_OPTIONS.find((m) => m.id === metricId) || IMPACT_METRIC_OPTIONS[0];
  const control = impact.control?.change || {};
  return (
    <table className="text-xs w-full">
      <thead>
        <tr className="text-left text-slate-400 uppercase tracking-wide">
          <th className="py-1 pr-3 font-semibold">Store</th><th className="py-1 pr-3 font-semibold">Region</th><th className="py-1 pr-3 font-semibold">Went live</th>
          <th className="py-1 pr-3 font-semibold text-right">Before / wk</th><th className="py-1 pr-3 font-semibold text-right">After / wk</th><th className="py-1 pr-3 font-semibold text-right">Change</th><th className="py-1 font-semibold text-right">vs similar stores</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {impact.rows.map((r) => {
          const m = metricId === "perLf" ? "sales" : metricId;
          const change = r.status === "measured" || r.status === "maturing" ? (r.pre[m] > 0 ? (r.post[m] / r.pre[m] - 1) * 100 : null) : null;
          const lift = r.status === "measured" && control[m] != null && r.pre[m] > 0 ? ((r.post[m] - r.pre[m] * (1 + control[m])) / r.pre[m]) * 100 : null;
          const lf = impact.space;
          const perLf = (v, k) => (lf && lf[k] > 0 ? v / lf[k] : null);
          const pre = metricId === "perLf" ? perLf(r.pre.sales, "preLinearFt") : r.pre?.[m];
          const post = metricId === "perLf" ? perLf(r.post.sales, "postLinearFt") : r.post?.[m];
          const changeShown = metricId === "perLf" && pre > 0 && post != null ? (post / pre - 1) * 100 : change;
          return (
            <tr key={r.storeId} className={r.status === "measured" ? "" : "text-slate-400"}>
              <td className="py-1 pr-3">{r.storeName}{r.storeNumber ? ` (#${r.storeNumber})` : ""}</td>
              <td className="py-1 pr-3">{r.region || "—"}</td>
              <td className="py-1 pr-3">{r.goLiveDate || "—"}</td>
              {r.status === "measured" || r.status === "maturing" ? (
                <>
                  <td className="py-1 pr-3 text-right">{pre != null ? opt.fmt(pre) : "—"}</td>
                  <td className="py-1 pr-3 text-right">{post != null ? opt.fmt(post) : "—"}</td>
                  <td className={`py-1 pr-3 text-right font-medium ${deltaCls(changeShown)}`}>{fmtPct(changeShown)}</td>
                  <td className={`py-1 text-right font-medium ${deltaCls(lift)}`}>
                    {r.status === "maturing" ? <span className="text-slate-400 font-normal">only {r.postWeeks} wk{r.postWeeks === 1 ? "" : "s"} so far</span> : metricId === "perLf" ? "—" : fmtPp(lift)}
                  </td>
                </>
              ) : (
                <td className="py-1 text-right italic" colSpan={4}>{r.status === "not_executed" ? "Reset not completed in this store yet" : "Not enough sales history before the reset"}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ResetImpactModule({ planograms, stores, storeSchema, planogramSchema }) {
  const [state, setState] = useState({ status: "loading", rows: [], error: "" });
  const [measuring, setMeasuring] = useState(false);
  const [message, setMessage] = useState(null); // {type: "ok"|"error", text}
  const [groupBy, setGroupBy] = useState("region");
  const [metricId, setMetricId] = useState("sales");
  const [category, setCategory] = useState("All");
  const [region, setRegion] = useState("All");
  const [preWeeks, setPreWeeks] = useState(8);
  const [postWeeks, setPostWeeks] = useState(8);
  const [expanded, setExpanded] = useState(null);
  const impactDims = React.useMemo(() => [...IMPACT_DIMENSIONS, ...(storeSchema || []).map((f) => ({ id: `sattr:${f.id}`, label: `Store: ${f.label}` })), ...(planogramSchema || []).map((f) => ({ id: `pattr:${f.id}`, label: `Planogram: ${f.label}` }))], [storeSchema, planogramSchema]);
  const impactLookup = React.useMemo(() => ({ stores: stores || [], planograms: planograms || [], fields: Object.fromEntries([...(storeSchema || []).map((f) => [`sattr:${f.id}`, f.label]), ...(planogramSchema || []).map((f) => [`pattr:${f.id}`, f.label])]) }), [stores, planograms, storeSchema, planogramSchema]);

  const load = useCallback(async () => {
    const r = await loadResetImpacts();
    setState(r.ok ? { status: "ready", rows: r.rows, error: "" } : { status: "error", rows: [], error: r.error || "" });
  }, []);
  useEffect(() => { load(); }, [load]);

  const measureAll = async () => {
    setMeasuring(true); setMessage(null);
    try {
      const data = await invokeEdgeFunction("reset-impact", { all: true, preWeeks, postWeeks });
      const ok = (data.results || []).filter((r) => r.ok && r.status === "ok").length;
      setMessage({ type: "ok", text: ok > 0 ? `Measured ${ok} reset${ok === 1 ? "" : "s"}.` : "No Live version with a Historical baseline to measure yet." });
      await load();
    } catch (e) {
      setMessage({ type: "error", text: e?.message || "Couldn't measure resets." });
    } finally { setMeasuring(false); }
  };

  const impacts = state.rows.map((r) => ({ ...r.result, planogramId: r.planogram_id, proposalId: r.proposal_id, computedAt: r.computed_at })).filter((i) => i.status === "ok");
  const categories = ["All", ...new Set(impacts.map((i) => i.planogram.category).filter(Boolean))];
  const regions = ["All", ...new Set(impacts.flatMap((i) => i.rows.map((r) => r.region)).filter(Boolean))];
  const filtered = impacts
    .filter((i) => category === "All" || i.planogram.category === category)
    .map((i) => ({ ...i, rows: region === "All" ? i.rows : i.rows.filter((r) => r.region === region) }));
  const roll = rollupResetImpact(filtered, groupBy, impactLookup);
  const opt = IMPACT_METRIC_OPTIONS.find((m) => m.id === metricId) || IMPACT_METRIC_OPTIONS[0];
  const planogramName = (id) => planograms.find((p) => p.id === id)?.name;

  const FigureCells = ({ g, bold }) => {
    const f = impactFigures(g, metricId);
    return (
      <>
        <td className={`px-3 py-2 text-right ${bold ? "font-semibold" : ""}`}>{f.pre != null ? opt.fmt(f.pre) : "—"}</td>
        <td className={`px-3 py-2 text-right ${bold ? "font-semibold" : ""}`}>{f.post != null ? opt.fmt(f.post) : "—"}</td>
        <td className={`px-3 py-2 text-right font-medium ${deltaCls(f.changePct)}`}>{fmtPct(f.changePct)}</td>
        <td className={`px-3 py-2 text-right font-medium ${deltaCls(f.liftPp)}`}>{metricId === "perLf" ? "—" : fmtPp(f.liftPp)}</td>
      </>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-slate-800">Reset Impact</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-slate-500 flex items-center gap-1">Weeks before
            <input type="number" min={2} max={52} className={inputCls + " w-16"} value={preWeeks} onChange={(e) => setPreWeeks(Math.max(2, Math.min(52, parseInt(e.target.value, 10) || 8)))} /></label>
          <label className="text-xs text-slate-500 flex items-center gap-1">after
            <input type="number" min={4} max={52} className={inputCls + " w-16"} value={postWeeks} onChange={(e) => setPostWeeks(Math.max(4, Math.min(52, parseInt(e.target.value, 10) || 8)))} /></label>
          <button className={btnPrimary} onClick={measureAll} disabled={measuring}>
            {measuring ? <RefreshCw size={14} className="animate-spin" /> : <TrendingUp size={14} />} {measuring ? "Measuring…" : "Measure all Live resets"}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-3">How sales changed after each new version went Live, using the Historical version as the baseline — and how that compares with similar stores that didn't reset.</p>
      {message && <div className={`text-sm rounded-md px-3 py-2 mb-3 ${message.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>{message.text}</div>}
      {state.status === "error" && <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">Results couldn't be loaded{state.error ? ` (${state.error})` : ""}. If the latest <code>supabase/schema.sql</code> hasn't been run yet, run it in the Supabase SQL editor.</div>}
      {state.status === "loading" && <p className="text-sm text-slate-400">Loading…</p>}
      {state.status === "ready" && impacts.length === 0 && (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          Nothing measured yet. A reset can be measured once its new version is Live, stores have completed it, and Performance data covers a few weeks after.
        </div>
      )}
      {impacts.length > 0 && (
        <>
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <label className="text-xs text-slate-500 flex items-center gap-1.5">Summarize by
              <select className={inputCls + " w-40"} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{impactDims.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
            <label className="text-xs text-slate-500 flex items-center gap-1.5">Measure
              <select className={inputCls + " w-44"} value={metricId} onChange={(e) => setMetricId(e.target.value)}>{IMPACT_METRIC_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
            <label className="text-xs text-slate-500 flex items-center gap-1.5">Category
              <select className={inputCls + " w-36"} value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className="text-xs text-slate-500 flex items-center gap-1.5">Region
              <select className={inputCls + " w-36"} value={region} onChange={(e) => setRegion(e.target.value)}>{regions.map((c) => <option key={c}>{c}</option>)}</select></label>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto mb-2">
            <table className="text-sm w-full">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="text-left font-semibold px-3 py-2">{(impactDims.find((d) => d.id === groupBy) || {}).label}</th>
                  <th className="text-right font-semibold px-3 py-2">Stores</th>
                  <th className="text-right font-semibold px-3 py-2">Before / wk</th>
                  <th className="text-right font-semibold px-3 py-2">After / wk</th>
                  <th className="text-right font-semibold px-3 py-2" title="Raw change, not adjusted for anything">Change</th>
                  <th className="text-right font-semibold px-3 py-2" title="Change minus what similar stores that did not reset did over the same weeks">vs similar stores</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {roll.groups.map((g) => (
                  <tr key={g.label}><td className="px-3 py-2 text-slate-800">{g.label}</td><td className="px-3 py-2 text-right text-slate-500">{g.stores}</td><FigureCells g={g} /></tr>
                ))}
                {roll.total && roll.groups.length > 1 && (
                  <tr className="bg-slate-50"><td className="px-3 py-2 font-semibold text-slate-800">All</td><td className="px-3 py-2 text-right text-slate-500">{roll.total.stores}</td><FigureCells g={roll.total} bold /></tr>
                )}
                {roll.groups.length === 0 && <tr><td className="px-3 py-4 text-slate-400 italic" colSpan={6}>No stores have a full set of after-reset weeks yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400 mb-5">
            Figures are weekly averages. <strong>Change</strong> is the raw before/after difference; <strong>vs similar stores</strong> (percentage points) subtracts what stores of the same products that did not reset did over the same weeks.
            {roll.maturing > 0 && ` ${roll.maturing} store${roll.maturing === 1 ? " is" : "s are"} still maturing (fewer than 4 weeks after) and left out of the totals.`}
          </p>

          <h3 className="text-sm font-semibold text-slate-700 mb-2">By planogram</h3>
          <div className="space-y-2">
            {filtered.map((imp) => {
              const f = imp.summary ? impactFigures(imp.summary, metricId) : null;
              const open = expanded === imp.planogramId;
              return (
                <div key={imp.planogramId} className="bg-white border border-slate-200 rounded-lg">
                  <button className="w-full flex items-center gap-3 px-4 py-3 text-left" onClick={() => setExpanded(open ? null : imp.planogramId)}>
                    {open ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-slate-800 truncate">{planogramName(imp.planogramId) || imp.planogram.name}{imp.proposalId && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide bg-blue-50 text-blue-700 border border-blue-200 rounded px-1 py-0.5">From AI proposal</span>}</span>
                      <span className="block text-xs text-slate-400">{imp.planogram.category || "No category"} · live {imp.goLiveDate} · {imp.counts.measured} measured{imp.counts.maturing ? `, ${imp.counts.maturing} maturing` : ""}{imp.counts.notExecuted ? `, ${imp.counts.notExecuted} not executed` : ""} · {imp.control.stores} comparison store{imp.control.stores === 1 ? "" : "s"}</span>
                    </span>
                    {f && f.changePct != null && <span className={`text-sm font-semibold ${deltaCls(f.changePct)}`}>{fmtPct(f.changePct)}</span>}
                    {f && f.liftPp != null && metricId !== "perLf" && <span className={`text-xs ${deltaCls(f.liftPp)}`}>{fmtPp(f.liftPp)} vs similar</span>}
                  </button>
                  {open && <div className="px-4 pb-3 overflow-x-auto"><ImpactRowsTable impact={imp} metricId={metricId} /></div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Execution follow-up — stores stuck or past due on a reset. A check   */
/* first previews what would happen; nothing is sent until it's         */
/* confirmed. Escalations land here for the Category Manager.           */
/* ------------------------------------------------------------------ */

const FOLLOWUP_KIND_LABEL = { past_due: "Past due", stuck: "Stuck", past_due_and_stuck: "Past due & stuck" };

function ExecutionFollowupModule({ onEscalationsChanged, onStoresChanged }) {
  const [stuckDays, setStuckDays] = useState(3);
  const [escalateAfterDays, setEscalateAfterDays] = useState(5);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(null); // "check" | "apply"
  const [message, setMessage] = useState(null);
  const [esc, setEsc] = useState({ status: "loading", rows: [] });

  const loadEsc = useCallback(async () => {
    const r = await loadEscalations();
    setEsc(r.ok ? { status: "ready", rows: r.rows } : { status: "error", rows: [] });
    if (r.ok && onEscalationsChanged) onEscalationsChanged(r.rows.filter((x) => x.status === "open").length);
  }, [onEscalationsChanged]);
  useEffect(() => { loadEsc(); }, [loadEsc]);

  const run = async (apply) => {
    setBusy(apply ? "apply" : "check"); setMessage(null);
    try {
      const data = await invokeEdgeFunction("execution-followup", { apply, stuckDays, escalateAfterDays });
      setPlan(apply ? null : data.plan);
      if (apply) {
        const p = data.plan;
        setMessage({ type: "ok", text: `Sent ${p.reminders.length} reminder${p.reminders.length === 1 ? "" : "s"}, escalated ${p.escalations.length}, closed ${p.resolutions.length} that finished.` });
        await loadEsc();
        if (onStoresChanged) onStoresChanged();
      }
    } catch (e) {
      setMessage({ type: "error", text: e?.message || "The check failed." });
    } finally { setBusy(null); }
  };
  const resolve = async (row) => {
    try { await resolveEscalation(row.id, "Resolved by a person"); await loadEsc(); }
    catch (e) { setMessage({ type: "error", text: e?.message || "Couldn't resolve it." }); }
  };

  const open = esc.rows.filter((r) => r.status === "open").sort(byStoreThenPlanogram("store_name", "planogram_name"));
  const recent = esc.rows.filter((r) => r.status === "resolved").slice(0, 10);
  const willRemind = plan ? new Set(plan.reminders.map((r) => `${r.planogramId}|${r.storeId}`)) : new Set();
  const willEscalate = plan ? new Set(plan.escalations.map((r) => `${r.planogramId}|${r.storeId}`)) : new Set();
  const nothingToDo = plan && plan.reminders.length === 0 && plan.escalations.length === 0 && plan.resolutions.length === 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-slate-800">Execution Follow-up</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-slate-500 flex items-center gap-1" title="A store left in Partially Completed longer than this is treated as stuck">Stuck after
            <input type="number" min={1} max={60} className={inputCls + " w-16"} value={stuckDays} onChange={(e) => setStuckDays(Math.max(1, Math.min(60, parseInt(e.target.value, 10) || 3)))} /> days</label>
          <label className="text-xs text-slate-500 flex items-center gap-1" title="Escalate to the Category Manager once a store is this many days overdue or stuck">Escalate after
            <input type="number" min={1} max={90} className={inputCls + " w-16"} value={escalateAfterDays} onChange={(e) => setEscalateAfterDays(Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 5)))} /> days</label>
          <button className={btnPrimary} onClick={() => run(false)} disabled={!!busy}>
            {busy === "check" ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />} {busy === "check" ? "Checking…" : "Check stores"}
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-3">Finds stores whose reset is past its due date or stuck in Partially Completed. Checking shows what would happen; nothing is sent until you confirm.</p>
      {message && <div className={`text-sm rounded-md px-3 py-2 mb-3 ${message.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>{message.text}</div>}

      {plan && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-5">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-700">{plan.findings.length} store{plan.findings.length === 1 ? "" : "s"} behind</h3>
            <span className="text-xs text-slate-400">checked {plan.today}</span>
            {!nothingToDo && (
              <button className={btnPrimary + " ml-auto"} onClick={() => run(true)} disabled={!!busy}>
                {busy === "apply" ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />} Send {plan.reminders.length} reminder{plan.reminders.length === 1 ? "" : "s"}{plan.escalations.length > 0 ? ` & escalate ${plan.escalations.length}` : ""}
              </button>
            )}
          </div>
          {nothingToDo && <p className="text-sm text-slate-500">Everything is on track, or every late store already has a reminder open.</p>}
          {plan.findings.length > 0 && (
            <table className="text-xs w-full">
              <thead><tr className="text-left text-slate-400 uppercase tracking-wide"><th className="py-1 pr-3 font-semibold">Store</th><th className="py-1 pr-3 font-semibold">Planogram</th><th className="py-1 pr-3 font-semibold">Problem</th><th className="py-1 pr-3 font-semibold text-right">Days</th><th className="py-1 font-semibold">Will</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {plan.findings.slice().sort(byStoreThenPlanogram("storeName", "planogramName")).map((f) => {
                  const k = `${f.planogramId}|${f.storeId}`;
                  return (
                    <tr key={k}>
                      <td className="py-1.5 pr-3 text-slate-800">{f.storeName}</td>
                      <td className="py-1.5 pr-3">{f.planogramName}</td>
                      <td className="py-1.5 pr-3 text-slate-600">{FOLLOWUP_KIND_LABEL[f.kind]} — {f.reason}</td>
                      <td className="py-1.5 pr-3 text-right font-medium text-red-600">{f.daysOverdue}</td>
                      <td className="py-1.5">{[willRemind.has(k) ? "send reminder" : "reminder already open", willEscalate.has(k) ? "escalate" : null].filter(Boolean).join(" + ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {plan.resolutions.length > 0 && <p className="text-xs text-slate-500 mt-3">{plan.resolutions.length} store{plan.resolutions.length === 1 ? " has" : "s have"} finished since the last check ({plan.resolutions.map((r) => r.storeName).join(", ")}); their reminders and escalations will be closed.</p>}
        </div>
      )}

      <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5"><AlertTriangle size={14} className="text-amber-500" /> Escalations{open.length > 0 && <span className="text-xs font-normal text-slate-400">({open.length} open)</span>}</h3>
      {esc.status === "error" && <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">Escalations couldn't be loaded. If the latest <code>supabase/schema.sql</code> hasn't been run yet, run it in the Supabase SQL editor.</div>}
      {esc.status === "ready" && open.length === 0 && <p className="text-sm text-slate-400 italic mb-4">No open escalations.</p>}
      <div className="space-y-2 mb-5">
        {open.map((r) => (
          <div key={r.id} className="bg-white border border-amber-300 rounded-lg px-4 py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800">{r.store_name} — {r.planogram_name}
                {r.prior_escalations > 0 && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide bg-red-50 text-red-700 border border-red-200 rounded px-1 py-0.5">Repeat · {r.prior_escalations} before in 90 days</span>}</div>
              <div className="text-xs text-slate-500">{FOLLOWUP_KIND_LABEL[r.kind] || r.kind} · {r.days_overdue} days · {r.reason}</div>
              <div className="text-[11px] text-slate-400">Escalated {new Date(r.created_at).toLocaleDateString()}</div>
            </div>
            <button className={btnGhost} onClick={() => resolve(r)}><Check size={12} /> Mark resolved</button>
          </div>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Recently resolved</h4>
          <ul className="text-xs text-slate-500 space-y-0.5">
            {recent.map((r) => <li key={r.id}>{r.store_name} — {r.planogram_name} · {r.resolution || "resolved"} {r.resolved_at ? `(${new Date(r.resolved_at).toLocaleDateString()})` : ""}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function AccessMessageScreen({ title, body, onRetry, onSignOut }) {
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm">T</div>
          <span className="font-bold text-slate-800">Tandom Studio</span>
        </div>
        <h2 className="text-base font-semibold text-slate-800 mb-1">{title}</h2>
        <p className="text-sm text-slate-500 mb-4">{body}</p>
        <div className="flex gap-2">
          {onRetry && <button className={btnPrimary} onClick={onRetry}><RefreshCw size={14} /> Try again</button>}
          {onSignOut && <button className={btnGhost} onClick={onSignOut}><LogOut size={14} /> Sign out</button>}
        </div>
      </div>
    </div>
  );
}

// Escalations for the stores a regional manager covers (the database only returns those).
function RegionalEscalationsView() {
  const [state, setState] = useState({ status: "loading", rows: [] });
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const r = await loadEscalations();
    setState(r.ok ? { status: "ready", rows: r.rows } : { status: "error", rows: [] });
  }, []);
  useEffect(() => { load(); }, [load]);
  const resolve = async (row) => {
    try { await resolveEscalation(row.id, "Resolved by the regional manager"); setError(""); await load(); }
    catch (e) { setError(e?.message || "Couldn't resolve it."); }
  };
  const open = state.rows.filter((r) => r.status === "open").sort(byStoreThenPlanogram("store_name", "planogram_name"));
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800 mb-1">Escalations</h2>
      <p className="text-sm text-slate-500 mb-4">Stores in your regions that stayed late on a reset long enough to need attention.</p>
      {error && <div className="text-sm rounded-md px-3 py-2 mb-3 bg-red-50 text-red-700 border border-red-200">{error}</div>}
      {state.status === "error" && <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">Escalations couldn't be loaded.</div>}
      {state.status === "ready" && open.length === 0 && <p className="text-sm text-slate-400 italic">No open escalations in your regions.</p>}
      <div className="space-y-2">
        {open.map((r) => (
          <div key={r.id} className="bg-white border border-amber-300 rounded-lg px-4 py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800">{r.store_name} — {r.planogram_name}
                {r.prior_escalations > 0 && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide bg-red-50 text-red-700 border border-red-200 rounded px-1 py-0.5">Repeat · {r.prior_escalations} before in 90 days</span>}</div>
              <div className="text-xs text-slate-500">{r.days_overdue} days · {r.reason}</div>
            </div>
            <button className={btnGhost} onClick={() => resolve(r)}><Check size={12} /> Mark resolved</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Assortment: segments, slow movers, new items, SKU rationalization    */
/* (the calculations live in supabase/functions/_shared/assortment.js)  */
/* ------------------------------------------------------------------ */

const ASSORT_DEFAULT_CFG = { category: "", segmentFieldIds: [], planogramFilter: { fieldId: "", value: "" }, scope: { type: "all", value: "" }, weeks: 13, compare: "prior", groupBy: "region", assumptions: { ...DEFAULT_ASSUMPTIONS } };
const moneyA = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`);
const money2A = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`);
const growthA = (g) => (g === null || g === undefined ? "—" : `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%`);
const pctA = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const growthCls = (g) => (g === null || g === undefined ? "text-slate-400" : g >= 0.02 ? "text-emerald-600" : g <= -0.02 ? "text-red-600" : "text-slate-500");

const NEW_ITEM_HEADERS = ["Product Name", "UPC", "Category", "Width (in)", "Height (in)", "Depth (in)", "Retail Price", "Unit Cost", "Weekly Units per Store (forecast)", "Similar Item UPC(s)", "Similar Item Sales %", "Launch Date"];

function downloadNewItemTemplate(schema, format) {
  const attrCols = (schema || []).map((f) => f.label).filter((l) => !["upc", "category"].includes(l.trim().toLowerCase()));
  const headers = [...NEW_ITEM_HEADERS, ...attrCols];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws["!cols"] = headers.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "New Items");
  const notes = [
    ["Field", "Notes"],
    ["Product Name", "Required."],
    ["UPC", "Used to recognise the item later (and to match its Performance data once it sells)."],
    ["Category", "The category it belongs in, as named on your planograms (e.g. Cereal)."],
    ["Width / Height / Depth (in)", "Needed to check it fits on a shelf. Items without a size are listed but not placed."],
    ["Retail Price / Unit Cost", "Used to value the forecast. Optional if you name a similar item (its price and cost are used)."],
    ["Weekly Units per Store (forecast)", "Expected units per store per week. Leave blank to use a similar item instead."],
    ["Similar Item UPC(s)", "UPC (or exact name) of one or more existing items that should sell like this one; separate several with a comma."],
    ["Similar Item Sales %", "How the new item compares to the similar item(s): 100 = the same, 80 = four-fifths as much."],
    ["Launch Date", "YYYY-MM-DD, optional."],
    [],
    ["Attribute columns", `Any column named like one of your product attributes (${attrCols.slice(0, 6).join(", ") || "none set up yet"}) fills that attribute. Those are what the Segments view groups by.`],
  ];
  if (format === "csv") {
    const blob = new Blob([XLSX.utils.sheet_to_csv(ws)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "new_items_template.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const ws2 = XLSX.utils.aoa_to_sheet(notes);
  ws2["!cols"] = [{ wch: 32 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Instructions");
  XLSX.writeFile(wb, format === "xls" ? "new_items_template.xls" : "new_items_template.xlsx", format === "xls" ? { bookType: "biff8" } : undefined);
}

// Reads a new-item sheet. Items already in the library as new items are updated; established library items are
// left alone. Nothing is saved here: the caller creates/updates the returned products.
function parseNewItemWorkbook(file, products, schema, primaryKeyField) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const isCsv = /\.csv$/i.test(file.name || "");
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array", cellDates: true, raw: isCsv });
        const sheetName = wb.SheetNames.find((n) => /new items?/i.test(n)) || wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        const norm = (h) => String(h).trim().toLowerCase();
        const upcField = (schema || []).find((f) => norm(f.label) === "upc");
        const catField = (schema || []).find((f) => norm(f.label) === "category");
        const attrFields = (schema || []).filter((f) => f !== upcField && f !== catField);
        const upcOf = (p) => (getAttrByLabel(p, schema, ["upc"]) || p.sku || "").trim().toLowerCase();
        const byUpc = {}, byName = {};
        (products || []).forEach((p) => { const u = upcOf(p); if (u) byUpc[u] = p; byName[p.name.trim().toLowerCase()] = p; });
        const created = [], updated = [], skipped = [], warnings = [];
        const taken = {}; // upc/name -> product made earlier in this same file, so a repeated row updates instead of duplicating
        const num = (v) => { const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) && String(v).trim() !== "" ? n : null; };
        rows.forEach((raw, i) => {
          const r = {};
          Object.keys(raw).forEach((k) => { r[norm(k)] = raw[k]; });
          const pick = (...keys) => { for (const k of keys) if (r[k] !== undefined && String(r[k]).trim() !== "") return r[k]; return ""; };
          const name = String(pick("product name", "name", "item", "description")).trim();
          const upc = String(pick("upc", "upc/ean", "gtin")).trim();
          if (!name) { if (Object.values(raw).some((v) => String(v).trim())) skipped.push({ row: i + 2, reason: "No product name" }); return; }
          const existing = (upc && (taken[upc.toLowerCase()] || byUpc[upc.toLowerCase()])) || taken[name.toLowerCase()] || byName[name.toLowerCase()];
          if (existing && !existing.newItem) { skipped.push({ row: i + 2, reason: `${name} is already an established item in the product library` }); return; }
          const w = num(pick("width (in)", "width")), h = num(pick("height (in)", "height")), d = num(pick("depth (in)", "depth"));
          const category = String(pick("category")).trim();
          const proxyIds = [];
          String(pick("similar item upc(s)", "similar item upc", "similar items", "similar item")).split(/[,;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean).forEach((key) => {
            const hit = byUpc[key] || byName[key];
            if (hit && hit.id) proxyIds.push(hit.id); else warnings.push(`Row ${i + 2}: similar item "${key}" isn't in the library, so it was left off ${name}.`);
          });
          const scalePct = num(pick("similar item sales %", "similar item scale %", "similar item scale"));
          const info = {
            source: "category_manager", category,
            launchDate: toISODate(pick("launch date")) || "",
            retailPrice: num(pick("retail price", "price")) ?? 0,
            unitCost: num(pick("unit cost", "cost")) ?? 0,
            forecastUnitsPerStoreWeek: num(pick("weekly units per store (forecast)", "forecast", "weekly units per store")) ?? 0,
            proxyProductIds: proxyIds,
            proxyScale: scalePct && scalePct > 0 ? scalePct / 100 : 1,
          };
          const attributes = { ...(existing?.attributes || {}) };
          if (upcField && upc) attributes[upcField.id] = upc;
          if (catField && category) attributes[catField.id] = category;
          attrFields.forEach((f) => { const v = r[norm(f.label)]; if (v !== undefined && String(v).trim() !== "") attributes[f.id] = String(v).trim(); });
          const hasDims = w > 0 && h > 0 && d > 0;
          if (existing) {
            const next = {
              ...existing, attributes, sku: upc || existing.sku || "",
              dims: hasDims ? { w, h, d } : existing.dims,
              newItem: { ...existing.newItem, ...Object.fromEntries(Object.entries(info).filter(([k, v]) => !(v === "" || v === 0 || (Array.isArray(v) && v.length === 0)) || k === "source")), dimsMissing: hasDims ? false : existing.newItem?.dimsMissing },
            };
            updated.push(next);
            [upc.toLowerCase(), name.toLowerCase()].filter(Boolean).forEach((k) => { taken[k] = next; });
            return;
          }
          const product = {
            id: uid("prod"), name, sku: upc, dims: hasDims ? { w, h, d } : { w: 1, h: 1, d: 1 }, attributes, images: {}, overhangIn: 0, squeezeFactor: 1, merchStyles: {},
            pendingApproval: true, resetProtected: false, newItem: { ...info, dimsMissing: !hasDims, importedAt: new Date().toISOString() },
          };
          created.push(product);
          [upc.toLowerCase(), name.toLowerCase()].filter(Boolean).forEach((k) => { taken[k] = product; });
        });
        if (primaryKeyField === "upc" && !upcField) warnings.push('Your Product Primary Key is UPC but there is no "UPC" attribute yet, so these items can\'t be matched to Performance data until you add one under Settings.');
        resolve({ created, updated, skipped, warnings, totalRows: rows.length });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsArrayBuffer(file);
  });
}

// ---- shared pieces -------------------------------------------------------------------------------------------

function AssortSelect({ value, onChange, children, className = "" }) {
  return <select className={inputCls + " w-auto text-xs py-1 " + className} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>;
}

function AssortmentFilterBar({ cfg, setCfg, categories, stores, storeSchema, planogramSchema, planograms }) {
  const opts = React.useMemo(() => scopeOptions(stores, storeSchema), [stores, storeSchema]);
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const scopeValues = cfg.scope.type === "store" ? stores.map((s) => ({ v: s.id, l: s.name })).sort((a, b) => a.l.localeCompare(b.l))
    : cfg.scope.type === "storeAttr" ? (opts.attrs[cfg.scope.fieldId] || []).map((v) => ({ v, l: v }))
    : (opts[cfg.scope.type] || []).map((v) => ({ v, l: v }));
  const pf = cfg.planogramFilter || { fieldId: "", value: "" };
  const pfField = (planogramSchema || []).find((f) => f.id === pf.fieldId);
  const pfValues = pfField ? [...new Set(planograms.filter((p) => p.category === cfg.category).map((p) => attrDisplay(pfField, p.attributes?.[pfField.id])).filter(Boolean))].sort() : [];
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4 flex flex-wrap items-end gap-3">
      <div>
        <label className={labelCls}>Category</label>
        <AssortSelect value={cfg.category} onChange={(category) => set({ category })} className="min-w-[160px]">
          <option value="">Choose a category…</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </AssortSelect>
      </div>
      <div>
        <label className={labelCls}>Look at</label>
        <div className="flex items-center gap-1.5">
          <AssortSelect value={cfg.scope.type === "storeAttr" ? `attr:${cfg.scope.fieldId}` : cfg.scope.type} onChange={(v) => {
            if (v.startsWith("attr:")) { const f = (storeSchema || []).find((x) => x.id === v.slice(5)); set({ scope: { type: "storeAttr", fieldId: v.slice(5), fieldLabel: f?.label || "", value: "" } }); }
            else set({ scope: { type: v, value: "" } });
          }}>
            <option value="all">All stores</option>
            <option value="region">A region</option>
            <option value="cluster">A store cluster</option>
            <option value="format">A store format</option>
            <option value="store">One store</option>
            {(storeSchema || []).map((f) => <option key={f.id} value={`attr:${f.id}`}>Stores by {f.label}</option>)}
          </AssortSelect>
          {cfg.scope.type !== "all" && (
            <AssortSelect value={cfg.scope.value} onChange={(value) => set({ scope: { ...cfg.scope, value } })} className="min-w-[140px]">
              <option value="">{scopeValues.length ? "Choose…" : cfg.scope.type === "cluster" ? "No clusters set on stores yet" : "None available"}</option>
              {scopeValues.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </AssortSelect>
          )}
        </div>
      </div>
      {(planogramSchema || []).length > 0 && (
        <div>
          <label className={labelCls}>Planograms where</label>
          <div className="flex items-center gap-1.5">
            <AssortSelect value={pf.fieldId} onChange={(fieldId) => set({ planogramFilter: { fieldId, value: "" } })}>
              <option value="">Any planogram</option>
              {planogramSchema.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </AssortSelect>
            {pfField && (
              <AssortSelect value={pf.value} onChange={(value) => set({ planogramFilter: { ...pf, value } })} className="min-w-[110px]">
                <option value="">Choose…</option>
                {pfValues.map((v) => <option key={v} value={v}>{v}</option>)}
              </AssortSelect>
            )}
          </div>
        </div>
      )}
      <div>
        <label className={labelCls}>Period</label>
        <AssortSelect value={String(cfg.weeks)} onChange={(w) => set({ weeks: Number(w) })}>
          {[4, 8, 13, 26, 52].map((w) => <option key={w} value={w}>Last {w} weeks</option>)}
        </AssortSelect>
      </div>
      <div>
        <label className={labelCls}>Compare with</label>
        <AssortSelect value={cfg.compare} onChange={(compare) => set({ compare })}>
          <option value="prior">The {cfg.weeks} weeks before</option>
          <option value="yoy">Same weeks last year</option>
        </AssortSelect>
      </div>
    </div>
  );
}

// ---- Segments ------------------------------------------------------------------------------------------------

function SegmentsView({ ctx, tree, cfg, setCfg, productSchema }) {
  const [open, setOpen] = useState(() => new Set());
  const fieldOptions = productSchema.filter((f) => !["category", "upc"].includes(f.label.trim().toLowerCase()) && !cfg.segmentFieldIds.includes(f.id));
  const labelOf = (id) => productSchema.find((f) => f.id === id)?.label || "(removed attribute)";
  const move = (i, d) => setCfg((c) => { const a = [...c.segmentFieldIds]; const j = i + d; if (j < 0 || j >= a.length) return c; [a[i], a[j]] = [a[j], a[i]]; return { ...c, segmentFieldIds: a }; });
  const toggle = (key) => setOpen((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const rows = [];
  const walk = (nodes) => nodes.forEach((nd) => { rows.push(nd); if (open.has(nd.key)) walk(nd.children); });
  walk(tree.nodes);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-slate-800 mb-1">How does a shopper decide at the shelf?</h3>
        <p className="text-xs text-slate-500 mb-3">
          Pick the product attributes in the order a shopper makes the decision. For cereal that might be Age group (adult or kids) first, then Sugar level, then Brand.
          Each step splits the category further, so you can see which segments are growing, which are declining, and how much shelf each one holds compared with what it sells.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {cfg.segmentFieldIds.map((id, i) => (
            <span key={id} className="inline-flex items-center gap-1 bg-amber-50 border border-amber-300 rounded-full pl-2.5 pr-1 py-0.5 text-xs font-medium text-slate-800">
              <span className="text-[10px] text-amber-700 font-bold">{i + 1}</span> {labelOf(id)}
              <button className="text-slate-400 hover:text-slate-700 px-0.5" title="Earlier" disabled={i === 0} onClick={() => move(i, -1)}><ChevronLeft size={12} /></button>
              <button className="text-slate-400 hover:text-slate-700 px-0.5" title="Later" disabled={i === cfg.segmentFieldIds.length - 1} onClick={() => move(i, 1)}><ChevronRight size={12} /></button>
              <button className="text-slate-400 hover:text-red-600 px-0.5" title="Remove" onClick={() => setCfg((c) => ({ ...c, segmentFieldIds: c.segmentFieldIds.filter((x) => x !== id) }))}><X size={12} /></button>
            </span>
          ))}
          <AssortSelect value="" onChange={(id) => { if (id) setCfg((c) => ({ ...c, segmentFieldIds: [...c.segmentFieldIds, id] })); }}>
            <option value="">{cfg.segmentFieldIds.length ? "+ Then…" : "+ First decision…"}</option>
            {fieldOptions.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </AssortSelect>
        </div>
        {productSchema.length === 0 && <p className="text-xs text-amber-700 mt-2">No product attributes are set up yet. Add them under Settings, then fill them in on your products.</p>}
      </div>

      {!cfg.category ? (
        <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">Choose a category above.</p>
      ) : ctx.storeCount === 0 ? (
        <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">No Live or Pending planograms in <span className="font-semibold">{cfg.category}</span> are assigned to {ctx.scope.label.toLowerCase()}.</p>
      ) : !ctx.win ? (
        <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">No Performance data is loaded yet.</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <div className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100">
            {ctx.params.category} · {ctx.scope.label} · {ctx.storeCount} store{ctx.storeCount === 1 ? "" : "s"} · {ctx.win.cur.start} to {ctx.win.cur.end} against {ctx.win.base.start} to {ctx.win.base.end}
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-2 font-semibold">Segment</th>
                <th className="px-2 py-2 font-semibold text-right">Items</th>
                <th className="px-2 py-2 font-semibold text-right">Sales</th>
                <th className="px-2 py-2 font-semibold text-right">% of sales</th>
                <th className="px-2 py-2 font-semibold text-right">% of space</th>
                <th className="px-2 py-2 font-semibold text-right" title="Share of sales ÷ share of space × 100. Over 100 earns more than the room it takes.">Space index</th>
                <th className="px-2 py-2 font-semibold text-right">Sales growth</th>
                <th className="px-2 py-2 font-semibold">Trend</th>
                <th className="px-2 py-2 font-semibold">What it means</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-slate-50/60 font-semibold text-slate-800">
                <td className="px-3 py-2">{ctx.params.category} (all)</td>
                <td className="px-2 py-2 text-right">{tree.total.skus}</td>
                <td className="px-2 py-2 text-right">{moneyA(tree.total.sales)}</td>
                <td className="px-2 py-2 text-right">100%</td>
                <td className="px-2 py-2 text-right">100%</td>
                <td className="px-2 py-2 text-right">100</td>
                <td className={`px-2 py-2 text-right ${growthCls(tree.total.growth)}`}>{growthA(tree.total.growth)}</td>
                <td className="px-2 py-2">{tree.total.growth === null ? "n/a" : tree.total.growth >= 0.02 ? "Growing" : tree.total.growth <= -0.02 ? "Declining" : "Flat"}</td>
                <td className="px-2 py-2 text-slate-400 font-normal">{tree.total.growth === null ? "Needs earlier-period sales to compare" : ""}</td>
              </tr>
              {rows.map((nd) => (
                <tr key={nd.key} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5" style={{ paddingLeft: 12 + nd.depth * 18 }}>
                    <span className="inline-flex items-center gap-1">
                      {nd.children.length > 0 ? (
                        <button className="text-slate-400 hover:text-slate-700" onClick={() => toggle(nd.key)}>{open.has(nd.key) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                      ) : <span className="w-[13px]" />}
                      <span className="font-medium text-slate-800">{nd.label}</span>
                      <span className="text-[10px] text-slate-400">{labelOf(ctx.levels[nd.depth])}</span>
                      {nd.largestSpace && <span className="text-[9px] font-bold uppercase tracking-wide bg-slate-100 text-slate-600 border border-slate-200 rounded px-1 py-0.5" title="Holds the most shelf space among its siblings">Most space</span>}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right">{nd.metrics.skus}</td>
                  <td className="px-2 py-1.5 text-right">{moneyA(nd.metrics.sales)}</td>
                  <td className="px-2 py-1.5 text-right">{pctA(nd.shareOfCategorySales)}</td>
                  <td className="px-2 py-1.5 text-right">{pctA(nd.shareOfCategorySpace)}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${nd.spaceIndex === null ? "text-slate-400" : nd.spaceIndex >= 115 ? "text-emerald-600" : nd.spaceIndex <= 85 ? "text-red-600" : "text-slate-600"}`}>{nd.spaceIndex ?? "—"}</td>
                  <td className={`px-2 py-1.5 text-right ${growthCls(nd.growth)}`}>{growthA(nd.growth)}{nd.vsCategoryPp !== null && <span className="block text-[10px] text-slate-400">{nd.vsCategoryPp >= 0 ? "+" : ""}{nd.vsCategoryPp} pts vs category</span>}</td>
                  <td className="px-2 py-1.5">{nd.trend}</td>
                  <td className="px-2 py-1.5 text-slate-500">
                    {nd.opportunity && <span className={`mr-1 text-[10px] font-bold uppercase tracking-wide rounded px-1 py-0.5 border ${nd.opportunity === "Add space" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"}`}>{nd.opportunity}</span>}
                    {nd.spaceNote}
                  </td>
                </tr>
              ))}
              {tree.nodes.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-4 text-center text-slate-400 italic">Choose the first decision above to split this category into segments.</td></tr>
              )}
            </tbody>
          </table>
          <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">Space is each item's shelf width, averaged per store in this view. Space index is measured against the segment's siblings (its parent), so you can read it straight down a level.</div>
        </div>
      )}
    </div>
  );
}

// ---- Slow movers ---------------------------------------------------------------------------------------------

function SlowMoversView({ ctx, cfg, setCfg, segLabel, storeSchema }) {
  const [showAll, setShowAll] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const result = React.useMemo(() => slowMovers(ctx, { groupBy: cfg.groupBy }), [ctx, cfg.groupBy]);
  const shown = result.rows.filter((r) => !onlyFlagged || r.slowest || r.declining);
  const visible = showAll ? shown : shown.slice(0, 40);
  if (!cfg.category) return <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">Choose a category above.</p>;
  if (ctx.storeCount === 0) return <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">No Live or Pending planograms in <span className="font-semibold">{cfg.category}</span> are assigned to {ctx.scope.label.toLowerCase()}.</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-slate-500">Slowest first by units per store per week. The bottom quarter (at or under {result.slowThreshold}) is flagged.</span>
        <label className="text-xs text-slate-500 flex items-center gap-1.5 ml-auto">Compare across
          <AssortSelect value={cfg.groupBy} onChange={(groupBy) => setCfg((c) => ({ ...c, groupBy }))}>
            <option value="none">Nothing</option><option value="region">Regions</option><option value="cluster">Clusters</option><option value="format">Formats</option><option value="store">Stores</option>
            {(storeSchema || []).map((f) => <option key={f.id} value={`storeAttr:${f.id}`}>By {f.label}</option>)}
          </AssortSelect>
        </label>
        <label className="text-xs text-slate-500 flex items-center gap-1.5"><input type="checkbox" className="accent-amber-500" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Only slow or declining</label>
      </div>
      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500 uppercase tracking-wide">
              <th className="px-3 py-2 font-semibold">#</th>
              <th className="px-2 py-2 font-semibold">Item</th>
              <th className="px-2 py-2 font-semibold">Segment</th>
              <th className="px-2 py-2 font-semibold text-right">Units / store / wk</th>
              <th className="px-2 py-2 font-semibold text-right">Sales / store / wk</th>
              <th className="px-2 py-2 font-semibold text-right">Space (in)</th>
              <th className="px-2 py-2 font-semibold text-right">Sales / in / wk</th>
              <th className="px-2 py-2 font-semibold text-right">Growth</th>
              <th className="px-2 py-2 font-semibold text-right">Stores</th>
              {result.groups.length > 0 && <th className="px-2 py-2 font-semibold">Slow in</th>}
              <th className="px-2 py-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((r) => (
              <tr key={r.productId} className={r.slowest ? "bg-amber-50/50" : ""}>
                <td className="px-3 py-1.5 text-slate-400">{r.rank}</td>
                <td className="px-2 py-1.5 font-medium text-slate-800">{r.name}</td>
                <td className="px-2 py-1.5 text-slate-500">{r.segment.length ? r.segment.join(" › ") : "—"}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{r.velocity}</td>
                <td className="px-2 py-1.5 text-right">{money2A(r.salesPerStoreWeek)}</td>
                <td className="px-2 py-1.5 text-right">{r.spaceIn}</td>
                <td className="px-2 py-1.5 text-right">{money2A(r.salesPerInchWeek)}</td>
                <td className={`px-2 py-1.5 text-right ${growthCls(r.growth)}`}>{growthA(r.growth)}</td>
                <td className="px-2 py-1.5 text-right">{r.stores}</td>
                {result.groups.length > 0 && (
                  <td className="px-2 py-1.5 text-slate-600" title={r.groupVelocity.filter((g) => g.velocity !== null).map((g) => `${g.label}: ${g.velocity}${g.slow ? " (slow)" : ""}`).join("\n")}>
                    {r.groupsCarried > 0 ? `${r.slowIn} of ${r.groupsCarried}` : "—"}
                  </td>
                )}
                <td className="px-2 py-1.5">
                  {r.slowest && <span className="text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-300 rounded px-1 py-0.5 mr-1">Slow</span>}
                  {r.declining && <span className="text-[9px] font-bold uppercase tracking-wide bg-red-50 text-red-700 border border-red-200 rounded px-1 py-0.5 mr-1">Declining</span>}
                  {!r.hasData && r.units > 0 && <span className="text-[9px] text-slate-400" title="Fewer weeks of data than the minimum">thin data</span>}
                </td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={11} className="px-3 py-4 text-center text-slate-400 italic">Nothing matches.</td></tr>}
          </tbody>
        </table>
        {shown.length > 40 && (
          <button className="w-full text-xs text-slate-500 hover:bg-slate-50 py-2 border-t border-slate-100" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${shown.length}`}</button>
        )}
      </div>
      <p className="text-[11px] text-slate-400">An item that is slow in most {result.groups.length ? "groups" : "places"} it is carried is a stronger candidate to drop than one that is slow in only one. {segLabel}</p>
    </div>
  );
}

// ---- New items -----------------------------------------------------------------------------------------------

function NewItemEditor({ item, products, productSchema, categories, onSave, onCancel, onDelete }) {
  const n = item.newItem || {};
  const upcField = productSchema.find((f) => f.label.trim().toLowerCase() === "upc");
  const catField = productSchema.find((f) => f.label.trim().toLowerCase() === "category");
  const [name, setName] = useState(item.name);
  const [upc, setUpc] = useState((upcField ? item.attributes?.[upcField.id] : "") || item.sku || "");
  const [category, setCategory] = useState(n.category || (catField ? item.attributes?.[catField.id] : "") || "");
  const [dims, setDims] = useState({ w: n.dimsMissing ? "" : item.dims?.w ?? "", h: n.dimsMissing ? "" : item.dims?.h ?? "", d: n.dimsMissing ? "" : item.dims?.d ?? "" });
  const [price, setPrice] = useState(n.retailPrice || "");
  const [cost, setCost] = useState(n.unitCost || "");
  const [forecast, setForecast] = useState(n.forecastUnitsPerStoreWeek || "");
  const [scalePct, setScalePct] = useState(Math.round((n.proxyScale || 1) * 100));
  const [proxyIds, setProxyIds] = useState(n.proxyProductIds || []);
  const [launch, setLaunch] = useState(n.launchDate || "");
  const [attrs, setAttrs] = useState(item.attributes || {});
  const [proxyQuery, setProxyQuery] = useState("");
  const attrFields = productSchema.filter((f) => f !== upcField && f !== catField);
  const candidates = products.filter((p) => !p.newItem && p.id !== item.id && (!proxyQuery.trim() || p.name.toLowerCase().includes(proxyQuery.trim().toLowerCase()))).slice(0, 8);
  const hasDims = Number(dims.w) > 0 && Number(dims.h) > 0 && Number(dims.d) > 0;
  const valuesFor = (fid) => [...new Set(products.map((p) => p.attributes?.[fid]).filter((v) => v !== undefined && v !== null && String(v).trim()).map(String))].sort();

  const save = () => {
    if (!name.trim()) return;
    const attributes = { ...attrs };
    if (upcField) attributes[upcField.id] = upc.trim();
    if (catField && category.trim()) attributes[catField.id] = category.trim();
    onSave({
      ...item, name: name.trim(), sku: upc.trim(), attributes,
      dims: hasDims ? { w: Number(dims.w), h: Number(dims.h), d: Number(dims.d) } : item.dims,
      newItem: {
        ...n, category: category.trim(), launchDate: launch, retailPrice: Number(price) || 0, unitCost: Number(cost) || 0,
        forecastUnitsPerStoreWeek: Number(forecast) || 0, proxyProductIds: proxyIds, proxyScale: Math.max(0.01, (Number(scalePct) || 100) / 100), dimsMissing: !hasDims,
      },
    });
  };

  return (
    <div className="bg-slate-50 border border-amber-200 rounded-lg p-4 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="UPC"><input className={inputCls} value={upc} onChange={(e) => setUpc(e.target.value)} /></Field>
        <Field label="Category">
          <input className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} list="assort-cats" />
          <datalist id="assort-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
        <Field label="Width (in)"><input type="number" step="0.01" className={inputCls} value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} /></Field>
        <Field label="Height (in)"><input type="number" step="0.01" className={inputCls} value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} /></Field>
        <Field label="Depth (in)"><input type="number" step="0.01" className={inputCls} value={dims.d} onChange={(e) => setDims({ ...dims, d: e.target.value })} /></Field>
        <Field label="Retail price"><input type="number" step="0.01" className={inputCls} value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Unit cost"><input type="number" step="0.01" className={inputCls} value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
        <Field label="Launch date"><input type="date" className={inputCls} value={launch} onChange={(e) => setLaunch(e.target.value)} /></Field>
      </div>
      {attrFields.length > 0 && (
        <div>
          <div className={labelCls}>Attributes (what the Segments view groups by)</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {attrFields.map((f) => (
              <Field key={f.id} label={f.label}>
                <input className={inputCls} value={attrs[f.id] ?? ""} onChange={(e) => setAttrs({ ...attrs, [f.id]: e.target.value })} list={`assort-vals-${f.id}`} />
                <datalist id={`assort-vals-${f.id}`}>{valuesFor(f.id).map((v) => <option key={v} value={v} />)}</datalist>
              </Field>
            ))}
          </div>
        </div>
      )}
      <div className="border-t border-slate-200 pt-3">
        <div className={labelCls}>How much will it sell?</div>
        <p className="text-xs text-slate-500 mb-2">Either type a forecast, or pick one or more similar items already in the library and its sales are taken from theirs.</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
          <Field label="Forecast (units / store / week)"><input type="number" step="0.1" className={inputCls} value={forecast} onChange={(e) => setForecast(e.target.value)} placeholder="optional" /></Field>
          <Field label="Sells as much as similar (%)"><input type="number" className={inputCls} value={scalePct} onChange={(e) => setScalePct(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          {proxyIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 bg-white border border-slate-300 rounded-full pl-2 pr-1 py-0.5 text-xs">
              {products.find((p) => p.id === id)?.name || "(removed)"}
              <button className="text-slate-400 hover:text-red-600" onClick={() => setProxyIds(proxyIds.filter((x) => x !== id))}><X size={11} /></button>
            </span>
          ))}
          {proxyIds.length === 0 && <span className="text-xs text-slate-400 italic">No similar items chosen</span>}
        </div>
        <input className={inputCls + " max-w-xs"} placeholder="Find a similar item…" value={proxyQuery} onChange={(e) => setProxyQuery(e.target.value)} />
        {proxyQuery.trim() && (
          <div className="mt-1 max-w-xs bg-white border border-slate-200 rounded-md divide-y divide-slate-100">
            {candidates.map((p) => (
              <button key={p.id} className="w-full text-left text-xs px-2 py-1.5 hover:bg-slate-50 disabled:text-slate-300" disabled={proxyIds.includes(p.id)} onClick={() => { setProxyIds([...proxyIds, p.id]); setProxyQuery(""); }}>{p.name}</button>
            ))}
            {candidates.length === 0 && <div className="text-xs text-slate-400 px-2 py-1.5">No match</div>}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-slate-200">
        <button className="text-xs text-red-600 hover:underline" onClick={onDelete}>Delete from library</button>
        <div className="flex gap-2"><button className={btnGhost} onClick={onCancel}>Cancel</button><button className={btnPrimary} onClick={save}><Save size={14} /> Save</button></div>
      </div>
    </div>
  );
}

function NewItemsView({ ctx, products, productSchema, categories, primaryKeyField, cfg, onCreate, onUpdate, onDelete }) {
  const fileRef = useRef(null);
  const [editingId, setEditingId] = useState(null);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [sheetLink, setSheetLink] = useState("");
  const [sheetError, setSheetError] = useState("");
  const items = products.filter((p) => p.newItem).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

  const importFile = async (file) => {
    if (!file) return;
    setBusy(true); setStatus(null);
    try {
      const r = await parseNewItemWorkbook(file, products, productSchema, primaryKeyField);
      r.created.forEach(onCreate); r.updated.forEach(onUpdate);
      const parts = [];
      if (r.created.length) parts.push(`${r.created.length} added to the product library (pending approval)`);
      if (r.updated.length) parts.push(`${r.updated.length} updated`);
      if (r.skipped.length) parts.push(`${r.skipped.length} skipped (${r.skipped.slice(0, 3).map((s) => `row ${s.row}: ${s.reason}`).join("; ")}${r.skipped.length > 3 ? "…" : ""})`);
      setStatus({ type: r.created.length + r.updated.length ? "ok" : "error", message: (parts.join(", ") || "Nothing to import") + ".", warnings: r.warnings.slice(0, 6) });
    } catch (e) {
      setStatus({ type: "error", message: "Couldn't read that file. Use the template: an Excel (.xlsx/.xls) or CSV file with a Product Name column." });
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const importSheet = async () => {
    setSheetError("");
    if (!sheetLink.trim()) return;
    setBusy(true);
    try {
      const res = await invokeEdgeFunction("fetch-sheet", { url: sheetLink.trim() });
      const bin = atob(res.base64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setShowSheet(false); setSheetLink("");
      await importFile(new File([bytes], res.filename || "google-sheet.csv", { type: "text/csv" }));
    } catch (e) { setSheetError(e?.message || "Couldn't read that sheet."); setBusy(false); }
  };
  const addBlank = () => {
    const p = {
      id: uid("prod"), name: "New item", sku: "", dims: { w: 1, h: 1, d: 1 }, attributes: {}, images: {}, overhangIn: 0, squeezeFactor: 1, merchStyles: {}, pendingApproval: true, resetProtected: false,
      newItem: { source: "category_manager", category: cfg.category || "", launchDate: "", retailPrice: 0, unitCost: 0, forecastUnitsPerStoreWeek: 0, proxyProductIds: [], proxyScale: 1, dimsMissing: true, importedAt: new Date().toISOString() },
    };
    onCreate(p); setEditingId(p.id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-slate-500 flex-1 min-w-[240px]">New items from your category manager. Each one is added to the product library (flagged Pending until you approve it there), and needs either a forecast or a similar item so its sales can be estimated.</p>
        <div className="relative">
          <button className={btnGhost} onClick={() => setShowTemplateMenu((v) => !v)}><Download size={14} /> Template <ChevronDown size={12} /></button>
          {showTemplateMenu && (
            <div className="absolute right-0 z-30 mt-1 w-52 bg-white border border-slate-200 rounded-lg shadow-lg p-1.5">
              {[["xlsx", "Excel (.xlsx)"], ["xls", "Excel 97-2003 (.xls)"], ["csv", "CSV (.csv)"]].map(([id, label]) => (
                <button key={id} className="w-full text-left text-xs font-medium text-slate-700 px-2 py-1.5 rounded hover:bg-slate-50" onClick={() => { downloadNewItemTemplate(productSchema, id); setShowTemplateMenu(false); }}>{label}</button>
              ))}
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => importFile(e.target.files[0])} />
        <button className={btnGhost} disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}><Upload size={14} /> {busy ? "Reading…" : "Import file"}</button>
        <button className={btnGhost} disabled={busy} onClick={() => { setShowSheet((v) => !v); setSheetError(""); }}><Link2 size={14} /> From Google Sheet</button>
        <button className={btnPrimary} onClick={addBlank}><Plus size={14} /> Add item</button>
      </div>
      {showSheet && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
          <div className="text-xs text-slate-500">Paste the link to a Google Sheet laid out like the template, shared as <span className="font-semibold">Anyone with the link → Viewer</span>. The tab in the link is the one that's read.</div>
          <div className="flex gap-2">
            <input className={inputCls} value={sheetLink} onChange={(e) => setSheetLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" onKeyDown={(e) => { if (e.key === "Enter") importSheet(); }} />
            <button className={btnPrimary} disabled={busy || !sheetLink.trim()} onClick={importSheet}>Import</button>
            <button className={btnGhost} onClick={() => setShowSheet(false)}>Cancel</button>
          </div>
          {sheetError && <div className="text-xs rounded-md px-2.5 py-1.5 bg-red-50 text-red-700 border border-red-200">{sheetError}</div>}
        </div>
      )}
      {status && (
        <div className={`text-sm rounded-md px-3 py-2 ${status.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {status.message}
          {status.warnings?.length > 0 && <ul className="mt-1 text-xs list-disc pl-4 text-amber-700">{status.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">No new items yet. Download the template, fill it in (or paste the sheet your category manager sent), and import it.</p>
      ) : (
        <div className="space-y-2">
          {items.map((it) => {
            const fc = forecastFor(ctx, it);
            const n = it.newItem;
            return (
              <div key={it.id}>
                {editingId === it.id ? (
                  <NewItemEditor item={it} products={products} productSchema={productSchema} categories={categories} onCancel={() => setEditingId(null)}
                    onSave={(p) => { onUpdate(p); setEditingId(null); }} onDelete={() => { onDelete(it.id); setEditingId(null); }} />
                ) : (
                  <div className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-[200px]">
                      <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">{it.name}{it.pendingApproval && <span className="text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 border border-amber-300 rounded px-1 py-0.5">Pending</span>}</div>
                      <div className="text-xs text-slate-400">{n.category || "No category"}{it.sku ? ` · ${it.sku}` : ""}{n.dimsMissing ? "" : ` · ${it.dims.w}×${it.dims.h}×${it.dims.d} in`}{n.launchDate ? ` · launches ${n.launchDate}` : ""}</div>
                    </div>
                    <div className="text-xs text-slate-600 min-w-[200px]">
                      {fc.unitsPerStoreWeek !== null
                        ? <>Forecast <span className="font-semibold">{fc.unitsPerStoreWeek}</span> units/store/wk <span className="text-slate-400">({fc.basis}{fc.proxies.length ? `: ${fc.proxies.map((p) => p.name).join(", ")}` : ""})</span></>
                        : <span className="text-slate-400">{(n.proxyProductIds || []).length ? "Similar items have no sales history in this view" : "No forecast yet"}</span>}
                    </div>
                    {fc.ready
                      ? <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">Ready</span>
                      : <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{fc.missing}</span>}
                    <button className="text-xs text-amber-700 font-semibold hover:underline" onClick={() => setEditingId(it.id)}>Edit</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Recommendations -----------------------------------------------------------------------------------------

const CAND_STATUS = {
  recommended: ["Recommended", "bg-emerald-50 text-emerald-700 border-emerald-200"],
  not_worth_it: ["Not worth it", "bg-slate-100 text-slate-600 border-slate-200"],
  no_room: ["No room", "bg-red-50 text-red-700 border-red-200"],
  already_carried: ["Already carried", "bg-slate-100 text-slate-500 border-slate-200"],
  not_ready: ["Needs info", "bg-amber-50 text-amber-700 border-amber-200"],
  excluded: ["Left out", "bg-slate-100 text-slate-400 border-slate-200"],
};

function RecommendationsView({ ctx, products, cfg, setCfg, planogramFilter, onOpenProposal, onDrafted }) {
  const [showAllFor, setShowAllFor] = useState(() => new Set()); // item ids whose full planogram list is open
  const CAND_LIMIT = 25; // a chain can have hundreds of planograms per category; the best are listed first
  const newItems = products.filter((p) => p.newItem && (!cfg.category || !p.newItem.category || p.newItem.category === cfg.category));
  const [picked, setPicked] = useState(null); // Set of item ids; null = every ready item
  const [exclude, setExclude] = useState(() => new Set());
  const [protect, setProtect] = useState(() => new Set());
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState(null);
  const [error, setError] = useState("");
  const readyIds = React.useMemo(() => newItems.filter((p) => forecastFor(ctx, p).ready).map((p) => p.id), [ctx, newItems]);
  const chosen = (picked ? [...picked] : readyIds).filter((id) => newItems.some((p) => p.id === id));
  const rec = React.useMemo(() => (chosen.length && ctx.storeCount > 0 ? recommend(ctx, chosen, { exclude, protect }) : null), [ctx, chosen.join("|"), exclude, protect]); // eslint-disable-line react-hooks/exhaustive-deps
  const setA = (patch) => setCfg((c) => ({ ...c, assumptions: { ...c.assumptions, ...patch } }));
  const a = cfg.assumptions;
  const toggleSet = (setter, key) => setter((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const toggleItem = (id) => setPicked((prev) => { const base = new Set(prev || readyIds); if (base.has(id)) base.delete(id); else base.add(id); return base; });

  const draft = async () => {
    setDrafting(true); setError(""); setDraftResult(null);
    try {
      const res = await invokeEdgeFunction("draft-assortment", {
        newItemIds: chosen,
        params: { category: cfg.category, scope: cfg.scope.type === "all" ? { type: "all" } : cfg.scope, planogramFilter, weeks: cfg.weeks, compare: cfg.compare, segmentFieldIds: cfg.segmentFieldIds, assumptions: { metric: a.metric, cannibalization: a.cannibalization, transfer: a.transfer, maxRemovalsPerAdd: a.maxRemovalsPerAdd } },
        exclude: [...exclude], protect: [...protect],
      });
      setDraftResult(res);
      if (onDrafted) onDrafted();
    } catch (e) { setError(e?.message || "Couldn't draft the changes."); }
    finally { setDrafting(false); }
  };

  if (!cfg.category) return <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">Choose a category above.</p>;
  const metricWord = { sales: "sales", margin: "margin", units: "units" }[a.metric];
  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Which planograms should the new items go on?</h3>
          <p className="text-xs text-slate-500">For each planogram in {cfg.category}, an item goes in free shelf space if there is any; otherwise the slowest items come out to make room. A swap is only recommended if the new item's expected {metricWord} beats what is given up. The best items are placed first, and each decision updates the planogram for the next item.</p>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div><label className={labelCls}>Better means more</label>
            <AssortSelect value={a.metric} onChange={(metric) => setA({ metric })}><option value="sales">Sales $</option><option value="margin">Margin $</option><option value="units">Units</option></AssortSelect></div>
          <div><label className={labelCls} title="Share of a new item's sales that is really existing items' sales moving over">Cannibalization %</label>
            <input type="number" min="0" max="100" className={inputCls + " w-20 text-xs py-1"} value={Math.round(a.cannibalization * 100)} onChange={(e) => setA({ cannibalization: clamp((Number(e.target.value) || 0) / 100, 0, 1) })} /></div>
          <div><label className={labelCls} title="Share of a removed item's sales that stays in the category (shoppers buy something else)">Sales kept when an item is removed %</label>
            <input type="number" min="0" max="100" className={inputCls + " w-20 text-xs py-1"} value={Math.round(a.transfer * 100)} onChange={(e) => setA({ transfer: clamp((Number(e.target.value) || 0) / 100, 0, 1) })} /></div>
          <div><label className={labelCls}>Most to remove per new item</label>
            <AssortSelect value={String(a.maxRemovalsPerAdd)} onChange={(v) => setA({ maxRemovalsPerAdd: Number(v) })}>{[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</AssortSelect></div>
        </div>
        <div>
          <div className={labelCls}>New items to place</div>
          {newItems.length === 0 && <p className="text-xs text-slate-400 italic">No new items for this category yet — add them on the New items tab.</p>}
          <div className="flex flex-wrap gap-2">
            {newItems.map((p) => {
              const fc = forecastFor(ctx, p);
              const on = chosen.includes(p.id);
              return (
                <label key={p.id} className={`text-xs rounded-full border px-2.5 py-1 flex items-center gap-1.5 ${fc.ready ? "cursor-pointer" : "opacity-60"} ${on ? "bg-amber-50 border-amber-300" : "bg-white border-slate-300"}`} title={fc.ready ? "" : fc.missing}>
                  <input type="checkbox" className="accent-amber-500" disabled={!fc.ready} checked={on} onChange={() => toggleItem(p.id)} /> {p.name}{!fc.ready && <span className="text-amber-700"> · {fc.missing}</span>}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {ctx.storeCount === 0 && <p className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-6 text-center">No Live or Pending planograms in {cfg.category} are assigned to {ctx.scope.label.toLowerCase()}.</p>}
      {rec && (
        <>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex flex-wrap items-center gap-3">
            <div className="text-sm text-blue-900 flex-1 min-w-[240px]">
              <span className="font-semibold">{rec.totals.placements}</span> placement{rec.totals.placements === 1 ? "" : "s"} for <span className="font-semibold">{rec.totals.itemsRecommended}</span> of {rec.items.length} item{rec.items.length === 1 ? "" : "s"}, worth about <span className="font-semibold">{a.metric === "units" ? `${Math.round(rec.totals.netNetworkWeek).toLocaleString()} units` : moneyA(rec.totals.netNetworkWeek)}</span> a week across the stores in view.
            </div>
            <button className={btnPrimary} disabled={drafting || rec.totals.placements === 0} onClick={draft}><Sparkles size={14} /> {drafting ? "Drafting…" : "Draft changes for review"}</button>
          </div>
          {error && <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</div>}
          {draftResult && (
            <div className="bg-white border border-emerald-200 rounded-lg p-3 space-y-1.5">
              <div className="text-sm font-semibold text-emerald-800">{draftResult.proposals.length} draft{draftResult.proposals.length === 1 ? "" : "s"} ready for review</div>
              {draftResult.proposals.map((p) => (
                <div key={p.proposalId} className="flex items-center gap-3 text-sm">
                  <span className="font-medium text-slate-800">{p.planogramName}</span>
                  <span className="text-xs text-slate-500">{p.adds} added{p.removes ? `, ${p.removes} removed` : ""}</span>
                  <button className="text-xs text-amber-700 font-semibold hover:underline ml-auto" onClick={() => onOpenProposal(p.proposalId)}>Review</button>
                </div>
              ))}
              {draftResult.notDrafted.map((p) => <div key={p.planogramId} className="text-xs text-amber-700">{p.planogramName}: {p.reason}</div>)}
              <div className="text-[11px] text-slate-400">Approving a draft creates a new Work-in-Progress version of that planogram; nothing changes on a live planogram until you do.</div>
            </div>
          )}
          {rec.items.map((item) => (
            <div key={item.productId} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-sm font-semibold text-slate-800">{item.name}</span>
                <span className="text-xs text-slate-500">Forecast {item.forecast.unitsPerStoreWeek} units/store/wk ({item.forecast.basis}) at {money2A(item.forecast.price)}</span>
                {item.segment.length > 0 && (
                  <span className="text-xs text-slate-500">
                    {item.segment.join(" › ")}
                    {item.segmentTrend && <> — <span className={growthCls(item.segmentTrend.growth)}>{item.segmentTrend.trend.toLowerCase()}</span>{item.segmentTrend.spaceIndex !== null && <>, space index {item.segmentTrend.spaceIndex}</>}{item.segmentTrend.opportunity && <span className="ml-1 font-semibold text-emerald-700">· {item.segmentTrend.opportunity}</span>}</>}
                  </span>
                )}
                <span className="ml-auto text-xs font-semibold text-slate-600">{item.recommendedCount} planogram{item.recommendedCount === 1 ? "" : "s"} recommended</span>
              </div>
              <table className="w-full text-xs">
                <thead><tr className="text-left text-slate-400 uppercase tracking-wide border-b border-slate-100">
                  <th className="px-3 py-1.5 w-8"></th><th className="px-2 py-1.5 font-semibold">Planogram</th><th className="px-2 py-1.5 font-semibold text-right">Stores</th><th className="px-2 py-1.5 font-semibold">Result</th>
                  <th className="px-2 py-1.5 font-semibold">Where</th><th className="px-2 py-1.5 font-semibold">Makes room by removing</th><th className="px-2 py-1.5 font-semibold text-right">Net / store / wk</th><th className="px-2 py-1.5 font-semibold text-right">Net / wk</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {(showAllFor.has(item.productId) ? item.candidates : item.candidates.slice(0, CAND_LIMIT)).map((c) => {
                    const [label, cls] = CAND_STATUS[c.status] || [c.status, ""];
                    const key = `${item.productId}|${c.planogramId}`;
                    const canToggle = !["already_carried", "not_ready"].includes(c.status);
                    return (
                      <tr key={c.planogramId} className={c.status === "recommended" ? "" : "text-slate-500"} title={c.reason}>
                        <td className="px-3 py-1.5"><input type="checkbox" className="accent-amber-500" disabled={!canToggle} checked={c.status !== "excluded"} onChange={() => toggleSet(setExclude, key)} title="Include this planogram" /></td>
                        <td className="px-2 py-1.5 font-medium text-slate-800">{c.planogramName}</td>
                        <td className="px-2 py-1.5 text-right">{c.stores}</td>
                        <td className="px-2 py-1.5"><span className={`text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 border ${cls}`}>{label}</span></td>
                        <td className="px-2 py-1.5">{c.add ? `${c.add.sectionName ? c.add.sectionName + " · " : ""}${c.add.fixtureName}${c.add.spaceFreeIn !== undefined && c.removes.length === 0 ? ` (${c.add.spaceFreeIn}in free)` : ""}` : "—"}</td>
                        <td className="px-2 py-1.5">
                          {c.removes.length === 0 ? <span className="text-slate-400">{c.add ? "Nothing — it fits" : "—"}</span> : c.removes.map((rm) => (
                            <span key={rm.placementId} className="inline-flex items-center gap-1 mr-2">
                              {rm.name} <span className="text-slate-400">({rm.velocity}/wk)</span>
                              <button className={`${protect.has(rm.productId) ? "text-amber-600" : "text-slate-300 hover:text-amber-600"}`} title="Keep this item (don't remove it)" onClick={() => toggleSet(setProtect, rm.productId)}><Lock size={11} /></button>
                            </span>
                          ))}
                          {c.variety.length > 0 && <div className="text-[10px] text-blue-700">{c.variety.join(". ")}</div>}
                        </td>
                        <td className={`px-2 py-1.5 text-right ${c.netPerStoreWeek === null ? "" : c.netPerStoreWeek > 0 ? "text-emerald-600" : "text-red-600"}`}>{c.netPerStoreWeek === null ? "—" : a.metric === "units" ? c.netPerStoreWeek : money2A(c.netPerStoreWeek)}</td>
                        <td className={`px-2 py-1.5 text-right font-semibold ${c.netNetworkWeek === null ? "" : c.netNetworkWeek > 0 ? "text-emerald-600" : "text-red-600"}`}>{c.netNetworkWeek === null ? "—" : a.metric === "units" ? Math.round(c.netNetworkWeek) : moneyA(c.netNetworkWeek)}</td>
                      </tr>
                    );
                  })}
                  {item.candidates.length === 0 && <tr><td colSpan={8} className="px-3 py-3 text-center text-slate-400 italic">No planograms in view.</td></tr>}
                  {item.candidates.length > CAND_LIMIT && (
                    <tr><td colSpan={8} className="px-3 py-1.5 text-center"><button className="text-xs text-amber-700 font-semibold hover:underline" onClick={() => setShowAllFor((prev) => { const n = new Set(prev); if (n.has(item.productId)) n.delete(item.productId); else n.add(item.productId); return n; })}>{showAllFor.has(item.productId) ? `Show the top ${CAND_LIMIT}` : `Show all ${item.candidates.length} planograms`}</button></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
          <p className="text-[11px] text-slate-400">Untick a planogram to leave an item off it; click the lock to protect an item from being removed. The list updates straight away and the drafts follow what you see. Hover a row for the reasoning.</p>
        </>
      )}
    </div>
  );
}

// ---- The tab -------------------------------------------------------------------------------------------------

function AssortmentModule({ products, planograms, fixtures, stores, performance, productSchema, storeSchema, planogramSchema, primaryKeyField, onCreateProduct, onUpdateProduct, onDeleteProduct, onOpenProposal, onDrafted }) {
  const [cfg, setCfgState] = useState(ASSORT_DEFAULT_CFG);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("segments"); // segments | slow | newItems | recommend
  const saveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    safeGet("settings:assortment").then((raw) => {
      if (cancelled) return;
      try {
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved === "object") setCfgState((c) => ({ ...c, ...saved, scope: { ...c.scope, ...(saved.scope || {}) }, assumptions: { ...c.assumptions, ...(saved.assumptions || {}) } }));
      } catch (e) { /* keep defaults */ }
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);
  const setCfg = useCallback((updater) => {
    setCfgState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { safeSet("settings:assortment", JSON.stringify(next)); }, 800);
      return next;
    });
  }, []);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const categories = React.useMemo(() => Array.from(new Set(planograms.map((p) => p.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [planograms]);
  const scopeReady = cfg.scope.type === "all" || !!cfg.scope.value;
  const planogramFilter = cfg.planogramFilter?.fieldId && cfg.planogramFilter?.value ? { ...cfg.planogramFilter, fieldLabel: (planogramSchema || []).find((f) => f.id === cfg.planogramFilter.fieldId)?.label } : undefined;
  const ctx = React.useMemo(
    () => buildContext({ products, planograms, fixtures, performance, stores, productSchema }, {
      category: cfg.category, scope: scopeReady ? cfg.scope : { type: "all" }, planogramFilter, weeks: cfg.weeks, compare: cfg.compare, segmentFieldIds: cfg.segmentFieldIds, assumptions: cfg.assumptions,
    }),
    [products, planograms, fixtures, performance, stores, productSchema, cfg.category, cfg.scope, planogramFilter?.fieldId, planogramFilter?.value, scopeReady, cfg.weeks, cfg.compare, cfg.segmentFieldIds, cfg.assumptions],
  );
  const tree = React.useMemo(() => segmentTree(ctx), [ctx]);

  const tabs = [["segments", "Segments"], ["slow", "Slow movers"], ["newItems", "New items"], ["recommend", "Recommendations"]];
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-bold text-slate-800">Assortment</h2>
      </div>
      <p className="text-sm text-slate-500 mb-3">See which segments are growing, which items are slow, and where new items earn their space.</p>
      <AssortmentFilterBar cfg={cfg} setCfg={setCfg} categories={categories} stores={stores} storeSchema={storeSchema} planogramSchema={planogramSchema} planograms={planograms} />
      {!scopeReady && <p className="text-xs text-amber-700 mb-3">Choose a {cfg.scope.type} above; until then all stores are shown.</p>}
      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setView(id)} className={`-mb-px px-3 py-1.5 text-xs font-semibold rounded-t-md border border-b-0 ${view === id ? "bg-white border-slate-200 text-slate-800" : "bg-transparent border-transparent text-slate-500 hover:text-slate-700"}`}>{label}</button>
        ))}
      </div>
      {!loaded ? <div className="text-xs text-slate-400 flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> Loading your settings…</div> : (
        <>
          {view === "segments" && <SegmentsView ctx={ctx} tree={tree} cfg={cfg} setCfg={setCfg} productSchema={productSchema} />}
          {view === "slow" && <SlowMoversView ctx={ctx} cfg={cfg} setCfg={setCfg} segLabel="" storeSchema={storeSchema} />}
          {view === "newItems" && <NewItemsView ctx={ctx} products={products} productSchema={productSchema} categories={categories} primaryKeyField={primaryKeyField} cfg={cfg} onCreate={onCreateProduct} onUpdate={onUpdateProduct} onDelete={onDeleteProduct} />}
          {view === "recommend" && <RecommendationsView ctx={ctx} products={products} cfg={cfg} setCfg={setCfg} planogramFilter={planogramFilter} onOpenProposal={onOpenProposal} onDrafted={onDrafted} />}
        </>
      )}
    </div>
  );
}

function AppContent({ session }) {
  const [tab, setTab] = useState("planograms");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // profiles row: { role, store_id, regions, display_name }. undefined = still loading, null = none (no access).
  const [profile, setProfile] = useState(undefined);
  const loadProfile = useCallback(async () => {
    const uid = session?.user?.id;
    if (!uid) return;
    try {
      let r = await supabase.from("profiles").select("role, store_id, regions, display_name").eq("id", uid).maybeSingle();
      if (r.error) r = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle(); // older database without store/regions yet
      setProfile(r.error || !r.data?.role ? null : r.data);
    } catch (e) { setProfile(null); }
  }, [session?.user?.id]);
  useEffect(() => { loadProfile(); }, [loadProfile]);
  const userRole = profile?.role || null;
  const isAdmin = userRole === "admin";
  const isStoreScoped = userRole === "store_associate" || userRole === "regional_manager"; // lands on Store Assistant only
  const isEventPlanner = userRole === "event_planner"; // lands on Event Planner only
  const isRestricted = isStoreScoped || isEventPlanner;
  const signOut = () => supabase.auth.signOut();
  const isPlanner = userRole === "admin" || userRole === "category_manager"; // may see Reset Impact and Execution follow-up
  const [openEscalations, setOpenEscalations] = useState(0);
  useEffect(() => {
    if (!isPlanner) return;
    loadEscalations().then((r) => { if (r.ok) setOpenEscalations(r.rows.filter((x) => x.status === "open").length); });
  }, [isPlanner]);
  // the follow-up agent edits stores (reminder tasks) on the server; pull them back in
  const refreshStores = useCallback(async () => {
    try { const rows = await loadIndexed("store"); if (Array.isArray(rows) && rows.length > 0) setStores(rows); } catch (e) { /* keep what is on screen */ }
  }, []);

  const [productSchema, setProductSchema] = useState(DEFAULT_PRODUCT_SCHEMA);
  const [fixtureSchema, setFixtureSchema] = useState(DEFAULT_FIXTURE_SCHEMA);
  const [planogramSchema, setPlanogramSchema] = useState([]); // user-defined planogram attributes
  const [storeSchema, setStoreSchema] = useState([]); // user-defined store attributes
  const [primaryKeyField, setPrimaryKeyField] = useState("sku"); // "sku" | "upc" — global product matching key
  const [imageRepo, setImageRepo] = useState(DEFAULT_IMAGE_REPO);
  const [upcLookup, setUpcLookup] = useState(DEFAULT_UPC_LOOKUP);
  const [capacityWarningsEnabled, setCapacityWarningsEnabled] = useState(true);
  const [products, setProducts] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [planograms, setPlanograms] = useState([]);
  const [performance, setPerformance] = useState({}); // productId -> [{weekEnding, unitCost, price, units}]
  const [stores, setStores] = useState([]);
  const [activePlanogramId, setActivePlanogramId] = useState(null);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const [appMode, setAppModeState] = useState("planner"); // "planner" | "storeAssistant" | "eventPlanner"
  const [selectedStoreId, setSelectedStoreIdState] = useState(null); // which store is "logged in" to Store Assistant
  // restricted roles never write these shared settings (they have no access to them, and their screen is fixed by role)
  const setAppMode = (mode) => { setAppModeState(mode); if (!isRestricted) safeSet("settings:appMode", mode); };
  const setSelectedStoreId = (id) => { setSelectedStoreIdState(id); if (!isRestricted) safeSet("settings:selectedStoreId", id || ""); };
  const [events, setEvents] = useState([]); // Event Planner — reset/promo/etc events
  const [eventTypes, setEventTypes] = useState(DEFAULT_EVENT_TYPES); // customizable event type list
  const [taskTypes, setTaskTypes] = useState(DEFAULT_TASK_TYPES); // customizable Store Assistant task type list
  const [resetThresholds, setResetThresholds] = useState([]); // [{category, low, high}] — Reset Drafting Agent's Sales/Space Index bounds, per planogram category
  const [dosTargets, setDosTargets] = useState([]); // [{category, days}] — days of supply the shelf should hold, per planogram Category (no row = no check)
  const [draftingReset, setDraftingReset] = useState(false);
  const [proposals, setProposals] = useState({ loaded: false, rows: [] }); // pending agent Proposals (see ResetDraftQueue)
  const [reviewingProposalId, setReviewingProposalId] = useState(null); // the Proposal open in ProposalReview, if any
  const [profileNames, setProfileNames] = useState({}); // user id -> display name, for "requested by"

  // Pending Proposals drive the review queue. A failed read leaves loaded:false, which makes the
  // queue fall back to the drafts themselves rather than showing nothing.
  const refreshProposals = useCallback(async () => {
    const result = await loadPendingProposals();
    setProposals({ loaded: result.ok, rows: result.rows });
    if (result.ok) {
      const names = await loadProfileNames(result.rows.map((r) => r.requested_by));
      setProfileNames((prev) => ({ ...prev, ...names }));
    }
  }, []);
  useEffect(() => { refreshProposals(); }, [refreshProposals]);

  useEffect(() => {
    pendingWriteListeners.add(setPendingSaveCount);
    return () => pendingWriteListeners.delete(setPendingSaveCount);
  }, []);

  useEffect(() => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        setLoadError(true);
        setLoading(false);
      }
    }, 8000); // if storage hasn't responded within 8s, stop spinning and let the app open (empty) rather than hang forever

    (async () => {
      try {
        const [pSchema, fSchema, pogSchema, storeSch, pkField, imgRepo, upcLk, capWarn, prods, fixs, pogs, perf, strs, savedMode, savedStoreId, savedEvents, savedEventTypes, savedTaskTypes, savedResetThresholds, savedDosTargets] = await Promise.all([
          safeGet("schema:product"),
          safeGet("schema:fixture"),
          safeGet("schema:planogram"),
          safeGet("schema:store"),
          safeGet("settings:primaryKeyField"),
          safeGet("settings:imageRepo"),
          safeGet("settings:upcLookup"),
          safeGet("settings:capacityWarnings"),
          loadIndexed("product"),
          loadIndexed("fixture"),
          loadIndexed("planogram"),
          loadIndexed("perf"),
          loadIndexed("store"),
          safeGet("settings:appMode"),
          safeGet("settings:selectedStoreId"),
          safeGet("settings:events"),
          safeGet("schema:eventType"),
          safeGet("schema:taskType"),
          safeGet("schema:resetThresholds"),
          safeGet("schema:dosTargets"),
        ]);
        if (settled) return; // the timeout already fired and the app moved on — don't clobber state after the fact
        if (pSchema) setProductSchema(JSON.parse(pSchema));
        if (fSchema) setFixtureSchema(JSON.parse(fSchema));
        if (pogSchema) setPlanogramSchema(JSON.parse(pogSchema));
        if (storeSch) setStoreSchema(JSON.parse(storeSch));
        if (pkField) setPrimaryKeyField(pkField);
        if (imgRepo) setImageRepo({ ...DEFAULT_IMAGE_REPO, ...JSON.parse(imgRepo) });
        if (upcLk) setUpcLookup({ ...DEFAULT_UPC_LOOKUP, ...migrateUpcLookup(JSON.parse(upcLk)) });
        if (capWarn !== null) setCapacityWarningsEnabled(capWarn === "true");
        if (savedMode) setAppModeState(savedMode);
        if (savedStoreId) setSelectedStoreIdState(savedStoreId);
        if (savedEvents) setEvents(JSON.parse(savedEvents));
        if (savedEventTypes) setEventTypes(JSON.parse(savedEventTypes));
        if (savedTaskTypes) setTaskTypes(JSON.parse(savedTaskTypes));
        if (savedResetThresholds) setResetThresholds(JSON.parse(savedResetThresholds));
        if (savedDosTargets) setDosTargets(JSON.parse(savedDosTargets));
        setProducts(prods);
        setFixtures(fixs);
        setPlanograms(pogs);
        const perfMap = {};
        perf.forEach((entry) => { perfMap[entry.id] = entry.records; });
        setPerformance(perfMap);
        setStores(strs);
      } catch (e) {
        if (!settled) setLoadError(true);
      } finally {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          setLoading(false);
        }
      }
    })();

    return () => clearTimeout(timeoutId);
  }, []);

  // Planogram Lifecycle auto-transitions, checked whenever planograms change and persisted when
  // due. Both are naturally self-limiting — once a planogram's stored status actually matches
  // the transitioned-to value, its condition is no longer true, so this won't keep re-writing on
  // every re-render.
  useEffect(() => {
    const today = todayISO();
    planograms.forEach((p) => {
      const status = p.status || "wip";
      // (1) Approved publishes to Pending 3 weeks before the event date — this is the moment a
      // future store-associate module would be notified of what's coming, so stores can start
      // marking down items being removed. A publishedAt timestamp is recorded now as the data
      // hook for that integration.
      if (status === "approved" && p.eventDate && today >= addDaysISO(p.eventDate, -PENDING_LEAD_DAYS)) {
        const next = { ...p, status: "pending", publishedAt: p.publishedAt || new Date().toISOString() };
        saveIndexed("planogram", next);
        setPlanograms((prev) => prev.map((x) => (x.id === p.id ? next : x)));
        return;
      }
      // (2) Pending becomes Live exactly on the event date — promoteToLive also retires any
      // other Live member of the same version family, which is what actually makes a planogram
      // become Historical in practice: a newer version taking over.
      if (status === "pending" && p.eventDate && today >= p.eventDate) {
        promoteToLive(p);
      }
    });
  }, [planograms]);

  const updateProductSchema = (next) => { setProductSchema(next); safeSet("schema:product", JSON.stringify(next)); };
  const updateFixtureSchema = (next) => { setFixtureSchema(next); safeSet("schema:fixture", JSON.stringify(next)); };
  const updatePlanogramSchema = (next) => { setPlanogramSchema(next); safeSet("schema:planogram", JSON.stringify(next)); };
  const updateStoreSchema = (next) => { setStoreSchema(next); safeSet("schema:store", JSON.stringify(next)); };
  const updatePrimaryKeyField = (next) => { setPrimaryKeyField(next); safeSet("settings:primaryKeyField", next); };
  const updateImageRepo = (patch) => {
    setImageRepo((prev) => {
      const next = { ...prev, ...patch };
      safeSet("settings:imageRepo", JSON.stringify(next));
      return next;
    });
  };
  const updateUpcLookup = (patch) => {
    setUpcLookup((prev) => {
      const next = { ...prev, ...patch };
      safeSet("settings:upcLookup", JSON.stringify(next));
      return next;
    });
  };
  const updateCapacityWarningsEnabled = (next) => { setCapacityWarningsEnabled(next); safeSet("settings:capacityWarnings", String(next)); };

  const createProduct = (p) => { setProducts((prev) => [...prev, p]); saveIndexed("product", p); };
  const updateProductEntity = (p) => { setProducts((prev) => prev.map((x) => (x.id === p.id ? p : x))); saveIndexed("product", p); };
  const deleteProductEntity = (id) => { setProducts((prev) => prev.filter((x) => x.id !== id)); deleteIndexed("product", id); };

  const createFixture = (f) => { setFixtures((prev) => [...prev, f]); saveIndexed("fixture", f); };
  const updateFixtureEntity = (f) => { setFixtures((prev) => prev.map((x) => (x.id === f.id ? f : x))); saveIndexed("fixture", f); };
  const deleteFixtureEntity = (id) => { setFixtures((prev) => prev.filter((x) => x.id !== id)); deleteIndexed("fixture", id); };

  const createStore = (s) => { setStores((prev) => [...prev, s]); saveIndexed("store", s); };
  const updateStoreEntity = (s) => { setStores((prev) => prev.map((x) => (x.id === s.id ? s : x))); saveIndexed("store", s); };
  const deleteStoreEntity = (id) => {
    setStores((prev) => prev.filter((x) => x.id !== id));
    deleteIndexed("store", id);
    // also unassign this store from any planogram that referenced it
    setPlanograms((prev) => prev.map((p) => {
      if (!p.storeIds || !p.storeIds.includes(id)) return p;
      const next = { ...p, storeIds: p.storeIds.filter((sid) => sid !== id) };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  // Store Assistant Photo Gallery. Stored directly on the store entity (photos array) rather
  // than as a separate backend kind, since there's no "photos" table to write to — this reuses
  // the stores table's existing persistence path, the same approach used for execution/issues
  // on planograms.
  const addStorePhoto = (storeId, photo) => {
    setStores((prev) => prev.map((s) => {
      if (s.id !== storeId) return s;
      const next = { ...s, photos: [...(s.photos || []), photo] };
      saveIndexed("store", next);
      return next;
    }));
  };
  const deleteStorePhoto = (storeId, photoId) => {
    setStores((prev) => prev.map((s) => {
      if (s.id !== storeId) return s;
      const next = { ...s, photos: (s.photos || []).filter((p) => p.id !== photoId) };
      saveIndexed("store", next);
      return next;
    }));
  };

  // Store Assistant Task Management. Stored directly on the store entity (tasks array), the
  // same approach used for photos and issues, so it rides the existing stores table.
  const addStoreTask = (storeId, task) => {
    setStores((prev) => prev.map((s) => {
      if (s.id !== storeId) return s;
      const next = { ...s, tasks: [...(s.tasks || []), task] };
      saveIndexed("store", next);
      return next;
    }));
  };
  const updateStoreTask = (storeId, task) => {
    setStores((prev) => prev.map((s) => {
      if (s.id !== storeId) return s;
      const next = { ...s, tasks: (s.tasks || []).map((t) => (t.id === task.id ? task : t)) };
      saveIndexed("store", next);
      return next;
    }));
  };
  // The ask-tandom function already saved a confirmed task change; this only mirrors it into local state.
  const syncStoreTask = (storeId, task) => {
    setStores((prev) => prev.map((s) => (s.id !== storeId ? s : { ...s, tasks: (s.tasks || []).map((t) => (t.id === task.id ? task : t)) })));
  };
  const deleteStoreTask = (storeId, taskId) => {
    setStores((prev) => prev.map((s) => {
      if (s.id !== storeId) return s;
      const next = { ...s, tasks: (s.tasks || []).filter((t) => t.id !== taskId) };
      saveIndexed("store", next);
      return next;
    }));
  };

  // Event Planner: events and the customizable event-type list are both stored as a single JSON
  // blob each in the generic settings store (there's no dedicated "events" backend table), so
  // every write persists the WHOLE array/list at once rather than one row per event.
  const createEvent = (event) => {
    setEvents((prev) => {
      const next = [...prev, event];
      safeSet("settings:events", JSON.stringify(next));
      return next;
    });
  };
  const updateEvent = (event) => {
    setEvents((prev) => {
      const next = prev.map((e) => (e.id === event.id ? event : e));
      safeSet("settings:events", JSON.stringify(next));
      return next;
    });
  };
  const deleteEvent = (id) => {
    setEvents((prev) => {
      const next = prev.filter((e) => e.id !== id);
      safeSet("settings:events", JSON.stringify(next));
      return next;
    });
  };
  const updateEventTypes = (next) => {
    setEventTypes(next);
    safeSet("schema:eventType", JSON.stringify(next));
  };
  const updateTaskTypes = (next) => {
    setTaskTypes(next);
    safeSet("schema:taskType", JSON.stringify(next));
  };
  const updateResetThresholds = (next) => {
    setResetThresholds(next);
    safeSet("schema:resetThresholds", JSON.stringify(next));
  };
  const updateDosTargets = (next) => {
    setDosTargets(next);
    safeSet("schema:dosTargets", JSON.stringify(next));
  };


  const createPlanogram = (p) => { setPlanograms((prev) => [...prev, p]); saveIndexed("planogram", p); };
  const savePerformanceForProduct = (productId, records) => {
    setPerformance((prev) => ({ ...prev, [productId]: records }));
    saveIndexed("perf", { id: productId, records });
  };
  const deletePerformanceForProduct = (productId) => {
    setPerformance((prev) => { const next = { ...prev }; delete next[productId]; return next; });
    deleteIndexed("perf", productId);
  };
  const clearAllPerformance = () => {
    const ids = Object.keys(performance);
    setPerformance({});
    ids.forEach((id) => deleteIndexed("perf", id));
  };
  const updatePlanogramEntity = useCallback((p) => {
    setPlanograms((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    saveIndexed("planogram", p);
  }, []);
  const deletePlanogramEntity = (id) => {
    // Deleting an unreviewed AI draft from anywhere (e.g. the planogram list) counts as rejecting
    // it, so its Proposal doesn't sit pending forever. Already decided -> the database no-ops.
    const doomed = planograms.find((x) => x.id === id);
    if (doomed?.resetDraft?.proposalId && !doomed.resetDraft.reviewed) {
      reviewProposal(doomed.resetDraft.proposalId, "rejected", `Draft version "${doomed.name}" deleted`).catch(() => {}).finally(refreshProposals);
    }
    setPlanograms((prev) => prev.filter((x) => x.id !== id));
    deleteIndexed("planogram", id);
    if (activePlanogramId === id) setActivePlanogramId(null);
  };
  const assignStoresToPlanogram = (planogramId, storeIds) => {
    setPlanograms((prev) => prev.map((p) => {
      if (p.id !== planogramId) return p;
      const next = { ...p, storeIds };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  // Builds a new version of `source`, using `existingList` (not necessarily the latest React
  // state) to compute the next version number — this indirection is what lets bulk creation
  // below get correct, non-colliding version numbers even when two selected planograms belong
  // to the same family, since state updates don't land synchronously between loop iterations.
  const buildPlanogramVersion = (source, existingList) => makePlanogramVersion(source, existingList);

  // Creates a new version of a planogram, always linked back to the ORIGINAL master of its
  // family (never to whichever version it happens to be copied from). The merchandising content
  // is deep-cloned with fresh ids; the lifecycle resets to WIP with a clean slate — a new version
  // is a fresh planning cycle, not a continuation of the source's own publish/live history.
  const createPlanogramVersion = (source) => {
    const next = buildPlanogramVersion(source, planograms);
    createPlanogram(next);
    return next;
  };

  // Same as above, but for creating versions of several selected planograms at once. Tracks a
  // local running list as it goes (rather than re-reading the same stale `planograms` snapshot
  // for every iteration) so two selections from the same family still get distinct, correctly
  // incrementing version numbers instead of colliding.
  const createPlanogramVersionsBulk = (sources) => {
    let workingList = planograms;
    const created = [];
    sources.forEach((source) => {
      const next = buildPlanogramVersion(source, workingList);
      createPlanogram(next);
      workingList = [...workingList, next];
      created.push(next);
    });
    return created;
  };

  // Reset Drafting Agent: the analysis runs server-side (draft-reset Edge Function), which saves
  // what it found as a pending Proposal. Nothing is created in the planogram list yet — a person
  // reviews the Proposal and approving it (apply-proposal function) is what creates the new WIP
  // version. For a single planogram the review opens straight away; a bulk run just fills the
  // Review Queue, lowest score first.
  const draftResetForPlanogram = async (source, lookbackWeeks) => {
    setDraftingReset(true);
    try {
      const [draft] = await invokeDraftReset([source.id], lookbackWeeks);
      if (!draft?.ok) throw new Error(draft?.error || "No draft came back.");
      await refreshProposals();
      setActivePlanogramId(null);
      setReviewingProposalId(draft.proposalId);
    } catch (e) {
      window.alert(`Couldn't draft a reset: ${e.message}`);
    } finally {
      setDraftingReset(false);
    }
  };

  const draftResetForPlanogramsBulk = async (sources, lookbackWeeks) => {
    setDraftingReset(true);
    let drafted = 0;
    const failures = [];
    try {
      for (let i = 0; i < sources.length; i += DRAFT_RESET_CHUNK) {
        const chunk = sources.slice(i, i + DRAFT_RESET_CHUNK);
        const results = await invokeDraftReset(chunk.map((s) => s.id), lookbackWeeks);
        chunk.forEach((source) => {
          const result = results.find((d) => d.planogramId === source.id);
          if (!result?.ok) { failures.push(`${source.name}: ${result?.error || "no result"}`); return; }
          drafted++;
        });
      }
    } catch (e) {
      failures.push(e.message);
    } finally {
      setDraftingReset(false);
      refreshProposals();
    }
    if (failures.length > 0) {
      window.alert(`${drafted} of ${sources.length} drafted.\n\nCouldn't finish:\n${failures.slice(0, 5).join("\n")}${failures.length > 5 ? `\n…and ${failures.length - 5} more` : ""}`);
    }
  };

  // Approve = the apply-proposal function builds the new WIP version from the Proposal and commits
  // it (planogram, proposal status and activity entry in one step); the returned version is added
  // to the list as-is (the server already saved it) and opened. A refusal — e.g. the planogram was
  // edited after the draft was made — comes back as a message and leaves the Proposal pending.
  const approveProposal = async (proposal) => {
    try {
      const out = await applyProposal(proposal.id);
      if (out?.planogram) setPlanograms((prev) => (prev.some((p) => p.id === out.planogram.id) ? prev : [...prev, out.planogram]));
      setReviewingProposalId(null);
      if (out?.planogramId) setActivePlanogramId(out.planogramId);
    } catch (e) {
      window.alert(`Couldn't approve this draft: ${e.message}`);
    } finally {
      refreshProposals();
    }
  };

  const rejectProposal = async (proposal) => {
    const source = planograms.find((p) => p.id === proposal.target_id);
    try {
      await reviewProposal(proposal.id, "rejected", source ? `Draft for "${source.name}"` : null);
      setReviewingProposalId(null);
    } catch (e) {
      window.alert(`Couldn't record your decision: ${e.message}`);
    } finally {
      refreshProposals();
    }
  };

  // Approving or discarding an AI draft is a recorded decision on its Proposal (who, when, and it
  // lands in the Activity log). The decision is written first: if it can't be recorded, nothing
  // changes locally, so the Proposal and the draft can't drift apart. Drafts made before
  // Proposals existed have no proposalId and simply skip the recording step.
  const recordDraftDecision = async (draftPlanogram, decision) => {
    const proposalId = draftPlanogram.resetDraft?.proposalId;
    if (!proposalId) return true;
    try {
      await reviewProposal(proposalId, decision, `Draft version "${draftPlanogram.name}"`);
      return true;
    } catch (e) {
      window.alert(`Couldn't record your decision: ${e.message}`);
      return false;
    } finally {
      refreshProposals();
    }
  };

  const approveResetDraft = async (draftPlanogram) => {
    if (!(await recordDraftDecision(draftPlanogram, "approved"))) return;
    updatePlanogramEntity({ ...draftPlanogram, resetDraft: { ...draftPlanogram.resetDraft, reviewed: true } });
  };

  const discardResetDraft = async (draftPlanogram) => {
    if (!(await recordDraftDecision(draftPlanogram, "rejected"))) return;
    const sourceId = draftPlanogram.resetDraft?.sourceId;
    deletePlanogramEntity(draftPlanogram.id);
    if (sourceId) setActivePlanogramId(sourceId);
  };

  // Commits a ProSpace import: adds any schema fields it needed (e.g. a UPC field, if the
  // product schema didn't already have one), creates the new products/fixtures it flagged for
  // approval, then creates the imported planogram(s) themselves. Order matters here only in that
  // everything referenced by a placement/fixture-instance must exist before the planogram does —
  // in practice all of it already exists as plain objects by this point, so this is just three
  // batched state updates rather than one-at-a-time creates.
  const importProSpaceResults = ({ planograms: pgDrafts, newProducts, newFixtures, schemaPatch }) => {
    if (schemaPatch && schemaPatch.length > 0) {
      updateProductSchema([...productSchema, ...schemaPatch]);
    }
    newProducts.forEach((p) => createProduct(p));
    newFixtures.forEach((f) => createFixture(f));
    pgDrafts.forEach((p) => createPlanogram(p));
  };

  // Promotes a planogram to Live, and — since Live is meant to represent the one current layout
  // for a given space — retires any OTHER Live member of the same version family to Historical
  // in the same step. This is the concrete trigger for "Historical = replaced by a newer
  // version," and it's shared by both the automatic Pending→Live transition and the manual
  // "Make Live Now" override, so the retirement behavior is identical either way.
  const promoteToLive = (p) => {
    const next = { ...p, status: "live" };
    saveIndexed("planogram", next);
    setPlanograms((prev) => prev.map((x) => {
      if (x.id === p.id) return next;
      if (getFamilyMasterId(x) === getFamilyMasterId(p) && (x.status || "wip") === "live") {
        const retired = { ...x, status: "historical" };
        saveIndexed("planogram", retired);
        return retired;
      }
      return x;
    }));
  };

  // Store Assistant: per-store execution status for a planogram. Kept on the planogram itself
  // (keyed by store id) rather than as a separate entity, so it rides along on the exact same
  // persistence path (updatePlanogramEntity/saveIndexed) everything else here already uses —
  // no new table needed for Phase 1. Status is one of: new, reviewed, in_progress,
  // partially_completed, completed, rejected. `reason` is used for rejected (an explanation).
  const setPlanogramExecutionStatus = (planogramId, storeId, status, reason) => {
    setPlanograms((prev) => prev.map((p) => {
      if (p.id !== planogramId) return p;
      const next = {
        ...p,
        execution: {
          ...p.execution,
          [storeId]: {
            status,
            updatedAt: new Date().toISOString(),
            completedAt: status === "completed" ? new Date().toISOString() : (p.execution?.[storeId]?.completedAt || null),
            rejectionReason: status === "rejected" ? (reason || "") : (p.execution?.[storeId]?.rejectionReason || ""),
          },
        },
      };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  // A store marking its execution Completed on a Pending planogram is also the trigger that
  // promotes that planogram to Live (and retires whichever sibling was Live before it, per the
  // Planogram Lifecycle) — done as ONE atomic state update rather than calling
  // setPlanogramExecutionStatus and promoteToLive separately, since two sequential updates
  // built off the same stale `planogram` snapshot could silently drop one of the two changes.
  const completeStoreExecution = (planogramId, storeId) => {
    setPlanograms((prev) => {
      const target = prev.find((p) => p.id === planogramId);
      if (!target) return prev;
      const wasPending = (target.status || "wip") === "pending";
      const nowISO = new Date().toISOString();
      const updatedTarget = {
        ...target,
        execution: { ...target.execution, [storeId]: { status: "completed", updatedAt: nowISO, completedAt: nowISO } },
        status: wasPending ? "live" : target.status,
      };
      saveIndexed("planogram", updatedTarget);
      return prev.map((p) => {
        if (p.id === planogramId) return updatedTarget;
        if (wasPending && getFamilyMasterId(p) === getFamilyMasterId(target) && (p.status || "wip") === "live") {
          const retired = { ...p, status: "historical" };
          saveIndexed("planogram", retired);
          return retired;
        }
        return p;
      });
    });
  };

  // Store Assistant: a store reporting a condition/issue back to the space planner. Stored as
  // an array directly on the planogram for the same reason as execution status above.
  const addPlanogramIssue = (planogramId, storeId, storeName, type, message) => {
    setPlanograms((prev) => prev.map((p) => {
      if (p.id !== planogramId) return p;
      const issue = { id: uid("issue"), storeId, storeName, type, message, status: "open", createdAt: new Date().toISOString() };
      const next = { ...p, issues: [...(p.issues || []), issue] };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  const resolvePlanogramIssue = (planogramId, issueId) => {
    setPlanograms((prev) => prev.map((p) => {
      if (p.id !== planogramId) return p;
      const next = { ...p, issues: (p.issues || []).map((i) => (i.id === issueId ? { ...i, status: "resolved", resolvedAt: new Date().toISOString() } : i)) };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  // "Anything opened will be Reviewed" — called when a store opens a planogram's instructions.
  // Only advances New → Reviewed; never regresses a status that's already moved further along.
  const markPlanogramReviewed = (planogramId, storeId) => {
    setPlanograms((prev) => prev.map((p) => {
      if (p.id !== planogramId) return p;
      const current = p.execution?.[storeId]?.status || "new";
      if (current !== "new") return p;
      const next = { ...p, execution: { ...p.execution, [storeId]: { status: "reviewed", updatedAt: new Date().toISOString(), completedAt: p.execution?.[storeId]?.completedAt || null } } };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  // "Anything marked from activities will be In Progress" — toggles a single New/Deleted item's
  // checked state for this store, and if that pushes the store's first checkmark on this
  // planogram, also advances execution status to In Progress. Both changes land in the same
  // atomic update for the same reason completeStoreExecution does — no stale-snapshot races.
  const toggleItemCheck = (planogramId, storeId, productId) => {
    setPlanograms((prev) => prev.map((p) => {
      if (p.id !== planogramId) return p;
      const currentChecks = p.itemChecks?.[storeId] || {};
      const nowChecked = !currentChecks[productId];
      const currentExecStatus = p.execution?.[storeId]?.status || "new";
      const shouldAdvance = nowChecked && (currentExecStatus === "new" || currentExecStatus === "reviewed");
      const next = {
        ...p,
        itemChecks: { ...p.itemChecks, [storeId]: { ...currentChecks, [productId]: nowChecked } },
        execution: shouldAdvance
          ? { ...p.execution, [storeId]: { status: "in_progress", updatedAt: new Date().toISOString(), completedAt: p.execution?.[storeId]?.completedAt || null } }
          : p.execution,
      };
      saveIndexed("planogram", next);
      return next;
    }));
  };

  // wipes everything currently stored and replaces it wholesale with the contents of a backup file
  const importFullBackup = async (backup) => {
    const kindsAndCurrent = [
      ["product", products],
      ["fixture", fixtures],
      ["planogram", planograms],
      ["store", stores],
      ["perf", Object.keys(performance).map((id) => ({ id }))],
    ];
    for (const [kind, currentItems] of kindsAndCurrent) {
      for (const item of currentItems) await deleteIndexed(kind, item.id);
    }
    for (const p of backup.products) await saveIndexed("product", p);
    for (const f of backup.fixtures) await saveIndexed("fixture", f);
    for (const pog of backup.planograms) await saveIndexed("planogram", pog);
    for (const s of backup.stores) await saveIndexed("store", s);
    for (const [productId, records] of Object.entries(backup.performance)) await saveIndexed("perf", { id: productId, records });
    await safeSet("schema:product", JSON.stringify(backup.productSchema));
    await safeSet("schema:fixture", JSON.stringify(backup.fixtureSchema));
    await safeSet("schema:planogram", JSON.stringify(backup.planogramSchema));
    await safeSet("schema:store", JSON.stringify(backup.storeSchema));
    await safeSet("settings:primaryKeyField", backup.primaryKeyField);

    setProducts(backup.products);
    setFixtures(backup.fixtures);
    setPlanograms(backup.planograms);
    setStores(backup.stores);
    setPerformance(backup.performance);
    setProductSchema(backup.productSchema);
    setFixtureSchema(backup.fixtureSchema);
    setPlanogramSchema(backup.planogramSchema);
    setStoreSchema(backup.storeSchema);
    setPrimaryKeyField(backup.primaryKeyField);
    setActivePlanogramId(null);
  };

  const activePlanogram = planograms.find((p) => p.id === activePlanogramId);
  const openIssueCount = planograms.reduce((sum, p) => sum + (p.issues || []).filter((i) => i.status === "open").length, 0);

  if (loading) {
    return (
      <div className="min-h-[400px] flex items-center justify-center text-slate-400 text-sm gap-2">
        <RefreshCw size={16} className="animate-spin" /> Loading your planograms…
      </div>
    );
  }

  if (profile === undefined) {
    return <div className="min-h-[400px] flex items-center justify-center text-slate-400 text-sm gap-2"><RefreshCw size={16} className="animate-spin" /> Checking your access…</div>;
  }
  if (!profile) {
    return <AccessMessageScreen title="Your account isn't set up yet" body="This account has no role. Ask an administrator to invite you or assign your role, then try again." onRetry={() => { setProfile(undefined); loadProfile(); }} onSignOut={signOut} />;
  }
  if (userRole === "store_associate" && !profile.store_id) {
    return <AccessMessageScreen title="No store assigned" body="Your account isn't assigned to a store yet. Ask an administrator to choose your store, then try again." onRetry={() => { setProfile(undefined); loadProfile(); }} onSignOut={signOut} />;
  }
  if (userRole === "regional_manager" && (profile.regions || []).length === 0) {
    return <AccessMessageScreen title="No regions assigned" body="Your account isn't assigned to a region yet. Ask an administrator to choose your regions, then try again." onRetry={() => { setProfile(undefined); loadProfile(); }} onSignOut={signOut} />;
  }

  // each role lands on its own screen; restricted roles can't reach the others
  const effectiveMode = isStoreScoped ? "storeAssistant" : isEventPlanner ? "eventPlanner" : appMode;
  const effectiveStoreId = userRole === "store_associate" ? profile.store_id : selectedStoreId;

  if (effectiveMode === "storeAssistant") {
    return (
      <StoreAssistantModule
        isRegional={userRole === "regional_manager"}
        lockedStore={userRole === "store_associate"}
        onSignOut={isRestricted ? signOut : undefined}
        stores={stores}
        planograms={planograms}
        products={products}
        fixtures={fixtures}
        selectedStoreId={effectiveStoreId}
        onSelectStore={setSelectedStoreId}
        onExitToPlanner={isRestricted ? undefined : () => setAppMode("planner")}
        onSetExecutionStatus={setPlanogramExecutionStatus}
        onCompleteExecution={completeStoreExecution}
        onMarkReviewed={markPlanogramReviewed}
        onToggleItemCheck={toggleItemCheck}
        onAddIssue={addPlanogramIssue}
        onAddPhoto={addStorePhoto}
        onDeletePhoto={deleteStorePhoto}
        onAddTask={addStoreTask}
        onUpdateTask={updateStoreTask}
        onDeleteTask={deleteStoreTask}
        onTaskSynced={syncStoreTask}
        taskTypes={taskTypes}
        onUpdateTaskTypes={updateTaskTypes}
      />
    );
  }

  if (effectiveMode === "eventPlanner") {
    return (
      <EventPlannerModule
        onSignOut={isRestricted ? signOut : undefined}
        events={events}
        eventTypes={eventTypes}
        planograms={planograms}
        onCreateEvent={createEvent}
        onUpdateEvent={updateEvent}
        onDeleteEvent={deleteEvent}
        onUpdateEventTypes={updateEventTypes}
        onExitToPlanner={isRestricted ? undefined : () => setAppMode("planner")}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800" style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body, .min-h-screen { background: white !important; }
          .print-area { border: none !important; box-shadow: none !important; }
        }
      `}</style>
      <AskTandomLauncher onTaskSynced={syncStoreTask} planogram={activePlanogram ? { id: activePlanogram.id, name: activePlanogram.name || "Untitled planogram" } : null} />
      <div className="bg-slate-900 text-white px-6 py-3.5 flex items-center gap-3 no-print">
        <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm">T</div>
        <span className="font-bold tracking-tight">Tandom Studio</span>
        <span className="text-xs text-slate-400 hidden sm:inline">— Teams Delivering Merchandising in Tandom</span>
        <span className={`text-xs flex items-center gap-1.5 ${pendingSaveCount > 0 ? "text-amber-300" : "text-slate-500"}`}>
          {pendingSaveCount > 0 ? (
            <><RefreshCw size={12} className="animate-spin" /> Saving…</>
          ) : (
            <><Check size={12} /> All changes saved</>
          )}
        </span>
        {loadError && (
          <span className="text-xs text-amber-300 flex items-center gap-1"><AlertTriangle size={12} /> Couldn't load saved data — starting fresh</span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {openIssueCount > 0 && (
            <button
              onClick={() => { setTab("storeFeedback"); setActivePlanogramId(null); }}
              className="text-xs text-amber-300 hover:text-amber-200 flex items-center gap-1 underline decoration-dotted"
              title="View Store Feedback"
            >
              <AlertTriangle size={12} /> {openIssueCount} open issue{openIssueCount !== 1 ? "s" : ""}
            </button>
          )}
          <button
            onClick={() => setAppMode("eventPlanner")}
            className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-full px-3 py-1.5 border border-slate-700"
          >
            <CalendarDays size={13} /> Event Planner
          </button>
          <button
            onClick={() => setAppMode("storeAssistant")}
            className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-full px-3 py-1.5 border border-slate-700"
          >
            <Store size={13} /> Store Assistant
          </button>
          {session?.user?.email && (
            <span className="text-xs text-slate-400 flex items-center gap-2 border-l border-slate-700 pl-3">
              {session.user.email}
              <button
                onClick={() => supabase.auth.signOut()}
                className="flex items-center gap-1 text-slate-300 hover:text-white"
                title="Sign out"
              >
                <LogOut size={12} /> Sign out
              </button>
            </span>
          )}
        </div>
      </div>

      {!activePlanogram && !reviewingProposalId && (
        <div className="bg-white border-b border-slate-200 px-6 flex gap-1">
          <TabButton active={tab === "planograms"} onClick={() => setTab("planograms")} icon={Layers} badge={buildResetDraftQueue(planograms, proposals).length}>Planograms</TabButton>
          <TabButton active={tab === "products"} onClick={() => setTab("products")} icon={Package}>Products</TabButton>
          <TabButton active={tab === "fixtures"} onClick={() => setTab("fixtures")} icon={Boxes}>Fixtures</TabButton>
          <TabButton active={tab === "stores"} onClick={() => setTab("stores")} icon={Store}>Stores</TabButton>
          <TabButton active={tab === "performance"} onClick={() => setTab("performance")} icon={TrendingUp}>Performance</TabButton>
          <TabButton active={tab === "analysis"} onClick={() => setTab("analysis")} icon={BarChart3}>Analysis</TabButton>
          <TabButton active={tab === "storeFeedback"} onClick={() => setTab("storeFeedback")} icon={AlertTriangle}>Store Feedback</TabButton>
          {isPlanner && <TabButton active={tab === "assortment"} onClick={() => setTab("assortment")} icon={Grid3x3}>Assortment</TabButton>}
          {isPlanner && <TabButton active={tab === "resetImpact"} onClick={() => setTab("resetImpact")} icon={TrendingUp}>Reset Impact</TabButton>}
          {isPlanner && <TabButton active={tab === "execution"} onClick={() => setTab("execution")} icon={Mail} badge={openEscalations}>Execution</TabButton>}
          <TabButton active={tab === "schema"} onClick={() => setTab("schema")} icon={Settings2}>Settings</TabButton>
          <TabButton active={tab === "help"} onClick={() => setTab("help")} icon={HelpCircle}>Help</TabButton>
        </div>
      )}

      <div className="p-6 max-w-[1400px] mx-auto">
        {reviewingProposalId ? (
          <ProposalReview
            key={reviewingProposalId}
            proposalId={reviewingProposalId}
            planograms={planograms}
            onBack={() => setReviewingProposalId(null)}
            onApprove={approveProposal}
            onReject={rejectProposal}
          />
        ) : activePlanogram ? (
          <PlanogramEditor
            planogramSchema={planogramSchema}
            planogram={activePlanogram}
            products={products}
            fixtures={fixtures}
            performance={performance}
            productSchema={productSchema}
            resetThresholds={resetThresholds}
            dosTargets={dosTargets}
            stores={stores}
            capacityWarningsEnabled={capacityWarningsEnabled}
            onAssignStores={(storeIds) => assignStoresToPlanogram(activePlanogram.id, storeIds)}
            onUpdate={updatePlanogramEntity}
            onBack={() => setActivePlanogramId(null)}
            allPlanograms={planograms}
            onCreateVersion={(source) => { const v = createPlanogramVersion(source); setActivePlanogramId(v.id); }}
            onOpenVersion={setActivePlanogramId}
            onMakeLive={promoteToLive}
            onResolveIssue={resolvePlanogramIssue}
            onDraftReset={draftResetForPlanogram}
            draftingReset={draftingReset}
            onApproveResetDraft={approveResetDraft}
            onDiscardResetDraft={discardResetDraft}
          />
        ) : tab === "planograms" ? (
          <PlanogramList
            planogramSchema={planogramSchema}
            planograms={planograms}
            stores={stores}
            products={products}
            fixtures={fixtures}
            productSchema={productSchema}
            onCreate={createPlanogram}
            onOpen={setActivePlanogramId}
            onDelete={deletePlanogramEntity}
            onUpdate={updatePlanogramEntity}
            onAssignStores={assignStoresToPlanogram}
            onCreateVersion={(source) => { const v = createPlanogramVersion(source); setActivePlanogramId(v.id); }}
            onCreateVersions={createPlanogramVersionsBulk}
            onImportProSpace={importProSpaceResults}
            onDraftResetBulk={draftResetForPlanogramsBulk}
            draftingReset={draftingReset}
            proposals={proposals}
            profileNames={profileNames}
            currentUserId={session?.user?.id}
            onOpenProposal={setReviewingProposalId}
          />
        ) : tab === "products" ? (
          <ProductLibrary
            schema={productSchema}
            products={products}
            primaryKeyField={primaryKeyField}
            imageRepo={imageRepo}
            upcLookup={upcLookup}
            onCreate={createProduct}
            onUpdate={updateProductEntity}
            onDelete={deleteProductEntity}
            isAdmin={isAdmin}
          />
        ) : tab === "fixtures" ? (
          <FixtureLibrary
            schema={fixtureSchema}
            fixtures={fixtures}
            onCreate={createFixture}
            onUpdate={updateFixtureEntity}
            onDelete={deleteFixtureEntity}
          />
        ) : tab === "stores" ? (
          <StoreLibrary
            storeSchema={storeSchema}
            stores={stores}
            onCreate={createStore}
            onUpdate={updateStoreEntity}
            onDelete={deleteStoreEntity}
          />
        ) : tab === "performance" ? (
          <PerformanceModule
            products={products}
            performance={performance}
            stores={stores}
            productSchema={productSchema}
            primaryKeyField={primaryKeyField}
            onSaveProductPerformance={savePerformanceForProduct}
            onDeleteProductPerformance={deletePerformanceForProduct}
            onClearAllPerformance={clearAllPerformance}
          />
        ) : tab === "analysis" ? (
          <AnalysisModule
            products={products}
            planograms={planograms}
            stores={stores}
            performance={performance}
            productSchema={productSchema}
          />
        ) : tab === "assortment" && isPlanner ? (
          <AssortmentModule
            products={products} planograms={planograms} fixtures={fixtures} stores={stores} performance={performance}
            productSchema={productSchema} storeSchema={storeSchema} planogramSchema={planogramSchema} primaryKeyField={primaryKeyField}
            onCreateProduct={createProduct} onUpdateProduct={updateProductEntity} onDeleteProduct={deleteProductEntity}
            onOpenProposal={setReviewingProposalId} onDrafted={refreshProposals}
          />
        ) : tab === "resetImpact" && isPlanner ? (
          <ResetImpactModule planograms={planograms} stores={stores} storeSchema={storeSchema} planogramSchema={planogramSchema} />
        ) : tab === "execution" && isPlanner ? (
          <ExecutionFollowupModule onEscalationsChanged={setOpenEscalations} onStoresChanged={refreshStores} />
        ) : tab === "storeFeedback" ? (
          <StoreFeedbackView planograms={planograms} onResolveIssue={resolvePlanogramIssue} onOpenPlanogram={setActivePlanogramId} />
        ) : tab === "help" ? (
          <HelpScreen />
        ) : (
          <div className="space-y-5">
            <BackupRestorePanel
              dataBundle={{ productSchema, fixtureSchema, planogramSchema, storeSchema, primaryKeyField, products, fixtures, planograms, performance, stores }}
              onImport={importFullBackup}
            />
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <h3 className="font-bold text-slate-800 text-sm mb-1">Global Settings</h3>
              <p className="text-xs text-slate-500 mb-3">Applies across Products and Performance Data imports.</p>
              <label className={labelCls}>Product Primary Key</label>
              <p className="text-xs text-slate-400 mb-2">Which field uniquely identifies a product during bulk import and performance matching.</p>
              <div className="grid grid-cols-2 gap-2 max-w-xs">
                <button
                  onClick={() => updatePrimaryKeyField("sku")}
                  className={`text-sm rounded-md py-2 border font-medium ${primaryKeyField === "sku" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  SKU
                </button>
                <button
                  onClick={() => updatePrimaryKeyField("upc")}
                  className={`text-sm rounded-md py-2 border font-medium ${primaryKeyField === "upc" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  UPC
                </button>
              </div>
              {primaryKeyField === "upc" && !hasUpcField(productSchema) && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mt-2">
                  No "UPC" field exists in Product Attribute Fields yet — add one below or matching will always fail.
                </div>
              )}

              <div className="border-t border-slate-100 mt-4 pt-4">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span>
                    <span className="text-sm font-medium text-slate-700 block">Show shelf capacity warnings</span>
                    <span className="text-xs text-slate-400">The "Xin left" / "Xin overhang" badge (shown on hover/select) and the red "Over capacity" warning on shelves. Turn off for a clean view when presenting to retailers.</span>
                  </span>
                  <input
                    type="checkbox"
                    className="accent-amber-500 w-4 h-4 shrink-0"
                    checked={capacityWarningsEnabled}
                    onChange={(e) => updateCapacityWarningsEnabled(e.target.checked)}
                  />
                </label>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-bold text-slate-800 text-sm">Image Repository</h3>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={imageRepo.enabled} onChange={(e) => updateImageRepo({ enabled: e.target.checked })} />
                  Enabled
                </label>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Point at a folder of images (served locally, e.g. this project's <code>public/</code> folder) or a cloud/CDN URL, and the app will look up each product's orientation images automatically by {imageRepo.keyField === "sku" ? "SKU" : "UPC"} instead of requiring manual upload.
              </p>
              <div className="grid grid-cols-1 gap-3">
                <Field label="Lookup Key">
                  <div className="grid grid-cols-2 gap-2 max-w-xs">
                    <button
                      type="button"
                      onClick={() => updateImageRepo({ keyField: "upc" })}
                      className={`text-sm rounded-md py-1.5 border font-medium ${(imageRepo.keyField || "upc") === "upc" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                    >
                      UPC
                    </button>
                    <button
                      type="button"
                      onClick={() => updateImageRepo({ keyField: "sku" })}
                      className={`text-sm rounded-md py-1.5 border font-medium ${imageRepo.keyField === "sku" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                    >
                      SKU
                    </button>
                  </div>
                </Field>
                <Field label="Base URL">
                  <input
                    className={inputCls}
                    value={imageRepo.baseUrl}
                    onChange={(e) => updateImageRepo({ baseUrl: e.target.value })}
                    placeholder="/product-images/  or  https://cdn.example.com/products/"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Filename Pattern">
                    <input
                      className={inputCls}
                      value={imageRepo.pattern}
                      onChange={(e) => updateImageRepo({ pattern: e.target.value })}
                      placeholder="{key}-{orientation}"
                    />
                  </Field>
                  <Field label="File Extensions (tried in order)">
                    <input
                      className={inputCls}
                      value={imageRepo.extensions}
                      onChange={(e) => updateImageRepo({ extensions: e.target.value })}
                      placeholder="jpg,jpeg,png,webp"
                    />
                  </Field>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5 mt-3 text-[11px]">
                {ORIENTATIONS.map((o) => (
                  <div key={o.id} className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1">
                    <span className="text-slate-600">{o.label}</span>
                    <span className="font-mono text-slate-400">{ORIENTATION_CODES[o.id] ? `.${ORIENTATION_CODES[o.id]}` : "—"}</span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Example: {imageRepo.keyField === "sku" ? "SKU" : "UPC"} <code>5010029000016</code>, Front view → looks for
                <code className="mx-1">{imageRepo.baseUrl}{(imageRepo.pattern || "{key}.{code}").replace("{key}", "5010029000016").replace("{code}", ORIENTATION_CODES.front).replace("{orientation}", "front")}.jpg</code>
                (then tries the next extension if that one doesn't load).
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Local folder: drop image files into this project's <code>public/product-images/</code> folder — Vite serves everything there automatically at <code>/product-images/…</code>. Cloud: set Base URL to any public HTTPS location using the same naming convention.
              </p>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-bold text-slate-800 text-sm">Web Image Lookup (Retailer CDN)</h3>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" className="accent-amber-500 w-3.5 h-3.5" checked={upcLookup.enabled} onChange={(e) => updateUpcLookup({ enabled: e.target.checked })} />
                  Enabled
                </label>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                When a product has no image yet, guess its image URL on a retailer's own public product-image CDN (by UPC) and use it if it loads — the same trick as the Image Repository above, just pointed at someone else's server instead of your own. This works for whatever a retailer already carries; anything they don't stock won't have an image to find this way.
              </p>
              <p className="text-[11px] text-slate-400 mb-3">
                A JSON lookup API (UPCitemdb) was tried first, but it locks browser access to its own domain (CORS), so a direct call from this app is always blocked — that's a restriction on their end, not something fixable here. Probing image URLs directly sidesteps that, since loading an image for display isn't subject to CORS the way a data request is.
              </p>
              <div className="grid grid-cols-1 gap-3">
                <Field label="Base URL">
                  <input
                    className={inputCls}
                    value={upcLookup.baseUrl}
                    onChange={(e) => updateUpcLookup({ baseUrl: e.target.value })}
                    placeholder="https://www.kroger.com/product/images/"
                  />
                </Field>
                <Field label="Image size (use {size} in the pattern)">
                  <select className={inputCls} value={upcLookup.size || "xlarge"} onChange={(e) => updateUpcLookup({ size: e.target.value })}>
                    <option value="xlarge">Extra large — best quality (recommended)</option>
                    <option value="large">Large</option>
                    <option value="medium">Medium</option>
                    <option value="small">Small — blurry at planogram scale</option>
                    <option value="thumbnail">Thumbnail — blurry at planogram scale</option>
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Filename Pattern">
                    <input
                      className={inputCls}
                      value={upcLookup.pattern}
                      onChange={(e) => updateUpcLookup({ pattern: e.target.value })}
                      placeholder="{size}/{orientation}/{key}"
                    />
                  </Field>
                  <Field label="File Extensions (blank = none)">
                    <input
                      className={inputCls}
                      value={upcLookup.extensions}
                      onChange={(e) => updateUpcLookup({ extensions: e.target.value })}
                      placeholder="leave blank if the CDN has no file extension"
                    />
                  </Field>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Example: 12-digit UPC <code>013000004668</code> normalizes to <code>{normalizeUpcForKrogerCdn("013000004668")}</code> (Kroger's CDN keys images by a 13-digit code — the UPC's number-system and check digits dropped, zero-padded back to 13), then Front view → tries
                <code className="mx-1">{upcLookup.baseUrl}{(upcLookup.pattern || "{size}/{orientation}/{key}").replace("{key}", normalizeUpcForKrogerCdn("013000004668")).replace("{orientation}", "front").replace("{size}", upcLookup.size || "xlarge")}{(upcLookup.extensions || "").split(",")[0]?.trim() ? `.${upcLookup.extensions.split(",")[0].trim()}` : ""}</code>.
                {ORIENTATIONS.length > 1 && " The same normalized key is tried for all 6 orientations — front, back, top, bottom, left, right — filling in whichever ones the retailer happens to have."}
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                This UPC-to-key normalization is specific to Kroger's own image CDN convention — if you point Base URL at a different retailer's pattern instead, this conversion may no longer be the right one.
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                This is a best-effort guess at an undocumented URL pattern, not an official API — a retailer can change or block it at any time without notice. Worth keeping the Image Repository above as your primary, reliable source and treating this as a convenience for filling gaps.
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Both an "on save" lookup (in the product editor, next to Orientation Images) and a bulk "Backfill Missing Images from Web" action (in the Product Library toolbar) are available once this is enabled.
              </p>
            </div>

            <SchemaEditor title="Product Attribute Fields" schema={productSchema} onChange={updateProductSchema} max={200} />
            <SchemaEditor title="Fixture Attribute Fields" schema={fixtureSchema} onChange={updateFixtureSchema} max={50} />
            <SchemaEditor title="Planogram Attribute Fields" schema={planogramSchema} onChange={updatePlanogramSchema} max={100} />
            <SchemaEditor title="Store Attribute Fields" schema={storeSchema} onChange={updateStoreSchema} max={100} />

            <div className="bg-white rounded-lg border border-slate-200 p-4 mt-6">
              <h3 className="text-sm font-semibold text-slate-800 mb-1 flex items-center gap-1.5"><Sparkles size={15} className="text-amber-500" /> Reset Drafting Thresholds</h3>
              <p className="text-xs text-slate-500 mb-3">Sales/Space Index bounds the Reset Drafting Agent uses to flag under- and over-performers, by planogram Category. Default {DEFAULT_RESET_THRESHOLDS.low} / {DEFAULT_RESET_THRESHOLDS.high} applies until a category is set here.</p>
              <ResetThresholdsEditor planograms={planograms} resetThresholds={resetThresholds} onChange={updateResetThresholds} />
            </div>

            {isAdmin && <UserRolesPanel currentUserId={session?.user?.id} stores={stores} />}

            <div className="bg-white rounded-lg border border-slate-200 p-4 mt-6">
              <h3 className="text-sm font-semibold text-slate-800 mb-1 flex items-center gap-1.5"><Sparkles size={15} className="text-amber-500" /> Days of Supply Targets</h3>
              <p className="text-xs text-slate-500 mb-3">How many days of sales the shelf should hold, by planogram Category. The Reset Drafting Agent weighs this alongside the Sales/Space Index: it will not cut a product below its target, adds facings or height where the shelf runs short, and trims a shelf holding far more than it needs. Leave a category blank to skip the check. A product can carry its own target on its product page.</p>
              <DosTargetsEditor planograms={planograms} dosTargets={dosTargets} onChange={updateDosTargets} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Auth gating — shows setup instructions if Supabase isn't configured, */
/* a login/signup screen if no one's signed in, otherwise the app       */
/* ------------------------------------------------------------------ */

function SetupNeededScreen() {
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="max-w-lg bg-white border border-slate-200 rounded-lg p-6 space-y-3">
        <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2"><AlertTriangle size={18} className="text-amber-500" /> Supabase isn't configured yet</h1>
        <p className="text-sm text-slate-600">
          Tandom Studio needs a Supabase project to store data for real, shared across everyone who signs in.
        </p>
        <ol className="text-sm text-slate-600 list-decimal list-inside space-y-1">
          <li>Create a free project at <span className="font-mono text-xs bg-slate-100 px-1 rounded">supabase.com</span></li>
          <li>In your project: SQL Editor → New query → paste the contents of <span className="font-mono text-xs bg-slate-100 px-1 rounded">supabase/schema.sql</span> from this project → Run</li>
          <li>Project Settings → API → copy your Project URL and anon/public key</li>
          <li>Copy <span className="font-mono text-xs bg-slate-100 px-1 rounded">.env.example</span> to <span className="font-mono text-xs bg-slate-100 px-1 rounded">.env</span> and fill in both values</li>
          <li>Restart <span className="font-mono text-xs bg-slate-100 px-1 rounded">npm run dev</span></li>
        </ol>
        <p className="text-xs text-slate-400">Full walkthrough is in this project's README.md.</p>
      </div>
    </div>
  );
}

// Read once, before Supabase clears the URL: invite/recovery links arrive as #access_token=…&type=invite|recovery,
// and expired or reused links arrive as #error_description=….
function readAuthLinkInfo() {
  try {
    const params = new window.URLSearchParams((window.location.hash || "").replace(/^#/, ""));
    const type = params.get("type");
    const err = params.get("error_description");
    return { needsPassword: type === "invite" || type === "recovery", error: err ? err.replace(/\+/g, " ") : null };
  } catch (e) { return { needsPassword: false, error: null }; }
}

function AuthScreen({ linkError }) {
  const [mode, setMode] = useState("signin"); // signin | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(linkError ? `${linkError} Ask an administrator to send a new invitation, or use "Forgot password".` : null);
  const [notice, setNotice] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) throw error;
        setNotice("If that email has an account, a link to set a new password is on its way.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white border border-slate-200 rounded-lg p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm">T</div>
          <span className="font-bold text-slate-800">Tandom Studio</span>
        </div>
        <p className="text-xs text-slate-500 mb-5">{mode === "forgot" ? "Enter your email and we'll send a link to set a new password." : "Sign in with the account your administrator invited you with."}</p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className={labelCls}>Email</label>
            <div className="relative">
              <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
              <input type="email" required className={inputCls + " pl-8"} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </div>
          </div>
          {mode === "signin" && (
            <div>
              <label className={labelCls}>Password</label>
              <div className="relative">
                <Lock size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
                <input type="password" required minLength={6} className={inputCls + " pl-8"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
            </div>
          )}
          {error && <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</div>}
          {notice && <div className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200">{notice}</div>}
          <button type="submit" disabled={busy} className={btnPrimary + " w-full justify-center"}>
            {busy ? "Please wait…" : mode === "forgot" ? "Send reset link" : "Sign In"}
          </button>
        </form>
        <button type="button" className="text-xs text-slate-400 hover:underline mt-4"
          onClick={() => { setMode(mode === "forgot" ? "signin" : "forgot"); setError(null); setNotice(null); }}>
          {mode === "forgot" ? "← Back to sign in" : "Forgot password?"}
        </button>
      </div>
    </div>
  );
}

// Shown after an invitation or password-reset link: the person is signed in by the link and picks a password.
function SetPasswordScreen({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) { setError(err.message || "Couldn't set the password."); return; }
    try { window.history.replaceState(null, "", window.location.pathname); } catch (x) { /* ignore */ }
    onDone();
  };
  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-white border border-slate-200 rounded-lg p-6 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm">T</div>
          <span className="font-bold text-slate-800">Welcome to Tandom Studio</span>
        </div>
        <p className="text-xs text-slate-500">Choose a password for your account.</p>
        <div>
          <label className={labelCls}>New password</label>
          <input type="password" required minLength={8} className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Confirm password</label>
          <input type="password" required minLength={8} className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</div>}
        <button type="submit" disabled={busy} className={btnPrimary + " w-full justify-center"}>{busy ? "Saving…" : "Save password and continue"}</button>
      </form>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out, object = signed in
  const [linkInfo] = useState(readAuthLinkInfo);
  const [settingPassword, setSettingPassword] = useState(linkInfo.needsPassword);

  useEffect(() => {
    if (!supabaseConfigured) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === "PASSWORD_RECOVERY") setSettingPassword(true);
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) return <SetupNeededScreen />;
  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm gap-2"><RefreshCw size={16} className="animate-spin" /> Checking session…</div>;
  }
  if (!session) return <AuthScreen linkError={linkInfo.error} />;
  if (settingPassword) return <SetPasswordScreen onDone={() => setSettingPassword(false)} />;
  return <AppContent session={session} />;
}
