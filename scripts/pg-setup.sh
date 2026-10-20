#!/usr/bin/env bash
# Prepares a Postgres database for the Postgres option (#4), as the owner:
# creates the app's database if missing, applies migrations-pg, then gives
# app_worker a new random password in --out. Run before the Terraform apply
# that points Hyperdrive at the database; TF_VAR_supabase_password is then
# read from the --out file.
#
# usage: scripts/pg-setup.sh --host <db host> --database <app database>
#          --owner-password-file <file> --ca-file <Supabase CA pem> --out <new file>
#        [--port 5432] [--tls off]   # --tls off instead of --ca-file: loopback only, for the local database
#
# The database is created from the maintenance database postgres. Prints no
# secret: the owner password is read from its file by each step, and the
# worker password is written only to --out (mode 600). A rerun creates nothing
# and applies only new migrations, then stops with exit 1 at step 3 because
# --out already exists; to apply new migrations alone, run
# scripts/migrate-pg.mjs. Relative paths are read from the folder it is run in.
set -euo pipefail

usage() { sed -n '8,10p' "$0" | sed 's/^# //' >&2; exit 2; }
host="" port=5432 database="" owner_file="" ca_file="" tls="" out=""
while (( $# > 0 )); do
  (( $# >= 2 )) || { echo "flag $1 has no value" >&2; usage; }
  case "$1" in
    --host) host="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --tls) tls="${2:-}"; shift 2 ;;
    --database) database="${2:-}"; shift 2 ;;
    --owner-password-file) owner_file="${2:-}"; shift 2 ;;
    --ca-file) ca_file="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$host" && -n "$database" && -n "$owner_file" && -n "$out" ]] || usage
[[ -n "$ca_file" || "$tls" == "off" ]] || { echo "give --ca-file, or --tls off for a loopback database" >&2; usage; }
[[ -z "$ca_file" || -z "$tls" ]] || { echo "give --ca-file or --tls off, not both" >&2; usage; }
[[ "$database" != "postgres" && "$database" != template* ]] || { echo "--database must be the app's own database, not postgres or a template" >&2; exit 2; }

# Resolve relative paths against the caller's folder before changing folder,
# so the password file lands where it was asked for.
abs() { [[ "$1" == /* ]] && echo "$1" || echo "$PWD/$1"; }
owner_file=$(abs "$owner_file") out=$(abs "$out")
[[ -z "$ca_file" ]] || ca_file=$(abs "$ca_file")
cd "$(dirname "$0")/.."

# pg-connect.mjs refuses --tls off for anything but a loopback host.
conn=(--host "$host" --port "$port" --owner-password-file "$owner_file")
if [[ -n "$ca_file" ]]; then conn+=(--ca-file "$ca_file"); else conn+=(--tls off); fi
echo "1/3 database"
node scripts/create-pg-database.mjs --name "$database" "${conn[@]}" --database postgres
echo "2/3 migrations"
node scripts/migrate-pg.mjs "${conn[@]}" --database "$database"
echo "3/3 worker password"
node scripts/set-worker-password.mjs "${conn[@]}" --database "$database" --out "$out"
