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

-- ------------------------------------------------------------------
-- Phase 1: Roles & functional-area RLS
-- ------------------------------------------------------------------
-- Replaces the v1 "any authenticated user can do anything" model above with three roles:
--   admin               — everything, including user/role management
--   category_manager    — (aka "Space Planner" in the UI) everything merchandising- and
--                          store-related; not user/role management
--   store_associate     — read-only everywhere today. Store-specific WRITE actions (feedback,
--                          tasks) don't exist as direct tables yet — when Store Feedback Triage
--                          and similar agents are built, they go through the Proposal model
--                          (agents only ever write a `proposals` row, never a table directly),
--                          so no direct-write grant belongs here even once those agents exist.
-- New signups default to 'store_associate' (least privilege); an Admin promotes from there —
-- there's no in-app role management UI yet, so promoting a user means updating their `profiles`
-- row directly (Supabase Studio's Table Editor, or a one-off SQL update).

alter table profiles add column if not exists role text not null default 'store_associate';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table profiles add constraint profiles_role_check
      check (role in ('admin', 'category_manager', 'store_associate'));
  end if;
end $$;

-- Reads a user's role without re-entering RLS on `profiles` (avoids recursive-policy issues
-- when this is called from inside a `profiles` policy itself).
create or replace function current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

-- An Admin may update any profile (to promote/demote a role); a user may still update their
-- own profile (display_name etc.) via the existing "Users can update their own profile" policy,
-- but the trigger below blocks a non-admin from changing their *own* role through that path.
drop policy if exists "Admins can update any profile" on profiles;
create policy "Admins can update any profile"
  on profiles for update
  to authenticated
  using (current_user_role() = 'admin');

create or replace function prevent_unauthorized_role_change()
returns trigger as $$
begin
  if new.role is distinct from old.role and current_user_role() <> 'admin' then
    raise exception 'Only an Admin can change a user''s role';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists prevent_unauthorized_role_change on profiles;
create trigger prevent_unauthorized_role_change
  before update on profiles
  for each row execute procedure prevent_unauthorized_role_change();

-- Replace the v1 blanket "any authenticated user can write" policies with functional-area
-- ones: everyone authenticated can still read (planograms, products, etc. need to be visible
-- to Store Associates executing a reset in-store); only Admin and Category Manager can write.
do $$
declare
  t text;
begin
  foreach t in array array['products', 'fixtures', 'planograms', 'stores', 'performance', 'app_settings']
  loop
    execute format('drop policy if exists "Authenticated users can read %1$s" on %1$s;', t);
    execute format('drop policy if exists "Authenticated users can insert %1$s" on %1$s;', t);
    execute format('drop policy if exists "Authenticated users can update %1$s" on %1$s;', t);
    execute format('drop policy if exists "Authenticated users can delete %1$s" on %1$s;', t);
    execute format('drop policy if exists "Any role can read %1$s" on %1$s;', t);
    execute format('drop policy if exists "Admin and Category Manager can insert %1$s" on %1$s;', t);
    execute format('drop policy if exists "Admin and Category Manager can update %1$s" on %1$s;', t);
    execute format('drop policy if exists "Admin and Category Manager can delete %1$s" on %1$s;', t);

    execute format('
      create policy "Any role can read %1$s" on %1$s
        for select to authenticated using (true);
    ', t);
    execute format('
      create policy "Admin and Category Manager can insert %1$s" on %1$s
        for insert to authenticated with check (current_user_role() in (''admin'', ''category_manager''));
    ', t);
    execute format('
      create policy "Admin and Category Manager can update %1$s" on %1$s
        for update to authenticated using (current_user_role() in (''admin'', ''category_manager''));
    ', t);
    execute format('
      create policy "Admin and Category Manager can delete %1$s" on %1$s
        for delete to authenticated using (current_user_role() in (''admin'', ''category_manager''));
    ', t);
  end loop;
end $$;

-- ------------------------------------------------------------------
-- Phase 1: Agent actor type
-- ------------------------------------------------------------------
-- Agents are NOT Supabase Auth users — they never log in, so they don't get a `profiles` row.
-- This is a static registry Edge Functions check against before acting, and the UI can use to
-- show "who proposed this." Critically, agents get NO RLS grants of their own on any table
-- above: an agent only ever writes a `proposals` row (Phase 3), through an Edge Function that
-- runs with the service-role key. Scoping what an agent may touch is the Edge Function's own
-- code, not a database grant — see the design doc for why.
create table if not exists agents (
  id text primary key,               -- e.g. 'reset-drafting-agent'
  name text not null,
  description text,
  enabled boolean not null default true,
  allowed_target_types text[] not null default '{}',  -- e.g. {'planogram_version'}
  created_at timestamptz not null default now()
);

alter table agents enable row level security;

drop policy if exists "Any authenticated user can read agents" on agents;
create policy "Any authenticated user can read agents"
  on agents for select
  to authenticated
  using (true);

drop policy if exists "Admins manage agents" on agents;
create policy "Admins manage agents"
  on agents for all
  to authenticated
  using (current_user_role() = 'admin')
  with check (current_user_role() = 'admin');

insert into agents (id, name, description, allowed_target_types)
values ('reset-drafting-agent', 'Reset Drafting Agent',
        'Reads Performance history and drafts facing/deletion/addition changes for a planogram reset.',
        array['planogram_version'])
on conflict (id) do nothing;
