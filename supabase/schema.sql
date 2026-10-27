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

insert into agents (id, name, description, allowed_target_types)
values ('assortment-agent', 'Assortment Agent',
        'Places new items on the planograms where they earn the most, trading out the slowest items when a shelf is full, and drafts those changes for review.',
        array['planogram_version'])
on conflict (id) do nothing;

insert into agents (id, name, description, allowed_target_types)
values ('ask-tandom', 'Ask Tandom',
        'Answers store and planner questions about planograms, resets, tasks and products; can mark a store task open/completed after the person confirms.',
        array['store_task'])
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

-- ------------------------------------------------------------------
-- Phase 4: applying a proposal
-- ------------------------------------------------------------------
-- Turning an approved proposal into a real planogram version is its own privileged step, held by
-- a different actor than the one that proposed it. The `apply-proposal` Edge Function checks the
-- caller's role, builds the new version from the proposal, and then calls this function — which
-- only the service role can execute — to commit everything in ONE transaction: the new planogram
-- row, the proposal's move to 'applied', and the activity entry. Nothing else in the system
-- writes a planogram on a proposal's behalf, and an agent never does.
alter table proposals add column if not exists applied_id text;  -- id of the planogram this created

create or replace function apply_proposal(p_id uuid, p_user uuid, p_planogram jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prop proposals;
  v_new_id text := p_planogram->>'id';
begin
  if v_new_id is null or v_new_id = '' then raise exception 'The new planogram has no id'; end if;

  select * into v_prop from proposals where id = p_id for update;
  if not found then raise exception 'Proposal not found'; end if;

  -- applying twice is harmless: the second call just reports the planogram the first one made
  if v_prop.status = 'applied' then return v_prop.applied_id; end if;
  if v_prop.status <> 'pending' then
    raise exception 'This proposal was already %', v_prop.status;
  end if;

  insert into planograms (id, data, updated_by) values (v_new_id, p_planogram, p_user);

  update proposals
     set status = 'applied',
         applied_id = v_new_id,
         reviewed_by = coalesce(reviewed_by, p_user),
         reviewed_at = coalesce(reviewed_at, now())
   where id = p_id;

  insert into activity_log (actor_type, actor_id, action, target_type, target_id, detail)
  values ('user', p_user::text, 'proposal_applied', v_prop.target_type, v_prop.target_id,
          jsonb_build_object('proposalId', v_prop.id, 'agentId', v_prop.agent_id, 'score', v_prop.score,
                             'planogramId', v_new_id, 'planogramName', p_planogram->>'name',
                             'version', p_planogram->'versionNumber'));

  return v_new_id;
end;
$$;

revoke all on function apply_proposal(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function apply_proposal(uuid, uuid, jsonb) to service_role;

-- ------------------------------------------------------------------
-- Reset Impact + Execution Follow-up agents
-- ------------------------------------------------------------------
-- Both agents are deterministic (no model call) and write only through their Edge Functions with the
-- service-role key, so neither table has an insert policy.

insert into agents (id, name, description, allowed_target_types)
values ('reset-impact-agent', 'Reset Impact Agent',
        'Compares sales before and after a planogram version goes Live (the Historical version is the baseline), against similar stores that did not reset.',
        array['planogram_version'])
on conflict (id) do nothing;

insert into agents (id, name, description, allowed_target_types)
values ('execution-followup-agent', 'Execution Follow-up Agent',
        'Finds stores whose reset is stuck or past due, adds a reminder task to Task Management, and escalates to the Category Manager.',
        array['store_task', 'escalation'])
on conflict (id) do nothing;

-- One row per measured planogram version; re-measuring replaces it.
create table if not exists reset_impacts (
  planogram_id text primary key,              -- the Live version that was measured
  baseline_planogram_id text,                 -- the Historical version it replaced
  proposal_id uuid,                           -- the AI proposal that created this version, when there was one
  go_live_date date,
  params jsonb not null default '{}',         -- window lengths used
  result jsonb not null,                      -- per-store rows, control group, space, summary
  computed_by uuid references auth.users(id) on delete set null,
  computed_at timestamptz not null default now()
);
create index if not exists reset_impacts_proposal_idx on reset_impacts (proposal_id);
alter table reset_impacts enable row level security;
drop policy if exists "Admin and Category Manager can read reset_impacts" on reset_impacts;
create policy "Admin and Category Manager can read reset_impacts"
  on reset_impacts for select to authenticated
  using (current_user_role() in ('admin', 'category_manager'));

-- A store that stayed late on a reset long enough to need a person's attention.
create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  planogram_id text not null,
  planogram_name text,
  store_id text not null,
  store_name text,
  kind text,                                  -- past_due | stuck | past_due_and_stuck
  days_overdue int,
  reason text,
  prior_escalations int not null default 0,   -- this store's escalations in the previous 90 days (repeat problems)
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by_agent text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution text
);
create index if not exists escalations_open_idx on escalations (status, created_at desc);
create index if not exists escalations_store_idx on escalations (store_id, created_at desc);
alter table escalations enable row level security;
drop policy if exists "Admin and Category Manager can read escalations" on escalations;
create policy "Admin and Category Manager can read escalations"
  on escalations for select to authenticated
  using (current_user_role() in ('admin', 'category_manager'));
-- people may mark an escalation resolved (nothing else is ever updated by a client)
drop policy if exists "Admin and Category Manager can resolve escalations" on escalations;
create policy "Admin and Category Manager can resolve escalations"
  on escalations for update to authenticated
  using (current_user_role() in ('admin', 'category_manager'))
  with check (current_user_role() in ('admin', 'category_manager'));

-- ------------------------------------------------------------------
-- Access model v2: five roles, store/region assignment, scoped reads and writes
-- ------------------------------------------------------------------
--   admin             everything, including users and roles
--   category_manager  everything merchandising- and store-related (Tandom Studio)
--   regional_manager  Store Assistant for every store in their assigned region(s) (profiles.regions)
--   event_planner     Event Planner; read-only planograms/stores/products/fixtures
--   store_associate   Store Assistant for their ONE assigned store (profiles.store_id)
-- Store-scoped users (store_associate, regional_manager) can read only their stores and the planograms
-- assigned to them, and write only what store execution needs: tasks and photos on their stores, and
-- execution progress, item checks, feedback issues and go-live status on those planograms (enforced by
-- the guard triggers below, not just by the app). They never see Performance (sales) data.
-- This block must stay LAST in the file: it replaces the read policies created earlier.
-- Verified against a real Postgres by scripts/test-access-rules.sh.

alter table profiles add column if not exists store_id text;                        -- store_associate: the one store
alter table profiles add column if not exists regions text[] not null default '{}'; -- regional_manager: region names (stores.data->>'region')

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'category_manager', 'regional_manager', 'event_planner', 'store_associate'));

