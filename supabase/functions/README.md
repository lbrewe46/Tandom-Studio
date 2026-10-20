# Edge Functions

| Function | What it does | Who may call it |
| --- | --- | --- |
| `draft-reset` | Runs the Reset Drafting Agent over one or more planograms, saves each result as a pending Proposal (with an activity-log entry), and returns the proposed changes, reasons, Draft Score and `proposalId` | `admin`, `category_manager` |

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
```

The agent itself (`_shared/reset-agent.js`) lives only here — `App.jsx` no longer contains it.

## Tests

`npm run test:edge` runs the real request handler against an in-memory stand-in for Supabase
(auth, roles, disabled agent, input validation, page limits, a hand-built planogram with a known
answer). It does not exercise Supabase's own JWT/RLS machinery or the Deno runtime — the smoke test
above covers that once deployed.

## Limits worth knowing


Supabase allows **2 s of CPU and 256 MB of memory per request** (waiting on the database does not
count toward CPU). The function reads the whole `performance` table, as the app itself does on load.
Measured locally: 50 planograms against 5,000 products × 52 weekly records ≈ 20 MB read and well
under a second of CPU. Around 20,000 products the payload is ~80 MB and the memory ceiling is the
likelier limit. Past that — or with per-store weekly records across many stores — performance data
needs to be normalized into real rows and queried per product, which this function does not do yet.
