# Sourced by scripts/local-suite.sh and scripts/pg-checks.sh: the local
# Docker Postgres for the Postgres option (#4), and a reset of its database to
# empty, migrated from migrations-pg as the owner. Callers run from the repo root.
PG_STATE_DIR="${TMPDIR:-/tmp}/starter-app-pg"
mkdir -p -m 700 "$PG_STATE_DIR"

# The local Postgres. Its passwords are local-only placeholders, the same ones
# wrangler.pg.jsonc names. The reset first gives public the default privileges
# Supabase gives it (every new table, sequence and function granted to anon and
# authenticated), so the revokes in migrations-pg are tested against the same
# starting point.
PG_CONTAINER=starter-pg
PG_PORT=54330
PG_DB=starter_local
pg_psql() { docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$PG_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q "$@" >/dev/null; }
pg_up() {
  if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
    docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=localonly -p "127.0.0.1:${PG_PORT}:5432" postgres:17 >/dev/null
  fi
  docker start "$PG_CONTAINER" >/dev/null
  for _ in $(seq 1 30); do
    docker exec "$PG_CONTAINER" pg_isready -U postgres -q && return 0
    sleep 1
  done
  echo "Postgres in $PG_CONTAINER never became ready" >&2
  return 1
}
# The owner's connection options for scripts/migrate-pg.mjs and
# scripts/set-worker-password.mjs.
printf 'localonly' >"$PG_STATE_DIR/owner-password"
PG_OWNER_ARGS=(--host 127.0.0.1 --port "$PG_PORT" --database "$PG_DB" --owner-password-file "$PG_STATE_DIR/owner-password" --tls off)
# An empty database with Supabase's default privileges on public.
pg_empty() {
  pg_psql -d postgres <<SQL
drop database if exists ${PG_DB} with (force);
drop role if exists app_worker;
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end \$\$;
create database ${PG_DB};
SQL
  pg_psql -d "$PG_DB" <<'SQL'
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
SQL
}
# Extra arguments go to scripts/migrate-pg.mjs (for example --until).
pg_migrate() {
  node scripts/migrate-pg.mjs "${PG_OWNER_ARGS[@]}" "$@" >/dev/null
}
# Local only: a deployed password is set by scripts/set-worker-password.mjs.
pg_worker_login() {
  pg_psql -d "$PG_DB" -c "alter role app_worker login password 'localonly-worker'"
}
pg_reset() {
  pg_empty
  pg_migrate
  pg_worker_login
}
