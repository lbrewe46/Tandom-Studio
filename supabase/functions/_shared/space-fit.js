// Space fit: does a planogram's fixture space match what its assortment needs? Pure functions (browser and Edge Function).
//
// "Needed" is the shelf width the items require to hold their category's days-of-supply target at the sales they actually
// make (the same blended per-store weekly rate the reset agent uses): enough facings for each item, at its current stack
// height and depth. An item without a target or without enough sales keeps the facings it has. Capacity is the width of every
// shelf in the planogram. The recommendation is in whole sections of the planogram's usual section width, because that is
// how fixtures are bought and set, and only changes when the gap is at least a whole section.
import { getLatestWeekEnding, getCutoffISO, aggregateProductPerformanceRange, getPlacementSpaceIn, getStackDims, getDosTargetDays } from "./app-core.js";

const round1 = (n) => Math.round(n * 10) / 10;

export const FIT_DEFAULTS = { weeks: 13, fill: 0.95, minWeeks: 4 };

// -> { ok, capacityIn, neededIn, usedIn, utilization, sectionCount, sectionWidthIn, sectionsNeeded, action, delta, reason, items }
export function spaceFit(planogram, { products = [], fixtures = [], performance = {}, dosTargets = [], weeks = FIT_DEFAULTS.weeks, fill = FIT_DEFAULTS.fill, cache } = {}) {
  const productById = cache?.productById || Object.fromEntries(products.map((p) => [p.id, p]));
  const fixtureById = Object.fromEntries(fixtures.map((f) => [f.id, f]));
  const latest = cache?.latest !== undefined ? cache.latest : getLatestWeekEnding(performance);
  if (cache && cache.latest === undefined) cache.latest = latest;
  const endISO = latest, startISO = latest ? getCutoffISO(latest, weeks) : null;
  const sections = planogram.sections || [];
  if (sections.length === 0) return { ok: false, reason: "This planogram has no sections." };

  const widths = [];
  let capacityIn = 0;
  sections.forEach((sec) => {
    (sec.fixtures || []).forEach((fx) => {
      const w = Number(sec.width) || Number(fixtureById[fx.fixtureId]?.dims?.w) || 0;
      capacityIn += w;
    });
    if (Number(sec.width) > 0) widths.push(Number(sec.width));
  });
  if (capacityIn <= 0) return { ok: false, reason: "The fixtures have no width to measure." };
  // the planogram's usual section width (most common)
  const tally = new Map();
  widths.forEach((w) => tally.set(w, (tally.get(w) || 0) + 1));
  const sectionWidthIn = widths.length ? [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0] : 48;
  const sectionCount = sections.length;
  const capacityPerSection = capacityIn / sectionCount;

  const groups = new Map();
  sections.forEach((sec) => (sec.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    const product = productById[pl.productId];
    if (!product) return;
    const g = groups.get(pl.productId) || { product, placements: [], facings: 0, usedIn: 0 };
    g.placements.push(pl); g.facings += pl.facings || 1; g.usedIn += getPlacementSpaceIn(product, pl);
    groups.set(pl.productId, g);
  })));

  let usedIn = 0, neededIn = 0;
  const items = [];
  groups.forEach((g, pid) => {
    const first = g.placements[0];
    const oneFacing = { ...first, facings: 1 };
    const perFacingIn = getPlacementSpaceIn(g.product, oneFacing);
    const unitsPerFacing = getStackDims(g.product, oneFacing, products).units;
    const agg = latest ? aggregateProductPerformanceRange(pid, performance, startISO, endISO, null) : { weeksOfData: 0, totalUnits: 0 };
    const weekly = agg.weeksOfData >= FIT_DEFAULTS.minWeeks ? agg.totalUnits / agg.weeksOfData : 0;
    const target = weekly > 0 ? getDosTargetDays(planogram.category || "", dosTargets, g.product) : null;
    let neededFacings = g.facings, basis = "current";
    if (target && unitsPerFacing > 0) { neededFacings = Math.max(1, Math.ceil((weekly / 7) * target / unitsPerFacing)); basis = "days of supply"; }
    usedIn += g.usedIn;
    const need = neededFacings * perFacingIn;
    neededIn += need;
    items.push({ productId: pid, name: g.product.name, facings: g.facings, neededFacings, basis });
  });

  const usable = capacityPerSection * fill;
  const sectionsNeeded = Math.max(1, Math.ceil(neededIn / usable - 1e-9));
  const delta = sectionsNeeded - sectionCount;
  const action = delta > 0 ? "add" : delta < 0 ? "remove" : "ok";
  const basedOn = items.filter((i) => i.basis === "days of supply").length;
  const inch = (n) => `${Math.round(n)}in`;
  let reason;
  if (action === "add") reason = `At the days-of-supply targets the items need about ${inch(neededIn)} of shelf; the planogram has ${inch(capacityIn)} in ${sectionCount} section${sectionCount === 1 ? "" : "s"}. ${sectionsNeeded} sections of ${inch(sectionWidthIn)} would fit them.`;
  else if (action === "remove") reason = `The items need about ${inch(neededIn)} of ${inch(capacityIn)}. ${sectionsNeeded} section${sectionsNeeded === 1 ? "" : "s"} of ${inch(sectionWidthIn)} would hold them, so ${-delta} section${-delta === 1 ? " is" : "s are"} over-sized.`;
  else reason = `The items need about ${inch(neededIn)} of ${inch(capacityIn)}; the planogram is the right size.`;
  if (basedOn === 0) reason += " (No days-of-supply targets matched these items, so this is based on the facings they have now.)";
  return {
    ok: true, capacityIn: round1(capacityIn), usedIn: round1(usedIn), neededIn: round1(neededIn), utilization: round1((neededIn / capacityIn) * 100) / 100,
    sectionCount, sectionWidthIn, sectionsNeeded, action, delta, reason, items, basedOnItems: basedOn,
  };
}

export const createFitCache = () => ({ latest: undefined, productById: null });
