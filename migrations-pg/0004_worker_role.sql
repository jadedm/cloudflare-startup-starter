-- The Worker connects as app_worker, not as postgres: on Supabase, postgres has
-- BYPASSRLS and can change the schema, so a compromised Worker could read or
-- rewrite anything. app_worker gets row access to the six app tables and
-- nothing else. Its password is set outside migrations
-- (scripts/set-worker-password.mjs), so the role is created without login.
-- Roles belong to the whole Postgres server, not to one database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_worker') then
    create role app_worker nologin nocreatedb nocreaterole nobypassrls noinherit;
  end if;
end
$$;

-- Set every time, so a role that already existed with more (made by hand with
-- BYPASSRLS or CREATEROLE) loses it. REPLICATION would let the role stream the
-- whole WAL past RLS.
alter role app_worker nocreatedb nocreaterole nobypassrls noinherit noreplication;

-- NOSUPERUSER may only be named by a superuser. Supabase's postgres is not one
-- (and so cannot have granted it); a plain Postgres's postgres is.
do $$
begin
  if (select rolsuper from pg_roles where rolname = current_user) then
    alter role app_worker nosuperuser;
  end if;
end
$$;

grant usage on schema public to app_worker;
grant select, insert, update, delete
  on table "user", "session", "account", "verification", "rateLimit", "note"
  to app_worker;

-- RLS stays on to keep anon and authenticated out (0003). With RLS on and no
-- policy, the Worker would see no rows either. Better Auth looks sessions and
-- counters up by token and key across all users, so the policy cannot be
-- narrower than every row. Isolation between users is the application's
-- "userId" predicate; what the role removes is DDL, BYPASSRLS and access
-- outside these tables.
do $$
declare
  t text;
begin
  foreach t in array array['user', 'session', 'account', 'verification', 'rateLimit', 'note'] loop
    execute format('drop policy if exists worker_rows on %I', t);
    execute format('create policy worker_rows on %I for all to app_worker using (true) with check (true)', t);
  end loop;
end
$$;

-- Supabase's default privileges grant every new table, sequence and function
-- in public to anon and authenticated, so 0003's revokes covered only the
-- tables that existed then. This runs as the migrating role (postgres on
-- Supabase, the owner of the app tables), so it covers what later migrations
-- create. Functions are also executable by PUBLIC through the global default,
-- which a per-schema rule cannot take away, so that revoke is global for the
-- migrating role: a function it creates later in any schema of this database,
-- such as an RPC meant for the Data API, needs an explicit grant.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end
$$;
alter default privileges revoke execute on functions from public;

-- Default privileges only shape objects created later. Anything already in
-- public keeps Supabase's grants to anon and authenticated, and functions keep
-- PUBLIC's execute. This is why the Postgres option expects a database of its
-- own: in a shared one, it also takes these away from objects that are not
-- the app's.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
    end if;
  end loop;
end
$$;
revoke execute on all functions in schema public from public;

-- Not changed: PUBLIC holds TEMPORARY on the database by default, so the worker
-- can create temp tables (scripts/check-worker-role.sql records it). Revoking
-- it from PUBLIC would reach every role.