-- The store ids the signed-in user is scoped to: [] when they have none, NULL for roles that aren't store-scoped.
create or replace function current_user_store_ids()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select case p.role
    when 'store_associate' then case when p.store_id is null then '{}'::text[] else array[p.store_id] end
    when 'regional_manager' then coalesce((select array_agg(s.id) from stores s where s.data->>'region' = any(p.regions)), '{}'::text[])
    else null
  end
  from profiles p where p.id = auth.uid()
$$;

create or replace function is_store_scoped_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role in ('store_associate', 'regional_manager') from profiles where id = auth.uid()), false)
$$;

-- Only an Admin changes a user's role, store or regions (service-role / SQL-editor changes have no auth.uid() and pass).
create or replace function prevent_unauthorized_role_change()
returns trigger as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.role is distinct from old.role or new.store_id is distinct from old.store_id or new.regions is distinct from old.regions)
     and coalesce(current_user_role(), '') <> 'admin' then
    raise exception 'Only an Admin can change a user''s role, store or regions';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ---- reads ---------------------------------------------------------------------------------
drop policy if exists "Any role can read stores" on stores;
drop policy if exists "Role-scoped read stores" on stores;
create policy "Role-scoped read stores" on stores for select to authenticated using (
  current_user_role() in ('admin', 'category_manager', 'event_planner')
  or (is_store_scoped_user() and id = any(coalesce(current_user_store_ids(), '{}')))
);

