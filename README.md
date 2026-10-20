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

## Users & Roles (admin only)

Settings → **Users & Roles** lists every signed-up user with a role dropdown (Admin, Category Manager, Store Associate). You can't change your own role, and the last remaining Admin can't be demoted. The database still enforces who may change roles (admin-only policy + trigger); no `schema.sql` change. New sign-ups start as Store Associate. The very first Admin still has to be set once in Supabase: `update profiles set role = 'admin' where email = '...';`.

## Ask Tandom

A chat assistant (Edge Function `ask-tandom`): planners get an **Ask Tandom** button at the bottom right; store associates get an **Ask Tandom** item in the Store Assistant menu. It answers from your data (where products go, what changes in a reset, tasks, issues, case packs, the help guide) and can mark a store task open/completed after the person confirms. See `supabase/functions/README.md` for setup (`ANTHROPIC_API_KEY` repository secret, then re-run `schema.sql`).
