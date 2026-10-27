// Major reset: re-lays a whole planogram from the items on it. Pure functions (no I/O), used by the draft-reset Edge Function.
//
// What it does, in order
//   1. Needs: each item's facings come from its days-of-supply target at the sales it makes (the same rule the space-fit check
//      uses); an item without a target or enough sales keeps the facings it has.
//   2. Size: if the needs don't fit the shelves, whole sections are added (as copies of an existing section, empty) up to
//      MAX_NEW_SECTIONS; otherwise facings are trimmed on the weakest earners before anything is left out.
//   3. Blocks: items group by the segment fields (decision order), the biggest-selling block first.
//   4. Shelves: sections run left to right; inside a section, shelves are filled nearest eye level first, so each block's best
//      sellers sit at eye level. An item goes on the first shelf that can take it (width and stack height checked with the same
//      rules the editor uses); one that will not fit anywhere at its target tries fewer facings.
//   5. Output: one `setLayout` change per shelf that changed (plus `addSection` for each new section), so the existing apply path
//      builds the new Work-in-Progress version. Items that cannot be placed anywhere are reported as skipped and would drop out
//      of the layout, so they are named loudly.
//
// Assumptions, stated rather than hidden: eye level is 60in from the base; fixtures that are pegboards or mounted on another
// fixture keep their contents; removing sections is only ever a note, never done.
import { getLatestWeekEnding, getCutoffISO, aggregateProductPerformanceRange, getPlacementSpaceIn, getStackDims, getDosTargetDays, layoutFixtureBoxes, getShelfClearanceIn, getStackHeightProblem, getAutoStackHigh, uid } from "./app-core.js";

export const MAJOR_DEFAULTS = { weeks: 13, eyeLevelIn: 60, fill: 0.95, minWeeks: 4, maxNewSections: 4 };

const round2 = (n) => Math.round(n * 100) / 100;

function eligibleShelves(planogram, fixtureDefs, sections) {
  const out = [];
  sections.forEach((section, si) => (section.fixtures || []).forEach((fx) => {
    const def = fixtureDefs.find((f) => f.id === fx.fixtureId);
    if (!def || def.type === "Pegboard" || fx.mountedOnId) return;
    out.push({ section, si, fx, def, widthIn: def.dims?.w || 24, topIn: (planogram.base || 0) + (fx.notchY || 0) + (def.dims?.h || 2) });
  }));
  return out;
}

