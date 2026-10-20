#!/usr/bin/env bash
# Runs scripts/access-rules.test.sql against a real Postgres. Needs psql plus a reachable server
# (set PGHOST/PGPORT/PGUSER as usual). Builds a throwaway database, a stand-in for Supabase's auth
# schema, applies supabase/schema.sql TWICE (it must be re-runnable), then runs the checks.
set -euo pipefail
cd "$(dirname "$0")/.."
DB="tandom_access_test_$$"
trap 'dropdb --if-exists "$DB" >/dev/null 2>&1 || true' EXIT
createdb "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public, auth to authenticated, anon, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on functions to authenticated, service_role;
SQL
for pass in 1 2; do psql -q -d "$DB" -v ON_ERROR_STOP=1 -f supabase/schema.sql 2>&1 | grep -v "NOTICE" || true; done
psql -q -t -A -d "$DB" -f scripts/access-rules.test.sql