drop policy if exists "Any role can read planograms" on planograms;
drop policy if exists "Role-scoped read planograms" on planograms;
create policy "Role-scoped read planograms" on planograms for select to authenticated using (
  current_user_role() in ('admin', 'category_manager', 'event_planner')
  or (is_store_scoped_user() and coalesce(data->>'status', 'wip') <> 'wip'
      and (data->'storeIds') ?| coalesce(current_user_store_ids(), '{}'))
);

drop policy if exists "Any role can read performance" on performance;
drop policy if exists "Role-scoped read performance" on performance;
create policy "Role-scoped read performance" on performance for select to authenticated using (
  current_user_role() in ('admin', 'category_manager')
);

-- ---- store-scoped writes -------------------------------------------------------------------
-- The "exists" test lets an app "save" (an upsert) of a row that is already there through the INSERT
-- check without ever allowing a brand-new row to be created.
drop policy if exists "Store users insert own stores" on stores;
create policy "Store users insert own stores" on stores for insert to authenticated with check (
  is_store_scoped_user() and id = any(coalesce(current_user_store_ids(), '{}'))
  and exists (select 1 from stores x where x.id = stores.id)
);
drop policy if exists "Store users update own stores" on stores;
create policy "Store users update own stores" on stores for update to authenticated
  using (is_store_scoped_user() and id = any(coalesce(current_user_store_ids(), '{}')))
  with check (is_store_scoped_user() and id = any(coalesce(current_user_store_ids(), '{}')));

drop policy if exists "Store users insert own planograms" on planograms;
create policy "Store users insert own planograms" on planograms for insert to authenticated with check (
  is_store_scoped_user() and (data->'storeIds') ?| coalesce(current_user_store_ids(), '{}')
  and exists (select 1 from planograms x where x.id = planograms.id)
);
drop policy if exists "Store users update own planograms" on planograms;
create policy "Store users update own planograms" on planograms for update to authenticated
  using (is_store_scoped_user() and coalesce(data->>'status', 'wip') <> 'wip' and (data->'storeIds') ?| coalesce(current_user_store_ids(), '{}'))
  with check (is_store_scoped_user() and (data->'storeIds') ?| coalesce(current_user_store_ids(), '{}'));

-- A store user may change only tasks and photos on a store row.
create or replace function guard_store_scoped_store_write()
returns trigger as $$
begin
  if auth.uid() is null or not is_store_scoped_user() then return new; end if;
  if (new.data - 'tasks' - 'photos') is distinct from (old.data - 'tasks' - 'photos') then
    raise exception 'Store users can only change a store''s tasks and photos';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
drop trigger if exists guard_store_scoped_store_write on stores;
create trigger guard_store_scoped_store_write before update on stores
  for each row execute procedure guard_store_scoped_store_write();

-- A store user may change only: execution progress and item checks for THEIR stores, feedback issues they
-- add (existing issues stay as they are), and a planogram's go-live status moving forward.
create or replace function guard_store_scoped_planogram_write()
returns trigger as $$
declare
  scope text[];
  k text;
  i jsonb;
