# Tandom Studio — local prototype with a real multi-user backend

This version stores data in **Supabase** (a hosted Postgres database + authentication) instead
of your browser. That means: real accounts, real shared data across your team, and no more
"I lost everything on refresh" — the database is the source of truth, not the browser tab.

## One-time setup

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), sign up (free tier is fine), and create a new project.
Wait a minute or two for it to finish provisioning.

### 2. Run the database schema

In your Supabase project: **SQL Editor → New query**, paste the entire contents of
[`supabase/schema.sql`](./supabase/schema.sql) from this folder, and click **Run**.

This creates all the tables (products, fixtures, planograms, stores, performance, settings,
user profiles) and sets up permissions so any signed-in user can read/write everything —
a single shared team workspace.

### 3. Get your API credentials

In your Supabase project: **Project Settings → API**. You need two values:
- **Project URL**
- **anon / public key**

### 4. Configure the app

```bash
cp .env.example .env
```

Open `.env` and paste in your Project URL and anon key.

### 5. Install and run

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. The first time, you'll see a sign-up screen — create an
account (email + password). Anyone else on your team does the same, using the same `.env`
values (or their own local copy of this project), and everyone sees the same shared data.

## How this differs from the localStorage version

| | localStorage version | This version (Supabase) |
|---|---|---|
| Where data lives | Your browser only | A real hosted database |
| Multi-user | No — each browser is its own empty copy | Yes — everyone sees the same data |
| Survives clearing browser data | No | Yes |
| Requires login | No | Yes |
| Requires internet | No | Yes (talks to Supabase) |

## Data model note

Every entity (product, fixture, planogram, store, performance) is stored as a single JSON
column in its own table, rather than broken into individual typed SQL columns. This was a
deliberate choice — it meant the entire existing app could point at Supabase with **zero
changes** to how the planogram editor, forms, or any other screen works, since the app already
funnels every read/write through the same small set of functions
(`src/lib/db.js`). The tradeoff: you can't yet write plain SQL reports against, say, individual
weekly performance rows — that would mean normalizing the `performance` table into real rows,
which is an isolated follow-up affecting only that one table and `src/lib/db.js`, not the rest
of the app.

## Editor tabs

Analyze, Planogram Attributes, Lifecycle and Versions are tabs across the top of the planogram editor instead of bars stacked
above the shelf. Planogram Attributes holds Category, Department, Cluster, Event Date, Stores, Section Count (read-only), size and base; new versions carry Department and Cluster over (the event date starts blank). Nothing is open until you pick a tab, and picking the open tab again closes it. The Analyze tab shows an amber
dot when the selected period has more weeks than there is data for.

## Product Library and the planogram stay in sync

Selecting a product on the shelf highlights and scrolls to it in the Product Library; clicking a product in the library
selects its placement on the planogram (and scrolls to it), cycling through them when it is placed more than once. Every
facing of the linked product draws a blue outline, and a green count on each library row shows how many places it holds on
this planogram. Double-clicking a library product opens a summary window: attributes, case pack and days-of-supply target,
performance for the analysis window, and where and how it sits on this planogram (stack, units, days of supply, pack-out).

## Stacking and capping (ProSpace meanings)

