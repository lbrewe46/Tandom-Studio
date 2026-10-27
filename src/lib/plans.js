// Assortment plans: pure helpers (no React, no network) so the rules can be tested on their own.

export const PLAN_STATUSES = [
  ["draft", "Draft"], ["shared", "Shared for review"], ["approved", "Approved"], ["scheduled", "Scheduled"], ["executed", "Executed"], ["cancelled", "Cancelled"],
];
export const planStatusLabel = (s) => (PLAN_STATUSES.find(([k]) => k === s) || [s, s])[1];

// One plan line from a proposal's change set: what is added, removed and re-faced on that planogram.
export function planItemFromProposal(proposal, planogramName) {
  const changes = proposal?.proposed_change?.changes || [];
  const names = (type) => changes.filter((c) => c.type === type).map((c) => c.productName || c.productId);
  const a = proposal?.proposed_change?.assortment || {};
  return {
    proposalId: proposal.id,
    planogramId: proposal.target_id,
    planogramName: planogramName || proposal.target_id,
    adds: names("addProduct"),
    removes: names("delete"),
    facings: changes.filter((c) => c.type === "increaseFacings" || c.type === "reduceFacings").length,
    // what the assortment engine expected this to be worth (absent on drafts made before it was recorded)
    impact: a.impact ? { metric: a.impact.metric, net: a.impact.netNetworkWeek, items: a.impact.items || [] } : null,
    kind: a.kind || null,
    window: proposal?.proposed_change?.startISO ? { startISO: proposal.proposed_change.startISO, endISO: proposal.proposed_change.endISO } : null,
    assumptions: a.assumptions || null,
  };
}

export function planTotals(items) {
  const list = items || [];
  return {
    planograms: new Set(list.map((i) => i.planogramId)).size,
    adds: list.reduce((n, i) => n + (i.adds || []).length, 0),
    removes: list.reduce((n, i) => n + (i.removes || []).length, 0),
    facings: list.reduce((n, i) => n + (i.facings || 0), 0),
  };
}

// Approved proposals still free to go into a new plan: not already in a live (not cancelled) plan, optionally for one category.
export function proposalsAvailableForPlan(proposals, plans, { category, planogramById } = {}) {
  const taken = new Set((plans || []).filter((p) => p.status !== "cancelled").flatMap((p) => p.proposal_ids || []));
  return (proposals || []).filter((p) => {
    if (taken.has(p.id)) return false;
    if (category && planogramById && planogramById[p.target_id]?.category !== category) return false;
    return true;
  });
}

// Flat rows for the Excel/CSV download.
export function planRows(plan) {
  const rows = [];
  (plan.items || []).forEach((i) => {
    (i.adds || []).forEach((n) => rows.push({ Planogram: i.planogramName, Action: "Add", Item: n }));
    (i.removes || []).forEach((n) => rows.push({ Planogram: i.planogramName, Action: "Remove", Item: n }));
    if (i.facings) rows.push({ Planogram: i.planogramName, Action: "Facings changes", Item: `${i.facings} item${i.facings === 1 ? "" : "s"}` });
  });
  return rows;
}

// The date columns: a plan is "late" when it is still not executed past its effective date, "review due" past review_by.
export function planDateFlags(plan, todayISO) {
  const open = !["executed", "cancelled"].includes(plan.status);
  return {
    late: open && !!plan.effective_date && plan.effective_date < todayISO,
    reviewDue: open && !!plan.review_by && plan.review_by <= todayISO,
  };
}