begin
  if auth.uid() is null or not is_store_scoped_user() then return new; end if;
  scope := coalesce(current_user_store_ids(), '{}');
  if (new.data - 'execution' - 'itemChecks' - 'issues' - 'status') is distinct from (old.data - 'execution' - 'itemChecks' - 'issues' - 'status') then
    raise exception 'Store users can only update execution progress, item checks, feedback and go-live status';
  end if;
  for k in
    select jsonb_object_keys(coalesce(new.data->'execution', '{}'::jsonb))
    union select jsonb_object_keys(coalesce(old.data->'execution', '{}'::jsonb))
    union select jsonb_object_keys(coalesce(new.data->'itemChecks', '{}'::jsonb))
    union select jsonb_object_keys(coalesce(old.data->'itemChecks', '{}'::jsonb))
  loop
    if not (k = any(scope)) and (
         (new.data->'execution'->k) is distinct from (old.data->'execution'->k)
         or (new.data->'itemChecks'->k) is distinct from (old.data->'itemChecks'->k)) then
      raise exception 'Store users can only update execution for their own stores';
    end if;
  end loop;
  if not (coalesce(new.data->'issues', '[]'::jsonb) @> coalesce(old.data->'issues', '[]'::jsonb)) then
    raise exception 'Store users cannot change or remove existing feedback';
  end if;
  for i in select * from jsonb_array_elements(coalesce(new.data->'issues', '[]'::jsonb)) loop
    if not (coalesce(old.data->'issues', '[]'::jsonb) @> jsonb_build_array(i)) and not ((i->>'storeId') = any(scope)) then
      raise exception 'Store users can only raise feedback for their own stores';
    end if;
  end loop;
  if (new.data->>'status') is distinct from (old.data->>'status')
     and not (coalesce(old.data->>'status', 'wip'), coalesce(new.data->>'status', 'wip')) in (('approved', 'live'), ('pending', 'live'), ('live', 'historical')) then
    raise exception 'Store users cannot change a planogram''s status that way';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;
drop trigger if exists guard_store_scoped_planogram_write on planograms;
create trigger guard_store_scoped_planogram_write before update on planograms
  for each row execute procedure guard_store_scoped_planogram_write();

-- ---- event planners: events only -------------------------------------------------------------
-- (events and event types live in app_settings under these two keys)
drop policy if exists "Event planners insert event settings" on app_settings;
create policy "Event planners insert event settings" on app_settings for insert to authenticated
  with check (current_user_role() = 'event_planner' and key in ('settings:events', 'schema:eventType'));
drop policy if exists "Event planners update event settings" on app_settings;
create policy "Event planners update event settings" on app_settings for update to authenticated
  using (current_user_role() = 'event_planner' and key in ('settings:events', 'schema:eventType'))
  with check (current_user_role() = 'event_planner' and key in ('settings:events', 'schema:eventType'));

-- ---- regional managers: see and resolve escalations for their stores -----------------------------
drop policy if exists "Regional managers read their escalations" on escalations;
create policy "Regional managers read their escalations" on escalations for select to authenticated
  using (current_user_role() = 'regional_manager' and store_id = any(coalesce(current_user_store_ids(), '{}')));
drop policy if exists "Regional managers resolve their escalations" on escalations;
create policy "Regional managers resolve their escalations" on escalations for update to authenticated
  using (current_user_role() = 'regional_manager' and store_id = any(coalesce(current_user_store_ids(), '{}')))
  with check (current_user_role() = 'regional_manager' and store_id = any(coalesce(current_user_store_ids(), '{}')));

-- ---- usage analytics (Admin → Usage) -----------------------------------------------------------
-- One row per working session of a signed-in person. The app records when it began, when it was last
-- seen, and how many seconds the person was actually active (touching the screen with it in view),
-- by module. Nothing about what was edited is recorded. Only an Admin can read the numbers.
create table if not exists usage_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  active_seconds integer not null default 0 check (active_seconds >= 0),
  modules jsonb not null default '{}'::jsonb
);
create index if not exists usage_sessions_started_idx on usage_sessions (started_at);
create index if not exists usage_sessions_user_started_idx on usage_sessions (user_id, started_at);
alter table usage_sessions enable row level security;