A placement now carries the full ProSpace position: **Facings Wide** (`facings`), **Facings High**
(`high`), **Facings Deep** (`deep`) and **Capping** (`cap: { productId, count }`; no `productId` =
the same product on top, another product's id = a different product on top). All are optional, so
every existing planogram loads unchanged as 1 high x 1 deep, uncapped. There is nothing to migrate.

- Only *Wide* uses shelf width. *High* and caps use headroom; *Deep* is capacity only.
- **Height is enforced.** Headroom is measured from the shelf's top to the shelf above it that overlaps it
  (or the top of the planogram). The Placement panel disables a step that would not fit, and a stack that would
  be too tall is refused on edits and when a stacked product is moved or dropped onto a shelf that cannot take it.
  Stacks that are already too tall (imported, or a shelf moved afterwards) draw with a red dashed outline and can be reduced.
- **Automatic stacking (`autoStack`).** New shelf products start with "Stack automatically to the available
  height" on: High is worked out from the headroom under the shelf above and re-fits whenever a shelf moves or a
  product is added or moved (`refitAutoStacks`). The planner can untick it per product, or press "Auto-stack this
  shelf" on a fixture. Products the Reset Drafting Agent adds arrive auto-stacked too. Capping stays a manual choice.
- A cap has its own facing (`cap.orientation`: front, top, left...). One front on the shelf with two caps showing the
  top counts each cap at the product's depth, not its height, and that is what the height check uses.
- **Depth is enforced too.** Deep x the unit's depth must fit the shelf's depth (12 deep x 2in = 24in on a 24in shelf
  is fine, 13 is refused). A cap lying flat reaches further back than a standing unit, so only as many cap units fit
  front-to-back as the stack below is deep: 10in-long caps over a 24in stack count 2 deep, not 12.
- ProSpace import reads Facings High and Deep, caps on top (Y caps: count and orientation) and each shelf's
  maximum merchandise height. That height is the shelf's own limit: it can tighten the gap to the shelf above, and
  on a top shelf it replaces the bay height (ProSpace lets a top shelf run past the bay). It can be edited on the
  fixture. Caps beside or behind the stack (X / Z caps) are not imported and the import says so.
- The Reset Drafting Agent keeps stacks intact. When a standout product has no room for another facing, it
  proposes stacking one higher if that still clears the shelf above, and new products it adds must clear it too.
- Sales/Space Index still counts linear width only, so stacking does not change a product's space share.
- The helpers (`getStackDims`, `getShelfClearanceIn`, `getStackHeightProblem`) live in `src/App.jsx` and are
  copied into the Edge Functions by `npm run sync:edge`; `scripts/test-stacking.mjs` covers them.

## Days of supply and case pack

- **Case pack** (units per case) and an optional **days-of-supply override** live on the product page.
  Category **days-of-supply targets** are set in Settings, next to the Reset Drafting thresholds
  (stored as `schema:dosTargets`; a category left blank has no check).
- **Shelf capacity** is wide x high x deep plus caps. **Days of supply** = capacity / average daily units sold.
- **Pack-out rule.** Stores receive whole cases, so a shelf should hold a case or a case and a half
  (1, 1.5, 2, 2.5 cases; odd case packs, which have no half case, use whole cases) and never less than
  one case. Anything else sends overage to the back room, where it gets damaged.
- **Reset Drafting Agent**, after the Sales/Space Index pass:
  - cancels a reduction that would leave a product under its days-of-supply target;
  - adds capacity where the shelf runs short, cheapest first: deeper, then taller, then another facing;
  - trims a shelf holding more than 2x its target;
  - adjusts Facings Deep so the shelf lands on a case or half-case pack-out without breaking the target;
  - flags a shelf that cannot hold one full case, and reports shelves where no depth setting works.
- **Placement panel** shows units on shelf, days of supply against target, and the pack-out in cases.
  The **Supply Report** button on a planogram lists every product with those figures and what needs attention.
- Case pack never changes sales-driven decisions on its own; Core / Must-Carry products are still never reduced.

## Access model

Three roles, stored in `profiles.role` and enforced by Row Level Security in `supabase/schema.sql`:

| Role | Can do |
| --- | --- |
| `admin` | Everything, including changing users' roles |
| `category_manager` (Space Planner) | Read and write all merchandising and store data; run the AI agents |
| `store_associate` | Read everything; no direct writes. May only trigger Store Assistant functions (not built yet) |

New signups start as `store_associate`. There is no role-management screen yet — to promote
someone, edit their row in Supabase Studio (Table Editor → `profiles` → `role`). The very first
Admin has to be set from the SQL editor (`update profiles set role = 'admin' where email = '...';`),
because only an Admin can change roles. A signed-in user can never change their own role.

## Edge Functions (AI agents)

The Reset Drafting Agent's analysis runs in a Supabase Edge Function, not in the browser, so its
thresholds, protection rules and scoring never ship to users. Deploying it is a separate step from
the database schema — see [`supabase/functions/README.md`](supabase/functions/README.md). Until it
is deployed, the **Draft Reset with AI** buttons show an error and nothing else in the app is affected.

Every draft the agent produces is saved as a **Proposal** (the `proposals` table: which agent, what it
targets, the proposed change, its reason and Draft Score, who asked, and its review status) and logged
in the append-only `activity_log`. Nothing is created in your planogram list until a person approves:

- **Draft Reset with AI** on one planogram opens the review straight away; a bulk run just fills the
  **AI Draft Review Queue** on the Planograms tab (lowest Draft Score first).
- **Approve** calls the `apply-proposal` Edge Function (Admin and Category Manager only), which builds
  the next WIP version from the Proposal and commits it — the new planogram, the Proposal's move to
  `applied` and the activity entry — in a single database transaction (`apply_proposal()`, callable only
  by the service role). If the planogram was edited after the draft was made, Approve is refused with an
  explanation, so a stale draft can't be applied; reject it and run a new one.
- **Reject** records the decision through `review_proposal()` and nothing else changes.
- The **Activity** button on each planogram shows who proposed, approved or rejected what.

Nobody writes the `proposals` or `activity_log` tables directly, and the agent itself never touches
`planograms`.

**Updating an existing install to this version, in this order:** (1) run the new `supabase/schema.sql`
in the SQL Editor (safe to re-run), (2) deploy the two functions, `draft-reset` and `apply-proposal` (the
GitHub Action does both whenever something under `supabase/functions/` is pushed), (3) deploy the front
end. Deploying the functions before the schema makes Draft Reset report that it couldn't record the
proposal.

## Backup & Restore still works

The in-app **Attribute Fields → Backup & Restore** export/import still works exactly as
before — it's a good habit regardless of backend, and it's also how you'd move data from an
old localStorage-based copy into this Supabase-backed one (export from the old copy, sign in
here, import).

## Building for production

```bash
npm run build
```

Produces a static `dist/` folder. Since all persistence now goes through Supabase rather than
the browser, this build can be deployed anywhere (Vercel, Netlify, your own server) and will
work correctly for multiple users hitting it from different machines — this is the version
that's actually ready for a real shared deployment, unlike the localStorage-only version.

**Important:** when deploying, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as
environment variables in your hosting platform's settings (not just in a local `.env` file,
which never gets uploaded).

