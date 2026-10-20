-- Checks the Worker role and the default-privilege lockdown.
-- Run as the migrating role (postgres). Probe objects are created inside the
-- transaction and rolled back. Prints one row per check, then raises an error
-- (non-zero exit under psql -v ON_ERROR_STOP=1) if any required check is not
-- true. A missing role makes its checks false, not empty.
-- has_table_privilege with a comma list is true if ANY listed privilege is
-- held, so "has all of" is checked one privilege at a time; "has none of" can
-- use the list.
begin;

create table public.probe_role (i int);
create sequence public.probe_role_seq;
create function public.probe_role_fn() returns int language sql as 'select 1';

create temp table worker_checks on commit drop as
with app(t) as (values ('user'), ('session'), ('account'), ('verification'), ('rateLimit'), ('note')),
dml(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')),
api(r) as (select rolname from pg_roles where rolname in ('anon', 'authenticated')),
w as (select * from pg_roles where rolname = 'app_worker')
select * from (
  select 'R3 worker exists, with no superuser, bypassrls, createrole or createdb' as check_name,
         coalesce((select not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb) from w), false) as pass
  union all
  select 'R3 worker is a member of no role and has no replication',
         exists (select 1 from w) and not (select rolreplication from w)
         and not exists (select 1 from pg_auth_members m where m.member = (select oid from w))
  union all
  select 'R3 worker can log in and connect, and has usage on public (else every check above is moot)',
         coalesce((select rolcanlogin and has_database_privilege(oid, current_database(), 'CONNECT')
                          and has_schema_privilege(oid, 'public', 'USAGE') from w), false)
  union all
  select 'R5 anon and authenticated both exist (the API checks below would pass vacuously without them)',
         (select count(*) = 2 from api)
  union all
  select 'R2 worker cannot create in public',
         exists (select 1 from w) and not has_schema_privilege((select oid from w), 'public', 'CREATE')
  union all
  select 'R2 worker is not a member of the owner of any app table (an owner bypasses RLS)',
         exists (select 1 from w)
         and (select count(*) = 6 and bool_and(not pg_has_role((select oid from w), c.relowner, 'MEMBER'))
              from pg_class c join pg_namespace n on n.oid = c.relnamespace join app on c.relname = app.t
              where n.nspname = 'public' and c.relkind = 'r')
  union all
  select 'R3 worker has no usage on app_meta, auth or vault (the last two Supabase only; trivially true without them)',
         exists (select 1 from w)
         and not exists (select 1 from pg_namespace n where n.nspname in ('app_meta', 'auth', 'vault') and has_schema_privilege((select oid from w), n.oid, 'USAGE'))
  union all
  select 'R1 worker has each of select, insert, update, delete on all six app tables',
         exists (select 1 from w)
         and (select bool_and(has_table_privilege((select oid from w), format('public.%I', t), p)) from app, dml)
  union all
  select 'R1 worker has no truncate, references or trigger on the app tables',
         exists (select 1 from w)
         and (select not bool_or(has_table_privilege((select oid from w), format('public.%I', t), 'TRUNCATE,REFERENCES,TRIGGER')) from app)
  union all
  select 'R5 anon and authenticated have nothing on the app tables',
         coalesce((select not bool_or(has_table_privilege(r, format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) from app, api), true)
  union all
  select 'R5 row level security is on for all six app tables',
         (select count(*) = 6 and bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
          join app on c.relname = app.t where n.nspname = 'public' and c.relkind = 'r')
  union all
  select 'R4 anon and authenticated have nothing on a new table',
         coalesce((select not bool_or(has_table_privilege(r, 'public.probe_role', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) from api), true)
  union all
  select 'R12 anon and authenticated have nothing on a new sequence',
         coalesce((select not bool_or(has_sequence_privilege(r, 'public.probe_role_seq', 'USAGE,SELECT,UPDATE')) from api), true)
  union all
  select 'R12 no API role or PUBLIC can execute a new function',
         coalesce((select not bool_or(has_function_privilege(r, 'public.probe_role_fn()', 'EXECUTE')) from api), true)
         and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = 'public.probe_role_fn()'::regprocedure and a.grantee = 0)
  union all
  select 'R13 each app table has exactly one policy, worker_rows: app_worker only, all commands, permissive, true/true',
         (select count(*) = 6 and count(distinct p.tablename) = 6 and bool_and(p.roles = '{app_worker}'::name[])
                 and bool_and(p.policyname = 'worker_rows' and p.cmd = 'ALL' and p.permissive = 'PERMISSIVE' and p.qual = 'true' and p.with_check = 'true')
          from pg_policies p join app on p.tablename = app.t where p.schemaname = 'public')
  union all
  select 'R13 no app-table policy applies to PUBLIC',
         not exists (select 1 from pg_policies p join app on p.tablename = app.t where p.schemaname = 'public' and 'public' = any(p.roles))
  union all
  select 'R15 worker can create temp tables (recorded, not required)',
         coalesce((select has_database_privilege(oid, current_database(), 'TEMP') from w), false)
) checks;

select check_name, pass from worker_checks;

do $$
declare
  failed text;
begin
  select string_agg(check_name, '; ') into failed
  from worker_checks where pass is not true and check_name not like 'R15 %';
  if failed is not null then
    raise exception 'worker role checks failed: %', failed;
  end if;
end
$$;

rollback;