drop policy if exists "Users record their own sessions" on usage_sessions;
create policy "Users record their own sessions" on usage_sessions for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "Users update their own sessions" on usage_sessions;
create policy "Users update their own sessions" on usage_sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- (a person must be able to see their own row for their own update to find it)
drop policy if exists "Users read their own sessions" on usage_sessions;
create policy "Users read their own sessions" on usage_sessions for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "Admins read usage" on usage_sessions;
create policy "Admins read usage" on usage_sessions for select to authenticated
  using (current_user_role() = 'admin');

-- The database, not the browser, decides the times and the role, and active time can never exceed the
-- time the session has been open.
create or replace function guard_usage_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.started_at := now();
    new.last_seen_at := now();
    new.active_seconds := 0;
    new.role := current_user_role();
    if new.modules is null or jsonb_typeof(new.modules) <> 'object' then new.modules := '{}'::jsonb; end if;
  else
    new.user_id := old.user_id;
    new.started_at := old.started_at;
    new.role := old.role;
    new.last_seen_at := now();
    new.active_seconds := least(greatest(coalesce(new.active_seconds, 0), old.active_seconds), ceil(extract(epoch from (now() - old.started_at)))::int);
    if new.modules is null or jsonb_typeof(new.modules) <> 'object' then new.modules := old.modules; end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_usage_session on usage_sessions;
create trigger guard_usage_session before insert or update on usage_sessions
  for each row execute procedure guard_usage_session();

-- Admin-only summary. Days are in the caller's time zone (p_tz). A person counts as active on every day a session
-- touched. WAU / MAU are the people active in the 7 / 30 days up to and including that day; stickiness is the
-- average daily active users over the last 30 days divided by the people active in those 30 days.
create or replace function usage_metrics(p_days int default 30, p_tz text default 'UTC')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 7), 365);
  v_today date := (now() at time zone p_tz)::date;
  v_from date := v_today - (least(greatest(coalesce(p_days, 30), 7), 365) - 1);
  v_result jsonb;
begin
  if current_user_role() is distinct from 'admin' then
    raise exception 'Only an Admin can read usage';
  end if;
  with s as (
    select id, user_id, role, modules, active_seconds,
           (started_at at time zone p_tz)::date as d_start, (last_seen_at at time zone p_tz)::date as d_end
    from usage_sessions
    where last_seen_at >= (v_from - 29)::timestamp at time zone p_tz
  ),
  ud as (select distinct s.user_id, g::date as day from s, generate_series(s.d_start, s.d_end, interval '1 day') g),
  days as (select g::date as day from generate_series(v_from, v_today, interval '1 day') g),
  daily as (
    select d.day,
      (select count(*) from ud where ud.day = d.day) as dau,
      (select count(distinct user_id) from ud where ud.day between d.day - 6 and d.day) as wau,
      (select count(distinct user_id) from ud where ud.day between d.day - 29 and d.day) as mau,
      (select count(*) from s where s.d_start = d.day) as sessions,
      (select coalesce(sum(active_seconds), 0) from s where s.d_start = d.day) as seconds
    from days d
  ),
  inrange as (select * from s where d_start >= v_from),
  last30 as (select user_id, day from ud where day > v_today - 30),
  totals as (
    select
      (select count(distinct user_id) from ud where day >= v_from) as active_users,
      (select count(*) from inrange) as sessions,
      (select coalesce(sum(active_seconds), 0) from inrange) as seconds,
      (select count(*) from ud where day >= v_from) as user_days,
      (select count(distinct user_id) from last30) as mau30,
      (select count(*) from last30) as user_days30
  ),
  by_role as (
    select coalesce(role, 'unknown') as role, count(distinct user_id) as users, count(*) as sessions, coalesce(sum(active_seconds), 0) as seconds
    from inrange group by 1 order by 4 desc
  ),
  by_module as (
    select m.key as module, sum((m.value)::numeric)::bigint as seconds, count(distinct i.user_id) as users
    from inrange i, jsonb_each_text(i.modules) m group by 1 order by 2 desc
  ),
  by_user as (
    select i.user_id, p.display_name, p.email, coalesce(max(i.role), 'unknown') as role, count(*) as sessions,
           coalesce(sum(i.active_seconds), 0) as seconds, max(i.d_end) as last_day,
           (select count(*) from ud where ud.user_id = i.user_id and ud.day >= v_from) as days_active
    from inrange i left join profiles p on p.id = i.user_id group by i.user_id, p.display_name, p.email order by 6 desc limit 200
  )
  select jsonb_build_object(
    'days', v_days, 'from', v_from, 'to', v_today, 'timezone', p_tz,
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'dau', dau, 'wau', wau, 'mau', mau, 'sessions', sessions, 'seconds', seconds) order by day), '[]'::jsonb) from daily),
    'totals', (select jsonb_build_object(
        'activeUsers', active_users, 'sessions', sessions, 'activeSeconds', seconds,
        'avgSessionSeconds', case when sessions > 0 then round(seconds::numeric / sessions) else 0 end,
        'avgSessionsPerUser', case when active_users > 0 then round(sessions::numeric / active_users, 2) else 0 end,
        'avgSecondsPerActiveDay', case when user_days > 0 then round(seconds::numeric / user_days) else 0 end,
        'dau', (select dau from daily where day = v_today), 'wau', (select wau from daily where day = v_today), 'mau', (select mau from daily where day = v_today),
        'avgDau30', case when user_days30 > 0 then round(user_days30::numeric / 30, 2) else 0 end,
        'stickiness', case when mau30 > 0 then round((user_days30::numeric / 30) / mau30, 4) else null end
      ) from totals),
    'byRole', (select coalesce(jsonb_agg(to_jsonb(by_role)), '[]'::jsonb) from by_role),
    'byModule', (select coalesce(jsonb_agg(to_jsonb(by_module)), '[]'::jsonb) from by_module),
    'users', (select coalesce(jsonb_agg(to_jsonb(by_user)), '[]'::jsonb) from by_user)
  ) into v_result;
  return v_result;
