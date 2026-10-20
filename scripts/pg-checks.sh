#!/usr/bin/env bash
# Database-side checks for the Postgres option (#4), against the local Docker
# Postgres with no Worker running: the worker role's privileges and a control
# that proves the role check can fail, what the role and the Data API roles are
# refused, migrations run twice and onto existing rows, and the password script.
# The Worker-side cases are the pg-* groups of scripts/local-suite.sh.
# usage: scripts/pg-checks.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/pg-local.sh
source scripts/pg-local.sh

pass=0
fail=0
check() {
  local id="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); echo "PASS $id: $got"
    return
  fi
  fail=$((fail + 1)); echo "FAIL $id: got '$got', want '$want'"
}
# As the owner, or as another role through SET ROLE. Prints ok or the SQLSTATE.
as_role() {
  local role="$1" query="$2" out
  out=$(docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$PG_CONTAINER" psql -U postgres -d "$PG_DB" -qtA \
    -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -c "set role ${role}" -c "$query" 2>&1 >/dev/null) && { echo ok; return; }
  sed -nE 's/.*ERROR: +([0-9A-Z]{5}).*/\1/p' <<<"$out" | head -1
}
owner_sql() { docker exec -i "$PG_CONTAINER" psql -U postgres -d "$PG_DB" -qtA -v ON_ERROR_STOP=1 -c "$1"; }
role_check() {
  docker exec -i "$PG_CONTAINER" psql -U postgres -d "$PG_DB" -qtA -v ON_ERROR_STOP=1 <scripts/check-worker-role.sql >"$PG_STATE_DIR/role-check.out" 2>&1 && echo pass || echo fail
}

pg_up
pg_reset

# 18: a second run applies nothing; a changed applied file is refused.
check "18 second run" "$(node scripts/migrate-pg.mjs "${PG_OWNER_ARGS[@]}")" "nothing to apply"
owner_sql "update app_meta.migrations set sha256 = 'x' where name like '0004_%'" >/dev/null
check "18 changed file refused" "$(node scripts/migrate-pg.mjs "${PG_OWNER_ARGS[@]}" >/dev/null 2>&1 && echo applied || echo refused)" "refused"
pg_reset

# 7 and 8: every role check passes, and fails once the role can bypass RLS.
check "7 role check" "$(role_check)" "pass"
check "7 checks listed" "$(grep -c '|t$' "$PG_STATE_DIR/role-check.out")" "17"
owner_sql "alter role app_worker bypassrls" >/dev/null
check "8 bypassrls control" "$(role_check) $(grep -c 'worker role checks failed' "$PG_STATE_DIR/role-check.out")" "fail 1"
owner_sql "alter role app_worker nobypassrls" >/dev/null
check "8 restored" "$(role_check)" "pass"

# 9: what the worker role is refused (42501 is insufficient privilege).
owner_sql 'create table "other_app_table" (i int)' >/dev/null
check "9 create table" "$(as_role app_worker 'create table "x" (i int)')" "42501"
check "9 pg_authid" "$(as_role app_worker 'select count(*) from pg_authid')" "42501"
check "9 table outside the six" "$(as_role app_worker 'select count(*) from "other_app_table"')" "42501"
check "9 migration ledger" "$(as_role app_worker 'select count(*) from app_meta.migrations')" "42501"
check "9 truncate" "$(as_role app_worker 'truncate "note"')" "42501"
check "9 allowed: select note" "$(as_role app_worker 'select count(*) from "note"')" "ok"

# 10: the Data API roles see none of the app tables, nor one made later.
for t in user session account verification rateLimit note; do
  check "10 anon $t" "$(as_role anon "select count(*) from \"$t\"")" "42501"
  check "10 authenticated $t" "$(as_role authenticated "select count(*) from \"$t\"")" "42501"
done
check "10 anon, later table" "$(as_role anon 'select count(*) from "other_app_table"')" "42501"

# 30: later migrations onto a database that already holds rows, beside an
# unrelated table with its own grant.
pg_empty
pg_migrate --until 0002
owner_sql "insert into \"user\" values ('u1', 'n', 'u1@example.test', false, null, now(), now());
  insert into \"session\" values ('s1', now() + interval '1 day', 'tok', now(), now(), null, null, 'u1');
  insert into \"account\" (\"id\", \"accountId\", \"providerId\", \"userId\", \"createdAt\", \"updatedAt\") values ('a1', 'u1', 'credential', 'u1', now(), now());
  insert into \"verification\" values ('v1', 'i', 'v', now(), now(), now());
  insert into \"rateLimit\" values ('r1', 'k', 1, 1);
  insert into \"note\" values ('n1', 'u1', 'kept', now());
  create table \"unrelated\" (i int); grant select on \"unrelated\" to anon;" >/dev/null
