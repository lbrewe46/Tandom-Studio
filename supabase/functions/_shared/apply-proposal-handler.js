// Request handling for the apply-proposal Edge Function: the one place a pending Proposal is
// turned into a real planogram version. Plain JS with the service-role client injected, so the
// same code runs in Deno (supabase/functions/apply-proposal/index.ts) and in Node tests.
//
// Contract
//   POST { proposalId: string }
//   200 { ok: true, proposalId, planogramId, planogram, alreadyApplied? }
//   400 bad input / unsupported target · 401 no/invalid JWT · 403 role not allowed
//   404 no such proposal · 409 can't be applied (already decided, source planogram gone or edited since)
//
// Who may apply: Admin and Category Manager. The agent that made the proposal never does — it has
// no path to the planograms table at all. The commit itself is the apply_proposal() database
// function (service-role only), which writes the planogram, marks the proposal 'applied' and logs
// it in one transaction.

import { json, preflightOrWrongMethod, authenticate } from "./http.js";
import { applyResetDraftChanges, makePlanogramVersion } from "./app-core.js";
import { fingerprint, appliedPlanogramId } from "./proposal-core.js";

export const TARGET_TYPE = "planogram_version";
export const ALLOWED_ROLES = ["admin", "category_manager"];
const PAGE_SIZE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchAll(db, table, columns, applyFilters = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await applyFilters(db.from(table).select(columns)).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function handleApplyProposal(req, db) {
  const early = preflightOrWrongMethod(req);
  if (early) return early;

  const auth = await authenticate(req, db, ALLOWED_ROLES, "Your role is not permitted to approve proposals");
  if (auth.response) return auth.response;

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Body must be JSON" }); }
  const proposalId = body?.proposalId;
  // ids are uuids; rejecting anything else here keeps a malformed value from reaching the database
  if (typeof proposalId !== "string" || !UUID.test(proposalId)) return json(400, { error: "proposalId must be a proposal id" });

  try {
    const { data: proposal, error: propErr } = await db.from("proposals").select("*").eq("id", proposalId).maybeSingle();
    if (propErr) throw new Error(`reading proposals: ${propErr.message}`);
    if (!proposal) return json(404, { error: "Proposal not found" });
    if (proposal.target_type !== TARGET_TYPE) return json(400, { error: `Don't know how to apply a ${proposal.target_type} proposal` });

    // a repeat of an apply that already went through just reports the planogram it made
    if (proposal.status === "applied") {
      const { data: existing } = await db.from("planograms").select("data").eq("id", proposal.applied_id).maybeSingle();
      return json(200, { ok: true, alreadyApplied: true, proposalId, planogramId: proposal.applied_id, planogram: existing?.data ?? null });
    }
    if (proposal.status !== "pending") return json(409, { error: `This proposal was already ${proposal.status}` });

    const changes = proposal.proposed_change?.changes;
    if (!Array.isArray(changes)) return json(409, { error: "This proposal has no change list to apply" });

    // --- the planogram it was drafted from, and every version already in its family ------------
    const { data: sourceRow, error: srcErr } = await db.from("planograms").select("id, data").eq("id", proposal.target_id).maybeSingle();
    if (srcErr) throw new Error(`reading planograms: ${srcErr.message}`);
    if (!sourceRow?.data) return json(409, { error: "The planogram this was drafted from no longer exists" });
    const source = sourceRow.data;

    const recorded = proposal.proposed_change.sourceFingerprint;
    if (recorded && recorded !== (await fingerprint(source.sections ?? null))) {
      return json(409, { error: "The planogram has been edited since this draft was made, so its changes may no longer fit. Reject this proposal and run a new draft." });
    }

    const masterId = source.masterId || source.id;
    const [master, versions] = await Promise.all([
      fetchAll(db, "planograms", "id, data", (q) => q.eq("id", masterId)),
      fetchAll(db, "planograms", "id, data", (q) => q.eq("data->>masterId", masterId)),
    ]);
    const family = [...new Map([...master, ...versions, sourceRow].map((r) => [r.id, r.data])).values()];

    // --- build the new WIP version exactly as the app would, then commit it atomically --------
    const modifiedSections = applyResetDraftChanges(source.sections || [], changes);
    const newPlanogram = {
      ...makePlanogramVersion({ ...source, sections: modifiedSections }, family, appliedPlanogramId(proposalId)),
      resetDraft: undefined, // never inherit a pending review from the version it was drafted from
      aiDraft: { proposalId, sourceId: source.id, score: proposal.score ?? null },
    };

    const { data: appliedId, error: applyErr } = await db.rpc("apply_proposal", { p_id: proposalId, p_user: auth.user.id, p_planogram: newPlanogram });
    if (applyErr) {
      if (/already/i.test(applyErr.message || "")) return json(409, { error: applyErr.message });
      throw new Error(`apply_proposal: ${applyErr.message}`);
    }
    return json(200, { ok: true, proposalId, planogramId: appliedId, planogram: newPlanogram });
  } catch (e) {
    console.error("apply-proposal failed", e);
    return json(500, { error: "Couldn't apply this proposal" });
  }
}
