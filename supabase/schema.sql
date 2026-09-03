-- Tandom Studio — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Database → SQL Editor → New query → paste → Run).
--
-- Design choice, stated up front: each entity (product, fixture, planogram, store, performance)
-- is stored as a JSONB "data" column rather than fully-typed relational columns. This is
-- deliberate — it means the app's existing data shapes (which already work, and which every
-- screen in the UI already expects) move over with zero rewriting of the React app's logic,
-- just a swap of *where* the five storage primitives (safeGet/safeSet/safeDelete/loadIndexed/
-- saveIndexed/deleteIndexed) point. The tradeoff is that you can't yet write plain SQL
-- reports directly against e.g. individual performance weeks — that would mean normalizing
-- the `performance` table into real rows later, which is a separate, isolated follow-up
-- (only these tables would need to change, not the app).
--
-- Access model for v1: any authenticated (logged-in) user can read and write everything —
-- a single shared team workspace, matching "Teams Delivering Merchandising in Tandom."
-- Per-role permissions (e.g. read-only viewers) can be layered on top of this later by
-- tightening the policies below; nothing about the app needs to change to support that.

-- ------------------------------------------------------------------
-- Profiles (one row per user, auto-created on signup)
-- ------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "Profiles are viewable by any authenticated user" on profiles;
create policy "Profiles are viewable by any authenticated user"
  on profiles for select
  to authenticated
  using (true);

drop policy if exists "Users can update their own profile" on profiles;
create policy "Users can update their own profile"
  on profiles for update
  to authenticated
  using (auth.uid() = id);

-- auto-create a profile row whenever a new user signs up
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- ------------------------------------------------------------------
-- Generic helper: one table per entity kind, all shaped the same way
-- ------------------------------------------------------------------
-- id          — the app's own generated id (e.g. "prod_abc123"), kept as text so existing
--               ids created before migration (from a browser backup) still work unchanged
-- data        — the full entity as JSON, exactly what the app already reads/writes
-- updated_at  — bumped automatically on every write, useful for sync/debugging later
-- updated_by  — which user last touched it (nice to have for a shared workspace)

create table if not exists products (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists fixtures (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists planograms (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists stores (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- one row per product; data = the array of {weekEnding, unitCost, price, units, storeId}
-- weekly records for that product (mirrors the app's in-memory shape exactly)
create table if not exists performance (
  id text primary key, -- productId
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- app-wide settings: product/fixture attribute schemas, primary key field, image repo config
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- ------------------------------------------------------------------
-- Row Level Security — shared workspace: any signed-in user can do anything
-- ------------------------------------------------------------------
alter table products enable row level security;
alter table fixtures enable row level security;
alter table planograms enable row level security;
alter table stores enable row level security;
alter table performance enable row level security;
alter table app_settings enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['products', 'fixtures', 'planograms', 'stores', 'performance', 'app_settings']
  loop
    execute format('drop policy if exists "Authenticated users can read %1$s" on %1$s;', t);
    execute format('
      create policy "Authenticated users can read %1$s" on %1$s
        for select to authenticated using (true);
    ', t);
    execute format('drop policy if exists "Authenticated users can insert %1$s" on %1$s;', t);
    execute format('
      create policy "Authenticated users can insert %1$s" on %1$s
        for insert to authenticated with check (true);
    ', t);
    execute format('drop policy if exists "Authenticated users can update %1$s" on %1$s;', t);
    execute format('
      create policy "Authenticated users can update %1$s" on %1$s
        for update to authenticated using (true);
    ', t);
    execute format('drop policy if exists "Authenticated users can delete %1$s" on %1$s;', t);
    execute format('
      create policy "Authenticated users can delete %1$s" on %1$s
        for delete to authenticated using (true);
    ', t);
  end loop;
end $$;

-- keep updated_at current automatically
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array['products', 'fixtures', 'planograms', 'stores', 'performance', 'app_settings']
  loop
    execute format('
      drop trigger if exists set_updated_at on %1$s;
      create trigger set_updated_at before update on %1$s
        for each row execute procedure set_updated_at();
    ', t);
  end loop;
end $$;
