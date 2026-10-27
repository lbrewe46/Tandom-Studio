// Assortment: which segments are growing or shrinking, which items are slowest, and where new items
// should go. Pure functions on plain data (no database, no UI), so the same code runs in the browser
// (the Assortment tab) and in the draft-assortment Edge Function, and is tested in Node.
//
// The ideas, in the order a category manager would think about them:
//   1. Segments. The planner picks product attributes in the order shoppers decide at the shelf
//      (e.g. Adult/Kids, then Sugar, then Brand). Each segment gets its sales, its share of sales, its
//      share of shelf space, and its growth against the comparison period. Space index = share of sales
//      / share of space x 100: over 100 earns more than the room it takes, under 100 earns less.
//   2. Slow movers. Every item on the category's planograms, ranked by units per store per week, with
//      its space and sales per linear inch, for any scope (all stores, a region, a cluster, a format or one store).
//   3. Forecast. A new item has either a forecast (units per store per week) or one or more similar items
//      whose actual velocity stands in for it.
//   4. SKU rationalization. For each new item and each planogram that carries the category, find the room
//      (free shelf space first, otherwise the slowest items that would have to go), value the swap
//      (forecast sales less what is given up), and recommend only swaps that come out ahead. Items are
//      placed best first, and each decision updates a working copy of the planogram so later items see
//      the space and removals already used.

import {
  getAttrByLabel, getLatestWeekEnding, getCutoffISO, addDaysISO, effectivePlanogramStatus, getPlacementSpaceIn,
  layoutFixtureBoxes, getShelfClearanceIn, getStackHeightProblem, getAutoStackHigh, applyResetDraftChanges, uid,
} from "./app-core.js";

export const DEFAULT_ASSUMPTIONS = {
  metric: "sales", // what "better" means: sales | margin | units
  cannibalization: 0.2, // share of a new item's forecast that is really existing items' sales moving over
  transfer: 0.3, // share of a removed item's sales that stays in the category (shoppers buy something else)
  minWeeksOfData: 4,
  maxRemovalsPerAdd: 3,
  // what makes an item "core": it sells in nearly every week, steadily, and is part of the base of the category's sales
  coreMinWeeksSelling: 0.85, // sells in at least this share of the weeks
  coreMaxCv: 0.6, // weekly sales vary no more than this (standard deviation / average)
  coreSalesShare: 0.8, // belongs to the items that together make this share of the category's sales
  coreMinCoverage: 0.8, // a core item is expected in at least this share of the stores
  corePriceBand: 0.05, // a price within this of the usual price counts as "steady" (information only)
};

const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// "storeAttr" looks at the stores whose user-defined attribute (scope.fieldId) equals scope.value.
export const SCOPE_TYPES = ["all", "region", "cluster", "format", "store", "storeAttr"];
const attrText = (entity, fieldId) => { const v = entity?.attributes?.[fieldId]; return v === undefined || v === null ? "" : String(v).trim(); };

// Stores in the chosen scope. `includeChain` says whether Performance rows with no store (chain-level or
// blended data) count: only for "all stores".
export function resolveScope(stores, scope = { type: "all" }) {
  const type = SCOPE_TYPES.includes(scope?.type) ? scope.type : "all";
  const value = scope?.value;
  const pick = (s) => {
    if (type === "all") return true;
    if (type === "region") return (s.region || "") === value;
    if (type === "cluster") return (s.cluster || "") === value;
    if (type === "format") return (s.format || "") === value;
    if (type === "storeAttr") return !!scope.fieldId && attrText(s, scope.fieldId) === value;
    return s.id === value;
  };
  const list = (stores || []).filter(pick);
  const label = type === "all" ? "All stores" : type === "store" ? (list[0]?.name || "Store") : type === "storeAttr" ? `${scope.fieldLabel || "Store attribute"}: ${value}` : `${{ region: "Region", cluster: "Cluster", format: "Format" }[type]}: ${value}`;
  return { type, value, fieldId: scope.fieldId, storeIds: new Set(list.map((s) => s.id)), includeChain: type === "all", label };
}