pg_migrate
pg_worker_login
check "30 rows kept" "$(owner_sql 'select (select count(*) from "user") + (select count(*) from "session") + (select count(*) from "account") + (select count(*) from "verification") + (select count(*) from "rateLimit") + (select count(*) from "note")')" "6"
check "30 unrelated grant kept" "$(as_role anon 'select count(*) from "unrelated"')" "ok"
check "30 role check" "$(role_check)" "pass"

# 32: the password script. Mode 600, the login check passes, an existing file
# and a symlink are refused, and nothing it prints contains the password.
pw_dir=$(mktemp -d)
trap 'rm -rf "$pw_dir"' EXIT
pw_out=$(node scripts/set-worker-password.mjs --out "$pw_dir/pw" "${PG_OWNER_ARGS[@]}" 2>&1)
check "32 mode" "$(stat -f '%Lp' "$pw_dir/pw")" "600"
check "32 login check" "$(grep -c 'login check: current_user=app_worker, bypassrls=false' <<<"$pw_out")" "1"
check "32 password not printed" "$(grep -cF "$(cat "$pw_dir/pw")" <<<"$pw_out" || true)" "0"
check "32 existing file refused" "$(node scripts/set-worker-password.mjs --out "$pw_dir/pw" "${PG_OWNER_ARGS[@]}" >/dev/null 2>&1 && echo ran || echo refused)" "refused"
ln -s "$pw_dir/elsewhere" "$pw_dir/link"
check "32 symlink refused" "$(node scripts/set-worker-password.mjs --out "$pw_dir/link" "${PG_OWNER_ARGS[@]}" >/dev/null 2>&1 && echo ran || echo refused) $([[ -e "$pw_dir/elsewhere" ]] && echo written || echo absent)" "refused absent"
check "32 tls off refused off loopback" "$(node scripts/set-worker-password.mjs --out "$pw_dir/x" --host db.example.test --owner-password-file "$PG_STATE_DIR/owner-password" --tls off >/dev/null 2>&1 && echo ran || echo refused)" "refused"

# 5 (Supabase-shaped owner): Supabase's postgres is not a superuser; it holds
# CREATEROLE, CREATEDB, BYPASSRLS and REPLICATION. Docker's postgres is a
# superuser, so every run above could pass where Supabase would refuse. Here
# the whole migration runs as an owner shaped like Supabase's, which creates
# app_worker itself, as it would on a fresh project.
check "5 timeouts on the role" "$(owner_sql "select array_to_string(rolconfig, ',') from pg_roles where rolname = 'app_worker'")" "statement_timeout=3s,idle_in_transaction_session_timeout=10s"
pg_psql -d postgres <<'SQL'
drop database if exists starter_shape with (force);
drop database if exists starter_local with (force);
drop role if exists app_worker;
drop role if exists shaped_owner;
create role shaped_owner login password 'localonly' nosuperuser createrole createdb bypassrls replication inherit;
create database starter_shape owner shaped_owner;
SQL
pg_psql -d starter_shape <<'SQL'
grant usage on schema public to anon, authenticated;
alter default privileges for role shaped_owner in schema public grant all on tables to anon, authenticated;
alter default privileges for role shaped_owner in schema public grant all on sequences to anon, authenticated;
alter default privileges for role shaped_owner in schema public grant all on functions to anon, authenticated;
SQL
shaped=$(node scripts/migrate-pg.mjs --host 127.0.0.1 --port "$PG_PORT" --database starter_shape --owner shaped_owner \
  --owner-password-file "$PG_STATE_DIR/owner-password" --tls off 2>&1 | tail -1)
check "5 migrate as a non-superuser owner" "$shaped" "applied 5 of 5"
check "5 owner is not a superuser" "$(docker exec -i "$PG_CONTAINER" psql -U postgres -d starter_shape -qtAc "select rolsuper from pg_roles where rolname = 'shaped_owner'")" "f"
shaped_pw=$(mktemp -d)
check "5 password as a non-superuser owner" "$(node scripts/set-worker-password.mjs --out "$shaped_pw/pw" --host 127.0.0.1 --port "$PG_PORT" --database starter_shape \
  --owner shaped_owner --owner-password-file "$PG_STATE_DIR/owner-password" --tls off 2>&1 | grep -c 'login check: current_user=app_worker, bypassrls=false')" "1"
rm -rf "$shaped_pw"
# As the owner, as on Supabase, where the checks' probe objects are created by
# the same role that ran the migrations.
check "5 role check" "$(docker exec -i "$PG_CONTAINER" psql -U postgres -d starter_shape -qtA -v ON_ERROR_STOP=1 -c 'set role shaped_owner' -f - <scripts/check-worker-role.sql >"$PG_STATE_DIR/role-check-shaped.out" 2>&1 && echo pass || echo fail)" "pass"
pg_psql -d postgres <<'SQL'
drop database starter_shape with (force);
drop role app_worker;
drop role shaped_owner;
SQL

pg_reset
echo "pass $pass, fail $fail"
[[ $fail -eq 0 && $pass -gt 0 ]]
