// Reset Drafting Agent — server-side logic (moved out of the browser bundle in Phase 2).
// Source of truth lives HERE; src/App.jsx no longer carries it. Shared geometry/performance
// helpers come from ./app-core.js, which is generated from src/App.jsx (scripts/sync-edge-core.mjs).
import { getAttrByLabel, getLatestWeekEnding, getCutoffISO, aggregateProductPerformanceRange, getPlacementSpaceIn, getEffectiveDims, layoutFixtureBoxes, getResetThreshold, uid } from "./app-core.js";

// A trial facing increase is only kept if every placement on that fixture still fits —
// layoutFixtureBoxes already flags overflow per box, so re-running it on a cloned fixture
// instance with one placement's facings bumped is the cheapest reliable fit check available.
function facingIncreaseFits(fixtureInst, fixtureDef, products, placementId, newFacings) {
  const trialFx = {
    ...fixtureInst,
    placements: (fixtureInst.placements || []).map((pl) => (pl.id === placementId ? { ...pl, facings: newFacings } : pl)),
  };
  const { boxes } = layoutFixtureBoxes(trialFx, fixtureDef, products);
  return !boxes.some((b) => b.overflow);
}

// Draft Score (Phase 3): the share of everything the draft found worth touching that it was
// actually able to apply cleanly. Only items that warranted a look (a change, or a skip for a
// space/data reason) count toward the denominator — a planogram with nothing worth changing
// scores 100, not because it was "reviewed", but because nothing was skipped either.
function computeDraftScore(result) {
  const total = (result.changes?.length || 0) + (result.skipped?.length || 0);
  if (total === 0) return 100;
  return Math.round((result.changes.length / total) * 100);
}

// Work that is identical for every planogram in one request (same Performance snapshot, same
// product list, same window): the latest week, each product's window totals, and the ranked
// missing-winner candidates per category. A bulk call builds one cache and passes it to every
// computeResetDraft; without one, a fresh cache makes a single call behave exactly as before.
function createDraftCache() {
  return { latest: undefined, aggregates: new Map(), candidates: new Map() };
}

