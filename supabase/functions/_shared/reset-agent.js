// Reset Drafting Agent — server-side logic (moved out of the browser bundle in Phase 2).
// Source of truth lives HERE; src/App.jsx no longer carries it. Shared geometry/performance
// helpers come from ./app-core.js, which is generated from src/App.jsx (scripts/sync-edge-core.mjs).
import { getAttrByLabel, getLatestWeekEnding, getCutoffISO, aggregateProductPerformanceRange, getPlacementSpaceIn, getEffectiveDims, layoutFixtureBoxes, getResetThreshold, getStackDims, getShelfClearanceIn, getStackHeightProblem, getStackDepthProblem, getAutoStackHigh, getDosTargetDays, getDaysOfSupply, getCasePackFill, DOS_EXCESS_FACTOR, uid } from "./app-core.js";

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

function computeResetDraft(planogram, products, fixtures, performance, productSchema, resetThresholds, lookbackWeeks, storeId, cache = createDraftCache(), dosTargets = []) {
  if (cache.latest === undefined) cache.latest = getLatestWeekEnding(performance);
  const latestISO = cache.latest;
  if (!latestISO) return { changes: [], skipped: [], notes: [], startISO: null, endISO: null, lookbackWeeks };
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
        placementRefs.push({ sectionId: section.id, section, fixtureInst, fixtureDef, placement });
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
        // No room for another facing WIDE — the other lever is stacking one more unit HIGH, which costs
        // no shelf width. Only taken when the taller stack still clears the shelf above (same rule the
        // editor enforces); otherwise it's skipped like before.
        const currentHigh = Math.max(1, Math.round(target.placement.high || 1));
        const taller = { ...target.placement, high: currentHigh + 1 };
        const clearance = getShelfClearanceIn(planogram, target.section, target.fixtureInst, fixtures);
        const alreadyOverflowing = layoutFixtureBoxes(target.fixtureInst, target.fixtureDef, placedProducts).boxes.some((b) => b.overflow);
        if (!alreadyOverflowing && !getStackHeightProblem(group.product, taller, placedProducts, clearance) && Number.isFinite(clearance)) {
          changes.push({
            type: "increaseHigh", productId: pid, productName: group.product.name,
            sectionId: target.sectionId, fixtureInstId: target.fixtureInst.id, placementId: target.placement.id,
            oldHigh: currentHigh, newHigh: currentHigh + 1,
            reason: `Stacked ${currentHigh + 1} high instead of ${currentHigh} — Sales/Space Index ${index.toFixed(0)} over the last ${lookbackWeeks} weeks (above ${high}); there is no room for another facing, but the taller stack (${getStackDims(group.product, taller, placedProducts).heightIn.toFixed(1)}in) fits under the shelf above.`,
          });
        } else {
          skipped.push({ productId: pid, productName: group.product.name, reason: `Sales/Space Index ${index.toFixed(0)} is a standout, but its fixture has no room for another facing${Number.isFinite(clearance) ? " or a taller stack" : ""}.` });
        }
      }
    }
  });

  // Days-of-supply and case-pack pass. The Sales/Space Index above decides who earns or loses space;
  // this pass checks the result against how long the shelf lasts. It can (1) cancel a reduction that
  // would leave a product short of its category's days-of-supply target, (2) add capacity where the
  // shelf runs short (stack higher first -- it costs no width -- then another facing), and (3) trim
  // a shelf holding far more than the target. Case packs only ever produce notes, never changes.
  const notes = [];
  const facingChangeFor = (placementId) => changes.find((c) => (c.type === "reduceFacings" || c.type === "increaseFacings") && c.placementId === placementId);
  const highChangeFor = (placementId) => changes.find((c) => (c.type === "reduceHigh" || c.type === "increaseHigh") && c.placementId === placementId);
  const dropChange = (c) => { if (c) changes.splice(changes.indexOf(c), 1); };
  productIds.forEach((pid) => {
    const group = groups[pid];
    const perf = perfByProduct[pid];
    const product = group.product;
    const target = [...group.refs].sort((a, b) => (b.placement.facings || 1) - (a.placement.facings || 1))[0];
    const pl = target.placement;
    const origFacings = pl.facings || 1;
    const origHigh = Math.max(1, Math.round(pl.high || 1));
    const origDeep = Math.max(1, Math.round(pl.deep || 1));
    const fc0 = facingChangeFor(pl.id);
    const hc0 = highChangeFor(pl.id);
    const state = { facings: fc0 ? fc0.newFacings : origFacings, high: hc0 ? hc0.newHigh : origHigh, deep: origDeep };
    const hadIncrease = (fc0 && fc0.type === "increaseFacings") || (hc0 && hc0.type === "increaseHigh");
    const otherUnits = group.refs.reduce((s, r) => (r === target ? s : s + getStackDims(product, r.placement, products).units), 0);
    const unitsAt = (st) => otherUnits + getStackDims(product, { ...pl, facings: st.facings, high: st.high > 1 ? st.high : undefined, deep: st.deep > 1 ? st.deep : undefined }, products).units;
    const weekly = perf.weeksOfData >= 4 ? perf.totalUnits / perf.weeksOfData : 0;
    const dosAt = (st) => getDaysOfSupply(unitsAt(st), weekly);
    const targetDays = weekly > 0 ? getDosTargetDays(planogram.category || "", dosTargets, product) : null;
    const dayStr = (n) => (Math.round(n * 10) / 10).toString();

    const writeFacings = (newF, reason) => {
      dropChange(facingChangeFor(pl.id));
      state.facings = newF;
      if (newF === origFacings) return;
      changes.push({
        type: newF > origFacings ? "increaseFacings" : "reduceFacings", productId: pid, productName: product.name,
        sectionId: target.sectionId, fixtureInstId: target.fixtureInst.id, placementId: pl.id,
        oldFacings: origFacings, newFacings: newF, reason,
      });
    };
    const writeHigh = (newH, reason) => {
      dropChange(highChangeFor(pl.id));
      state.high = newH;
      if (newH === origHigh) return;
      changes.push({
        type: newH > origHigh ? "increaseHigh" : "reduceHigh", productId: pid, productName: product.name,
        sectionId: target.sectionId, fixtureInstId: target.fixtureInst.id, placementId: pl.id,
        oldHigh: origHigh, newHigh: newH, reason,
      });
    };

    const writeDeep = (newD, reason) => {
      dropChange(changes.find((c) => c.type === "setDeep" && c.placementId === pl.id));
      state.deep = newD;
      if (newD === origDeep) return;
      changes.push({
        type: "setDeep", productId: pid, productName: product.name,
        sectionId: target.sectionId, fixtureInstId: target.fixtureInst.id, placementId: pl.id,
        oldDeep: origDeep, newDeep: newD, reason,
      });
    };
    const shelfDepth = target.fixtureDef?.dims?.d;
    const deepFits = (st, d) => !getStackDepthProblem(product, { ...pl, facings: st.facings, high: st.high > 1 ? st.high : undefined, deep: d > 1 ? d : undefined }, products, shelfDepth);

    if (targetDays) {
      // (1) an index-driven reduction that would starve the shelf is cancelled
      if (fc0 && fc0.type === "reduceFacings" && dosAt(state) < targetDays) {
        const dosWith = dosAt(state); // days of supply WITH the reduction applied
        writeFacings(origFacings);
        notes.push({ productId: pid, productName: product.name, kind: "dosKept", reason: `Kept at ${origFacings} facing${origFacings === 1 ? "" : "s"} -- the Sales/Space Index asked for fewer, but that would leave ${dayStr(dosWith)} days of supply against a ${targetDays}-day target.` });
      }
      // (2) short of the target: add capacity until it is reached or nothing fits
      const startDos = dosAt(state);
      if (startDos < targetDays) {
        const startFacings = state.facings, startHigh = state.high, startDeep = state.deep;
        for (let i = 0; i < 24 && dosAt(state) < targetDays; i++) {
          // deeper costs no width or height, so it comes first; then taller; another facing last
          if (state.deep < 60 && deepFits(state, state.deep + 1)) { state.deep += 1; continue; }
          const clearance = getShelfClearanceIn(planogram, target.section, target.fixtureInst, fixtures);
          const tallerPl = { ...pl, facings: state.facings, high: state.high + 1 };
          const canStack = !pl.autoStack && Number.isFinite(clearance) && !getStackHeightProblem(product, tallerPl, products, clearance) && state.high < 12;
          if (canStack) { state.high += 1; continue; }
          if (facingIncreaseFits(target.fixtureInst, target.fixtureDef, placedProducts, pl.id, state.facings + 1)) { state.facings += 1; continue; }
          break;
        }
        const endDos = dosAt(state);
        const gain = `${dayStr(startDos)} -> ${dayStr(endDos)} days of supply against a ${targetDays}-day target`;
        if (state.facings !== startFacings || state.high !== startHigh || state.deep !== startDeep) {
          const parts = [];
          if (state.deep !== startDeep) parts.push(`${state.deep} deep`);
          if (state.high !== startHigh) parts.push(`stacked ${state.high} high`);
          if (state.facings !== startFacings) parts.push(`${state.facings} facings`);
          const reason = `Increased to ${parts.join(" and ")} -- ${gain}.`;
          const f = state.facings, h = state.high, d = state.deep;
          writeFacings(f, reason);
          writeHigh(h, reason);
          writeDeep(d, reason);
        }
        if (endDos < targetDays) {
          skipped.push({ productId: pid, productName: product.name, reason: `Shelf holds ${dayStr(endDos)} days of supply against a ${targetDays}-day target, and there is no room for more depth, another facing or a taller stack.` });
        }
      } else if (!hadIncrease && !product.resetProtected && startDos > targetDays * DOS_EXCESS_FACTOR) {
        // (3) far more on the shelf than the target needs: trim while the target is still met
        const startFacings = state.facings, startHigh = state.high;
        for (let i = 0; i < 4 && dosAt(state) > targetDays * DOS_EXCESS_FACTOR; i++) {
          const next = state.high > 1 ? { ...state, high: state.high - 1 } : state.facings > 1 ? { ...state, facings: state.facings - 1 } : null;
          if (!next || dosAt(next) < targetDays) break;
          state.facings = next.facings; state.high = next.high;
        }
        if (state.facings !== startFacings || state.high !== startHigh) {
          const reason = `Reduced to ${state.high > 1 ? `${state.high} high x ` : ""}${state.facings} facing${state.facings === 1 ? "" : "s"} -- the shelf held ${dayStr(startDos)} days of supply, more than ${DOS_EXCESS_FACTOR}x the ${targetDays}-day target; now ${dayStr(dosAt(state))}.`;
          const f = state.facings, h = state.high;
          writeFacings(f, reason);
          writeHigh(h, reason);
        }
      }
    }

    // Case pack. A store orders and receives whole cases, and the industry-standard pack-out is a case
    // or a case and a half. A shelf that holds 14 units of a 12-pack leaves most of every delivery with
    // nowhere to go but the back room, where it gets damaged. Facings Deep costs no width or height, so
    // it is adjusted first to land on a whole or half number of cases (never under the days-of-supply
    // target, never past the shelf's depth).
    const fill = getCasePackFill(unitsAt(state), product.casePack);
    if (fill && !fill.exact) {
      const cp = fill.casePack;
      const currentUnits = unitsAt(state);
      const casesStr = (u) => `${Math.round((u / cp) * 100) / 100} case${u / cp === 1 ? "" : "s"}`;
      let best = null;
      for (let d = 1; d <= 60; d++) {
        const trial = { ...state, deep: d };
        if (!deepFits(trial, d)) break;
        const u = unitsAt(trial);
        if (!getCasePackFill(u, cp).exact) continue;
        if (targetDays && dosAt(trial) < targetDays) continue;
        if (!best || Math.abs(u - currentUnits) < Math.abs(best.units - currentUnits)) best = { deep: d, units: u };
      }
      if (best && best.deep !== state.deep) {
        writeDeep(best.deep, `Deep ${state.deep} -> ${best.deep}: the shelf held ${currentUnits} units of a ${cp}-unit case, which is not a case or half-case pack-out; it now holds ${best.units} (${casesStr(best.units)}), so a delivery goes on the shelf instead of the back room.`);
      } else if (currentUnits < cp) {
        skipped.push({ productId: pid, productName: product.name, reason: `Shelf holds only ${currentUnits} units but a case is ${cp}: every full-case delivery overflows the shelf. It needs more facings, height or depth (or a smaller case pack).` });
      } else {
        notes.push({
          productId: pid, productName: product.name, kind: "casePack",
          reason: `Shelf holds ${currentUnits} units (${casesStr(currentUnits)} of ${cp}), not a case or half-case pack-out, and no Deep setting lands on one. A ${fill.casesToFill}-case delivery would leave ${fill.casesToFill * cp - currentUnits} unit${fill.casesToFill * cp - currentUnits === 1 ? "" : "s"} with nowhere to go.`,
        });
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
        fixtureState[ref.fixtureInst.id] = { fixtureInst: ref.fixtureInst, fixtureDef: ref.fixtureDef, sectionId: ref.sectionId, section: ref.section, effectivePlacements };
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
          // a new product must also fit under the shelf above it (stack-aware, same rule as the editor)
          const headroom = getShelfClearanceIn(planogram, fs.section, fs.fixtureInst, fixtures);
          if (getStackHeightProblem(product, newPlacement, layoutProducts, headroom)) continue;
          // new products stack to the headroom on their own, like products added in the editor
          const autoHigh = getAutoStackHigh(product, newPlacement, layoutProducts, headroom);
          if (autoHigh > 1) newPlacement.high = autoHigh;
          newPlacement.autoStack = true;
          const trialFx = { ...fs.fixtureInst, placements: [...fs.effectivePlacements, newPlacement] };
          const { boxes, totalWidth, widthIn } = layoutFixtureBoxes(trialFx, fs.fixtureDef, layoutProducts);
          if (!boxes.some((b) => b.overflow)) {
            fs.effectivePlacements = [...fs.effectivePlacements, newPlacement];
            fs.remainder = widthIn - totalWidth;
            changes.push({
              type: "addProduct", productId: product.id, productName: product.name,
              sectionId: fs.sectionId, fixtureInstId: fs.fixtureInst.id, placementId: newPlacement.id,
              newFacings: 1, newHigh: autoHigh, autoStack: true,
              reason: `Added — a missing-winner performer ${scopeLabel} ($${Math.round(perf.totalSales).toLocaleString()} in sales over the last ${lookbackWeeks} weeks), not previously on this planogram.`,
            });
            break;
          }
        }
      });
    }
  }

  return { changes, skipped, notes, startISO, endISO, lookbackWeeks };
}

export { facingIncreaseFits, computeDraftScore, computeResetDraft, createDraftCache };