## Troubleshooting

- **"Supabase isn't configured yet" screen** — your `.env` is missing or has empty values.
  Double check `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, then restart `npm run dev`
  (Vite only reads `.env` at startup).
- **Sign up succeeds but you can't sign in** — your Supabase project may have email
  confirmation turned on. Check the inbox for that address, or turn confirmation off under
  Authentication → Providers → Email in your Supabase dashboard (fine for internal/testing use).
- **Data isn't showing up / "permission denied" errors in the console** — most likely the SQL
  schema wasn't run, or wasn't run completely. Re-run `supabase/schema.sql` in the SQL Editor —
  it's safe to run more than once.

## Product Library bulk delete (admin only)

Users whose `profiles.role` is `admin` see a checkbox on every product (grid and list), a **Select All (n)** button (selects everything the current search/filter shows) and **Delete Selected (n)**, which asks "Are you sure…" before deleting. Other roles don't see these controls. This is a UI gate; the database's own delete policy (admin and category manager) is unchanged, so no `schema.sql` change is needed.

## Users, roles and where each person lands (admin only)

Accounts are **invitation only**. In Settings → **Users & Roles** an Admin enters an email, name and role (plus a store, or regions); the person gets an email, sets a password, and lands on their own screen:

| Role | Lands on | Scope |
|---|---|---|
| Admin | Tandom Studio | everything, including Users & Roles |
| Category Manager | Tandom Studio | planograms, products, fixtures, stores, reports |
| Regional Manager | Store Assistant | every store in their assigned region(s) (matches each store's Region); also sees Escalations for those stores |
| Event Planner | Event Planner | events; read-only view of planograms and stores |
| Store Associate | Store Assistant | their one assigned store only |

Store Associates and Regional Managers have no way to reach Tandom Studio, and the **database** (not just the screens) limits them: they read only their stores and the live/approved planograms assigned to them, never Performance, and write only task/photo/execution/issue data for those stores (`supabase/schema.sql`, "Access model v2"; tested against real Postgres with `bash scripts/test-access-rules.sh`).

One-time setup:
1. Re-run `supabase/schema.sql`, then deploy the `manage-users` function (the GitHub Action does this).
2. Supabase → Authentication: turn **off** "Allow new users to sign up", and add the app URL (e.g. `https://tandom-studio.netlify.app`) to the redirect allow-list so invite links come back to the app.
3. Existing store associates must be given a store in Users & Roles; until then they see "No store assigned". Regional managers need at least one region (set a Region on each store).
4. The first Admin is still set once in SQL: `update profiles set role = 'admin' where email = '...';`