function computeResetDraft(planogram, products, fixtures, performance, productSchema, resetThresholds, lookbackWeeks, storeId, cache = createDraftCache()) {
  if (cache.latest === undefined) cache.latest = getLatestWeekEnding(performance);
  const latestISO = cache.latest;
  if (!latestISO) return { changes: [], skipped: [], startISO: null, endISO: null, lookbackWeeks };
  const endISO = latestISO;
  const startISO = getCutoffISO(latestISO, lookbackWeeks);
  const { low, high } = getResetThreshold(planogram.category || "", resetThresholds);
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));
  const aggregate = (pid) => {
    const key = `${pid}|${startISO}|${endISO}|${storeId || ""}`;
    let agg = cache.aggregates.get(key);
    if (!agg) { agg = aggregateProductPerformanceRange(pid, performance, startISO, endISO, storeId); cache.aggregates.set(key, agg); }
    return agg;
  };

  // every placement, with enough context to locate and mutate it later
  const placementRefs = [];
  (planogram.sections || []).forEach((section) => {
    (section.fixtures || []).forEach((fixtureInst) => {
      const fixtureDef = fixtures.find((f) => f.id === fixtureInst.fixtureId);
      (fixtureInst.placements || []).forEach((placement) => {
        placementRefs.push({ sectionId: section.id, fixtureInst, fixtureDef, placement });
      });
    });
  });

  // group by product — a product placed in more than one spot is judged once, as a whole
  const groups = {};
  let totalSpace = 0;
  placementRefs.forEach((ref) => {
    const product = productById[ref.placement.productId];
    if (!product) return;
    const space = getPlacementSpaceIn(product, ref.placement);
    totalSpace += space;
    if (!groups[ref.placement.productId]) groups[ref.placement.productId] = { product, refs: [], space: 0 };
    groups[ref.placement.productId].refs.push(ref);
    groups[ref.placement.productId].space += space;
  });

  const productIds = Object.keys(groups);
  const perfByProduct = {};
  productIds.forEach((pid) => {
    perfByProduct[pid] = aggregate(pid);
  });
  const totalSales = productIds.reduce((s, pid) => s + (perfByProduct[pid].totalSales || 0), 0);

  const changes = [];
  const skipped = [];
  const placedProducts = productIds.map((pid) => groups[pid].product); // all a facing-fit check can ever look up

  productIds.forEach((pid) => {
    const group = groups[pid];
    const perf = perfByProduct[pid];

    if (perf.weeksOfData < 4) {
      skipped.push({ productId: pid, productName: group.product.name, reason: `Fewer than 4 weeks of performance data in this window — left unchanged.` });
      return;
    }

    const isProtected = !!group.product.resetProtected;

    if (perf.totalUnits === 0) {
      if (isProtected) {
        skipped.push({ productId: pid, productName: group.product.name, reason: `Core / Must-Carry — zero units over this window would normally delete it, but it's protected.` });
        return;
      }
      group.refs.forEach((ref) => {
        changes.push({
          type: "delete", productId: pid, productName: group.product.name,
          sectionId: ref.sectionId, fixtureInstId: ref.fixtureInst.id, placementId: ref.placement.id,
          reason: `Deleted — zero units sold over the last ${lookbackWeeks} weeks.`,
        });
      });
      return;
    }

    const pctSpace = totalSpace > 0 ? (group.space / totalSpace) * 100 : 0;
    const pctSales = totalSales > 0 ? (perf.totalSales / totalSales) * 100 : 0;
    const index = pctSpace > 0 ? (pctSales / pctSpace) * 100 : (pctSales > 0 ? Infinity : 0);

    if (isProtected) {
      if (index < low) skipped.push({ productId: pid, productName: group.product.name, reason: `Core / Must-Carry — Sales/Space Index ${index.toFixed(0)} is below ${low}, but it's protected from facing reductions.` });
      return;
    }

    if (index < low) {
      const target = [...group.refs].sort((a, b) => (b.placement.facings || 1) - (a.placement.facings || 1))[0];
      const currentFacings = target.placement.facings || 1;
      if (currentFacings > 1) {
        changes.push({
          type: "reduceFacings", productId: pid, productName: group.product.name,
          sectionId: target.sectionId, fixtureInstId: target.fixtureInst.id, placementId: target.placement.id,
          oldFacings: currentFacings, newFacings: currentFacings - 1,
          reason: `Reduced from ${currentFacings} to ${currentFacings - 1} facings — Sales/Space Index ${index.toFixed(0)} over the last ${lookbackWeeks} weeks (below ${low}).`,
        });
      }
    } else if (index > high) {
      const target = [...group.refs].sort((a, b) => (b.placement.facings || 1) - (a.placement.facings || 1))[0];
      const currentFacings = target.placement.facings || 1;
      const newFacings = currentFacings + 1;
      if (facingIncreaseFits(target.fixtureInst, target.fixtureDef, placedProducts, target.placement.id, newFacings)) {
        changes.push({
          type: "increaseFacings", productId: pid, productName: group.product.name,
          sectionId: target.sectionId, fixtureInstId: target.fixtureInst.id, placementId: target.placement.id,
          oldFacings: currentFacings, newFacings,
          reason: `Increased from ${currentFacings} to ${newFacings} facings — Sales/Space Index ${index.toFixed(0)} over the last ${lookbackWeeks} weeks (above ${high}).`,
        });
      } else {
        skipped.push({ productId: pid, productName: group.product.name, reason: `Sales/Space Index ${index.toFixed(0)} is a standout, but its fixture has no room for another facing.` });
      }
    }
  });

  // Missing-winner additions: products not currently on this planogram, in the same Category,
  // performing well over the same window and at the same scope (store or chain-wide) as
  // everything above — dropped into whatever room the reductions/deletions just freed up.
  const planogramCategory = planogram.category || "";
  if (planogramCategory) {
    const placedProductIds = new Set(productIds);
    // Ranked once per (category, window, scope) and reused across planograms; each planogram then
    // only drops what it already carries. A stable sort's subsequence is that subset's own stable
    // sort, so this picks exactly the same ten candidates as ranking after filtering would.
    const candidateKey = `${planogramCategory}|${startISO}|${endISO}|${storeId || ""}`;
    let ranked = cache.candidates.get(candidateKey);
    if (!ranked) {
      ranked = products
        .filter((p) => getAttrByLabel(p, productSchema, ["category"]) === planogramCategory)
        .map((p) => ({ product: p, perf: aggregate(p.id) }))
        .filter((c) => c.perf.weeksOfData >= 4 && c.perf.totalUnits > 0)
        .sort((a, b) => b.perf.totalSales - a.perf.totalSales);
      cache.candidates.set(candidateKey, ranked);
    }
    const candidateScores = ranked.filter((c) => !placedProductIds.has(c.product.id)).slice(0, 10);

    if (candidateScores.length > 0) {
      const scopeLabel = storeId ? "this store" : "chain-wide";
      // effective per-fixture placement list — the reductions/deletions already decided above,
      // applied to a scratch copy so remaining room reflects the draft so far, not the original
      const fixtureState = {};
      placementRefs.forEach((ref) => {
        if (fixtureState[ref.fixtureInst.id]) return;
        const toDeleteIds = new Set(changes.filter((c) => c.type === "delete" && c.fixtureInstId === ref.fixtureInst.id).map((c) => c.placementId));
        const facingEditsLocal = {};
        changes.forEach((c) => { if ((c.type === "reduceFacings" || c.type === "increaseFacings") && c.fixtureInstId === ref.fixtureInst.id) facingEditsLocal[c.placementId] = c.newFacings; });
        const effectivePlacements = (ref.fixtureInst.placements || [])
          .filter((pl) => !toDeleteIds.has(pl.id))
          .map((pl) => (facingEditsLocal[pl.id] !== undefined ? { ...pl, facings: facingEditsLocal[pl.id] } : pl));
        fixtureState[ref.fixtureInst.id] = { fixtureInst: ref.fixtureInst, fixtureDef: ref.fixtureDef, sectionId: ref.sectionId, effectivePlacements };
      });

      // layoutFixtureBoxes looks products up by id for every placement; handing it only the
      // products that can appear here (placed + candidates) keeps each lookup tiny.
      const relevant = new Set([...placedProductIds, ...candidateScores.map((c) => c.product.id)]);
      const layoutProducts = products.filter((p) => relevant.has(p.id));

      const fixturesByRemainder = Object.values(fixtureState)
        .map((fs) => {
          const { boxes, totalWidth, widthIn } = layoutFixtureBoxes({ ...fs.fixtureInst, placements: fs.effectivePlacements }, fs.fixtureDef, layoutProducts);
          return { ...fs, remainder: boxes.some((b) => b.overflow) ? 0 : widthIn - totalWidth };
        })
        .filter((fs) => fs.remainder > 0.1)
        .sort((a, b) => b.remainder - a.remainder);

      candidateScores.forEach(({ product, perf }) => {
        for (const fs of fixturesByRemainder) {
          const newPlacement = { id: uid("pl"), productId: product.id, facings: 1, orientation: "front", rotation: 0, merchStyle: "unit" };
          const trialFx = { ...fs.fixtureInst, placements: [...fs.effectivePlacements, newPlacement] };
          const { boxes, totalWidth, widthIn } = layoutFixtureBoxes(trialFx, fs.fixtureDef, layoutProducts);
          if (!boxes.some((b) => b.overflow)) {
            fs.effectivePlacements = [...fs.effectivePlacements, newPlacement];
            fs.remainder = widthIn - totalWidth;
            changes.push({
              type: "addProduct", productId: product.id, productName: product.name,
              sectionId: fs.sectionId, fixtureInstId: fs.fixtureInst.id, placementId: newPlacement.id,
              newFacings: 1,
              reason: `Added — a missing-winner performer ${scopeLabel} ($${Math.round(perf.totalSales).toLocaleString()} in sales over the last ${lookbackWeeks} weeks), not previously on this planogram.`,
            });
            break;
          }
        }
      });
    }
  }

  return { changes, skipped, startISO, endISO, lookbackWeeks };
}

export { facingIncreaseFits, computeDraftScore, computeResetDraft, createDraftCache };