end $$;
revoke all on function usage_metrics(int, text) from public;
grant execute on function usage_metrics(int, text) to authenticated;

-- ------------------------------------------------------------------
-- Assortment plans: the approved output of the Assortment Planner, with dates, a status and a share link
-- ------------------------------------------------------------------
-- A plan groups the assortment proposals a category manager approved (proposals.status approved or applied,
-- agent 'assortment-agent'). It snapshots what each proposal changes so the plan still reads after the
-- proposal moves on, and carries the dates and status the reset teams plan around.
create table if not exists assortment_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  category text,
  status text not null default 'draft' check (status in ('draft', 'shared', 'approved', 'scheduled', 'executed', 'cancelled')),
  effective_date date,
  review_by date,
  notes text,
  proposal_ids uuid[] not null default '{}',
  items jsonb not null default '[]'::jsonb,       -- [{ proposalId, planogramId, planogramName, adds: [name], removes: [name], facings: n }]
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists assortment_plans_status_idx on assortment_plans (status, effective_date);

alter table assortment_plans enable row level security;

-- Anyone signed in can read a plan (that is what the share link relies on); only Admins and Category Managers
-- create, change or delete one.
drop policy if exists "Any role can read assortment plans" on assortment_plans;
create policy "Any role can read assortment plans" on assortment_plans for select to authenticated using (true);
drop policy if exists "Planners write assortment plans" on assortment_plans;
create policy "Planners write assortment plans" on assortment_plans for all to authenticated
  using (current_user_role() in ('admin', 'category_manager'))
  with check (current_user_role() in ('admin', 'category_manager'));

create or replace function stamp_assortment_plan() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now(); end if;
  if tg_op = 'UPDATE' then new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_by := auth.uid(); new.updated_at := now();
  return new;
end $$;
drop trigger if exists stamp_assortment_plan on assortment_plans;
create trigger stamp_assortment_plan before insert or update on assortment_plans for each row execute function stamp_assortment_plan();

-- Plans can be tied to an Event Planner event (events live in app_settings 'settings:events'); versions take its start date.
alter table assortment_plans add column if not exists event_id text;
