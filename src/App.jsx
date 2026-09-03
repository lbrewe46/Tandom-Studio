import React, { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  Plus, Minus, Trash2, ChevronLeft, ChevronRight, Settings2, Image as ImageIcon,
  RotateCw, X, Layers, Package, Boxes, Ruler, ArrowLeft, Check, Grid3x3,
  Pencil, Save, AlertTriangle, RefreshCw, Download, Upload, FileSpreadsheet, CalendarDays, TrendingUp,
  Maximize2, Minimize2, Store, ChevronDown, ChevronUp, AlignLeft, AlignCenter, AlignRight, Search, Eye, Printer, Copy,
  LogOut, Mail, Lock, ImageOff, Palette, ZoomIn, ZoomOut, Crosshair
} from "lucide-react";
import {
  supabase, supabaseConfigured, pendingWriteListeners,
  safeGet, safeSet, safeDelete, loadIndexed, saveIndexed, deleteIndexed,
} from "./lib/db.js";

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
// change needed. Comparing against the predecessor's placements — if there is no predecessor
// (this is the very first version), everything currently placed counts as New.
function computeItemChanges(planogram, predecessor, products) {
  const currentIds = getPlacedProductIds(planogram);
  const previousIds = predecessor ? getPlacedProductIds(predecessor) : new Set();
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
  const exts = (repo.extensions || "jpg").split(",").map((s) => s.trim()).filter(Boolean);
  const base = repo.baseUrl.endsWith("/") ? repo.baseUrl : repo.baseUrl + "/";
  const filename = pattern.replace("{key}", key).replace("{orientation}", orientation).replace("{code}", code || "");
  return exts.map((ext) => `${base}${filename}.${ext}`);
}

function testImageLoads(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    setTimeout(() => finish(false), timeoutMs);
    img.src = url;
  });
}

