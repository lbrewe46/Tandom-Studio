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

## Access model (v1)

Any authenticated user can read and write everything — a single shared workspace. There's no
per-role permission system yet (e.g. a "viewer" who can't edit). That's a layer that can be
added later purely in `supabase/schema.sql`'s RLS policies, without touching the app.

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
