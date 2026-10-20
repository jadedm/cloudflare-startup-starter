#!/usr/bin/env bash
# Fails if migrations-pg/0001_auth_tables.sql differs from the schema Better
# Auth generates for Postgres, so an upgrade that changes Better Auth's tables
# cannot ship with stale migrations. Generates into a throwaway database in the
# local Postgres container, then drops it.
# usage: scripts/check-pg-schema.sh   (PG_CONTAINER and PG_PORT override the defaults)
set -euo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="${PG_CONTAINER:-starter-pg}"
PG_PORT="${PG_PORT:-54330}"
DB="schema_check_$$"
OUT="$(mktemp)"
cleanup() {
  rm -f "$OUT"
  docker exec "$PG_CONTAINER" psql -U postgres -qc "drop database if exists ${DB}" >/dev/null
}
trap cleanup EXIT

docker exec "$PG_CONTAINER" psql -U postgres -qc "create database ${DB}" >/dev/null
PG_URL="postgres://postgres:localonly@127.0.0.1:${PG_PORT}/${DB}" node scripts/gen-auth-migration-pg.mjs "$OUT" >/dev/null
if ! diff -u migrations-pg/0001_auth_tables.sql "$OUT"; then
  echo "migrations-pg/0001_auth_tables.sql differs from Better Auth's generated schema (above)" >&2
  exit 1
fi
echo "migrations-pg/0001_auth_tables.sql matches Better Auth's generated schema"
