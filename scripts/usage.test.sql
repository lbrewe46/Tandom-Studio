-- Usage analytics rules and numbers, against a real Postgres. Run by scripts/test-access-rules.sh after the access checks.
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'u1@x'), ('00000000-0000-0000-0000-0000000000d2', 'u2@x'), ('00000000-0000-0000-0000-0000000000d3', 'u3@x')
  on conflict do nothing;
update profiles set role = 'category_manager' where email in ('u1@x', 'u2@x');
update profiles set role = 'store_associate', store_id = 's1' where email = 'u3@x';

-- known history, written as the owner (bypasses the guard's "now" by updating afterwards)
create or replace function t_hist(uid uuid, days_ago int, secs int, mods jsonb, role_ text) returns void language plpgsql as $$
declare sid uuid := gen_random_uuid(); begin
  insert into usage_sessions (id, user_id, modules) values (sid, uid, mods);
  alter table usage_sessions disable trigger guard_usage_session;
  update usage_sessions set started_at = (now() - make_interval(days => days_ago)), last_seen_at = (now() - make_interval(days => days_ago)) + make_interval(secs => secs),
    active_seconds = secs, role = role_ where id = sid;
  alter table usage_sessions enable trigger guard_usage_session;
end $$;
select t_hist('00000000-0000-0000-0000-0000000000d1', 0, 600, '{"spacePlanner":600}', 'category_manager');
select t_hist('00000000-0000-0000-0000-0000000000d1', 0, 300, '{"assortment":300}', 'category_manager');
select t_hist('00000000-0000-0000-0000-0000000000d2', 0, 900, '{"spacePlanner":900}', 'category_manager');
select t_hist('00000000-0000-0000-0000-0000000000d1', 1, 1200, '{"spacePlanner":1200}', 'category_manager');
select t_hist('00000000-0000-0000-0000-0000000000d3', 10, 120, '{"storeAssistant":120}', 'store_associate');

-- helpers (as whoever is signed in)
create or replace function t_as(uid text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', uid, false); end $$;

-- 1. only an Admin can read, and only through RLS or the function
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000a1');  -- admin
do $$ declare j jsonb; begin
  j := usage_metrics(30, 'UTC');
  if (j->'totals'->>'activeUsers')::int <> 3 then raise exception 'FAIL: expected 3 active users in 30 days, got %', j->'totals'->>'activeUsers'; end if;
  if (j->'totals'->>'sessions')::int <> 5 then raise exception 'FAIL: expected 5 sessions, got %', j->'totals'->>'sessions'; end if;
  if (j->'totals'->>'activeSeconds')::int <> 3120 then raise exception 'FAIL: active seconds, got %', j->'totals'->>'activeSeconds'; end if;
  if (j->'totals'->>'avgSessionSeconds')::int <> 624 then raise exception 'FAIL: avg session seconds, got %', j->'totals'->>'avgSessionSeconds'; end if;
  if (j->'totals'->>'avgSessionsPerUser')::numeric <> 1.67 then raise exception 'FAIL: avg sessions per user, got %', j->'totals'->>'avgSessionsPerUser'; end if;
  if (j->'totals'->>'dau')::int <> 2 then raise exception 'FAIL: DAU today should be 2, got %', j->'totals'->>'dau'; end if;
  if (j->'totals'->>'wau')::int <> 2 then raise exception 'FAIL: WAU should be 2, got %', j->'totals'->>'wau'; end if;
  if (j->'totals'->>'mau')::int <> 3 then raise exception 'FAIL: MAU should be 3, got %', j->'totals'->>'mau'; end if;
  -- user-days in the last 30 = u1 today, u1 yesterday, u2 today, u3 ten days ago = 4 ; 4/30 = 0.13 ; / 3 users = 0.0444
  if (j->'totals'->>'stickiness')::numeric <> 0.0444 then raise exception 'FAIL: stickiness, got %', j->'totals'->>'stickiness'; end if;
  if (select (m->>'seconds')::int from jsonb_array_elements(j->'byModule') m where m->>'module' = 'spacePlanner') <> 2700 then raise exception 'FAIL: space planner seconds'; end if;
  if jsonb_array_length(j->'daily') <> 30 then raise exception 'FAIL: daily series length'; end if;
  if (j->'daily'->29->>'dau')::int <> 2 or (j->'daily'->28->>'dau')::int <> 1 then raise exception 'FAIL: daily DAU for today and yesterday'; end if;
  if (select count(*) from usage_sessions) <> 5 then raise exception 'FAIL: admin should read every session'; end if;
end $$;

-- 2. everyone else is refused the summary and sees no other person's sessions
select t_as('00000000-0000-0000-0000-0000000000c1');  -- category manager
do $$ begin
  begin perform usage_metrics(30, 'UTC'); raise exception 'FAIL: a category manager read usage'; exception when others then if sqlerrm not like 'Only an Admin%' then raise; end if; end;
  if (select count(*) from usage_sessions) <> 0 then raise exception 'FAIL: a non-admin could read other people''s sessions'; end if;
end $$;

-- 3. a person records only their own sessions; the database sets the times, and active time is capped
select t_as('00000000-0000-0000-0000-0000000000d1');
do $$ declare sid uuid := gen_random_uuid(); r usage_sessions; n int; begin
  insert into usage_sessions (id, user_id, started_at, active_seconds, modules) values (sid, '00000000-0000-0000-0000-0000000000d1', now() - interval '3 days', 99999, '{"x":1}');
  update usage_sessions set active_seconds = 99999, modules = '{"spacePlanner":5}' where id = sid;
  get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL: a person could not update their own session (% rows)', n; end if;
  begin insert into usage_sessions (id, user_id) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000d2'); raise exception 'FAIL: recorded a session for someone else'; exception when insufficient_privilege or others then if sqlerrm like 'FAIL%' then raise; end if; end;
end $$;
reset role;
do $$ declare r usage_sessions; begin
  select * into r from usage_sessions where user_id = '00000000-0000-0000-0000-0000000000d1' and started_at > now() - interval '1 minute' order by started_at desc limit 1;
  if r.started_at < now() - interval '1 minute' then raise exception 'FAIL: the browser set the start time'; end if;
  if r.active_seconds > 5 then raise exception 'FAIL: active seconds exceeded the time open (%)', r.active_seconds; end if;
  if r.role <> 'category_manager' then raise exception 'FAIL: role not taken from the profile, got %', r.role; end if;
end $$;

-- 4. a person can't edit or move someone else's session
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000d2');
do $$ declare n int; begin
  if (select count(*) from usage_sessions) <> 1 then raise exception 'FAIL: a person should see exactly their own one session'; end if;
  update usage_sessions set active_seconds = 1 where user_id = '00000000-0000-0000-0000-0000000000d1';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL: updated another person''s sessions'; end if;
end $$;
reset role;
\echo ALL USAGE CHECKS PASSED
