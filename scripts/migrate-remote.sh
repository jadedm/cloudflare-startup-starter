#!/usr/bin/env bash
# Applies migrations/ to the deployed D1 database. wrangler.jsonc holds a
# local placeholder id, so running `wrangler d1 migrations apply --remote` from
# the repo would target a database that does not exist. This writes a
# throwaway config with the real id from Terraform and applies against that.
# usage: scripts/migrate-remote.sh --token-file <file> --account <id>
set -euo pipefail

TOKEN_FILE="" ACCOUNT=""
while (( $# > 0 )); do
  (( $# >= 2 )) || { echo "flag $1 has no value" >&2; exit 1; }
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done
[[ -n "$TOKEN_FILE" && -n "$ACCOUNT" ]] || { sed -n 6p "$0" >&2; exit 1; }
[[ "$TOKEN_FILE" == /* ]] || TOKEN_FILE="$PWD/$TOKEN_FILE"
cd "$(dirname "$0")/.."
ROOT="$PWD"

DB_ID=$(scripts/tf.sh --token-file "$TOKEN_FILE" output -raw d1_database_id)
DB_NAME=$(scripts/tf.sh --token-file "$TOKEN_FILE" output -raw d1_database_name)
[[ -n "$DB_ID" && -n "$DB_NAME" ]] || { echo "no D1 outputs in Terraform state; apply first" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
jq -n --arg name "$DB_NAME" --arg id "$DB_ID" --arg dir "$ROOT/migrations" \
  '{name: "migrate-only", compatibility_date: "2026-10-13", d1_databases: [{binding: "DB", database_name: $name, database_id: $id, migrations_dir: $dir}]}' \
  >"$WORK/wrangler.json"

export CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
"$ROOT/node_modules/.bin/wrangler" d1 migrations apply "$DB_NAME" --remote -c "$WORK/wrangler.json"