// Every value a scope picker can offer, from the stores themselves.
export function scopeOptions(stores, storeSchema = []) {
  const uniq = (key) => [...new Set((stores || []).map((s) => (s[key] || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  const attrs = {};
  (storeSchema || []).forEach((f) => {
    attrs[f.id] = [...new Set((stores || []).map((s) => attrText(s, f.id)).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  });
  return { region: uniq("region"), cluster: uniq("cluster"), format: uniq("format"), attrs };
}

export function segmentValue(product, fieldId) {
  const v = product?.attributes?.[fieldId];
  const s = v === undefined || v === null ? "" : String(v).trim();
  return s || "(none)";
}

// The two comparison windows. "prior" = the same number of weeks just before; "yoy" = the same weeks a year earlier.
export function windowsFor(performance, weeks, compare) {
  const latest = getLatestWeekEnding(performance);
  if (!latest) return null;
  const cur = { start: getCutoffISO(latest, weeks), end: latest };
  const base = compare === "yoy"
    ? { start: addDaysISO(cur.start, -364), end: addDaysISO(cur.end, -364) }
    : (() => { const end = addDaysISO(cur.start, -1); return { start: getCutoffISO(end, weeks), end }; })();
  return { cur, base };
}

// Everything the screens and the recommender share, computed once for a (category, scope, period).
// The planograms that will be on the shelf on `asOf`, one version per family. Each version with a date counts
// from that date, whether it is Live, Approved, Pending or still a work-in-progress that a plan has scheduled
// (so a later plan builds on an earlier plan's version). A family with no dated change keeps what is live.
// Returns the original planogram objects (not copies) so fingerprints and ids stay the same.
export function planogramsAsOf(planograms, asOf) {
  const fam = new Map();
  (planograms || []).forEach((p) => { const k = p.masterId || p.id; if (!fam.has(k)) fam.set(k, []); fam.get(k).push(p); });
  const out = [];
  fam.forEach((members) => {
    const eligible = members.filter((m) => {
      const st = m.status || "wip";
      const eff = effectivePlanogramStatus(m);
      if (m.eventDate) return m.eventDate <= asOf && st !== "historical";
      return eff === "live";
    });
    if (!eligible.length) return;
    eligible.sort((a, b) => (a.eventDate || "").localeCompare(b.eventDate || "") || (a.versionNumber || 1) - (b.versionNumber || 1));
    out.push(eligible[eligible.length - 1]);
  });
  return out;
}

export function buildContext(data, params) {
  const { products, planograms, fixtures, performance, stores, productSchema } = data;
  const category = params.category || "";
  const weeks = params.weeks || 13;
  const compare = params.compare === "yoy" ? "yoy" : "prior";
  const levels = (params.segmentFieldIds || []).filter(Boolean);
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(params.assumptions || {}) };
  const scope = resolveScope(stores, params.scope);
  // optional: only planograms whose own attribute has this value (e.g. Assortment Tier = A)
  const pf = params.planogramFilter && params.planogramFilter.fieldId && params.planogramFilter.value ? params.planogramFilter : null;
  const productsById = Object.fromEntries((products || []).map((p) => [p.id, p]));
  const win = windowsFor(performance || {}, weeks, compare);

  // planograms of this category that are (or are about to be) on shelves in the scope
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(params.asOf || "") ? params.asOf : "";
  const pogs = (asOf ? planogramsAsOf(planograms, asOf).filter((p) => (p.category || "") === category) : (planograms || []).filter((p) => (p.category || "") === category && ["live", "pending"].includes(effectivePlanogramStatus(p))))
    .filter((p) => !pf || attrText(p, pf.fieldId) === pf.value)
    .map((p) => ({ planogram: p, storeIds: (p.storeIds || []).filter((id) => scope.storeIds.has(id)) }))
    .filter((x) => x.storeIds.length > 0);
  const catStoreIds = new Set(pogs.flatMap((x) => x.storeIds));
  const storeCount = catStoreIds.size;

  // per product: the stores it is on shelf in, its average linear inches per store, and where it sits
  const carry = new Map(); // productId -> Set(storeId)
  const spaceWeighted = new Map(); // productId -> sum over planograms of (stores x inches)
  const onPlanograms = new Map(); // productId -> Set(planogramId)
  pogs.forEach(({ planogram, storeIds }) => {
    (planogram.sections || []).forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
      const prod = productsById[pl.productId];
      if (!prod) return;
      if (!carry.has(prod.id)) { carry.set(prod.id, new Set()); spaceWeighted.set(prod.id, 0); onPlanograms.set(prod.id, new Set()); }
      storeIds.forEach((sid) => carry.get(prod.id).add(sid));
      spaceWeighted.set(prod.id, spaceWeighted.get(prod.id) + getPlacementSpaceIn(prod, pl) * storeIds.length);
      onPlanograms.get(prod.id).add(planogram.id);
    })));
  });

  const sum = (pid, w, storeFilter) => {
    const out = { units: 0, sales: 0, cost: 0, weeks: new Set(), stores: new Set() };
    if (!w) return { ...out, margin: 0 };
    (performance?.[pid] || []).forEach((r) => {
      if (r.weekEnding < w.start || r.weekEnding > w.end) return;
      const ok = r.storeId ? storeFilter(r.storeId) : scope.includeChain;
      if (!ok) return;
      out.units += r.units || 0; out.sales += (r.units || 0) * (r.price || 0); out.cost += (r.units || 0) * (r.unitCost || 0);
      out.weeks.add(r.weekEnding); if (r.storeId) out.stores.add(r.storeId);
    });
    return { ...out, margin: out.sales - out.cost };
  };
  const inScope = (sid) => scope.storeIds.has(sid);

  // average per-store weekly figure for a product: units / (stores carrying x weeks in the window)
  const denominator = (pid) => Math.max(1, (carry.get(pid)?.size || 0) || (win ? sum(pid, win.cur, inScope).stores.size : 0)) * weeks;
  const metricOf = (m, which) => ({ sales: m.sales, margin: m.margin, units: m.units }[which]);

  const items = [...carry.keys()].map((pid) => {
    const product = productsById[pid];
    const cur = sum(pid, win?.cur, inScope);
    const base = sum(pid, win?.base, inScope);
    const d = denominator(pid);
    const space = spaceWeighted.get(pid) / Math.max(1, storeCount);
    return {
      product, productId: pid, cur, base, stores: carry.get(pid).size, planograms: onPlanograms.get(pid).size,
      space, velocity: cur.units / d, salesPerStoreWeek: cur.sales / d, marginPerStoreWeek: cur.margin / d,
      salesPerInchWeek: space > 0 ? (cur.sales / d) / space : 0,
      path: levels.map((fid) => segmentValue(product, fid)),
      hasData: cur.weeks.size >= assumptions.minWeeksOfData,
    };
  });

  return { data, params: { category, weeks, compare, levels, scope: params.scope || { type: "all" } }, assumptions, scope, win, pogs, storeCount, items, productsById, carry, onPlanograms, sum, inScope, denominator, metricOf, levels, productSchema, fixtures };
}

// ---- 1. segments -------------------------------------------------------------------------------------------

function nodeMetrics(rows) {
  const t = { sales: 0, units: 0, margin: 0, baseSales: 0, baseUnits: 0, baseMargin: 0, space: 0, skus: rows.length };
  rows.forEach((r) => {
    t.sales += r.cur.sales; t.units += r.cur.units; t.margin += r.cur.margin;
    t.baseSales += r.base.sales; t.baseUnits += r.base.units; t.baseMargin += r.base.margin;
    t.space += r.space;
  });
  return t;
}

const growthOf = (cur, base) => (base > 0 ? cur / base - 1 : null);

function classify(node, categoryGrowth) {
  const g = node.growth;
  node.trend = g === null ? "n/a" : g >= 0.02 ? "Growing" : g <= -0.02 ? "Declining" : "Flat";
  node.vsCategoryPp = g !== null && categoryGrowth !== null ? round((g - categoryGrowth) * 100, 1) : null;
  const idx = node.spaceIndex;
  node.spaceNote = idx === null ? "" : idx >= 115 ? "Earns more than its space" : idx <= 85 ? "Earns less than its space" : "In line with its space";
  node.opportunity = node.trend === "Growing" && idx !== null && idx >= 115 ? "Add space"
    : node.trend === "Declining" && idx !== null && idx <= 85 ? "Reduce space" : "";
}

// Segment tree for the chosen decision order. Each node: its metrics, shares of the category and of its parent,
// growth, space index and a plain label; children are the next decision down.
export function segmentTree(ctx) {
  const rows = ctx.items;
  const total = nodeMetrics(rows);
  const categoryGrowth = growthOf(total.sales, total.baseSales);
  const build = (list, depth, path) => {
    if (depth >= ctx.levels.length) return [];
    const groups = new Map();
    list.forEach((r) => { const k = r.path[depth]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const parentTotal = nodeMetrics(list);
    const nodes = [...groups.entries()].map(([label, members]) => {
      const m = nodeMetrics(members);
      const node = {
        key: [...path, label].join(" › "), label, depth, path: [...path, label], metrics: m,
        shareOfCategorySales: total.sales > 0 ? m.sales / total.sales : null,
        shareOfCategorySpace: total.space > 0 ? m.space / total.space : null,
        shareOfParentSales: parentTotal.sales > 0 ? m.sales / parentTotal.sales : null,
        shareOfParentSpace: parentTotal.space > 0 ? m.space / parentTotal.space : null,
        growth: growthOf(m.sales, m.baseSales), unitGrowth: growthOf(m.units, m.baseUnits), marginGrowth: growthOf(m.margin, m.baseMargin),
        spaceIndex: null, children: build(members, depth + 1, [...path, label]),
      };
      // index against the parent so a segment is judged among its siblings
      const ss = node.shareOfParentSales, sp = node.shareOfParentSpace;
      node.spaceIndex = ss !== null && sp !== null && sp > 0 ? round((ss / sp) * 100, 0) : null;
      classify(node, categoryGrowth);
      return node;
    }).sort((a, b) => b.metrics.sales - a.metrics.sales);
    const largestSpace = nodes.reduce((best, n) => (n.metrics.space > (best?.metrics.space ?? -1) ? n : best), null);
    if (largestSpace) largestSpace.largestSpace = true;
    return nodes;
  };
  return { category: ctx.params.category, total: { ...total, growth: categoryGrowth }, nodes: build(rows, 0, []), levels: ctx.levels, windows: ctx.win, storeCount: ctx.storeCount };
}

// The node for a segment path (or the deepest one that exists), used to boost placement scores.
export function findSegment(tree, path) {
  let nodes = tree.nodes, found = null;
  for (const label of path) {
    const n = nodes.find((x) => x.label === label);
    if (!n) break;
    found = n; nodes = n.children;
  }
  return found;
}

// ---- 2. slow movers ----------------------------------------------------------------------------------------

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);

// Items ranked slowest first by units per store per week. groupBy ("region" | "cluster" | "format" | "store")
// also ranks each item inside every group of the scope: `slowIn` of `groups` says how widely it is slow.
export function slowMovers(ctx, { groupBy = "none" } = {}) {
  const rows = ctx.items.filter((r) => r.product);
  const velocities = rows.filter((r) => r.hasData || r.cur.units === 0).map((r) => r.velocity).sort((a, b) => a - b);
  const p25 = quantile(velocities, 0.25);

  let groups = [];
  const attrGroup = typeof groupBy === "string" && groupBy.startsWith("storeAttr:") ? groupBy.slice(10) : null;
  if (attrGroup || ["region", "cluster", "format", "store"].includes(groupBy)) {
    const byKey = new Map();
    (ctx.data.stores || []).filter((s) => ctx.scope.storeIds.has(s.id)).forEach((s) => {
      const key = groupBy === "store" ? s.id : attrGroup ? attrText(s, attrGroup) || "(none)" : (s[groupBy] || "").trim() || "(none)";
      if (!byKey.has(key)) byKey.set(key, { key, label: groupBy === "store" ? s.name : key, storeIds: new Set() });
      byKey.get(key).storeIds.add(s.id);
    });
    // One pass over each item's sales and carrying stores, bucketed by group, so the cost grows with the
    // number of sales records rather than records x groups (a chain with thousands of stores grouped by store).
    const groupOfStore = new Map();
    byKey.forEach((g) => g.storeIds.forEach((sid) => groupOfStore.set(sid, g.key)));
    byKey.forEach((g) => { g.perItem = new Map(); });
    rows.forEach((r) => {
      const carriedBy = new Map();
      ctx.carry.get(r.productId).forEach((sid) => { const k = groupOfStore.get(sid); if (k !== undefined) carriedBy.set(k, (carriedBy.get(k) || 0) + 1); });
      if (!carriedBy.size) return;
      const unitsBy = new Map();
      (ctx.data.performance?.[r.productId] || []).forEach((rec) => {
        if (!ctx.win?.cur || rec.weekEnding < ctx.win.cur.start || rec.weekEnding > ctx.win.cur.end || !rec.storeId) return;
        const k = groupOfStore.get(rec.storeId);
        if (k !== undefined) unitsBy.set(k, (unitsBy.get(k) || 0) + (rec.units || 0));
      });
      carriedBy.forEach((n, k) => byKey.get(k).perItem.set(r.productId, (unitsBy.get(k) || 0) / (n * ctx.params.weeks)));
    });
    groups = [...byKey.values()].map((g) => ({ ...g, p25: quantile([...g.perItem.values()].sort((a, b) => a - b), 0.25) }));
  }

  const out = rows.map((r) => {
    const g = growthOf(r.cur.sales, r.base.sales);
    const groupVelocity = groups.map((gr) => ({ key: gr.key, label: gr.label, velocity: gr.perItem.has(r.productId) ? round(gr.perItem.get(r.productId), 2) : null, slow: gr.perItem.has(r.productId) && gr.perItem.get(r.productId) <= gr.p25 }));
    return {
      productId: r.productId, name: r.product.name, segment: r.path, stores: r.stores, planograms: r.planograms,
      units: r.cur.units, sales: round(r.cur.sales), margin: round(r.cur.margin),
      velocity: round(r.velocity, 2), salesPerStoreWeek: round(r.salesPerStoreWeek), spaceIn: round(r.space, 1), salesPerInchWeek: round(r.salesPerInchWeek, 2),
      growth: g, weeksOfData: r.cur.weeks.size, hasData: r.hasData, isNewItem: !!r.product.newItem,
      slowest: r.velocity <= p25 && (r.hasData || r.cur.units === 0),
      declining: g !== null && g <= -0.1,
      groupVelocity, slowIn: groupVelocity.filter((x) => x.slow).length, groupsCarried: groupVelocity.filter((x) => x.velocity !== null).length,
    };
  }).sort((a, b) => a.velocity - b.velocity || a.salesPerInchWeek - b.salesPerInchWeek || a.name.localeCompare(b.name));
  out.forEach((r, i) => { r.rank = i + 1; });
  return { rows: out, groupBy, groups: groups.map((g) => ({ key: g.key, label: g.label })), slowThreshold: round(p25, 2) };
}

// ---- 3. forecast for a new item ----------------------------------------------------------------------------

// Velocity (units per store per week) of any product in the scope, on the category's planograms or not.
export function velocityOfProduct(ctx, pid) {
  const known = ctx.items.find((r) => r.productId === pid);
  if (known) return { velocity: known.velocity, price: known.cur.units > 0 ? known.cur.sales / known.cur.units : 0, cost: known.cur.units > 0 ? known.cur.cost / known.cur.units : 0, hasData: known.hasData };
  const m = ctx.sum(pid, ctx.win?.cur, ctx.inScope);
  const stores = Math.max(1, m.stores.size);
  return { velocity: m.units / (stores * ctx.params.weeks), price: m.units > 0 ? m.sales / m.units : 0, cost: m.units > 0 ? m.cost / m.units : 0, hasData: m.weeks.size >= ctx.assumptions.minWeeksOfData };
}

// A new item's expected weekly units per store, its price and cost, and where those came from.
export function forecastFor(ctx, product) {
  const n = product.newItem || {};
  const proxies = (n.proxyProductIds || []).map((id) => {
    const p = ctx.productsById[id];
    const v = velocityOfProduct(ctx, id);
    return p && v.hasData && v.velocity > 0 ? { productId: id, name: p.name, velocity: round(v.velocity, 2), price: v.price, cost: v.cost } : null;
  }).filter(Boolean);
  const scale = Number.isFinite(Number(n.proxyScale)) && Number(n.proxyScale) > 0 ? Number(n.proxyScale) : 1;
  let unitsPerStoreWeek = null, basis = "none";
  if (Number(n.forecastUnitsPerStoreWeek) > 0) { unitsPerStoreWeek = Number(n.forecastUnitsPerStoreWeek); basis = "forecast"; }
  else if (proxies.length) { unitsPerStoreWeek = mean(proxies.map((p) => p.velocity)) * scale; basis = "similar items"; }
  const price = Number(n.retailPrice) > 0 ? Number(n.retailPrice) : mean(proxies.map((p) => p.price));
  const cost = Number(n.unitCost) > 0 ? Number(n.unitCost) : mean(proxies.map((p) => p.cost));
  const per = (units) => ({ sales: units * price, margin: units * (price - cost), units }[ctx.assumptions.metric]);
  return {
    productId: product.id, unitsPerStoreWeek: unitsPerStoreWeek === null ? null : round(unitsPerStoreWeek, 2), basis, proxies, proxyScale: scale,
    price: round(price), cost: round(cost), valuePerStoreWeek: unitsPerStoreWeek === null ? null : per(unitsPerStoreWeek),
    ready: unitsPerStoreWeek !== null && price > 0 && !n.dimsMissing,
    missing: unitsPerStoreWeek === null ? "Needs a forecast or a similar item with sales history" : price <= 0 ? "Needs a retail price" : n.dimsMissing ? "Needs its size (width, height, depth) to check it fits" : "",
  };
}

// ---- 4. SKU rationalization --------------------------------------------------------------------------------

const isShelf = (def) => def && def.type !== "Pegboard";

// Distinct products on a planogram that sit in each first-level segment (variety guard).
function segmentCounts(planogram, productsById, firstField) {
  const seen = new Map();
  (planogram.sections || []).forEach((s) => (s.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    const p = productsById[pl.productId]; if (!p) return;
    const seg = firstField ? segmentValue(p, firstField) : "all";
    if (!seen.has(seg)) seen.set(seg, new Set());
    seen.get(seg).add(p.id);
  })));
  return seen;
}

