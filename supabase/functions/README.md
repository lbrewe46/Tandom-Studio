# Edge Functions

| Function | What it does | Who may call it |
| --- | --- | --- |
| `draft-reset` | Runs the Reset Drafting Agent over one or more planograms, saves each result as a pending Proposal (with an activity-log entry), and returns the proposed changes, reasons, Draft Score and `proposalId` | `admin`, `category_manager` |
| `apply-proposal` | Approves a pending Proposal: builds the next WIP planogram version from it and commits the planogram, the Proposal's `applied` status and the activity entry in one transaction. Refuses if the proposal was already decided or the planogram was edited after the draft | `admin`, `category_manager` |
| `ask-tandom` | Ask Tandom chat. Calls Claude with read-only lookup tools (planograms, reset changes, tasks, issues, products, help guide) scoped to the caller's role/store. Can queue a task status change; the change is written only by a second, confirmed request | `admin`, `category_manager`, `store_associate` |
| `reset-impact` | Reset Impact Agent: compares weekly sales before/after a Live version (Historical version = baseline) per store, against similar stores that did not reset, and saves one result per planogram in `reset_impacts` | `admin`, `category_manager` |
| `execution-followup` | Execution Follow-up Agent: finds stores past due or stuck in Partially Completed; `apply: false` previews, `apply: true` adds reminder tasks, records escalations and closes finished ones | `admin`, `category_manager` |

The browser sends only planogram ids and a lookback window. Thresholds, Core / Must-Carry
protection, scoring and all performance data are read here with the service-role key.

## Deploy