You can't change your own role and the last Admin can't be demoted. Not included yet: removing a user, and email/push notification of escalations. Forgot-password sends a reset link.

## Ask Tandom

A chat assistant (Edge Function `ask-tandom`): planners get an **Ask Tandom** button at the bottom right; store associates get an **Ask Tandom** item in the Store Assistant menu. It answers from your data (where products go, what changes in a reset, tasks, issues, case packs, the help guide) and can mark a store task open/completed after the person confirms. See `supabase/functions/README.md` for setup (`ANTHROPIC_API_KEY` repository secret, then re-run `schema.sql`).
When a planogram is open (in the editor, or a store's execution guide) the chat is told which one, so "this planogram" works; a planogram outside the user's scope is ignored.

## Reset Impact and Execution Monitoring (agents)

- **Reset Impact tab** (Admin / Category Manager): sales before vs after a version went Live, summarized by Region, Store, Category, Department, Cluster, Store format or Planogram, for Sales $, Units, Margin $ or Sales per linear foot, each shown raw and against similar stores that did not reset. The outcome also appears on the planogram's Activity panel (including for approved AI proposals).
- **Execution Monitoring tab:** *Check stores* previews stores past due or stuck in Partially Completed; confirming adds a "Reset Follow-up" task to each store's Task Management and escalates stores overdue beyond a set number of days to a list for the Category Manager.
- Needs the latest `schema.sql` (two new tables) and the two new Edge Functions (`reset-impact`, `execution-followup`); see `supabase/functions/README.md`.


## Performance import from a Google Sheet

Performance Data accepts an Excel file (.xlsx/.xls), a CSV, or a **Google Sheet link** (button "From Google Sheet"). The sheet uses the same columns as the template and must be shared as **Anyone with the link → Viewer**; the tab in the link (`gid=`) is the one read. Private sheets can't be read, and the app says how to share them. The link is read by the `fetch-sheet` Edge Function (Admin and Category Manager only; deploy it with the other functions, no `schema.sql` change); nothing from the sheet is stored except the imported weekly rows.

## Assortment (new items and SKU rationalization)

The **Assortment Planner** module (top-bar switcher, between Event Planner and Space Planner; Admins and Category Managers) has six views: Segments (growth and space by shopper-decision attribute), Slow movers, Core items (classifies fundamental items by frequency, steadiness and share of sales, shows coverage by store format, flags core items missing from planograms and drafts their expansion), New items (template import from Excel/CSV/Google Sheet or manual entry; items go into the product library as Pending) Plans (approved drafts collected with dates, a status, preview, share link and Excel download) and Recommendations (which planograms each new item should go on, and what to remove).

- The analysis runs in the browser from data already loaded. **Draft changes for review** calls the new `draft-assortment` Edge Function, which re-runs the same engine (`supabase/functions/_shared/assortment.js`) on the server and files proposals under the `assortment-agent`, so they appear in the existing AI Draft Review Queue.
- Admin steps: re-run `supabase/schema.sql` (adds the `assortment-agent` row), then let the GitHub Action deploy `draft-assortment` (and `fetch-sheet` if not yet deployed).
- Core items: thresholds live in the assortment settings (`coreMinWeeksSelling`, `coreMaxCv`, `coreSalesShare`, `coreMinCoverage`); manual Mark core / Not core calls are saved with them. `draft-assortment` accepts `mode:"core"`, re-classifies on the server and refuses ids that are not core items with gaps. Staple status and competitor pricing are not in the data; price steadiness is only a hint.
- Plans: re-run `supabase/schema.sql` to add the `assortment_plans` table. Anyone signed in can read a plan (the share link is `/#plan=<id>`, for signed-in users only); Admins and Category Managers write. Tests: `scripts/plans.test.sql`, `scripts/test-plans.mjs`.
- Plans and events: a plan can be linked to an Event Planner event (`assortment_plans.event_id`, added by schema.sql). The plan takes the event start date, versions it creates carry it as `eventDate` (set by `apply-proposal` for later applies, by the app for versions that already exist), and the plan flags when the event is moved. Redeploy `apply-proposal`.
- Sequencing: several plans can target one planogram family on different dates. The Assortment filter bar has "Shelf as of" (`planogramsAsOf` in `assortment.js`, and `params.asOf` on `draft-assortment`): the standing version on that date is the latest dated version (Live, Approved, Pending, or a WIP a plan scheduled), so a later plan is drafted on top of an earlier one. Plans show "builds on", out-of-order approval, same-date and duplicate-add clashes, and drafted-before-earlier-plan flags; the Plans tab has a Timeline view. Redeploy `draft-assortment`.
- Minor reset: `draft-reset` accepts `{ planId, maxMoves }` (default 5). It resets the versions the plan's applied assortment drafts created, trims product adds/removes beyond `maxMoves` into the skipped list, and files a normal reset proposal (the existing review queue). Redeploy `draft-reset` via the Action.
- Space fit (`supabase/functions/_shared/space-fit.js`, tested by `scripts/test-space-fit.mjs`): compares the shelf width the items need at the category days-of-supply targets with the planogram's fixture width and recommends whole sections. It needs the Days of Supply targets (Settings) to say anything beyond "as it is now"; the major reset will reuse it.
- Presentation pack: a plan's "Download PowerPoint" (`src/lib/plans.js` buildPack for the content, `src/lib/pack-pptx.js` for the slides). PptxGenJS is loaded from cdn.jsdelivr.net when the button is clicked (nothing added to package.json), so the browser needs to reach that CDN. Expected impact comes from drafts made after this version (`draft-assortment` now stores it); older drafts show "not recorded". The category context slide is built from the retailer's sales when you download (using the Assortment segmentation); the store-group slide uses each planogram's assigned stores; the low/base/high slide (forecasts ±25%) needs drafts that recorded gain and loss separately. Redeploy `draft-assortment` via the Action.
- Major reset: `draft-reset` with `{ planId, mode:"major", segmentFieldIds?, allowResize? }` (`supabase/functions/_shared/major-reset.js`, tested by `scripts/test-major-reset.mjs`). It adds two change types the apply path understands, `setLayout` (a shelf's complete placement list) and `addSection` (an empty copy of a section); `applyResetDraftChanges` in `src/App.jsx` handles them and is re-synced into the Edge Functions. Assumptions: eye level 60in from the base, sections fill left to right, pegboards and mounted fixtures are untouched, sections are never removed. Redeploy `draft-reset` and `apply-proposal` via the Action.
- Stores have a new optional **Cluster** field (Stores tab) used for the cluster scope.
- Products need Category plus the attributes you want to segment by. Growth needs sales history for at least twice the chosen period.
- Tests: `node scripts/test-assortment.mjs`, `node scripts/test-draft-assortment.mjs` (both are part of `npm run test:edge`).

## Planogram and store attributes

Define your own fields for planograms and stores under **Settings** (stored in `app_settings` as `schema:planogram` and `schema:store`; values live in each record's `attributes`, keyed by field id, like products). They appear on the forms, as extra columns / card fields on the Planograms and Stores tabs, as scopes and groupings in Assortment, and as "Summarize by" options in Reset Impact. They are included in Export / Restore Full Backup. No `schema.sql` change is needed.

## Usage analytics (Admins)

The **Usage** tab shows DAU / WAU / MAU, stickiness (average DAU ÷ MAU over 30 days), average session length, time per active day and sessions per user, split by role, module and person.

- The browser (`src/lib/usage.js`) records one `usage_sessions` row per working session: person, role, start, last seen, active seconds, and seconds per module. Time counts only while the person interacts with the app in view (2 minutes of no interaction stops the clock; 30 minutes ends the session). Nothing about what they edit is recorded.
- The database sets the times and role itself and caps active time at the time the session has been open. Only an Admin can read the numbers, through `usage_metrics()`.
- Admin step: re-run `supabase/schema.sql` (creates `usage_sessions` and `usage_metrics`). Until then the tracker switches itself off quietly. Numbers start from the moment it is deployed.
- Tests: `node scripts/test-usage.mjs` (tracker) and `scripts/test-access-rules.sh` (which also runs `scripts/usage.test.sql`: the rules and the numbers, on a real Postgres).
