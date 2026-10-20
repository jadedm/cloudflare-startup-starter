-- Supabase serves tables in the public schema through its Data API as the
-- anon and authenticated roles. These tables hold users, sessions and their
-- tokens, OAuth state and rate-limit counters, and are only ever read by the
-- Worker through Hyperdrive, so the API must see none of them.
-- RLS with no policies denies every row to non-owner roles; the revokes remove
-- table access outright. The Worker's own role and policy come in 0004.
alter table "user" enable row level security;
alter table "session" enable row level security;
alter table "account" enable row level security;
alter table "verification" enable row level security;
alter table "rateLimit" enable row level security;
alter table "note" enable row level security;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table "user", "session", "account", "verification", "rateLimit", "note" from %I', r);
    end if;
  end loop;
end
$$;
