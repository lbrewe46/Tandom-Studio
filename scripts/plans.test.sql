-- Assortment plan access rules, against a real Postgres. Run by scripts/test-access-rules.sh.
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;
create or replace function t_as(uid text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', uid, false); end $$;
set role authenticated;
select t_as('00000000-0000-0000-0000-0000000000a1');  -- admin
insert into assortment_plans (name, category, items) values ('Spring bath tissue', 'Bath Tissue', '[{"planogramId":"A"}]');
do $$ begin
  if (select count(*) from assortment_plans) <> 1 then raise exception 'FAIL: admin should read the plan'; end if;
  if (select created_by from assortment_plans) is distinct from '00000000-0000-0000-0000-0000000000a1'::uuid then raise exception 'FAIL: created_by is stamped from the caller'; end if;
end $$;
-- a bad status is refused
do $$ begin
  begin insert into assortment_plans (name, status) values ('x', 'bogus'); raise exception 'FAIL: bogus status accepted';
  exception when check_violation then null; end;
  begin insert into assortment_plans (name) values ('   '); raise exception 'FAIL: blank name accepted';
  exception when check_violation then null; end;
end $$;
-- someone else (store associate) can read but not write
select t_as('00000000-0000-0000-0000-0000000000d3');
do $$ declare n int; begin
  if (select count(*) from assortment_plans) <> 1 then raise exception 'FAIL: any role reads plans'; end if;
  begin insert into assortment_plans (name) values ('nope'); raise exception 'FAIL: store associate created a plan';
  exception when insufficient_privilege then null; end;
  update assortment_plans set status = 'executed'; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: store associate changed a plan'; end if;
  delete from assortment_plans; get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL: store associate deleted a plan'; end if;
end $$;
-- a category manager can change it, and updated_at / created_by stay honest
select t_as('00000000-0000-0000-0000-0000000000d1');
do $$ declare n int; begin
  update assortment_plans set status = 'scheduled', effective_date = current_date + 14, created_by = '00000000-0000-0000-0000-0000000000d1'; get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: category manager should update'; end if;
  if (select created_by from assortment_plans) is distinct from '00000000-0000-0000-0000-0000000000a1'::uuid then raise exception 'FAIL: created_by must not be rewritable'; end if;
  if (select updated_by from assortment_plans) is distinct from '00000000-0000-0000-0000-0000000000d1'::uuid then raise exception 'FAIL: updated_by stamped'; end if;
end $$;
reset role;
select 'plans ok';