// Tries to put one facing of `product` on a shelf; returns the placement (with auto-stack height) or null.
function tryAdd(planogram, section, fixtureInst, def, placements, product, layoutProducts, fixtureDefs) {
  const placement = { id: uid("pl"), productId: product.id, facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" };
  const headroom = getShelfClearanceIn(planogram, section, fixtureInst, fixtureDefs);
  if (getStackHeightProblem(product, placement, layoutProducts, headroom)) return null;
  const high = getAutoStackHigh(product, placement, layoutProducts, headroom);
  if (high > 1) placement.high = high;
  placement.autoStack = true;
  const { boxes, totalWidth, widthIn } = layoutFixtureBoxes({ ...fixtureInst, placements: [...placements, placement] }, def, layoutProducts);
  if (boxes.some((b) => b.overflow)) return null;
  return { placement, remainder: widthIn - totalWidth, widthIn };
}


// ---- 4. core assortment -------------------------------------------------------------------------------------
// A core item is a staple: bought regularly and repeatedly, steady week to week, and part of the base of the
// category's sales. Tandom can measure those three from sales history (how many weeks it sells, how much weekly
// sales swing, and whether it is among the items that make up most of the category's sales). Whether an item is a
// necessity rather than an impulse or luxury buy cannot be read from sales, so a person can mark items core or not
// core. Price steadiness is shown as a sign of an everyday-priced item but does not decide anything, because
// competitors' prices are not in the data.

const median = (xs) => { if (!xs.length) return 0; const v = [...xs].sort((p, q) => p - q); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

// Average units of this category sold per store per week in a set of stores: how strong those stores are for it.
export function storeProductivity(ctx, storeIds) {
  if (!ctx._storeUnits) {
    const m = new Map();
    ctx.items.forEach((r) => (ctx.data.performance?.[r.productId] || []).forEach((rec) => {
      if (!ctx.win?.cur || rec.weekEnding < ctx.win.cur.start || rec.weekEnding > ctx.win.cur.end || !rec.storeId) return;
      m.set(rec.storeId, (m.get(rec.storeId) || 0) + (rec.units || 0));
    }));
    ctx._storeUnits = m;
  }
  const ids = [...storeIds];
  if (!ids.length) return 0;
  return ids.reduce((sum, id) => sum + (ctx._storeUnits.get(id) || 0), 0) / (ids.length * ctx.params.weeks);
}

export function coreProfile(ctx, { overrides = {} } = {}) {
  const a = ctx.assumptions;
  const weeks = ctx.params.weeks;
  const rows = ctx.items.filter((r) => r.product && !r.product.newItem);
  const storeById = Object.fromEntries((ctx.data.stores || []).map((st) => [st.id, st]));
  const catStores = new Set(ctx.pogs.flatMap((x) => x.storeIds));
  const formatOf = (sid) => (storeById[sid]?.format || "").trim() || "(none)";
  const formatTotals = new Map();
  catStores.forEach((sid) => { const f = formatOf(sid); formatTotals.set(f, (formatTotals.get(f) || 0) + 1); });
  const totalSales = rows.reduce((sum, r) => sum + r.cur.sales, 0);
  const cumBefore = new Map();
  let run = 0;
  [...rows].sort((x, y) => y.cur.sales - x.cur.sales).forEach((r) => { cumBefore.set(r.productId, totalSales > 0 ? run / totalSales : 1); run += r.cur.sales; });

  const out = rows.map((r) => {
    const carried = ctx.carry.get(r.productId) || new Set();
    const byWeek = new Map();
    const prices = [];
    if (ctx.win?.cur) {
      (ctx.data.performance?.[r.productId] || []).forEach((rec) => {
        if (rec.weekEnding < ctx.win.cur.start || rec.weekEnding > ctx.win.cur.end) return;
        const ok = rec.storeId ? ctx.scope.storeIds.has(rec.storeId) : ctx.scope.includeChain;
        if (!ok) return;
        byWeek.set(rec.weekEnding, (byWeek.get(rec.weekEnding) || 0) + (rec.units || 0));
        if ((rec.units || 0) > 0 && rec.price > 0) prices.push(rec.price);
      });
    }
    const perStore = Math.max(1, carried.size);
    const slots = [...byWeek.values()].map((u) => u / perStore);
    while (slots.length < weeks) slots.push(0);
    const mean = slots.reduce((sum, x) => sum + x, 0) / Math.max(1, slots.length);
    const sd = Math.sqrt(slots.reduce((sum, x) => sum + (x - mean) ** 2, 0) / Math.max(1, slots.length));
    const weeksSelling = Math.min(1, [...byWeek.values()].filter((u) => u > 0).length / weeks);
    const cv = mean > 0 ? sd / mean : null;
    const med = median(prices);
    const priceSteady = med > 0 ? prices.filter((x) => Math.abs(x - med) / med <= a.corePriceBand).length / prices.length : null;
    const share = totalSales > 0 ? r.cur.sales / totalSales : 0;
    const checks = {
      frequency: { ok: weeksSelling >= a.coreMinWeeksSelling, value: round(weeksSelling, 3) },
      steady: { ok: cv !== null && cv <= a.coreMaxCv, value: cv === null ? null : round(cv, 3) },
      baseline: { ok: r.cur.sales > 0 && (cumBefore.get(r.productId) ?? 1) < a.coreSalesShare, value: round(share, 4) },
    };
    const passes = Object.values(checks).filter((c) => c.ok).length;
    const auto = !r.hasData ? "unknown" : passes === 3 ? "core" : passes === 2 ? "near" : "not";
    const ov = overrides[r.productId];
    const cls = ov === "core" ? "core" : ov === "notcore" ? "not" : auto;
    const missingPogs = ctx.pogs.filter((x) => !(ctx.onPlanograms.get(r.productId) || new Set()).has(x.planogram.id));
    const coverage = catStores.size > 0 ? carried.size / catStores.size : 0;
    const carriedByFormat = new Map();
    carried.forEach((sid) => { const f = formatOf(sid); carriedByFormat.set(f, (carriedByFormat.get(f) || 0) + 1); });
    return {
      productId: r.productId, name: r.product.name, segment: r.path, cls, auto, override: ov === "core" || ov === "notcore" ? ov : null, hasData: r.hasData, checks,
      priceSteady: priceSteady === null ? null : round(priceSteady, 3),
      velocity: round(r.velocity, 2), sales: round(r.cur.sales), salesShare: round(share, 4),
      stores: carried.size, storesInView: catStores.size, coverage: round(coverage, 3),
      planograms: (ctx.onPlanograms.get(r.productId) || new Set()).size, planogramsInView: ctx.pogs.length,
      byFormat: [...formatTotals.entries()].map(([format, total]) => ({ format, carried: carriedByFormat.get(format) || 0, of: total, pct: round((carriedByFormat.get(format) || 0) / total, 3) })).sort((x, y) => x.format.localeCompare(y.format, undefined, { numeric: true, sensitivity: "base" })),
      missingPlanograms: missingPogs.map((x) => ({ planogramId: x.planogram.id, planogramName: x.planogram.name || "Untitled", stores: x.storeIds.length })),
      missingStores: catStores.size - carried.size,
      isGap: cls === "core" && coverage < a.coreMinCoverage && missingPogs.length > 0,
    };
  });
  const clsRank = { core: 0, near: 1, not: 2, unknown: 3 };
  out.sort((x, y) => (y.isGap - x.isGap) || (clsRank[x.cls] - clsRank[y.cls]) || y.sales - x.sales || x.name.localeCompare(y.name));
  const core = out.filter((r) => r.cls === "core");
  const summary = {
    items: out.length, core: core.length, near: out.filter((r) => r.cls === "near").length, notCore: out.filter((r) => r.cls === "not").length, unknown: out.filter((r) => r.cls === "unknown").length,
    coreShareOfSales: round(core.reduce((sum, r) => sum + r.salesShare, 0), 4),
    coreAvgCoverage: core.length ? round(core.reduce((sum, r) => sum + r.coverage, 0) / core.length, 3) : null,
    gaps: out.filter((r) => r.isGap).length,
  };
  return { rows: out, summary, thresholds: { weeksSelling: a.coreMinWeeksSelling, maxCv: a.coreMaxCv, salesShare: a.coreSalesShare, coverage: a.coreMinCoverage }, formats: [...formatTotals.entries()].map(([format, stores]) => ({ format, stores })) };
}

// What a core item is expected to sell where it is not carried yet: what it sells per store in the stores that carry it,
// scaled planogram by planogram by how strong the new stores are for this category compared with its current ones.
export function coreForecasts(ctx, ids) {
  const out = {};
  ids.forEach((id) => {
    const v = velocityOfProduct(ctx, id);
    const price = v.price, cost = v.cost;
    const value = { sales: v.velocity * price, margin: v.velocity * (price - cost), units: v.velocity }[ctx.assumptions.metric];
    out[id] = {
      productId: id, unitsPerStoreWeek: round(v.velocity, 2), basis: "measured where carried", proxies: [], proxyScale: 1,
      price: round(price), cost: round(cost), valuePerStoreWeek: value,
      ready: v.hasData && v.velocity > 0 && price > 0,
      missing: !v.hasData ? "Not enough weeks of sales to rely on" : v.velocity <= 0 ? "It has no sales in this period" : "It has no price in the sales data",
    };
  });
  return out;
}
export function coreValueScale(ctx) {
  return (product, planogram, storeIds) => {
    const here = storeProductivity(ctx, storeIds);
    const there = storeProductivity(ctx, ctx.carry.get(product.id) || []);
    if (!(here > 0) || !(there > 0)) return 1;
    return clamp(here / there, 0.25, 1.5);
  };
}

// Recommendations for the given new items. Options: exclude (Set of "itemId|planogramId"), protect (Set of product
// ids that may never be removed), maxPlanogramsPerItem (null = every planogram that comes out ahead).
export function recommend(ctx, newItemIds, options = {}) {
  const exclude = options.exclude || new Set();
  const protect = options.protect || new Set();
  const maxPer = options.maxPlanogramsPerItem || null;
  const a = ctx.assumptions;
  const tree = segmentTree(ctx);
  const firstField = ctx.levels[0] || null;
  const fixtureDefs = ctx.fixtures || [];
  const itemById = new Map(ctx.items.map((r) => [r.productId, r]));
  const perStoreValue = (r) => ctx.metricOf({ sales: r.salesPerStoreWeek, margin: r.marginPerStoreWeek, units: r.velocity }, a.metric);

  const work = {};
  ctx.pogs.forEach(({ planogram }) => { work[planogram.id] = { ...planogram, sections: JSON.parse(JSON.stringify(planogram.sections || [])) }; });
  const addedThisRun = new Set(); // products added by this plan are never removed by it
  const byPlanogram = {};
  const ensure = (pid) => (byPlanogram[pid] ||= { changes: [], skipped: [], notes: [] });

  const newProducts = newItemIds.map((id) => ctx.productsById[id]).filter(Boolean);
  const forecasts = new Map(newProducts.map((p) => [p.id, (options.forecastOverrides && options.forecastOverrides[p.id]) || forecastFor(ctx, p)]));
  const noun = options.kind === "core" ? "core item" : "new item";
  const order = [...newProducts].sort((x, y) => (forecasts.get(y.id).valuePerStoreWeek || 0) - (forecasts.get(x.id).valuePerStoreWeek || 0) || x.name.localeCompare(y.name));
  const results = [];

  order.forEach((product) => {
    const fc = forecasts.get(product.id);
    const itemPath = ctx.levels.map((fid) => segmentValue(product, fid));
    const seg = findSegment(tree, itemPath);
    const boost = seg ? clamp(((seg.spaceIndex ?? 100) - 100) / 200, -0.25, 0.5) + (seg.growth === null ? 0 : seg.growth > 0.05 ? 0.1 : seg.growth < -0.05 ? -0.1 : 0) : 0;
    const result = { productId: product.id, name: product.name, forecast: fc, segment: itemPath, segmentTrend: seg ? { trend: seg.trend, growth: seg.growth, spaceIndex: seg.spaceIndex, opportunity: seg.opportunity } : null, candidates: [] };
    results.push(result);

    ctx.pogs.forEach(({ planogram: orig, storeIds }) => {
      const pg = work[orig.id];
      const cand = { planogramId: orig.id, planogramName: orig.name || "Untitled", stores: storeIds.length, status: "", reason: "", removes: [], add: null, netPerStoreWeek: null, netNetworkWeek: null, score: null, variety: [] };
      result.candidates.push(cand);
      if (exclude.has(`${product.id}|${orig.id}`)) { cand.status = "excluded"; cand.reason = "Left out by you."; return; }
      const alreadyThere = (pg.sections || []).some((s) => (s.fixtures || []).some((fx) => (fx.placements || []).some((pl) => pl.productId === product.id)));
      if (alreadyThere) { cand.status = "already_carried"; cand.reason = "Already on this planogram."; return; }
      if (!fc.ready) { cand.status = "not_ready"; cand.reason = fc.missing; return; }

      const scale = options.valueScale ? options.valueScale(product, orig, storeIds) : 1; // e.g. these stores sell less of the category per store
      cand.scale = round(scale, 2);
      const gain = fc.valuePerStoreWeek * scale * (1 - a.cannibalization);
      const placedIds = new Set();
      (pg.sections || []).forEach((s) => (s.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => placedIds.add(pl.productId))));
      const layoutProducts = (ctx.data.products || []).filter((p) => placedIds.has(p.id) || p.id === product.id);
      const facingsOf = {};
      (pg.sections || []).forEach((s) => (s.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => { facingsOf[pl.productId] = (facingsOf[pl.productId] || 0) + (pl.facings || 1); })));
      const segCounts = segmentCounts(pg, ctx.productsById, firstField);
      const sameSeg = (p) => !firstField || segmentValue(p, firstField) === itemPath[0];

      let best = null; // { section, fixtureInst, add, removes, loss, sameSegCount }
      let sawShelf = false;
      (pg.sections || []).forEach((section) => (section.fixtures || []).forEach((fixtureInst) => {
        const def = fixtureDefs.find((f) => f.id === fixtureInst.fixtureId);
        if (!isShelf(def)) return;
        sawShelf = true;
        const placements = fixtureInst.placements || [];
        const sameSegCount = placements.filter((pl) => { const p = ctx.productsById[pl.productId]; return p && sameSeg(p); }).length;
        const direct = tryAdd(pg, section, fixtureInst, def, placements, product, layoutProducts, fixtureDefs);
        if (direct) {
          const cand2 = { section, fixtureInst, def, add: direct, removes: [], loss: 0, sameSegCount, remainder: direct.remainder };
          if (!best || best.removes.length > 0 || sameSegCount > best.sameSegCount || (sameSegCount === best.sameSegCount && cand2.remainder > best.remainder)) best = cand2;
          return;
        }
        if (best && best.removes.length === 0) return; // a no-removal spot already exists on this planogram
        // otherwise: which slowest items on this shelf would have to go?
        const removable = placements.map((pl) => {
          const p = ctx.productsById[pl.productId];
          const r = itemById.get(pl.productId);
          if (!p || protect.has(p.id) || addedThisRun.has(p.id)) return null;
          const share = (pl.facings || 1) / (facingsOf[p.id] || 1);
          const value = (r ? perStoreValue(r) : 0) * share;
          // variety guard: never remove the last item of a first-level segment unless the new item takes its place
          const left = segCounts.get(firstField ? segmentValue(p, firstField) : "all");
          if (firstField && !sameSeg(p) && left && left.size <= 1) return null;
          return { pl, p, r, value, velocity: r ? r.velocity : 0 };
        }).filter(Boolean).sort((x, y) => x.value - y.value || x.velocity - y.velocity || x.p.name.localeCompare(y.p.name));
        const taken = [];
        for (const cand3 of removable.slice(0, a.maxRemovalsPerAdd)) {
          taken.push(cand3);
          const takenIds = new Set(taken.map((t) => t.pl.id));
          const trial = tryAdd(pg, section, fixtureInst, def, placements.filter((pl) => !takenIds.has(pl.id)), product, layoutProducts, fixtureDefs);
          if (trial) {
            const loss = taken.reduce((s, t) => s + t.value * (1 - a.transfer), 0);
            if (!best || (best.removes.length > 0 && loss < best.loss)) best = { section, fixtureInst, def, add: trial, removes: [...taken], loss, sameSegCount, remainder: trial.remainder };
            break;
          }
        }
      }));

      if (!best) {
        cand.status = "no_room";
        cand.reason = !sawShelf ? "This planogram has no shelves to add to." : `No shelf has room, and removing up to ${a.maxRemovalsPerAdd} of the slowest items still would not make enough space (or the only items that could go are protected or the last in their segment).`;
        ensure(orig.id).skipped.push({ productId: product.id, productName: product.name, reason: cand.reason });
        return;
      }

      const net = gain - best.loss;
      const score = net * (1 + boost);
      cand.add = { sectionId: best.section.id, sectionName: best.section.name || "", fixtureInstId: best.fixtureInst.id, fixtureName: (best.def?.name || "Shelf"), placementId: best.add.placement.id, newHigh: best.add.placement.high || 1, spaceFreeIn: round(best.add.remainder + getPlacementSpaceIn(product, best.add.placement), 1), spaceNeededIn: round(getPlacementSpaceIn(product, best.add.placement), 1) };
      cand.removes = best.removes.map((t) => ({ placementId: t.pl.id, productId: t.p.id, name: t.p.name, valuePerStoreWeek: round(t.value), velocity: round(t.velocity, 2), sectionId: best.section.id, fixtureInstId: best.fixtureInst.id }));
      cand.netPerStoreWeek = round(net);
      cand.gainPerStoreWeek = round(gain);
      cand.lossPerStoreWeek = round(best.loss);
      cand.netNetworkWeek = round(net * storeIds.length);
      cand.score = round(score * storeIds.length);
      cand.metric = a.metric;
      const segHere = segCounts.get(firstField ? itemPath[0] : "all");
      if (firstField && !segHere) cand.variety.push(`Adds a segment this planogram doesn't carry yet: ${itemPath[0]}`);
      else if (firstField && segHere && best.removes.some((t) => !sameSeg(t.p))) cand.variety.push(`Trades ${best.removes.filter((t) => !sameSeg(t.p)).map((t) => segmentValue(t.p, firstField)).join(", ")} for ${itemPath[0]}`);
      cand._best = best; cand._net = net;
      cand.status = net > 0 ? "recommended" : "not_worth_it";
      cand.reason = net > 0
        ? `Forecast ${round(fc.unitsPerStoreWeek * scale, 2)} units/store/week (${fc.basis}${scale !== 1 ? `, adjusted x${round(scale, 2)} for how the stores on this planogram sell this category` : ""}) is worth ${round(gain)} per store per week after ${Math.round(a.cannibalization * 100)}% cannibalization${best.removes.length ? `, against ${round(best.loss)} given up by removing ${best.removes.map((t) => t.p.name).join(", ")}` : ", and it fits in existing free space"}.`
        : `Giving up ${round(best.loss)} per store per week to gain ${round(gain)} would lose ${round(-net)} per store per week.`;
    });

    // keep only the best planograms if a cap was asked for, then commit what remains to the working copies
    const ok = result.candidates.filter((c) => c.status === "recommended").sort((x, y) => y.score - x.score);
    ok.forEach((c, i) => { if (maxPer && i >= maxPer) { c.status = "not_worth_it"; c.reason = `Outside the top ${maxPer} planograms for this item. ${c.reason}`; } });
    result.candidates.filter((c) => c.status === "recommended").forEach((c) => {
      const best = c._best;
      const changes = [
        ...best.removes.map((t) => ({
          type: "delete", productId: t.p.id, productName: t.p.name, sectionId: best.section.id, fixtureInstId: best.fixtureInst.id, placementId: t.pl.id,
          reason: `Removed to make room for ${noun} ${product.name}: one of the slowest on this shelf (${round(t.velocity, 2)} units/store/week${t.r ? `, ${round(t.r.salesPerStoreWeek)} sales/store/week` : ""}).`,
        })),
        {
          type: "addProduct", productId: product.id, productName: product.name, sectionId: best.section.id, fixtureInstId: best.fixtureInst.id, placementId: best.add.placement.id,
          newFacings: 1, newHigh: best.add.placement.high || 1, autoStack: true,
          reason: `${noun === "core item" ? "Core item expansion" : "New item"} — ${c.reason}${c.variety.length ? ` ${c.variety.join(". ")}.` : ""}`,
        },
      ];
      work[c.planogramId] = { ...work[c.planogramId], sections: applyResetDraftChanges(work[c.planogramId].sections, changes) };
      addedThisRun.add(product.id);
      ensure(c.planogramId).changes.push(...changes);
    });
    result.candidates.forEach((c) => { delete c._best; delete c._net; });
    const rank = { recommended: 0, not_worth_it: 1, no_room: 2, excluded: 3, not_ready: 4, already_carried: 5 };
    result.candidates.sort((x, y) => (rank[x.status] ?? 9) - (rank[y.status] ?? 9) || (y.netNetworkWeek ?? -Infinity) - (x.netNetworkWeek ?? -Infinity) || x.planogramName.localeCompare(y.planogramName));
    result.recommendedCount = result.candidates.filter((c) => c.status === "recommended").length;
    result.totalNetNetworkWeek = round(result.candidates.filter((c) => c.status === "recommended").reduce((s, c) => s + c.netNetworkWeek, 0));
  });

  Object.keys(byPlanogram).forEach((pid) => {
    const g = byPlanogram[pid];
    if (!g.changes.length && !g.skipped.length) delete byPlanogram[pid];
  });
  const winText = ctx.win ? { startISO: ctx.win.cur.start, endISO: ctx.win.cur.end } : { startISO: null, endISO: null };
  return {
    items: results, byPlanogram, metric: a.metric, assumptions: a, windows: ctx.win, ...winText, lookbackWeeks: ctx.params.weeks,
    totals: { itemsRecommended: results.filter((r) => r.recommendedCount > 0).length, placements: results.reduce((s, r) => s + r.recommendedCount, 0), netNetworkWeek: round(results.reduce((s, r) => s + (r.totalNetNetworkWeek || 0), 0)) },
  };
}