1. Apply `supabase/schema.sql` first (roles, the `agents` table and the `proposals` / `activity_log` tables must exist — the function won't hand back a draft it couldn't record as a Proposal).
2. **Without a local CLI (GitHub Action):** `.github/workflows/deploy-functions.yml` deploys on every push
   that touches `supabase/functions/`, or on demand. Add two repository secrets once —
   `SUPABASE_ACCESS_TOKEN` (Supabase dashboard → Account → Access Tokens) and `SUPABASE_PROJECT_ID`
   (Project Settings → General → Reference ID) — then run it from GitHub → Actions → *Deploy Edge
   Functions* → *Run workflow*. The `.github` folder must sit at the repository root.

   **Or with the [Supabase CLI](https://supabase.com/docs/guides/cli):**

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase functions deploy draft-reset
   supabase functions deploy apply-proposal
   supabase functions deploy ask-tandom
   supabase functions deploy reset-impact
   supabase functions deploy execution-followup
   supabase secrets set ANTHROPIC_API_KEY=...   # Ask Tandom only
   ```

   No Supabase secrets to set: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into every Edge
   Function automatically. Leave JWT verification on (the default). The handler also checks the
   caller's session and role itself. (An Anthropic API key will be needed by the first agent that
   makes a model call — `supabase secrets set ANTHROPIC_API_KEY=...` — but this one is deterministic.)

3. Smoke test, using a Category Manager's access token (browser dev tools → Application → local
   storage → the `sb-…-auth-token` entry → `access_token`):

   ```bash
   curl -i -X POST "https://<ref>.supabase.co/functions/v1/draft-reset" \
     -H "Authorization: Bearer <access_token>" -H "apikey: <anon key>" \
     -H "Content-Type: application/json" \
     -d '{"planogramIds":["<a planogram id>"],"lookbackWeeks":13}'
   ```

   Expect `200` with `results[0].ok: true` and a `results[0].proposalId` (a new pending row in `proposals`). The same call with a Store Associate's token must
   return `403`; with no token, `401`.

## Turning the agent off

`update agents set enabled = false where id = 'reset-drafting-agent';` — the function answers
`403 This agent is disabled` immediately, no redeploy.

## Keeping the shared code in sync

`_shared/app-core.js` is **generated** from `src/App.jsx` (the geometry and performance helpers the
app and the agent both need). After changing any of those helpers in `App.jsx`:

```bash
npm run sync:edge     # regenerate app-core.js
npm run check:edge    # CI-friendly: fails if app-core.js is stale, then runs the tests
supabase functions deploy draft-reset
supabase functions deploy apply-proposal
```

The agent itself (`_shared/reset-agent.js`) lives only here — `App.jsx` no longer contains it.

## Tests

`npm run test:edge` runs the real request handler against an in-memory stand-in for Supabase
(auth, roles, disabled agent, input validation, page limits, a hand-built planogram with a known
answer, and for `apply-proposal` every refusal path, retries, version numbering and a full draft-then-approve
round trip). The database function `apply_proposal()` is not covered by these; it was exercised directly
against a real Postgres when it was written. The tests do not exercise Supabase's own JWT/RLS machinery or the Deno runtime — the smoke test
above covers that once deployed.

## Limits worth knowing


Supabase allows **2 s of CPU and 256 MB of memory per request** (waiting on the database does not
count toward CPU). The function reads the whole `performance` table, as the app itself does on load.
Measured locally: 50 planograms against 5,000 products × 52 weekly records ≈ 20 MB read and well
under a second of CPU. Around 20,000 products the payload is ~80 MB and the memory ceiling is the
likelier limit. Past that — or with per-store weekly records across many stores — performance data
needs to be normalized into real rows and queried per product, which this function does not do yet.

## Ask Tandom

- Needs the **`ANTHROPIC_API_KEY`** secret. With the GitHub Action, add it once as a repository secret named `ANTHROPIC_API_KEY`; the workflow copies it into Supabase on each deploy (it never goes in the code). Without it the chat answers "isn't set up yet".
- Optional secret `ASK_TANDOM_MODEL` (default `claude-sonnet-5-5`).
- Run the latest `supabase/schema.sql` first: it registers the `ask-tandom` agent (`update agents set enabled = false where id = 'ask-tandom'` switches it off instantly).
- **Scope:** a Store Associate must have a store selected and only sees that store's planograms (approved/pending/live), tasks and issues. Admins and Category Managers see everything. There is no user-to-store link yet, so a store associate's scope is the store selected in Store Assistant.
- **Writes:** the model can never write. `propose_task_status_change` only queues a proposal; the app shows a confirmation card, and pressing Confirm sends a separate request that updates the task (open/completed) and records `task_status_changed` in the activity log.
- Tests: `node scripts/test-ask-tandom.mjs` (in `npm run test:edge`).

## Reset Impact and Execution Follow-up

Both are deterministic (no model call, no API key). Run the latest `supabase/schema.sql` first: it creates `reset_impacts` and `escalations` and registers `reset-impact-agent` / `execution-followup-agent` (`update agents set enabled = false where id = '...'` switches either off).

- **Reset Impact:** before = the N weeks (default 8) ending on or before a store's go-live date (the day it completed execution); after = full weeks ending 7+ days later, up to N weeks; a store needs 4 after-weeks to count. The week straddling go-live is ignored. "Planogram sales" = every product on the new OR the Historical version. "vs similar stores" subtracts the change of stores that sell those products, were not assigned to the planogram's family, and were not reset by another same-category planogram in that period. Rollups (region, store, category, department, cluster, format, planogram) add up the stores' before/after totals and lift, so mixed groups stay correct.
- **Execution Follow-up:** past due = Event Date passed and the store is not Completed/Rejected; stuck = Partially Completed longer than `stuckDays` (default 3). One reminder task per store and planogram while the first is open; escalation once overdue or stuck >= `escalateAfterDays` (default 5), once per store and planogram, flagged "repeat" when the store had escalations in the last 90 days. Nothing runs on its own: a person presses **Check stores**, reviews the preview, and confirms.
- Tests: `scripts/test-reset-impact.mjs`, `scripts/test-execution-followup.mjs` (both in `npm run test:edge`).
