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

-- ------------------------------------------------------------------
-- Phase 3: Proposals + activity log
-- ------------------------------------------------------------------
-- A Proposal is the one shared record for anything an agent suggests: who proposed it, what it
-- targets, the proposed change itself, why, how confident (Draft Score), and where it stands in
-- review. Agents write Proposals only through an Edge Function (service-role key); people never
-- insert or edit them directly — they review them through review_proposal() below. Nothing in
-- this phase applies a proposal: the AI-drafted WIP version is still built by the app, and
-- approving it just records the decision. Phase 4 adds apply_proposal().
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references agents(id),
  target_type text not null,                 -- e.g. 'planogram_version'
  target_id text not null,                   -- id of the thing proposed against (the source planogram)
  proposed_change jsonb not null,            -- for the Reset Drafting Agent: { changes, skipped, startISO, endISO, lookbackWeeks }
  reason text,                               -- one-line human summary
  score int,                                 -- Draft Score 0-100 (agents that don't score leave it null)
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'applied')),
  requested_by uuid references auth.users(id) on delete set null,  -- the person who ran the agent
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz
);

create index if not exists proposals_status_created_idx on proposals (status, created_at desc);
create index if not exists proposals_target_idx on proposals (target_type, target_id);

-- Append-only record of who did what: agents (written by Edge Functions) and people (written by
-- review_proposal). No client policy allows insert/update/delete, so history can't be rewritten.
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('user', 'agent')),
  actor_id text not null,                    -- profiles.id (as text) for a user, agents.id for an agent
  action text not null,                      -- e.g. 'proposal_created', 'proposal_approved'
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_log_target_idx on activity_log (target_id, created_at desc);
create index if not exists activity_log_created_idx on activity_log (created_at desc);

alter table proposals enable row level security;
alter table activity_log enable row level security;

-- Any signed-in role can read (Store Associates may need to see why a layout changed); nobody
-- gets an insert/update/delete policy, so only the service role and review_proposal() can write.
drop policy if exists "Any role can read proposals" on proposals;
create policy "Any role can read proposals" on proposals for select to authenticated using (true);
drop policy if exists "Any role can read activity_log" on activity_log;
create policy "Any role can read activity_log" on activity_log for select to authenticated using (true);

-- Records a person's decision on a pending proposal and logs it. Idempotent for the same
-- decision (a retry after a dropped connection is harmless); refuses to flip an earlier decision.
create or replace function review_proposal(p_id uuid, p_decision text, p_note text default null)
returns proposals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_prop proposals;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  if current_user_role() not in ('admin', 'category_manager') then
    raise exception 'Your role is not permitted to review proposals';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected';
  end if;

  select * into v_prop from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found'; end if;
  if v_prop.status = p_decision then return v_prop; end if;
  if v_prop.status <> 'pending' then
    raise exception 'This proposal was already %', v_prop.status;
  end if;

  update proposals
     set status = p_decision, reviewed_by = v_uid, reviewed_at = now()
   where id = p_id
  returning * into v_prop;

  insert into activity_log (actor_type, actor_id, action, target_type, target_id, detail)
  values ('user', v_uid::text, 'proposal_' || p_decision, v_prop.target_type, v_prop.target_id,
          jsonb_build_object('proposalId', v_prop.id, 'agentId', v_prop.agent_id, 'score', v_prop.score, 'note', p_note));

  return v_prop;
end;
$$;

revoke all on function review_proposal(uuid, text, text) from public, anon;
grant execute on function review_proposal(uuid, text, text) to authenticated;