// -> result in the same shape as the Reset Drafting Agent's, plus `movement` and `major`.
export function computeMajorReset(planogram, { products = [], fixtures = [], performance = {}, dosTargets = [], segmentFieldIds = [], weeks = MAJOR_DEFAULTS.weeks, allowResize = true } = {}) {
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const latest = getLatestWeekEnding(performance);
  const endISO = latest, startISO = latest ? getCutoffISO(latest, weeks) : null;
  const sections0 = planogram.sections || [];
  const shelves0 = eligibleShelves(planogram, fixtures, sections0);
  if (shelves0.length === 0) throw new Error("This planogram has no shelves a major reset can lay out");

  // ---- items ----------------------------------------------------------------------------------------------------------
  const groups = new Map();
  sections0.forEach((section) => (section.fixtures || []).forEach((fx) => (fx.placements || []).forEach((pl) => {
    const product = productById[pl.productId];
    if (!product) return;
    const g = groups.get(pl.productId) || { product, placements: [], facings: 0, fxIds: new Set(), anyEligible: false };
    g.placements.push({ pl, fx }); g.facings += pl.facings || 1; g.fxIds.add(fx.id);
    groups.set(pl.productId, g);
  })));
  const eligibleFxIds = new Set(shelves0.map((s) => s.fx.id));
  // items on shelves a major reset does not touch (pegboards, mounted fixtures) stay where they are and are not re-laid
  const items = [];
  groups.forEach((g, pid) => {
    if (![...g.fxIds].some((id) => eligibleFxIds.has(id))) return;
    const base = [...g.placements].filter((x) => eligibleFxIds.has(x.fx.id)).sort((a, b) => (b.pl.facings || 1) - (a.pl.facings || 1))[0].pl;
    const eligibleFacings = g.placements.filter((x) => eligibleFxIds.has(x.fx.id)).reduce((s, x) => s + (x.pl.facings || 1), 0);
    const one = { ...base, facings: 1 };
    const perFacingIn = getPlacementSpaceIn(g.product, one);
    const unitsPerFacing = getStackDims(g.product, one, products).units;
    const agg = latest ? aggregateProductPerformanceRange(pid, performance, startISO, endISO, null) : { weeksOfData: 0, totalUnits: 0, totalSales: 0 };
    const weekly = agg.weeksOfData >= MAJOR_DEFAULTS.minWeeks ? agg.totalUnits / agg.weeksOfData : 0;
    const target = weekly > 0 ? getDosTargetDays(planogram.category || "", dosTargets, g.product) : null;
    let facings = eligibleFacings, basis = "current";
    if (target && unitsPerFacing > 0) {
      const needed = Math.max(1, Math.ceil((weekly / 7) * target / unitsPerFacing));
      facings = Math.min(needed, Math.max(eligibleFacings * 2, eligibleFacings + 2)); // never more than double in one reset
      basis = "days of supply";
    }
    const path = segmentFieldIds.length ? segmentFieldIds.map((id) => String(g.product.attributes?.[id] ?? "").trim() || "Other") : ["All"];
    items.push({ pid, product: g.product, base, perFacingIn, facings, startFacings: eligibleFacings, basis, sales: agg.totalSales || 0, weekly, path, protectedItem: !!g.product.resetProtected, oldFxIds: g.fxIds });
  });

  // ---- size: add sections if the needs do not fit, else trim the weakest ---------------------------------------------
  const skipped = [];
  const notes = [];
  const capacityOf = (shelves) => shelves.reduce((s, x) => s + x.widthIn, 0);
  const needOf = () => items.reduce((s, i) => s + i.facings * i.perFacingIn, 0);
  const addedSections = [];
  let sections = sections0;
  let shelves = shelves0;
  const sectionTemplate = (() => { const last = [...sections0].reverse().find((sec) => (sec.fixtures || []).some((fx) => eligibleFxIds.has(fx.id))); return last; })();
  const addSection = () => {
    const after = sections[sections.length - 1];
    const copy = { ...JSON.parse(JSON.stringify(sectionTemplate)), id: uid("sec"), name: undefined };
    copy.fixtures = (sectionTemplate.fixtures || []).filter((fx) => eligibleFxIds.has(fx.id)).map((fx) => ({ ...JSON.parse(JSON.stringify(fx)), id: uid("fx"), placements: [] }));
    delete copy.name;
    sections = [...sections, copy];
    addedSections.push({ afterSectionId: after.id, section: copy });
    shelves = eligibleShelves(planogram, fixtures, sections);
  };
  if (allowResize) {
    const perSection = capacityOf(shelves0) / Math.max(1, new Set(shelves0.map((s) => s.si)).size);
    while (addedSections.length < MAJOR_DEFAULTS.maxNewSections && needOf() > capacityOf(shelves) * MAJOR_DEFAULTS.fill && perSection > 0) addSection();
  }
  // trim facings on the lowest sales-per-inch first, then (only if still over) leave out the weakest unprotected items
  const density = (i) => (i.sales / Math.max(1, i.facings * i.perFacingIn));
  let guard = 0;
  while (needOf() > capacityOf(shelves) * MAJOR_DEFAULTS.fill && guard++ < 5000) {
    const trim = items.filter((i) => i.facings > 1 && !i.protectedItem).sort((a, b) => density(a) - density(b) || a.pid.localeCompare(b.pid))[0];
    if (trim) { trim.facings -= 1; continue; }
    const drop = items.filter((i) => !i.protectedItem).sort((a, b) => a.sales - b.sales || a.pid.localeCompare(b.pid))[0];
    if (!drop) break;
    items.splice(items.indexOf(drop), 1);
    skipped.push({ productId: drop.pid, productName: drop.product.name, reason: "No room in the new layout even at one facing. It would drop off the planogram if this draft is approved; add a section or protect another item to keep it." });
  }

  // ---- blocks and order ------------------------------------------------------------------------------------------------
  const blockKey = (i) => i.path.join(" › ");
  const blockSales = new Map();
  items.forEach((i) => blockSales.set(blockKey(i), (blockSales.get(blockKey(i)) || 0) + i.sales));
  const ordered = [...items].sort((a, b) => (blockSales.get(blockKey(b)) - blockSales.get(blockKey(a))) || blockKey(a).localeCompare(blockKey(b)) || b.sales - a.sales || a.product.name.localeCompare(b.product.name));

  // ---- shelves in fill order: section by section, eye level first within a section ---------------------------------------
  const eye = MAJOR_DEFAULTS.eyeLevelIn;
  const slots = [...shelves].sort((a, b) => a.si - b.si || Math.abs(a.topIn - eye) - Math.abs(b.topIn - eye) || b.topIn - a.topIn).map((s) => ({ ...s, placed: [] }));
  const layoutProducts = products;
  const tryPlace = (slot, item, facings) => {
    const pl = { ...item.base, facings };
    delete pl.high; delete pl.autoStack;
    const headroom = getShelfClearanceIn(planogram, slot.section, slot.fx, fixtures);
    if (getStackHeightProblem(item.product, pl, layoutProducts, headroom)) return null;
    const high = getAutoStackHigh(item.product, pl, layoutProducts, headroom);
    if (item.base.high > 1 && !item.base.autoStack) { // an explicit stack height the editor accepted before: keep it if it still clears
      const keep = { ...item.base, facings };
      if (!getStackHeightProblem(item.product, keep, layoutProducts, headroom)) { pl.high = item.base.high; }
      else if (high > 1) { pl.high = high; pl.autoStack = true; }
    } else {
      if (high > 1) pl.high = high;
      pl.autoStack = true;
    }
    const trial = [...slot.placed, pl];
    const { boxes } = layoutFixtureBoxes({ ...slot.fx, placements: trial }, slot.def, layoutProducts);
    if (boxes.some((b) => b.overflow)) return null;
    return pl;
  };
  let pointer = 0;
  const unplaced = [];
  ordered.forEach((item) => {
    for (let f = item.facings; f >= 1; f--) {
      const order = [...slots.keys()].filter((k) => k >= pointer).concat([...slots.keys()].filter((k) => k < pointer));
      for (const k of order) {
        const pl = tryPlace(slots[k], item, f);
        if (pl) { slots[k].placed.push(pl); item.placedSlot = slots[k].fx.id; item.placedFacings = f; pointer = Math.max(pointer, k); return; }
      }
    }
    unplaced.push(item);
  });
  unplaced.forEach((i) => skipped.push({ productId: i.pid, productName: i.product.name, reason: "Does not fit on any shelf of the new layout (width or stack height). It would drop off the planogram if this draft is approved." }));

  // ---- changes -------------------------------------------------------------------------------------------------------------
  const changes = [];
  addedSections.forEach((a) => changes.push({ type: "addSection", afterSectionId: a.afterSectionId, section: a.section, productName: `New section after ${a.afterSectionId}`, reason: "Added so the items fit at their days-of-supply facings." }));
  const oldPlacementsByFx = new Map();
  sections0.forEach((section) => (section.fixtures || []).forEach((fx) => oldPlacementsByFx.set(fx.id, fx.placements || [])));
  slots.forEach((slot) => {
    const before = oldPlacementsByFx.get(slot.fx.id) || [];
    const sameAsBefore = before.length === slot.placed.length && before.every((pl, i) => pl.productId === slot.placed[i].productId && (pl.facings || 1) === (slot.placed[i].facings || 1));
    if (sameAsBefore) return;
    const names = slot.placed.map((pl) => productById[pl.productId]?.name).filter(Boolean);
    changes.push({
      type: "setLayout", sectionId: slot.section.id, fixtureInstId: slot.fx.id, placements: slot.placed,
      productName: `${slot.def.name || "Shelf"} at ${Math.round(slot.fx.notchY || 0)}in, section ${slot.si + 1}`,
      reason: `${before.length} item${before.length === 1 ? "" : "s"} become ${slot.placed.length}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}.`,
    });
  });
  // a fixture that was eligible but ends up with nothing, and had something, still needs an (empty) layout so the old items go
  const slotFx = new Set(slots.map((s) => s.fx.id));
  shelves0.forEach((s) => { if (!slotFx.has(s.fx.id) && (oldPlacementsByFx.get(s.fx.id) || []).length) changes.push({ type: "setLayout", sectionId: s.section.id, fixtureInstId: s.fx.id, placements: [], productName: "Shelf cleared", reason: "Nothing assigned to this shelf." }); });

  // ---- movement summary --------------------------------------------------------------------------------------------------------
  const placed = ordered.filter((i) => i.placedSlot);
  const moved = placed.filter((i) => !i.oldFxIds.has(i.placedSlot)).length;
  const facingsChanged = placed.filter((i) => i.placedFacings !== i.startFacings).length;
  const blocks = [...blockSales.entries()].map(([path, sales]) => ({ path, sales: round2(sales), items: ordered.filter((i) => blockKey(i) === path).length })).sort((a, b) => b.sales - a.sales);
  const shrinkNote = (allowResize ? [] : [needOf() > capacityOf(shelves) ? "Sizes were not changed (resizing off); facings were trimmed to fit." : ""]).filter(Boolean);
  shrinkNote.forEach((reason) => notes.push({ productName: "Size", reason }));
  const emptySections = new Set(shelves0.map((s) => s.si));
  sections0.forEach((sec, si) => { if (emptySections.has(si) && slots.filter((s) => s.section.id === sec.id).every((s) => s.placed.length === 0)) notes.push({ productName: `Section ${si + 1}`, reason: "Ends up empty: the assortment fits in fewer sections. Removing it is left to you." }); });

  return {
    changes, skipped, notes, startISO, endISO, lookbackWeeks: weeks,
    movement: { items: placed.length, moved, unchanged: placed.length - moved, facingsChanged, pctMoved: placed.length ? round2((moved / placed.length) * 100) : 0, unplaced: unplaced.length, trimmedOut: skipped.length - unplaced.length },
    major: { sectionsAdded: addedSections.length, blocks, eyeLevelIn: eye },
  };
}