async function findRepositoryImage(repo, key, orientation) {
  for (const url of buildImageCandidateUrls(repo, key, orientation)) {
    if (await testImageLoads(url)) return url;
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

function downloadFullBackup({ productSchema, fixtureSchema, primaryKeyField, products, fixtures, planograms, performance, stores }) {
  const payload = {
    app: "Tandom Studio",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    productSchema, fixtureSchema, primaryKeyField, products, fixtures, planograms, performance, stores,
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

function TabButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
        active ? "border-amber-500 text-slate-900" : "border-transparent text-slate-400 hover:text-slate-600"
      }`}
    >
      <Icon size={16} />
      {children}
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

function OrientationImages({ images, onChange, repo, lookupKey }) {
  const fileInputs = useRef({});
  const [urlDrafts, setUrlDrafts] = useState({});
  const [matching, setMatching] = useState(false);
  const [matchMsg, setMatchMsg] = useState(null);

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

  return (
    <div>
      {repo?.enabled && (
        <div className="flex items-center gap-2 mb-2">
          <button type="button" className={btnGhost} disabled={matching || !lookupKey} onClick={matchFromRepo}>
            {matching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
            {matching ? "Matching…" : "Match from Repository"}
          </button>
          {!lookupKey && <span className="text-xs text-slate-400">Set a SKU/UPC first to enable lookup.</span>}
          {matchMsg && <span className="text-xs text-slate-500">{matchMsg}</span>}
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

function ProductForm({ schema, initial, primaryKeyField, imageRepo, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [sku, setSku] = useState(initial?.sku || "");
  const [dims, setDims] = useState(initial?.dims || { w: 3, h: 6, d: 3 });
  const [attributes, setAttributes] = useState(initial?.attributes || {});
  const [images, setImages] = useState(initial?.images || {});
  const [overhangIn, setOverhangIn] = useState(initial?.overhangIn || 0);
  const [squeezePct, setSqueezePct] = useState(Math.round((initial?.squeezeFactor ?? 1) * 100));

  const lookupKey = getPrimaryKeyValueRaw({ sku, attributes }, schema, imageRepo?.keyField || "upc");

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
    });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
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
        <OrientationImages images={images} onChange={setImages} repo={imageRepo} lookupKey={lookupKey} />
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

function downloadPerformanceTemplate(primaryKeyField) {
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
  XLSX.writeFile(wb, "performance_import_template.xlsx");
}

function parsePerformanceWorkbook(file, products, stores, productSchema, primaryKeyField) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true });
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

function ProductLibrary({ schema, products, primaryKeyField, imageRepo, onCreate, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(null); // null | "new" | product
  const [importStatus, setImportStatus] = useState(null); // {type:'ok'|'error', message}
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null); // {current, total}
  const [matchingRepo, setMatchingRepo] = useState(false);
  const [matchProgress, setMatchProgress] = useState(null);
  const [matchStatus, setMatchStatus] = useState(null);
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_PRODUCT_LIST_COLUMNS);
  const [columnsPickerOpen, setColumnsPickerOpen] = useState(false);
  const toggleColumn = (colId) => setVisibleColumns((prev) => (prev.includes(colId) ? prev.filter((c) => c !== colId) : [...prev, colId]));
  const [columnWidths, setColumnWidths] = useState({}); // colId -> px; falls back to a default when unset
  const resizingRef = useRef(null);
  const [query, setQuery] = useState("");
  // matches against name, SKU, AND every attribute value — not just name — so typing anything
  // that appears anywhere on the product (a size, a vendor, a color) filters it in immediately
  const filteredProducts = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => {
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
  }, [products, query]);
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
        </div>
      </div>
      {matchStatus && (
        <div className={`text-sm rounded-md px-3 py-2 mb-3 ${matchStatus.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {matchStatus.message}
        </div>
      )}
      <p className="text-xs text-slate-400 mb-3 flex items-center gap-1.5">
        <FileSpreadsheet size={13} /> The template's columns always match your current attribute fields — configure those under Attribute Fields first. Products are matched on import by <span className="font-semibold text-slate-500">{primaryKeyField === "upc" ? "UPC" : "SKU"}</span> (set in Attribute Fields).
      </p>
      {primaryKeyField === "upc" && !hasUpcField(schema) && (
        <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">
          Your Product Primary Key is set to UPC, but no "UPC" attribute field exists yet — add one under Attribute Fields or matching will always fail.
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
        <div className="relative mb-3 max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className={inputCls + " pl-8"}
            placeholder="Search name, SKU, or any attribute…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {products.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No products yet. Create one, or upload a filled-in template to bulk-add your library.
        </div>
      ) : filteredProducts.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No products match "{query}".
        </div>
      ) : viewMode === "list" ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="text-xs" style={{ tableLayout: "fixed", width: "100%", minWidth: 480 + visibleColumns.length * 100 }}>
            <colgroup>
              <col style={{ width: 40 }} />
              {visibleColumns.map((colId) => <col key={colId} style={{ width: columnWidths[colId] || 160 }} />)}
              <col style={{ width: 110 }} />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
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
                <tr key={p.id} className="hover:bg-slate-50">
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
            <div key={p.id} className="bg-white rounded-lg border border-slate-200 p-3 flex gap-3">
              <div className="w-14 h-14 rounded bg-slate-50 border border-slate-200 flex items-center justify-center overflow-hidden shrink-0">
                {p.images?.front ? (
                  <img src={p.images.front} className="max-h-full max-w-full object-contain" />
                ) : (
                  <div className="w-8 h-8 rounded" style={{ background: hashColor(p.name) }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-slate-800 truncate">{p.name}</div>
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

  const save = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || uid("fix"),
      name: name.trim(),
      type,
      dims: { w: Number(dims.w) || 1, h: Number(dims.h) || 1, d: Number(dims.d) || 1 },
      attributes,
    });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
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
  const filtered = !q ? fixtures : fixtures.filter((f) => (f.name + " " + f.type).toLowerCase().includes(q));
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
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className={inputCls + " pl-9"}
            placeholder="Search by name or type…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {fixtures.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No fixtures yet. Create shelves, pegboards, or hooks to place on your planograms.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No fixtures match "{query}".
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
              <div className="flex items-center justify-between">
                <div className="font-semibold text-sm text-slate-800">{f.name}</div>
                <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">{f.type}</span>
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

function StoreForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [storeNumber, setStoreNumber] = useState(initial?.storeNumber || "");
  const [address, setAddress] = useState(initial?.address || "");
  const [region, setRegion] = useState(initial?.region || "");
  const [format, setFormat] = useState(initial?.format || STORE_FORMATS[0]);
  const [squareFootage, setSquareFootage] = useState(initial?.squareFootage || "");

  const save = () => {
    if (!name.trim()) return;
    onSave({
      id: initial?.id || uid("store"),
      name: name.trim(),
      storeNumber: storeNumber.trim(),
      address: address.trim(),
      region: region.trim(),
      format,
      squareFootage: Number(squareFootage) || 0,
    });
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4 max-w-lg">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Store Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Downtown Market" /></Field>
        <Field label="Store Number"><input className={inputCls} value={storeNumber} onChange={(e) => setStoreNumber(e.target.value)} placeholder="e.g. 4821" /></Field>
      </div>
      <Field label="Address"><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Region"><input className={inputCls} value={region} onChange={(e) => setRegion(e.target.value)} placeholder="e.g. Midwest" /></Field>
        <Field label="Format">
          <select className={inputCls} value={format} onChange={(e) => setFormat(e.target.value)}>
            {STORE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
        <Field label="Sq Footage"><input type="number" className={inputCls} value={squareFootage} onChange={(e) => setSquareFootage(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
        <button className={btnGhost} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={save}><Save size={14} /> Save Store</button>
      </div>
    </div>
  );
}

function StoreLibrary({ stores, onCreate, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  if (editing) {
    return (
      <StoreForm
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSave={(s) => { editing === "new" ? onCreate(s) : onUpdate(s); setEditing(null); }}
      />
    );
  }
  const q = query.trim().toLowerCase();
  const filtered = !q ? stores : stores.filter((s) =>
    [s.name, s.storeNumber, s.address, s.region, s.format].filter(Boolean).join(" ").toLowerCase().includes(q)
  );
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

      {stores.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No stores yet. Add the stores you'll be assigning planograms to.
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg p-8 text-center">
          No stores match "{query}".
        </div>
      ) : viewMode === "list" ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Name</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Store #</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Format</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Address</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Region</th>
                <th className="text-left font-semibold text-slate-500 uppercase tracking-wide px-3 py-2 whitespace-nowrap">Sq Ft</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{s.name}</td>
                  <td className="px-3 py-2 text-slate-500 font-mono whitespace-nowrap">#{s.storeNumber || "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap"><span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">{s.format || "—"}</span></td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap max-w-[260px] truncate" title={s.address}>{s.address || "—"}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{s.region || "—"}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{s.squareFootage ? s.squareFootage.toLocaleString() : "—"}</td>
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
              <div className="text-xs text-slate-400 font-mono mt-0.5">#{s.storeNumber || "—"}</div>
              <div className="text-xs text-slate-500 mt-1">{s.address}</div>
              <div className="text-xs text-slate-400 mt-1">{s.region}{s.squareFootage ? ` · ${s.squareFootage.toLocaleString()} sq ft` : ""}</div>
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

function PerformanceModule({ products, performance, stores, productSchema, primaryKeyField, onSaveProductPerformance, onDeleteProductPerformance, onClearAllPerformance }) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
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
      setImportStatus({ type: "error", message: "Couldn't read that file. Make sure it's a .xlsx based on the template." });
    } finally {
      setImporting(false); setImportProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
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
          <button className={btnGhost} onClick={() => downloadPerformanceTemplate(primaryKeyField)}><Download size={14} /> Download Template</button>
          <button className={btnGhost} disabled={importing} onClick={() => fileInputRef.current && fileInputRef.current.click()}>
            <Upload size={14} />
            {importing ? (importProgress?.phase === "importing" ? `Loading ${importProgress.current}/${importProgress.total}…` : "Reading file…") : "Upload Performance Data"}
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => handleFileChosen(e.target.files[0])} />
          {Object.keys(performance).length > 0 && (
            <button className={btnDanger} onClick={() => setConfirmingClear(true)}><Trash2 size={13} /> Clear All</button>
          )}
        </div>
      </div>

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
        <FileSpreadsheet size={13} /> Load weekly unit cost, retail price, and units sold per product per store. Products are matched by <span className="font-semibold text-slate-500">{primaryKeyField === "upc" ? "UPC" : "SKU"}</span> (set in Attribute Fields).
      </p>
      {primaryKeyField === "upc" && !hasUpcField(productSchema) && (
        <div className="text-sm rounded-md px-3 py-2 mb-3 bg-amber-50 text-amber-700 border border-amber-200">
          Your Product Primary Key is set to UPC, but no "UPC" attribute field exists yet — add one under Attribute Fields or matching will always fail.
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
/* Planogram list                                                       */
/* ------------------------------------------------------------------ */

function NewPlanogramForm({ existingCategories, onCreate, onCancel }) {
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

function PlanogramList({ planograms, stores, onCreate, onOpen, onDelete, onAssignStores, onCreateVersion, onCreateVersions }) {
  const [creating, setCreating] = useState(false);
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

  const categories = Array.from(new Set(planograms.map((p) => p.category).filter(Boolean))).sort();

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
      if (sortBy === "eventDate") return (a.eventDate || "9999-99-99").localeCompare(b.eventDate || "9999-99-99");
      if (sortBy === "category") return (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name);
      if (sortBy === "status") {
        const order = PLANOGRAM_STATUSES.indexOf(effectivePlanogramStatus(a)) - PLANOGRAM_STATUSES.indexOf(effectivePlanogramStatus(b));
        return order || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
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
          <button className={btnPrimary} onClick={() => setCreating(true)}><Plus size={14} /> New Planogram</button>
        </div>
      </div>

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
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {familyGroups.map((members) => (
            <div key={members[0].id}>
              {members.map((p, idx) => (
                <div key={p.id}>
                  <div
                    className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${selectedIds.has(p.id) ? "bg-amber-50" : "hover:bg-slate-50"}`}
                    style={{ paddingLeft: idx > 0 ? 40 : 12 }}
                    onClick={() => onOpen(p.id)}
                  >
                    <input
                      type="checkbox"
                      className="accent-amber-500 w-3.5 h-3.5 shrink-0"
                      checked={selectedIds.has(p.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelected(p.id)}
                    />
                    {idx > 0 && <span className="text-slate-300 text-xs shrink-0">↳</span>}
                    <span className="font-medium text-sm text-slate-800 truncate" style={{ maxWidth: 260 }}>{p.name}</span>
                    {p.masterId && <span className="text-[10px] font-mono font-semibold text-slate-400 border border-slate-200 rounded px-1 shrink-0">v{p.versionNumber || 1}</span>}
                    <PlanogramStatusBadge status={effectivePlanogramStatus(p)} className="shrink-0" />
                    {p.category && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0" style={{ background: hashColor(p.category) + "33", color: hashColor(p.category) }}>{p.category}</span>}
                    {p.eventDate && <span className="text-xs text-slate-400 flex items-center gap-1 shrink-0"><CalendarDays size={11} /> {p.eventDate}</span>}
                    <span className="text-xs text-slate-400 shrink-0">{(p.storeIds || []).length} store{(p.storeIds || []).length !== 1 ? "s" : ""}</span>
                    <div className="ml-auto flex items-center gap-2.5 shrink-0">
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
                </div>
              ))}
            </div>
          ))}
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
                  {p.category && <span className="text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5" style={{ background: hashColor(p.category) + "33", color: hashColor(p.category) }}>{p.category}</span>}
                </div>
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">{p.dims.w}×{p.dims.h}×{p.dims.d} in · base {p.base}in</div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-3">
                <span>{p.sections.length} section{p.sections.length !== 1 ? "s" : ""}</span>
                {p.eventDate && <span className="flex items-center gap-1"><CalendarDays size={11} /> {p.eventDate}</span>}
              </div>
              <div className="flex items-center justify-between mt-2">
                <button
                  onClick={(e) => { e.stopPropagation(); setAssigningId(assigningId === p.id ? null : p.id); }}
                  className={`text-xs font-medium flex items-center gap-1 rounded-full px-2 py-0.5 border ${(p.storeIds || []).length > 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-500 hover:bg-slate-50"}`}
                >
                  <Store size={11} /> {(p.storeIds || []).length > 0 ? `${p.storeIds.length} store${p.storeIds.length !== 1 ? "s" : ""}` : "Assign stores"}
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
                  selectedIds={p.storeIds || []}
                  onToggle={(storeId) => {
                    const current = p.storeIds || [];
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
    const rotated = pl.rotation === 90 || pl.rotation === 270;
    const nominalW = (rotated ? prod.dims.h : prod.dims.w) || 1;
    const squeeze = prod.squeezeFactor ?? 1;
    const w = nominalW * squeeze;
    const overhangIn = prod.overhangIn || 0;
    for (let i = 0; i < (pl.facings || 1); i++) items.push({ placement: pl, product: prod, wIn: w, overhangIn });
  });

  const totalContentWidth = items.reduce((s, it) => s + it.wIn, 0);
  const boxes = [];
  const isOverflow = (cursor, it) => cursor + it.wIn > widthIn + it.overhangIn;

  if (alignment === "right") {
    let cursor = Math.max(0, widthIn - totalContentWidth);
    items.forEach((it) => {
      boxes.push({ placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: isOverflow(cursor, it) });
      cursor += it.wIn;
    });
  } else if (alignment === "spread" && items.length > 1 && totalContentWidth < widthIn) {
    const gap = (widthIn - totalContentWidth) / (items.length - 1);
    let cursor = 0;
    items.forEach((it) => {
      boxes.push({ placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: isOverflow(cursor, it) });
      cursor += it.wIn + gap;
    });
  } else {
    // left (default), and also the fallback when "spread" has nothing to spread (0-1 items, or content already overflows)
    let cursor = 0;
    items.forEach((it) => {
      boxes.push({ placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: isOverflow(cursor, it) });
      cursor += it.wIn;
    });
  }

  return { boxes, totalWidth: totalContentWidth, widthIn };
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
    const rotated = pl.rotation === 90 || pl.rotation === 270;
    const nominalW = (rotated ? prod.dims.h : prod.dims.w) || 1;
    const squeeze = prod.squeezeFactor ?? 1;
    const w = nominalW * squeeze;
    const overhangIn = prod.overhangIn || 0;
    const pegX = pl.pegX ?? 0; // physical peg column position (inches, whole numbers)
    const pegY = pl.pegY ?? heightIn; // physical peg row position (inches, whole numbers, from panel bottom)
    const { originX, originY } = pegToOrigin(pegX, pegY, w);
    let cursor = originX;
    for (let i = 0; i < (pl.facings || 1); i++) {
      const overflow = cursor < 0 || cursor + w > widthIn + overhangIn || originY > heightIn || originY < 0;
      boxes.push({ placement: pl, product: prod, xIn: cursor, wIn: w, pegYIn: originY, overflow });
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
  const { placement, product, xIn, wIn } = box;
  const rotation = placement.rotation || 0;
  const rotated = rotation === 90 || rotation === 270;
  const footprintWpx = Math.max(wIn * scale - 1, 2);
  const footprintHpx = Math.max((rotated ? product.dims.w : product.dims.h) * scale - 1, 4);
  const naturalWpx = Math.max(product.dims.w * scale - 1, 2);
  const naturalHpx = Math.max(product.dims.h * scale - 1, 4);
  const img = product.images?.[placement.orientation];
  const hasPeg = pegYIn !== undefined && pegYIn !== null;
  const pegBottomPx = hasPeg ? (pegYIn - (rotated ? product.dims.w : product.dims.h)) * scale : undefined;
  const isNew = newProductIds && newProductIds.has(product.id);
  return (
    <div className={`absolute ${hasPeg ? "" : "bottom-0"}`} style={{ left: xIn * scale, width: footprintWpx, height: footprintHpx, bottom: hasPeg ? pegBottomPx : undefined }}>
      <div
        className={`absolute top-1/2 left-1/2 overflow-hidden flex items-center justify-center ${isNew ? "border-2 border-emerald-500 ring-2 ring-emerald-300" : "border border-slate-400/60"}`}
        style={{ width: naturalWpx, height: naturalHpx, transform: `translate(-50%, -50%) rotate(${rotation}deg)`, background: img ? "#fff" : hashColor(product.name) }}
        title={isNew ? `${product.name} — New item` : product.name}
      >
        {img && <img src={img} alt={product.name} className="absolute inset-0 w-full h-full object-cover" />}
      </div>
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
function PlanogramExecutionGuide({ planogram, products, fixtures, allPlanograms, storeId, onToggleItemCheck, onBack }) {
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
            <p className="text-xs text-slate-400 italic">No previous version to compare against — every placed item is shown as New.</p>
          )}
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
                              {b.placement.facings || 1} facing{(b.placement.facings || 1) !== 1 ? "s" : ""} · {ORIENTATIONS.find((o) => o.id === b.placement.orientation)?.label || b.placement.orientation}
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
        for (let i = 0; i < (pl.facings || 1); i++) items.push({ placement: pl, product: prod, wIn: w, overhangIn });
      });
    });

    let cursor = 0;
    const globalBoxes = items.map((it) => {
      // only the group's very last facing's own overhang tolerance matters here, since that's
      // the one actually sitting at the combined run's far edge
      const box = { placement: it.placement, product: it.product, xIn: cursor, wIn: it.wIn, overflow: cursor + it.wIn > totalWidth + it.overhangIn };
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

function ProductBox({ box, scale, selected, onSelect, metrics, schema, overlaySettings, onDragStartPlacement, onDragEndPlacement, dragging, readOnly, capacityWarningsEnabled, hideImages, highlightField, zoomLevel, pegYIn }) {
  const { placement, product, xIn, wIn, overflow } = box;
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
  const footprintHpx = Math.max((rotated ? product.dims.w : product.dims.h) * scale - 1, 4);
  // natural = the product's own front-facing size, which then gets rotated as a whole block
  const naturalWpx = Math.max(product.dims.w * scale - 1, 2);
  const naturalHpx = Math.max(product.dims.h * scale - 1, 4);

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
  const pegBottomPx = hasPeg ? (pegYIn - (rotated ? product.dims.w : product.dims.h)) * scale : undefined;

  return (
    <div
      className={`absolute ${hasPeg ? "" : "bottom-0"} ${selected ? "z-10" : ""}`}
      style={{ left: xIn * scale, width: footprintWpx, height: footprintHpx, bottom: hasPeg ? pegBottomPx : undefined, pointerEvents: "auto" }}
      title={`${product.name} · ${placement.orientation} · ${rotation}°`}
    >
      <div
        draggable={!readOnly}
        onDragStart={readOnly ? undefined : (e) => { e.stopPropagation(); onDragStartPlacement(e, placement); }}
        onDragEnd={readOnly ? undefined : (e) => { e.stopPropagation(); onDragEndPlacement(); }}
        onClick={readOnly ? undefined : (e) => { e.stopPropagation(); onSelect(placement.id); }}
        className={`absolute top-1/2 left-1/2 flex items-center justify-center overflow-hidden border ${readOnly ? "" : "cursor-grab active:cursor-grabbing"} ${
          selected ? "ring-2 ring-amber-500 border-amber-500" : showOverflowBorder ? "border-red-400" : hasHighlight ? "" : "border-slate-400/60"
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
        ) : !hasOverlayContent ? (
          <span className="leading-tight text-white font-semibold text-center px-0.5 break-words" style={{ fontSize: nameFontSize }}>
            {product.name.slice(0, 10)}
          </span>
        ) : null}

        {hasOverlayContent && settings.layout === "compact" && (
          <div className={`absolute ${posCls} left-0 max-w-full bg-black/70 text-white px-0.5 leading-tight overflow-hidden`} style={{ fontSize: overlayFontSize }}>
            {detailLines.slice(0, 1).map((l, i) => <div key={"d" + i} className={`font-semibold ${lineWrapCls}`}>{l}</div>)}
            {metricLineTexts.slice(0, 2).map((l, i) => <div key={"m" + i} className={lineWrapCls}>{l}</div>)}
          </div>
        )}
        {hasOverlayContent && settings.layout === "detailed" && (
          <div className={`absolute ${posCls} left-0 right-0 bg-black/75 text-white px-0.5 py-0.5 leading-tight overflow-hidden`} style={{ fontSize: overlayFontSize }}>
            {detailLines.map((l, i) => <div key={"d" + i} className={`font-semibold ${lineWrapCls}`}>{l}</div>)}
            {metricLineTexts.map((l, i) => <div key={"m" + i} className={lineWrapCls}>{l}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function FixtureBar({
  fx, fixtureDef, products, scale, base, maxNotchY, selected, sectionId, readOnly, joinedBoxes, capacityWarningsEnabled, hideImages, highlightField, zoomLevel,
  onSelectFixture, selectedPlacementId, onSelectPlacement, onDragCommit, onDropProduct, onMovePlacement,
  performance, cutoffISO, storeId, schema, overlaySettings,
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
        onDragCommit(d.currentNotch);
        onSelectFixture(fx.id);
      } else {
        onSelectFixture(fx.id);
      }
    }
  };

  const handleDown = (e) => {
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
    e.dataTransfer.setData("text/plain", JSON.stringify({
      kind: "placement",
      sectionId,
      fixtureInstId: fx.id,
      placementId: placement.id,
      productId: placement.productId,
      rotation: placement.rotation || 0,
    }));
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
    : !readOnly && (selected || dragging)
    ? "ring-2 ring-blue-500 z-20"
    : "";

  return (
    <>
      {/* the shelf/fixture bar itself — mousedown drags it up/down along notches, also accepts product drops */}
      <div
        onMouseDown={readOnly ? undefined : handleDown}
        onClick={readOnly ? undefined : (e) => e.stopPropagation()}
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
            : fixtureDef ? `${fixtureDef.name} (${fixtureDef.type}) — drag to reposition, or drop a product here` : "Missing fixture"
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
      {showWarnings && !visualOverflow && boxes.length > 0 && (
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
            onSelect={onSelectPlacement}
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
  onSelectFixture, selectedPlacementId, onSelectPlacement, onDragCommit, onDropProduct, onMovePlacement,
  performance, cutoffISO, storeId, schema, overlaySettings,
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
      if (d.moved) { onDragCommit(d.currentNotch); onSelectFixture(fx.id); }
      else onSelectFixture(fx.id);
    }
  };
  const handleDown = (e) => {
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
    const rectDebug = e.currentTarget.getBoundingClientRect();
    try { xy = computeDropXY(e); } catch (err) { xy = dropHoverXY || { xIn: 0, yIn: heightIn }; }
    setDropHoverXY(null);
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { kind: "product", productId: raw }; }

    const pegCoords = { pegX: xy.xIn, pegY: xy.yIn };

    // TEMPORARY diagnostic — remove once the vertical placement issue is confirmed fixed
    const droppedProd = products.find((p) => p.id === (payload.productId || null));
    console.log("[pegboard drop debug]", {
      "e.clientY": e.clientY,
      "panel rect top/height": [rectDebug.top, rectDebug.height],
      scale,
      "panel heightIn (fixture def)": heightIn,
      "computed pegY (stored)": xy.yIn,
      "derived row (1=top)": Math.round(heightIn - xy.yIn) + 1,
      "product height (if known)": droppedProd ? droppedProd.dims.h : "unknown",
    });

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
    e.dataTransfer.setData("text/plain", JSON.stringify({
      kind: "placement",
      sectionId,
      fixtureInstId: fx.id,
      placementId: placement.id,
      productId: placement.productId,
      rotation: placement.rotation || 0,
    }));
    // anchor the drag ghost at its top-left corner, not wherever it was grabbed — the cursor
    // position must represent that corner exactly for the peg calculation to land correctly
    try { e.dataTransfer.setDragImage(e.currentTarget, 0, 0); } catch (err) {}
  };

  const hasOverflow = boxes.some((b) => b.overflow);
  const showWarnings = capacityWarningsEnabled !== false;
  const visualOverflow = showWarnings && hasOverflow;
  const ringCls = !readOnly && dropHoverXY
    ? "ring-2 ring-amber-400 z-20"
    : visualOverflow
    ? "ring-2 ring-red-500 z-20"
    : !readOnly && (selected || dragging)
    ? "ring-2 ring-blue-500 z-20"
    : "";

  return (
    <>
      {/* the panel itself — mousedown drags it up/down along notches (repositioning the whole
          board), and it's a 2D drop target: any point on it accepts a product, snapped to the
          nearest 1in peg hole */}
      <div
        onMouseDown={readOnly ? undefined : handleDown}
        onClick={readOnly ? undefined : (e) => e.stopPropagation()}
        onDragOver={readOnly ? undefined : handlePanelDragOver}
        onDragLeave={readOnly ? undefined : handlePanelDragLeave}
        onDrop={readOnly ? undefined : handlePanelDrop}
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
        title={fixtureDef ? `${fixtureDef.name} (Pegboard) — 1in peg grid; drop a product anywhere on the panel, or drag the panel to reposition it` : "Missing fixture"}
      >
        {!readOnly && dropHoverXY && (
          <div
            className="absolute rounded-full bg-amber-400 pointer-events-none border border-amber-600"
            style={{ left: dropHoverXY.xIn * scale - 4, bottom: dropHoverXY.yIn * scale - 4, width: 8, height: 8 }}
          />
        )}
      </div>
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
            onSelect={onSelectPlacement}
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
  onRename, onResize, onMove, onDelete, onAddFixture, onDragFixture, onDropProductOnFixture, onMovePlacement,
  selectedFixtureId, onSelectFixture, selectedPlacementId, onSelectPlacement, onDeselectAll,
  performance, cutoffISO, storeId, schema, overlaySettings,
}) {
  const heightPx = planogram.dims.h * scale;
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
            <div className="ml-auto flex items-center gap-0.5">
              <button className={btnIcon} disabled={index === 0} onClick={() => onMove(-1)} title="Move left"><ChevronLeft size={14} /></button>
              <button className={btnIcon} disabled={index === total - 1} onClick={() => onMove(1)} title="Move right"><ChevronRight size={14} /></button>
              <button className={btnIcon} onClick={onDelete} title="Delete section"><Trash2 size={13} /></button>
            </div>
          </>
        )}
      </div>

      <div
        onClick={readOnly ? undefined : onDeselectAll}
        className="relative border-x border-slate-300 bg-gradient-to-b from-slate-100 to-slate-200"
        style={{ width: section.width * scale, height: heightPx }}
      >
        {/* base / kick plate */}
        <div
          className="absolute bottom-0 w-full bg-slate-700/80 flex items-center justify-center"
          style={{ height: planogram.base * scale }}
        >
          {planogram.base * scale > 14 && <span className="text-[8px] text-slate-200">BASE</span>}
        </div>

        {section.fixtures.map((fx) => {
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
                selectedPlacementId={selectedPlacementId}
                onSelectPlacement={onSelectPlacement}
                onDragCommit={(notchY) => onDragFixture(fx.id, notchY)}
                onDropProduct={(productId, insertIndex, pegCoords) => onDropProductOnFixture(fx.id, productId, insertIndex, pegCoords)}
                onMovePlacement={onMovePlacement}
                performance={performance}
                cutoffISO={cutoffISO}
                storeId={storeId}
                schema={schema}
                overlaySettings={overlaySettings}
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
              capacityWarningsEnabled={capacityWarningsEnabled}
              hideImages={hideImages}
              highlightField={highlightField}
              zoomLevel={zoomLevel}
              onSelectFixture={onSelectFixture}
              selectedPlacementId={selectedPlacementId}
              onSelectPlacement={onSelectPlacement}
              onDragCommit={(notchY) => onDragFixture(fx.id, notchY)}
              onDropProduct={(productId, insertIndex) => onDropProductOnFixture(fx.id, productId, insertIndex)}
              onMovePlacement={onMovePlacement}
              performance={performance}
              cutoffISO={cutoffISO}
              storeId={storeId}
              schema={schema}
              overlaySettings={overlaySettings}
            />
          );
        })}

        {section.fixtures.length === 0 && !readOnly && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-400 italic px-2 text-center">
            Empty section
          </div>
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

function PlacementInspector({ placement, product, metrics, weeks, onChange, onRemove, onClose, isPegboard, pegboardHeightIn }) {
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
        <div className="flex items-center gap-2">
          <button className={btnIcon} onClick={() => onChange({ ...placement, facings: Math.max(1, (placement.facings || 1) - 1) })}><Minus size={13} /></button>
          <span className="w-8 text-center font-mono text-sm">{placement.facings || 1}</span>
          <button className={btnIcon} onClick={() => onChange({ ...placement, facings: (placement.facings || 1) + 1 })}><Plus size={13} /></button>
        </div>
      </div>

      <button className={btnDanger + " w-full justify-center"} onClick={onRemove}><Trash2 size={13} /> Remove from fixture</button>
    </div>
  );
}

function ProductLibraryPanel({ products, schema }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const filtered = products.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  const thumbRefs = useRef({});

  return (
    <div className={`shrink-0 bg-white border border-slate-200 rounded-lg p-3 h-fit sticky top-4 flex flex-col transition-all ${expanded ? "w-80 max-h-[85vh]" : "w-56 max-h-[75vh]"}`}>
      <div className="flex items-center justify-between mb-1">
        <h4 className="font-bold text-sm text-slate-800 flex items-center gap-1.5"><Package size={14} /> Product Library</h4>
        <button className="text-slate-400 hover:text-slate-600" onClick={() => setExpanded((e) => !e)} title={expanded ? "Collapse panel" : "Expand panel"}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      <p className="text-[11px] text-slate-400 mb-2">Drag a product onto a shelf to merchandise it.</p>
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
              className="flex items-center gap-2 border border-slate-200 rounded-md px-2 py-1.5 bg-slate-50 hover:bg-amber-50 hover:border-amber-300 cursor-grab active:cursor-grabbing"
              title="Drag onto a shelf"
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
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-700 truncate">{p.name}</div>
                <div className="text-[10px] text-slate-400 font-mono">{tag || "—"}</div>
              </div>
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

function PlanogramVersionsBar({ planogram, allPlanograms, onCreateVersion, onOpenVersion }) {
  const members = getFamilyMembers(planogram, allPlanograms);
  const isMaster = !planogram.masterId;
  const master = isMaster ? planogram : allPlanograms.find((p) => p.id === planogram.masterId);

  return (
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
      <button className={btnGhost + " ml-auto"} onClick={() => onCreateVersion(planogram)}><Copy size={13} /> Create Version</button>
    </div>
  );
}

function PlanogramEditor({ planogram, products, fixtures, performance, productSchema, stores, capacityWarningsEnabled, onAssignStores, onUpdate, onBack, allPlanograms, onCreateVersion, onOpenVersion, onMakeLive, onResolveIssue }) {
  const [presentMode, setPresentMode] = useState(false);
  const [hideImages, setHideImages] = useState(false); // session-only view toggle, not saved with the planogram
  const [highlightField, setHighlightField] = useState(null); // attribute field id, or null = off
  const [highlightPanelOpen, setHighlightPanelOpen] = useState(false);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(false); // session-only, not saved
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false); // session-only, not saved
  const [topBarCollapsed, setTopBarCollapsed] = useState(false); // session-only, not saved
  const [sectionToolbarCollapsed, setSectionToolbarCollapsed] = useState(false); // session-only, not saved
  const [analyzeToolbarCollapsed, setAnalyzeToolbarCollapsed] = useState(false); // session-only, not saved
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

  const mutateSections = (fn) => onUpdate({ ...planogram, sections: fn(planogram.sections) });

  const addSection = () => {
    mutateSections((secs) => [...secs, { id: uid("sec"), name: `Sec ${secs.length + 1}`, width: 48, fixtures: [] }]);
  };
  const renameSection = (id, name) => mutateSections((secs) => secs.map((s) => (s.id === id ? { ...s, name } : s)));
  const resizeSection = (id, width) => mutateSections((secs) => secs.map((s) => (s.id === id ? { ...s, width } : s)));
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
    mutateSections((secs) => secs.map((s) => (s.id === sectionId ? { ...s, fixtures: s.fixtures.filter((f) => f.id !== fxId) } : s)));
    setSelectedFixtureId(null);
  };
  const updateFixtureInst = (sectionId, fxId, patch) => {
    mutateSections((secs) =>
      secs.map((s) =>
        s.id === sectionId ? { ...s, fixtures: s.fixtures.map((f) => (f.id === fxId ? { ...f, ...patch } : f)) } : s
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
                const newPlacement = { id: newId, productId, facings: 1, orientation: "front", rotation: 0 };
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

  const updatePlacement = (sectionId, fxId, placementId, patch) => {
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
      {!presentMode && <PlanogramVersionsBar planogram={planogram} allPlanograms={allPlanograms} onCreateVersion={onCreateVersion} onOpenVersion={onOpenVersion} />}
      {!presentMode && <PlanogramLifecycleBar planogram={planogram} onUpdate={onUpdate} onMakeLive={onMakeLive} />}

      {!presentMode && (
        <>
          {sectionToolbarCollapsed ? (
            <div className="flex justify-center mb-2 no-print">
              <button onClick={() => setSectionToolbarCollapsed(false)} className="text-slate-400 hover:text-slate-600 rounded-full border border-slate-200 bg-white px-3 py-0.5" title="Show planogram properties / add section">
                <ChevronDown size={14} />
              </button>
            </div>
          ) : (
          <div className="flex flex-wrap items-end gap-3 mb-4 bg-white border border-slate-200 rounded-lg p-3">
            <Field label="Category"><DebouncedTextInput className={inputCls + " w-32"} value={planogram.category || ""} onCommit={(category) => onUpdate({ ...planogram, category })} placeholder="e.g. Beer" /></Field>
            <Field label="Event Date"><input type="date" className={inputCls + " w-36"} value={planogram.eventDate || ""} onChange={(e) => onUpdate({ ...planogram, eventDate: e.target.value })} /></Field>
            <div className="relative">
              <label className={labelCls}>Stores</label>
              <button
                onClick={() => setAssigningStores((s) => !s)}
                className={`text-xs font-medium flex items-center gap-1.5 rounded-md px-2.5 py-1.5 border ${(planogram.storeIds || []).length > 0 ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
              >
                <Store size={13} /> {(planogram.storeIds || []).length > 0 ? `${planogram.storeIds.length} assigned` : "Assign"}
              </button>
              {assigningStores && (
                <StoreAssignmentPopover
                  stores={stores}
                  selectedIds={planogram.storeIds || []}
                  onToggle={(storeId) => {
                    const current = planogram.storeIds || [];
                    const next = current.includes(storeId) ? current.filter((id) => id !== storeId) : [...current, storeId];
                    onAssignStores(next);
                  }}
                  onClose={() => setAssigningStores(false)}
                />
              )}
            </div>
            <Field label="Width (in)"><input type="number" className={inputCls + " w-24"} value={planogram.dims.w} onChange={(e) => onUpdate({ ...planogram, dims: { ...planogram.dims, w: Number(e.target.value) || 1 } })} /></Field>
            <Field label="Height (in)"><input type="number" className={inputCls + " w-24"} value={planogram.dims.h} onChange={(e) => onUpdate({ ...planogram, dims: { ...planogram.dims, h: Number(e.target.value) || 1 } })} /></Field>
            <Field label="Depth (in)"><input type="number" className={inputCls + " w-24"} value={planogram.dims.d} onChange={(e) => onUpdate({ ...planogram, dims: { ...planogram.dims, d: Number(e.target.value) || 1 } })} /></Field>
            <Field label="Base (in)"><input type="number" className={inputCls + " w-24"} value={planogram.base} onChange={(e) => onUpdate({ ...planogram, base: Number(e.target.value) || 0 })} /></Field>
            <div className={`text-xs font-mono px-2 py-1 rounded ${totalSectionsWidth > planogram.dims.w ? "bg-red-50 text-red-600" : "bg-slate-50 text-slate-500"}`}>
              Sections used: {totalSectionsWidth} / {planogram.dims.w} in
            </div>
            <button className={btnPrimary + " ml-auto"} onClick={addSection}><Plus size={14} /> Add Section</button>
            <button className={btnIcon} onClick={() => setSectionToolbarCollapsed(true)} title="Collapse this panel"><ChevronUp size={14} /></button>
          </div>
          )}

          {analyzeToolbarCollapsed ? (
            availableWeeks > 0 && analysisWeeks > availableWeeks ? (
              <div className="flex items-center justify-between gap-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 mb-2">
                <span className="flex items-center gap-1.5"><AlertTriangle size={12} /> Only {availableWeeks} of {analysisWeeks} weeks selected have data loaded — figures reflect the {availableWeeks} week{availableWeeks !== 1 ? "s" : ""} available.</span>
                <button onClick={() => setAnalyzeToolbarCollapsed(false)} className="text-amber-700 hover:text-amber-900 shrink-0 no-print" title="Show performance analysis toolbar"><ChevronDown size={14} /></button>
              </div>
            ) : (
              <div className="flex justify-center mb-2 no-print">
                <button onClick={() => setAnalyzeToolbarCollapsed(false)} className="text-slate-400 hover:text-slate-600 rounded-full border border-slate-200 bg-white px-3 py-0.5" title="Show performance analysis toolbar">
                  <ChevronDown size={14} />
                </button>
              </div>
            )
          ) : (
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
              <button className={btnIcon} onClick={() => setAnalyzeToolbarCollapsed(true)} title="Collapse this panel"><ChevronUp size={14} /></button>
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
              </div>
              <div className="text-sm text-slate-500 mt-1.5 flex items-center gap-4 flex-wrap">
                <span className="font-mono">{planogram.dims.w}×{planogram.dims.h}×{planogram.dims.d} in · base {planogram.base}in</span>
                {planogram.eventDate && <span className="flex items-center gap-1.5"><CalendarDays size={13} /> {planogram.eventDate}</span>}
                {(planogram.storeIds || []).length > 0 && (
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
              <ProductLibraryPanel products={products} schema={productSchema} />
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
                    onMove={(dir) => moveSection(idx, dir)}
                    onDelete={() => deleteSection(section.id)}
                    onAddFixture={() => setSelectedSectionForAdd(section.id)}
                    onDragFixture={(fxId, notchY) => updateFixtureInst(section.id, fxId, { notchY })}
                    onDropProductOnFixture={(fxId, productId, insertIndex, pegCoords) => addPlacement(section.id, fxId, productId, insertIndex, pegCoords)}
                    onMovePlacement={movePlacement}
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

          {placementCtx ? (
            <PlacementInspector
              placement={placementCtx.pl}
              product={placementCtx.product}
              metrics={placementCtx.metrics}
              weeks={analysisWeeks}
              isPegboard={fixtures.find((f) => f.id === placementCtx.fx.fixtureId)?.type === "Pegboard"}
              pegboardHeightIn={fixtures.find((f) => f.id === placementCtx.fx.fixtureId)?.dims?.h}
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
              <div className="grid grid-cols-2 gap-2">
                <Field label="Notch Y (in from base)">
                  <input type="number" step="1" className={inputCls} value={fixtureCtx.fx.notchY} onChange={(e) => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { notchY: Math.round(Number(e.target.value)) || 0 })} />
                </Field>
                <Field label="X Offset (in)">
                  <input type="number" step="1" className={inputCls} value={fixtureCtx.fx.xOffset} onChange={(e) => updateFixtureInst(fixtureCtx.section.id, fixtureCtx.fx.id, { xOffset: Math.round(Number(e.target.value)) || 0 })} />
                </Field>
              </div>

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

function StoreSelectorScreen({ stores, onSelectStore, onExitToPlanner }) {
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
        <button onClick={onExitToPlanner} className="text-xs text-slate-400 hover:underline mt-4">← Back to Tandom Studio</button>
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

function MyActivitiesView({ store, planograms, products, fixtures, onSetExecutionStatus, onCompleteExecution, onMarkReviewed, onToggleItemCheck, onAddIssue }) {
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
  const [taskType, setTaskType] = useState(taskTypes[0]?.id || "");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [filterStatus, setFilterStatus] = useState("open"); // open | all | completed
  const [managingTypes, setManagingTypes] = useState(false);

  const tasks = (store.tasks || []).slice().sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
  const filtered = tasks.filter((t) => filterStatus === "all" || t.status === filterStatus);

  const cancelAdd = () => {
    setShowAdd(false);
    setTaskType(taskTypes[0]?.id || "");
    setDescription("");
    setDueDate("");
  };

  const submitAdd = () => {
    if (!description.trim()) return;
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
          <button className={btnPrimary} onClick={() => setShowAdd((s) => !s)}><Plus size={14} /> Add Task</button>
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-4">Day-to-day operational tasks for {store.name}.</p>

      {showAdd && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Task Type">
              <select className={inputCls} value={taskType} onChange={(e) => setTaskType(e.target.value)}>
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
            <button className={btnPrimary} disabled={!description.trim()} onClick={submitAdd}>Add Task</button>
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
                    {taskTypes.find((t) => t.id === task.type)?.label || task.type}
                  </span>
                  {task.dueDate && <span className="text-[10px] text-slate-400 flex items-center gap-1"><CalendarDays size={10} /> Due {task.dueDate}</span>}
                </div>
                <p className={`text-sm mt-1 ${task.status === "completed" ? "line-through text-slate-400" : "text-slate-800"}`}>{task.description}</p>
              </div>
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

const STORE_ASSISTANT_NAV = [
  { id: "myStore", label: "My Store", icon: Store },
  { id: "myActivities", label: "My Activities", icon: Layers },
  { id: "taskManagement", label: "Task Management", icon: Check },
  { id: "storeFeedback", label: "Store Feedback", icon: AlertTriangle },
  { id: "orders", label: "Orders", icon: Package },
  { id: "photoCollection", label: "Photo Collection", icon: ImageIcon },
];

function StoreAssistantModule({ stores, planograms, products, fixtures, selectedStoreId, onSelectStore, onExitToPlanner, onSetExecutionStatus, onCompleteExecution, onMarkReviewed, onToggleItemCheck, onAddIssue, onAddPhoto, onDeletePhoto, onAddTask, onUpdateTask, onDeleteTask, taskTypes, onUpdateTaskTypes }) {
  const [section, setSection] = useState("myActivities");
  const store = stores.find((s) => s.id === selectedStoreId);

  if (!store) {
    return <StoreSelectorScreen stores={stores} onSelectStore={onSelectStore} onExitToPlanner={onExitToPlanner} />;
  }

  return (
    <div className="min-h-screen flex bg-slate-100">
      <div className="w-56 bg-slate-900 text-white flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-slate-800 flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-amber-500 flex items-center justify-center text-slate-900 font-black text-sm shrink-0">T</div>
          <span className="font-bold text-sm">Store Assistant</span>
        </div>
        <nav className="flex-1 py-2">
          {STORE_ASSISTANT_NAV.map((item) => (
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
          <button onClick={() => onSelectStore(null)} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
            <RefreshCw size={11} /> Switch store
          </button>
          <button onClick={onExitToPlanner} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
            <LogOut size={11} /> Exit to Tandom Studio
          </button>
        </div>
      </div>
      <div className="flex-1 p-6 max-w-4xl">
        {section === "myStore" && <MyStoreView store={store} planograms={planograms} />}
        {section === "myActivities" && <MyActivitiesView store={store} planograms={planograms} products={products} fixtures={fixtures} onSetExecutionStatus={onSetExecutionStatus} onCompleteExecution={onCompleteExecution} onMarkReviewed={onMarkReviewed} onToggleItemCheck={onToggleItemCheck} onAddIssue={onAddIssue} />}
        {section === "taskManagement" && <TaskManagementView store={store} taskTypes={taskTypes} onAddTask={onAddTask} onUpdateTask={onUpdateTask} onDeleteTask={onDeleteTask} onUpdateTaskTypes={onUpdateTaskTypes} />}
        {section === "storeFeedback" && <StoreFeedbackViewSA store={store} planograms={planograms} />}
        {section === "orders" && <StoreAssistantComingSoon title="Orders" />}
        {section === "photoCollection" && <PhotoCollectionView store={store} planograms={planograms} onAddPhoto={onAddPhoto} onDeletePhoto={onDeletePhoto} />}
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

function EventPlannerModule({ events, eventTypes, planograms, onCreateEvent, onUpdateEvent, onDeleteEvent, onUpdateEventTypes, onExitToPlanner }) {
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
          <button
            onClick={onExitToPlanner}
            className="text-xs flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 rounded-full px-3 py-1.5 border border-slate-700"
          >
            <LogOut size={13} /> Exit to Tandom Studio
          </button>
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

function AppContent({ session }) {
  const [tab, setTab] = useState("planograms");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [productSchema, setProductSchema] = useState(DEFAULT_PRODUCT_SCHEMA);
  const [fixtureSchema, setFixtureSchema] = useState(DEFAULT_FIXTURE_SCHEMA);
  const [primaryKeyField, setPrimaryKeyField] = useState("sku"); // "sku" | "upc" — global product matching key
  const [imageRepo, setImageRepo] = useState(DEFAULT_IMAGE_REPO);
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
  const setAppMode = (mode) => { setAppModeState(mode); safeSet("settings:appMode", mode); };
  const setSelectedStoreId = (id) => { setSelectedStoreIdState(id); safeSet("settings:selectedStoreId", id || ""); };
  const [events, setEvents] = useState([]); // Event Planner — reset/promo/etc events
  const [eventTypes, setEventTypes] = useState(DEFAULT_EVENT_TYPES); // customizable event type list
  const [taskTypes, setTaskTypes] = useState(DEFAULT_TASK_TYPES); // customizable Store Assistant task type list

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
        const [pSchema, fSchema, pkField, imgRepo, capWarn, prods, fixs, pogs, perf, strs, savedMode, savedStoreId, savedEvents, savedEventTypes, savedTaskTypes] = await Promise.all([
          safeGet("schema:product"),
          safeGet("schema:fixture"),
          safeGet("settings:primaryKeyField"),
          safeGet("settings:imageRepo"),
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
        ]);
        if (settled) return; // the timeout already fired and the app moved on — don't clobber state after the fact
        if (pSchema) setProductSchema(JSON.parse(pSchema));
        if (fSchema) setFixtureSchema(JSON.parse(fSchema));
        if (pkField) setPrimaryKeyField(pkField);
        if (imgRepo) setImageRepo({ ...DEFAULT_IMAGE_REPO, ...JSON.parse(imgRepo) });
        if (capWarn !== null) setCapacityWarningsEnabled(capWarn === "true");
        if (savedMode) setAppModeState(savedMode);
        if (savedStoreId) setSelectedStoreIdState(savedStoreId);
        if (savedEvents) setEvents(JSON.parse(savedEvents));
        if (savedEventTypes) setEventTypes(JSON.parse(savedEventTypes));
        if (savedTaskTypes) setTaskTypes(JSON.parse(savedTaskTypes));
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
  const updatePrimaryKeyField = (next) => { setPrimaryKeyField(next); safeSet("settings:primaryKeyField", next); };
  const updateImageRepo = (patch) => {
    setImageRepo((prev) => {
      const next = { ...prev, ...patch };
      safeSet("settings:imageRepo", JSON.stringify(next));
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
  const buildPlanogramVersion = (source, existingList) => {
    const masterId = getFamilyMasterId(source);
    const siblings = existingList.filter((p) => getFamilyMasterId(p) === masterId);
    const nextVersion = Math.max(1, ...siblings.map((p) => p.versionNumber || 1)) + 1;
    const baseName = source.name.replace(/\s*\(v\d+\)\s*$/i, "").trim();
    return {
      ...source,
      id: uid("pog"),
      name: `${baseName} (v${nextVersion})`,
      masterId,
      versionNumber: nextVersion,
      sections: cloneSectionsWithNewIds(source.sections),
      status: "wip",
      eventDate: "",
      publishedAt: undefined,
    };
  };

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
    await safeSet("settings:primaryKeyField", backup.primaryKeyField);

    setProducts(backup.products);
    setFixtures(backup.fixtures);
    setPlanograms(backup.planograms);
    setStores(backup.stores);
    setPerformance(backup.performance);
    setProductSchema(backup.productSchema);
    setFixtureSchema(backup.fixtureSchema);
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

  if (appMode === "storeAssistant") {
    return (
      <StoreAssistantModule
        stores={stores}
        planograms={planograms}
        products={products}
        fixtures={fixtures}
        selectedStoreId={selectedStoreId}
        onSelectStore={setSelectedStoreId}
        onExitToPlanner={() => setAppMode("planner")}
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
        taskTypes={taskTypes}
        onUpdateTaskTypes={updateTaskTypes}
      />
    );
  }

  if (appMode === "eventPlanner") {
    return (
      <EventPlannerModule
        events={events}
        eventTypes={eventTypes}
        planograms={planograms}
        onCreateEvent={createEvent}
        onUpdateEvent={updateEvent}
        onDeleteEvent={deleteEvent}
        onUpdateEventTypes={updateEventTypes}
        onExitToPlanner={() => setAppMode("planner")}
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

      {!activePlanogram && (
        <div className="bg-white border-b border-slate-200 px-6 flex gap-1">
          <TabButton active={tab === "planograms"} onClick={() => setTab("planograms")} icon={Layers}>Planograms</TabButton>
          <TabButton active={tab === "products"} onClick={() => setTab("products")} icon={Package}>Products</TabButton>
          <TabButton active={tab === "fixtures"} onClick={() => setTab("fixtures")} icon={Boxes}>Fixtures</TabButton>
          <TabButton active={tab === "stores"} onClick={() => setTab("stores")} icon={Store}>Stores</TabButton>
          <TabButton active={tab === "performance"} onClick={() => setTab("performance")} icon={TrendingUp}>Performance</TabButton>
          <TabButton active={tab === "storeFeedback"} onClick={() => setTab("storeFeedback")} icon={AlertTriangle}>Store Feedback</TabButton>
          <TabButton active={tab === "schema"} onClick={() => setTab("schema")} icon={Settings2}>Attribute Fields</TabButton>
        </div>
      )}

      <div className="p-6 max-w-[1400px] mx-auto">
        {activePlanogram ? (
          <PlanogramEditor
            planogram={activePlanogram}
            products={products}
            fixtures={fixtures}
            performance={performance}
            productSchema={productSchema}
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
          />
        ) : tab === "planograms" ? (
          <PlanogramList
            planograms={planograms}
            stores={stores}
            onCreate={createPlanogram}
            onOpen={setActivePlanogramId}
            onDelete={deletePlanogramEntity}
            onAssignStores={assignStoresToPlanogram}
            onCreateVersion={(source) => { const v = createPlanogramVersion(source); setActivePlanogramId(v.id); }}
            onCreateVersions={createPlanogramVersionsBulk}
          />
        ) : tab === "products" ? (
          <ProductLibrary
            schema={productSchema}
            products={products}
            primaryKeyField={primaryKeyField}
            imageRepo={imageRepo}
            onCreate={createProduct}
            onUpdate={updateProductEntity}
            onDelete={deleteProductEntity}
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
        ) : tab === "storeFeedback" ? (
          <StoreFeedbackView planograms={planograms} onResolveIssue={resolvePlanogramIssue} onOpenPlanogram={setActivePlanogramId} />
        ) : (
          <div className="space-y-5">
            <BackupRestorePanel
              dataBundle={{ productSchema, fixtureSchema, primaryKeyField, products, fixtures, planograms, performance, stores }}
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
                    <span className="text-xs text-slate-400">The "Xin left" / "Xin overhang" badges and the red "Over capacity" warning on shelves. Turn off for a clean view when presenting to retailers.</span>
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

            <SchemaEditor title="Product Attribute Fields" schema={productSchema} onChange={updateProductSchema} max={200} />
            <SchemaEditor title="Fixture Attribute Fields" schema={fixtureSchema} onChange={updateFixtureSchema} max={50} />
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

function AuthScreen() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName || email } },
        });
        if (error) throw error;
        setNotice("Account created. If email confirmation is on for this project, check your inbox before signing in.");
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
        <p className="text-xs text-slate-500 mb-5">Teams Delivering Merchandising in Tandom</p>

        <div className="flex gap-1.5 mb-4">
          <button onClick={() => setMode("signin")} className={`flex-1 text-sm rounded-md py-1.5 border font-medium ${mode === "signin" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600"}`}>Sign In</button>
          <button onClick={() => setMode("signup")} className={`flex-1 text-sm rounded-md py-1.5 border font-medium ${mode === "signup" ? "bg-amber-500 border-amber-500 text-slate-900" : "border-slate-200 text-slate-600"}`}>Create Account</button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "signup" && (
            <div>
              <label className={labelCls}>Name</label>
              <input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane Planner" />
            </div>
          )}
          <div>
            <label className={labelCls}>Email</label>
            <div className="relative">
              <Mail size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
              <input type="email" required className={inputCls + " pl-8"} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Password</label>
            <div className="relative">
              <Lock size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-300" />
              <input type="password" required minLength={6} className={inputCls + " pl-8"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
          </div>
          {error && <div className="text-sm rounded-md px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</div>}
          {notice && <div className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200">{notice}</div>}
          <button type="submit" disabled={busy} className={btnPrimary + " w-full justify-center"}>
            {busy ? "Please wait…" : mode === "signup" ? "Create Account" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out, object = signed in

  useEffect(() => {
    if (!supabaseConfigured) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession));
    return () => listener.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) return <SetupNeededScreen />;
  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm gap-2"><RefreshCw size={16} className="animate-spin" /> Checking session…</div>;
  }
  if (!session) return <AuthScreen />;
  return <AppContent session={session} />;
}
