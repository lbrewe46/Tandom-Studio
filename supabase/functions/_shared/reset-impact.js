// Reset Impact Agent — the calculation. Compares sales before and after a planogram version went
// Live, store by store, with the Historical version as the baseline, and against similar stores
// that did not reset (so a market-wide trend isn't credited to the reset). Pure and deterministic:
// no model call, so a result can always be explained from the performance data.
//
// Windows (all whole weeks, `weekEnding` as in the Performance import):
//   before = the `preWeeks` weeks ending on or before the go-live date
//   gap    = the week straddling go-live is ignored
//   after  = the weeks that end 7+ days after go-live, up to `postWeeks`, as far as data reaches
// A store with fewer than `minPostWeeks` after-weeks is "maturing": shown, but left out of totals.
//
// What counts as "the planogram's sales": every product on the new version OR on the baseline
// version, so a product the reset removed (lost sales) and one it added (gained sales) both count.

import { effectivePlanogramStatus, getFamilyMembers, addDaysISO, getPlacementSpaceIn, rollupImpactRows, IMPACT_METRICS } from "./app-core.js";

export const IMPACT_DEFAULTS = { preWeeks: 8, postWeeks: 8, minPostWeeks: 4, minPreDataWeeks: 4 };
const METRICS = IMPACT_METRICS;

const dayNumber = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const datePart = (v) => (typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null);

export function getBaselinePlanogram(planogram, allPlanograms) {
  const mine = planogram.versionNumber || 1;
  return getFamilyMembers(planogram, allPlanograms)
    .filter((p) => p.id !== planogram.id && (p.status || "wip") === "historical" && (p.versionNumber || 1) < mine)
    .sort((a, b) => (b.versionNumber || 1) - (a.versionNumber || 1))[0] || null;
}

function productIdsOf(planogram) {
  const ids = new Set();
  (planogram?.sections || []).forEach((s) => (s.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    if (pl.productId) ids.add(pl.productId);
    if (pl.cap?.productId) ids.add(pl.cap.productId);
  })));
  return ids;
}

export function linearFeetOf(planogram, productsById) {
  let inches = 0;
  (planogram?.sections || []).forEach((s) => (s.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    const product = productsById[pl.productId];
    if (product) inches += getPlacementSpaceIn(product, pl);
  })));
  return inches / 12;
}

// storeId -> weekEnding -> {sales, units, margin}, over the given products only
function buildWeekly(productIds, performance) {
  const byStore = new Map();
  productIds.forEach((pid) => (performance[pid] || []).forEach((r) => {
    if (!r.weekEnding) return;
    const sid = r.storeId || "";
    let weeks = byStore.get(sid);
    if (!weeks) byStore.set(sid, (weeks = new Map()));
    const cur = weeks.get(r.weekEnding) || { sales: 0, units: 0, margin: 0 };
    const u = r.units || 0;
    cur.units += u;
    cur.sales += u * (r.price || 0);
    cur.margin += u * ((r.price || 0) - (r.unitCost || 0));
    weeks.set(r.weekEnding, cur);
  }));
  return byStore;
}

// weekly averages before/after one go-live date for one store's weekly map
export function measureWindows(weeks, goLive, latestISO, p) {
  const preFloor = addDaysISO(goLive, -7 * p.preWeeks);
  const postFrom = addDaysISO(goLive, 7);
  const postCeil = addDaysISO(goLive, 7 + 7 * p.postWeeks);
  const postAvail = !latestISO || latestISO < postFrom ? 0 : Math.min(p.postWeeks, Math.floor((dayNumber(latestISO) - dayNumber(postFrom)) / 7) + 1);
  const pre = { sales: 0, units: 0, margin: 0 };
  const post = { sales: 0, units: 0, margin: 0 };
  let preDataWeeks = 0;
  if (weeks) {
    weeks.forEach((v, we) => {
      if (we > preFloor && we <= goLive) { METRICS.forEach((m) => { pre[m] += v[m]; }); preDataWeeks++; }
      else if (we >= postFrom && we < postCeil && (!latestISO || we <= latestISO)) METRICS.forEach((m) => { post[m] += v[m]; });
    });
  }
  const avg = (o, n) => Object.fromEntries(METRICS.map((m) => [m, n > 0 ? o[m] / n : 0]));
  return { pre: avg(pre, p.preWeeks), post: avg(post, postAvail), preDataWeeks, postWeeks: postAvail };
}

const changeOf = (pre, post) => (pre > 0 ? post / pre - 1 : null);