export const planLink = (origin, id) => `${origin}/#plan=${encodeURIComponent(id)}`;
export function planIdFromHash(hash) {
  const m = /(?:^|[#&])plan=([^&]+)/.exec(String(hash || ""));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}


// ---- Inputs the pack draws from the retailer's data (computed in the app, passed to buildPack as options) ---------------
// First-level segments of a segment tree -> rows for the "category context" slide.
export function contextRows(tree, max = 8) {
  const pct = (x) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`);
  return (tree?.nodes || []).slice(0, max).map((n) => ({
    segment: n.label, sales: pct(n.shareOfCategorySales), space: pct(n.shareOfCategorySpace),
    growth: n.growth === null || n.growth === undefined ? "n/a" : `${n.growth >= 0 ? "+" : ""}${(n.growth * 100).toFixed(1)}%`,
    index: n.spaceIndex === null || n.spaceIndex === undefined ? "n/a" : String(n.spaceIndex), note: n.opportunity || n.spaceNote || "",
  }));
}

// Which kinds of store the plan's changes land on: planograms, stores and items added, grouped by a store field (format, region...).
// `planogramFor(item)` returns the planogram (or null); stores come from planogram.storeIds.
export function storeGroups(items, planogramFor, storesById, key = "format") {
  const groups = new Map();
  (items || []).forEach((it) => {
    const pg = planogramFor(it);
    if (!pg) return;
    const seen = new Set();
    (pg.storeIds || []).forEach((sid) => {
      const label = String(storesById[sid]?.[key] || "").trim() || "(not set)";
      const g = groups.get(label) || { group: label, stores: new Set(), planograms: new Set(), adds: 0 };
      if (!g.stores.has(sid)) g.stores.add(sid);
      g.planograms.add(pg.id);
      if (!seen.has(label)) { g.adds += (it.adds || []).length; seen.add(label); }
      groups.set(label, g);
    });
  });
  return [...groups.values()].map((g) => ({ group: g.group, stores: g.stores.size, planograms: g.planograms.size, adds: g.adds })).sort((a, b) => b.stores - a.stores || a.group.localeCompare(b.group));
}

// Low / base / high: what the plan is worth if the forecasts land `swing` below or above the estimate. Only possible when the
// drafts recorded the gain and the loss separately; otherwise null.
export function scenarioRange(items, swing = 0.25) {
  let base = 0, low = 0, high = 0, n = 0, total = 0;
  (items || []).forEach((it) => (it.impact?.items || []).forEach((e) => {
    total++;
    if (!Number.isFinite(e.gainNetworkWeek) || !Number.isFinite(e.lossNetworkWeek)) return;
    n++;
    base += e.gainNetworkWeek - e.lossNetworkWeek;
    low += e.gainNetworkWeek * (1 - swing) - e.lossNetworkWeek;
    high += e.gainNetworkWeek * (1 + swing) - e.lossNetworkWeek;
  }));
  return n && n === total ? { swing, low, base, high } : null;
}

// ---- Presentation pack: what a manufacturer shows a buyer --------------------------------------------------------------
// buildPack turns a plan into slide content (plain data, no layout), so the numbers can be tested and any renderer can draw them.
// Options: { preparedBy, preparedFor, hideRemovedNames, notes }. Competitor names are never invented: with hideRemovedNames the
// items that make room appear as "Item on the same shelf" with their sales rate only.
const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
export function fmtImpact(metric, n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "not recorded";
  return metric === "units" ? `${Math.round(n).toLocaleString("en-US")} units` : money(n);
}
const metricWord = (m) => ({ sales: "sales", margin: "margin", units: "unit sales" }[m] || "sales");

export function buildPack(plan, options = {}) {
  const items = plan.items || [];
  const t = planTotals(items);
  const withImpact = items.filter((i) => i.impact && Number.isFinite(i.impact.net));
  const metric = withImpact[0]?.impact.metric || "sales";
  const totalNet = withImpact.reduce((sum, i) => sum + i.impact.net, 0);
  const recorded = withImpact.length === items.length && items.length > 0;
  const a = items.find((i) => i.assumptions)?.assumptions || null;
  const win = items.find((i) => i.window)?.window || null;
  const slides = [];
  slides.push({ kind: "title", title: plan.name, subtitle: plan.category ? `${plan.category} assortment recommendation` : "Assortment recommendation", preparedBy: options.preparedBy || "", preparedFor: options.preparedFor || "", date: plan.effective_date ? `Proposed effective ${plan.effective_date}` : "" });
  slides.push({
    kind: "ask", title: "The recommendation",
    tiles: [
      { label: "Planograms", value: String(t.planograms) }, { label: "Items added", value: String(t.adds) }, { label: "Items removed", value: String(t.removes) },
      { label: `Expected weekly ${metricWord(metric)}`, value: recorded ? fmtImpact(metric, totalNet) : withImpact.length ? `${fmtImpact(metric, totalNet)}*` : "n/a" },
    ],
    bullets: [
      `${t.adds} item${t.adds === 1 ? "" : "s"} added and ${t.removes} removed across ${t.planograms} planogram${t.planograms === 1 ? "" : "s"}${plan.effective_date ? `, effective ${plan.effective_date}` : ""}.`,
      recorded ? `Expected to add about ${fmtImpact(metric, totalNet)} of ${metricWord(metric)} a week once set (after the sales that move over from other items).` : withImpact.length ? `*Expected impact is recorded for ${withImpact.length} of ${items.length} planograms only.` : "Expected impact was not recorded for these drafts.",
      "Decision requested: approve the changes above for the dates shown.",
    ],
  });
  if (options.context && options.context.length) {
    slides.push({ kind: "context", title: "Category context", columns: ["Segment", "Share of sales", "Share of space", "Sales trend", "Space index", "Read"], rows: options.context.map((r) => [r.segment, r.sales, r.space, r.growth, r.index, r.note]),
      note: "Space index above 100 means the segment earns more than the space it has. Source: retailer sales for this category." });
  }
  // one row per planogram, paged
  const rows = items.map((i) => ({
    planogram: i.planogramName, adds: i.adds.join(", ") || "—",
    removes: (options.hideRemovedNames ? i.removes.map((_, k) => `Item ${k + 1} on the same shelf`) : i.removes).join(", ") || "—",
    net: i.impact ? fmtImpact(i.impact.metric, i.impact.net) : "not recorded",
  }));
  const PER = 7;
  for (let p = 0; p * PER < rows.length || p === 0; p++) {
    slides.push({ kind: "recs", title: rows.length > PER ? `Planogram changes (${p + 1} of ${Math.ceil(rows.length / PER)})` : "Planogram changes", columns: ["Planogram", "Add", "Make room by removing", `Weekly ${metricWord(metric)}`], rows: rows.slice(p * PER, (p + 1) * PER) });
  }
  // evidence: the items being added, what they are forecast at and on what basis
  const evidence = [];
  items.forEach((i) => (i.impact?.items || []).forEach((e) => evidence.push({
    item: e.name, planogram: i.planogramName, stores: e.stores,
    forecast: e.forecastUnitsPerStoreWeek === null || e.forecastUnitsPerStoreWeek === undefined ? "n/a" : `${e.forecastUnitsPerStoreWeek} units/store/wk`,
    basis: e.basis || "n/a", net: fmtImpact(i.impact.metric, e.netNetworkWeek),
  })));
  if (evidence.length) {
    for (let p = 0; p * 8 < evidence.length; p++) slides.push({ kind: "evidence", title: evidence.length > 8 ? `Why these items (${p + 1} of ${Math.ceil(evidence.length / 8)})` : "Why these items", columns: ["Item", "Planogram", "Stores", "Forecast", "Basis", "Weekly"], rows: evidence.slice(p * 8, (p + 1) * 8).map((e) => [e.item, e.planogram, String(e.stores), e.forecast, e.basis, e.net]) });
  }
  if (options.byGroup && options.byGroup.rows.length) {
    slides.push({ kind: "groups", title: `Where the changes land (by store ${options.byGroup.label})`, columns: [options.byGroup.label[0].toUpperCase() + options.byGroup.label.slice(1), "Stores", "Planograms", "Items added"], rows: options.byGroup.rows.map((r) => [r.group, String(r.stores), String(r.planograms), String(r.adds)]) });
  }
  const range = scenarioRange(items, options.swing || 0.25);
  if (range) {
    const sw = Math.round(range.swing * 100);
    slides.push({
      kind: "range", title: "Range of outcomes",
      columns: ["Scenario", `Weekly ${metricWord(metric)}`], rows: [[`Low: forecasts ${sw}% under`, fmtImpact(metric, range.low)], ["Base: as forecast", fmtImpact(metric, range.base)], [`High: forecasts ${sw}% over`, fmtImpact(metric, range.high)]],
      note: range.low > 0 ? `Even with forecasts ${sw}% lower the plan stays positive.` : `If forecasts come in ${sw}% lower the plan is not positive; the items that depend most on the forecast are the ones to watch.`,
    });
  }
  const tradeoffs = [];
  if (a) {
    tradeoffs.push(`Cannibalization assumed: ${Math.round((a.cannibalization ?? 0) * 100)}% of a new item's sales come from existing items.`);
    tradeoffs.push(`Sales kept when an item is removed: ${Math.round((a.transfer ?? 0) * 100)}% stay in the category as shoppers switch.`);
  }
  const gives = items.flatMap((i) => (i.impact?.items || []).flatMap((e) => e.gives || []));
  if (gives.length) tradeoffs.push(options.hideRemovedNames
    ? `${gives.length} slower item${gives.length === 1 ? "" : "s"} make room; each sells at or below ${Math.max(...gives.map((g) => g.velocity || 0))} units per store per week.`
    : `Items that make room: ${[...new Set(gives.map((g) => g.name))].slice(0, 8).join(", ")}${new Set(gives.map((g) => g.name)).size > 8 ? " and more" : ""}.`);
  tradeoffs.push("A swap is only recommended when the added item is expected to earn more than what it replaces.");
  slides.push({ kind: "tradeoffs", title: "Trade-offs and assumptions", bullets: tradeoffs });
  slides.push({
    kind: "execution", title: "Execution",
    bullets: [
      `${t.planograms} planogram${t.planograms === 1 ? "" : "s"} to reset${plan.effective_date ? `, effective ${plan.effective_date}` : ""}${plan.review_by ? `; results reviewed ${plan.review_by}` : ""}.`,
      `Product movement: ${t.adds + t.removes} product placement${t.adds + t.removes === 1 ? "" : "s"} in total (${t.adds} in, ${t.removes} out).`,
      t.facings ? `${t.facings} facing change${t.facings === 1 ? "" : "s"} to hold days of supply.` : "No facing changes are needed beyond the placements above.",
      ...(options.notes ? [options.notes] : []),
    ],
  });
  slides.push({
    kind: "appendix", title: "Method and data",
    bullets: [
      win ? `Retailer sales ${win.startISO} to ${win.endISO}.` : "Retailer sales data as loaded in Tandom.",
      "Forecasts: new items use the supplier's forecast or similar items' sales; core items use how they sell where they are carried, adjusted for store strength.",
      "Placement: each item goes to free shelf space first; otherwise the slowest items come out, and only if the addition is expected to beat what is given up.",
      `Impact is measured in ${metricWord(metric)} per week and is an estimate, not a guarantee.`,
    ],
  });
  return slides;
}

// ---- Event link -------------------------------------------------------------------------------
// The versions a plan has made (applied drafts) -> planogram ids, via the live proposal rows.
export function planVersionIds(plan, liveByProposalId) {
  return (plan?.items || []).map((it) => liveByProposalId?.[it.proposalId]?.applied_id).filter(Boolean);
}

// What linking a plan to an event does to its versions: those whose eventDate differs get the event's start date.
// Approved/pending versions already carry a schedule (they are on their way to the shelf), so they are listed
// separately for the person to confirm. Live/archived versions are never touched.
export function eventLinkChanges(planograms, versionIds, event) {
  const byId = Object.fromEntries((planograms || []).map((p) => [p.id, p]));
  const date = event?.startDate || "";
  const move = [], confirm = [], skipped = [];
  (versionIds || []).forEach((id) => {
    const p = byId[id];
    if (!p || !date || (p.eventDate || "") === date) return;
    const st = p.status || "wip";
    if (st === "wip" || st === "draft") move.push(p);
    else if (st === "approved" || st === "pending") confirm.push(p);
    else skipped.push(p);
  });
  return { date, move, confirm, skipped };
}

// The plan's date no longer matches its event (the event was moved in the Event Planner).
export function eventDrift(plan, event) {
  if (!plan?.event_id) return null;
  if (!event) return { missing: true };
  if (event.startDate && plan.effective_date !== event.startDate) return { from: plan.effective_date || "", to: event.startDate };
  return null;
}

// ---- Sequencing -------------------------------------------------------------------------------
// Several plans can target the same planogram family on different dates. For each open plan: which earlier plans it
// builds on, which later plans build on it, clashes (same planogram on the same date, same item added twice), plans
// approved ahead of an earlier plan that is not, and items drafted from a version older than the earlier plan's result.
const OPEN = (p) => !["executed", "cancelled"].includes(p.status);
const BEFORE_APPROVAL = ["draft", "shared"];
export function planSequence(plans, planograms) {
  const byId = Object.fromEntries((planograms || []).map((p) => [p.id, p]));
  const famOf = (id) => { const p = byId[id]; return p ? (p.masterId || p.id) : id; };
  const open = (plans || []).filter(OPEN);
  const info = Object.fromEntries(open.map((p) => [p.id, {
    fams: new Set((p.items || []).map((i) => famOf(i.planogramId))),
    adds: new Set((p.items || []).flatMap((i) => (i.adds || []).map((n) => `${famOf(i.planogramId)}|${String(n).toLowerCase()}`))),
  }]));
  const shares = (a, b) => [...info[a.id].fams].some((f) => info[b.id].fams.has(f));
  const sameCat = (a, b) => (a.category || "") === (b.category || "");
  const earlier = (q, p) => !!q.effective_date && !!p.effective_date && (q.effective_date < p.effective_date || (q.effective_date === p.effective_date && String(q.created_at || "") < String(p.created_at || "")));
  const out = {};
  open.forEach((p) => {
    const rel = open.filter((q) => q.id !== p.id && sameCat(p, q) && shares(p, q));
    const predecessors = rel.filter((q) => earlier(q, p)).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    const successors = rel.filter((q) => earlier(p, q)).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    const conflicts = [];
    rel.forEach((q) => {
      if (q.effective_date && q.effective_date === p.effective_date) conflicts.push(`${q.name} changes the same planogram on the same date`);
      const dup = [...info[p.id].adds].filter((k) => info[q.id].adds.has(k)).map((k) => k.split("|")[1]);
      if (dup.length) conflicts.push(`${q.name} also adds ${dup.slice(0, 3).join(", ")}${dup.length > 3 ? "…" : ""}`);
    });
    const outOfOrder = predecessors.filter((q) => BEFORE_APPROVAL.includes(q.status) && !BEFORE_APPROVAL.includes(p.status)).map((q) => q.name);
    const redraft = [];
    predecessors.forEach((q) => {
      const qOut = (planograms || []).filter((g) => g.aiDraft && (q.proposal_ids || []).includes(g.aiDraft.proposalId));
      (p.items || []).forEach((it) => {
        const src = byId[it.planogramId];
        const res = qOut.find((g) => famOf(g.id) === famOf(it.planogramId));
        if (src && res && (src.versionNumber || 1) < (res.versionNumber || 1)) redraft.push({ planogram: it.planogramName || src.name, behind: q.name });
      });
    });
    out[p.id] = { predecessors: predecessors.map((q) => ({ id: q.id, name: q.name, date: q.effective_date })), successors: successors.map((q) => ({ id: q.id, name: q.name, date: q.effective_date })), conflicts, outOfOrder, redraft };
  });
  return out;
}

// Timeline lanes: one per category, plans in date order, each positioned 0-100 across the span of dates.
export function planTimeline(plans, todayISO) {
  const dated = (plans || []).filter((p) => OPEN(p) && p.effective_date);
  if (!dated.length) return { lanes: [], start: todayISO, end: todayISO, todayPct: 0 };
  const dates = dated.map((p) => p.effective_date).concat(todayISO).sort();
  const t = (d) => Date.parse(d + "T00:00:00Z");
  const start = dates[0], end = dates[dates.length - 1];
  const span = Math.max(1, t(end) - t(start));
  const pct = (d) => Math.round(((t(d) - t(start)) / span) * 1000) / 10;
  const cats = [...new Set(dated.map((p) => p.category || "No category"))].sort();
  return {
    start, end, todayPct: pct(todayISO),
    lanes: cats.map((c) => ({ category: c, plans: dated.filter((p) => (p.category || "No category") === c).sort((a, b) => a.effective_date.localeCompare(b.effective_date)).map((p) => ({ id: p.id, name: p.name, date: p.effective_date, pct: pct(p.effective_date), status: p.status })) })),
  };
}
