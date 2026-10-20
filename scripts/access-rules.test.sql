-- Verifies the database access rules in supabase/schema.sql against a REAL Postgres.
-- Run with scripts/test-access-rules.sh (needs a Postgres server; it builds a throwaway database with a
-- small stand-in for Supabase's auth schema). Every check raises an exception on failure.
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;

-- ---------- fixtures (as the database owner, which bypasses row security like the service role) ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@x'), ('00000000-0000-0000-0000-0000000000c1', 'cm@x'),
  ('00000000-0000-0000-0000-0000000000b1', 'regional@x'), ('00000000-0000-0000-0000-0000000000e1', 'planner@x'),
  ('00000000-0000-0000-0000-000000000051', 'store1@x'), ('00000000-0000-0000-0000-000000000052', 'store2@x'),
  ('00000000-0000-0000-0000-0000000000f1', 'nobody@x');
update profiles set role = 'admin' where email = 'admin@x';
update profiles set role = 'category_manager' where email = 'cm@x';
update profiles set role = 'regional_manager', regions = array['East'] where email = 'regional@x';
update profiles set role = 'event_planner' where email = 'planner@x';
update profiles set role = 'store_associate', store_id = 's1' where email = 'store1@x';
update profiles set role = 'store_associate', store_id = 's2' where email = 'store2@x';

insert into stores (id, data) values
  ('s1', '{"name":"East 1","region":"East","tasks":[],"photos":[]}'),
  ('s2', '{"name":"West 1","region":"West","tasks":[]}'),
  ('s3', '{"name":"East 2","region":"East","tasks":[]}');
insert into planograms (id, data) values
  ('p-live', '{"name":"Live","status":"live","storeIds":["s1","s3"],"sections":[{"id":"a"}],"execution":{},"issues":[{"id":"i0","storeId":"s1","message":"old"}]}'),
  ('p-sib',  '{"name":"Sibling","status":"live","storeIds":["s1"],"sections":[]}'),
  ('p-other','{"name":"Other","status":"live","storeIds":["s2"],"sections":[]}'),
  ('p-wip',  '{"name":"Draft","status":"wip","storeIds":["s1"],"sections":[]}');
insert into products (id, data) values ('pr1', '{"name":"Cola"}');
insert into performance (id, data) values ('pr1', '{"records":[]}');
insert into app_settings (key, value) values ('settings:events', '[]'), ('schema:product', '[]');
insert into escalations (planogram_id, store_id, status) values ('p-live', 's1', 'open'), ('p-other', 's2', 'open'), ('p-live', 's3', 'open');
insert into reset_impacts (planogram_id, result) values ('p-live', '{}');

-- ---------- helpers (run as whoever is signed in) ----------
create or replace function t_count(q text) returns int language plpgsql as $$
declare n int; begin execute 'select count(*) from (' || q || ') s' into n; return n; end $$;
create or replace function t_expect(label text, q text, want int) returns void language plpgsql as $$
declare got int; begin got := t_count(q); if got <> want then raise exception 'FAIL %: expected % rows, got %', label, want, got; end if; end $$;
create or replace function t_rows(label text, stmt text, want int) returns void language plpgsql as $$
declare n int; begin execute stmt; get diagnostics n = row_count; if n <> want then raise exception 'FAIL %: expected % rows affected, got %', label, want, n; end if; end $$;
create or replace function t_denied(label text, stmt text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then return; end;
  raise exception 'FAIL %: should have been refused', label;
end $$;
grant execute on all functions in schema public to authenticated;

create or replace function t_as(uid text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', uid, false); end $$;

-- ====================== store associate (store s1) ======================
set role authenticated;
select t_as('00000000-0000-0000-0000-000000000051');
select t_expect('store sees only own store', 'select 1 from stores', 1);
select t_expect('store sees only assigned, non-draft planograms', 'select 1 from planograms', 2);
select t_expect('store cannot read performance', 'select 1 from performance', 0);
select t_expect('store can read products', 'select 1 from products', 1);
select t_expect('store can read settings', 'select 1 from app_settings', 2);
select t_expect('store cannot read escalations', 'select 1 from escalations', 0);
select t_expect('store cannot read reset impacts', 'select 1 from reset_impacts', 0);
select t_rows('store updates own tasks', $q$update stores set data = jsonb_set(data, '{tasks}', '[{"id":"t1"}]') where id = 's1'$q$, 1);
select t_denied('store renames its store', $q$update stores set data = jsonb_set(data, '{name}', '"Hacked"') where id = 's1'$q$);
select t_rows('store cannot touch another store', $q$update stores set data = jsonb_set(data, '{tasks}', '[1]') where id = 's2'$q$, 0);
select t_rows('app save (upsert) of own store works', $q$insert into stores (id, data) select 's1', jsonb_set(data, '{tasks}', '[{"id":"t2"}]') from stores where id = 's1' on conflict (id) do update set data = excluded.data$q$, 1);
select t_denied('store cannot create a store', $q$insert into stores (id, data) values ('s9', '{"name":"New"}')$q$);
select t_rows('store updates its execution', $q$update planograms set data = jsonb_set(data, '{execution,s1}', '{"status":"in_progress"}') where id = 'p-live'$q$, 1);
select t_rows('store ticks an item check', $q$update planograms set data = jsonb_set(data, '{itemChecks}', '{"s1":{"pr1":true}}') where id = 'p-live'$q$, 1);
select t_denied('store edits another store''s execution', $q$update planograms set data = jsonb_set(data, '{execution,s3}', '{"status":"completed"}') where id = 'p-live'$q$);
select t_rows('store adds feedback', $q$update planograms set data = jsonb_set(data, '{issues}', (data->'issues') || '[{"id":"i1","storeId":"s1","message":"new"}]'::jsonb) where id = 'p-live'$q$, 1);
select t_denied('store adds feedback for another store', $q$update planograms set data = jsonb_set(data, '{issues}', (data->'issues') || '[{"id":"i2","storeId":"s2","message":"x"}]'::jsonb) where id = 'p-live'$q$);
select t_denied('store deletes existing feedback', $q$update planograms set data = jsonb_set(data, '{issues}', '[]') where id = 'p-live'$q$);
select t_denied('store edits the planogram layout', $q$update planograms set data = jsonb_set(data, '{sections}', '[]') where id = 'p-live'$q$);
select t_denied('store renames a planogram', $q$update planograms set data = jsonb_set(data, '{name}', '"X"') where id = 'p-live'$q$);
select t_denied('store reassigns a planogram to other stores', $q$update planograms set data = jsonb_set(data, '{storeIds}', '["s1","s2"]') where id = 'p-live'$q$);
select t_rows('store retires the replaced sibling', $q$update planograms set data = jsonb_set(data, '{status}', '"historical"') where id = 'p-sib'$q$, 1);
select t_denied('store cannot send a planogram back to draft', $q$update planograms set data = jsonb_set(data, '{status}', '"wip"') where id = 'p-live'$q$);
select t_rows('store cannot touch an unassigned planogram', $q$update planograms set data = jsonb_set(data, '{execution,s1}', '{"status":"x"}') where id = 'p-other'$q$, 0);
select t_rows('app save (upsert) of a planogram works', $q$insert into planograms (id, data) select id, data from planograms where id = 'p-live' on conflict (id) do update set data = excluded.data$q$, 1);
select t_denied('store cannot create a planogram', $q$insert into planograms (id, data) values ('p-new', '{"name":"N","status":"live","storeIds":["s1"]}')$q$);
select t_rows('store cannot delete a planogram', $q$delete from planograms where id = 'p-live'$q$, 0);
select t_denied('store cannot write products', $q$insert into products (id, data) values ('x', '{}')$q$);
select t_denied('store cannot write settings', $q$insert into app_settings (key, value) values ('settings:events', '[1]') on conflict (key) do update set value = excluded.value$q$);
select t_denied('store cannot change its own store assignment', $q$update profiles set store_id = 's2' where email = 'store1@x'$q$);
select t_denied('store cannot promote itself', $q$update profiles set role = 'admin' where email = 'store1@x'$q$);
select t_rows('store can change its own display name', $q$update profiles set display_name = 'Sam' where email = 'store1@x'$q$, 1);
reset role;

-- ====================== a store user without a store ======================
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000f1');
select t_expect('unassigned user sees no stores', 'select 1 from stores', 0);
select t_expect('unassigned user sees no planograms', 'select 1 from planograms', 0);
reset role;

-- ====================== regional manager (East = s1, s3) ======================
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000b1');
select t_expect('regional sees stores in region', 'select 1 from stores', 2);
select t_expect('regional sees planograms in region', 'select 1 from planograms', 2);
select t_expect('regional cannot read performance', 'select 1 from performance', 0);
select t_expect('regional sees region escalations only', 'select 1 from escalations', 2);
select t_rows('regional updates a region store execution', $q$update planograms set data = jsonb_set(data, '{execution,s3}', '{"status":"in_progress"}') where id = 'p-live'$q$, 1);
select t_denied('regional cannot write outside the region', $q$update planograms set data = jsonb_set(data, '{execution,s2}', '{"status":"x"}') where id = 'p-live'$q$);
select t_rows('regional cannot touch a West store', $q$update stores set data = jsonb_set(data, '{tasks}', '[1]') where id = 's2'$q$, 0);
select t_rows('regional resolves an escalation in region', $q$update escalations set status = 'resolved' where store_id = 's3'$q$, 1);
select t_rows('regional cannot resolve another region''s escalation', $q$update escalations set status = 'resolved' where store_id = 's2'$q$, 0);
select t_denied('regional cannot change own regions', $q$update profiles set regions = array['East','West'] where email = 'regional@x'$q$);
reset role;

-- ====================== event planner ======================
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000e1');
select t_expect('planner reads all stores', 'select 1 from stores', 3);
select t_expect('planner reads all planograms', 'select 1 from planograms', 4);
select t_expect('planner cannot read performance', 'select 1 from performance', 0);
select t_expect('planner reads products', 'select 1 from products', 1);
select t_rows('planner saves events', $q$update app_settings set value = '[1]' where key = 'settings:events'$q$, 1);
select t_rows('planner cannot change other settings', $q$update app_settings set value = '[1]' where key = 'schema:product'$q$, 0);
select t_denied('planner cannot invent settings keys', $q$insert into app_settings (key, value) values ('settings:other', '1')$q$);
select t_rows('planner cannot edit planograms', $q$update planograms set data = jsonb_set(data, '{name}', '"X"')$q$, 0);
select t_rows('planner cannot edit stores', $q$update stores set data = jsonb_set(data, '{name}', '"X"')$q$, 0);
select t_denied('planner cannot write products', $q$insert into products (id, data) values ('y', '{}')$q$);
reset role;

-- ====================== category manager and admin ======================
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000c1');
select t_expect('category manager reads everything', 'select 1 from planograms', 4);
select t_expect('category manager reads performance', 'select 1 from performance', 1);
select t_rows('category manager edits a layout', $q$update planograms set data = jsonb_set(data, '{sections}', '[]') where id = 'p-live'$q$, 1);
select t_rows('category manager edits settings', $q$update app_settings set value = '[2]' where key = 'schema:product'$q$, 1);
select t_denied('category manager cannot change roles', $q$update profiles set role = 'admin' where email = 'cm@x'$q$);
select t_as('00000000-0000-0000-0000-0000000000a1');
select t_rows('admin assigns a store', $q$update profiles set store_id = 's3' where email = 'store2@x'$q$, 1);
select t_rows('admin sets regions', $q$update profiles set regions = array['West'] where email = 'regional@x'$q$, 1);
reset role;

-- ====================== service role / SQL editor (no signed-in user) ======================
select set_config('request.jwt.claim.sub', '', false);
update profiles set role = 'regional_manager' where email = 'store2@x';
update profiles set role = 'store_associate' where email = 'store2@x';

select 'ALL ACCESS RULE CHECKS PASSED' as result;