export function computeResetImpact({ planogram, allPlanograms, products, performance, stores, params = {}, latestISO }) {
  const p = { ...IMPACT_DEFAULTS, ...params };
  const meta = { name: planogram.name || "Untitled", category: planogram.category || "", department: planogram.department || "", cluster: planogram.cluster || "", version: planogram.versionNumber || 1 };
  const base = { planogramId: planogram.id, planogram: meta, params: p, latestDataWeek: latestISO || null, rows: [] };
  if (effectivePlanogramStatus(planogram) !== "live") return { ...base, status: "not_live", reason: "Only a Live version can be measured." };
  if (!latestISO) return { ...base, status: "no_data", reason: "No Performance data has been imported." };

  const baseline = getBaselinePlanogram(planogram, allPlanograms);
  const productsById = Object.fromEntries(products.map((x) => [x.id, x]));
  const ids = new Set([...productIdsOf(planogram), ...productIdsOf(baseline)]);
  if (ids.size === 0) return { ...base, status: "no_data", reason: "The planogram has no products." };
  const weekly = buildWeekly(ids, performance);

  const completedDates = Object.values(planogram.execution || {}).filter((e) => e?.status === "completed").map((e) => datePart(e.completedAt)).filter(Boolean).sort();
  const planogramGoLive = planogram.eventDate || completedDates[0] || null;
  if (!planogramGoLive) return { ...base, status: "no_data", reason: "No go-live date: set an Event Date or have a store complete execution." };

  const family = getFamilyMembers(planogram, allPlanograms);
  const familyStores = new Set(family.flatMap((f) => f.storeIds || []));
  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));

  // similar stores that did not reset: sell these products, not in this planogram's family, and not
  // reset by another planogram of the same category around the same time
  const windowStart = addDaysISO(planogramGoLive, -7 * p.preWeeks);
  const windowEnd = addDaysISO(planogramGoLive, 7 + 7 * p.postWeeks);
  const otherReset = new Set();
  allPlanograms.forEach((o) => {
    if (family.includes(o) || !o.eventDate || (o.category || "") !== (planogram.category || "")) return;
    if (o.eventDate >= windowStart && o.eventDate <= windowEnd) (o.storeIds || []).forEach((s) => otherReset.add(s));
  });
  const controlTotals = { pre: { sales: 0, units: 0, margin: 0 }, post: { sales: 0, units: 0, margin: 0 }, stores: 0 };
  weekly.forEach((weeks, sid) => {
    if (!sid || familyStores.has(sid) || otherReset.has(sid)) return;
    const w = measureWindows(weeks, planogramGoLive, latestISO, p);
    if (w.preDataWeeks < p.minPreDataWeeks || w.postWeeks < p.minPostWeeks) return;
    METRICS.forEach((m) => { controlTotals.pre[m] += w.pre[m]; controlTotals.post[m] += w.post[m]; });
    controlTotals.stores++;
  });
  const control = controlTotals.stores > 0
    ? { stores: controlTotals.stores, change: Object.fromEntries(METRICS.map((m) => [m, changeOf(controlTotals.pre[m], controlTotals.post[m])])) }
    : { stores: 0, change: { sales: null, units: null, margin: null } };

  const space = { preLinearFt: baseline ? linearFeetOf(baseline, productsById) : null, postLinearFt: linearFeetOf(planogram, productsById) };

  const rows = (planogram.storeIds || []).map((sid) => {
    const store = storeById[sid] || {};
    const row = { storeId: sid, storeName: store.name || sid, storeNumber: store.storeNumber || "", region: store.region || "", format: store.format || "" };
    const exec = planogram.execution?.[sid];
    const goLive = exec?.status === "completed" ? datePart(exec.completedAt) : null;
    if (!goLive) return { ...row, status: "not_executed" };
    const w = measureWindows(weekly.get(sid), goLive, latestISO, p);
    const common = { ...row, goLiveDate: goLive, preDataWeeks: w.preDataWeeks, postWeeks: w.postWeeks, pre: w.pre, post: w.post };
    if (w.preDataWeeks < p.minPreDataWeeks) return { ...common, status: "no_baseline_data" };
    if (w.postWeeks < p.minPostWeeks) return { ...common, status: "maturing" };
    return { ...common, status: "measured" };
  });

  const measured = rows.filter((r) => r.status === "measured");
  return {
    ...base, status: "ok", baselinePlanogramId: baseline?.id || null, baselineName: baseline?.name || null,
    goLiveDate: planogramGoLive, space, control, rows,
    counts: { assigned: rows.length, measured: measured.length, maturing: rows.filter((r) => r.status === "maturing").length, notExecuted: rows.filter((r) => r.status === "not_executed").length, noBaselineData: rows.filter((r) => r.status === "no_baseline_data").length },
    summary: measured.length ? rollupImpactRows(measured.map((r) => ({ ...r, planogramId: planogram.id, space, controlChange: control.change })), meta.name) : null,
  };
}
