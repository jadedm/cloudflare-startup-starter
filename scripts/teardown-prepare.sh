#!/usr/bin/env bash
# Prepares a teardown. Deletes every avatar object from R2 (a bucket must be
# empty before it can be deleted), then writes a saved destroy plan to
# infra/terraform/tfplan-destroy and prints its audit. Deletes nothing else;
# the destroy is `scripts/tf.sh --token-file <file> apply tfplan-destroy`.
# usage: scripts/teardown-prepare.sh --token-file <file> --account <id>
set -euo pipefail
CALLER_DIR="$PWD"
cd "$(dirname "$0")/.."

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
# Resolve a relative token path against where the script was run from.
[[ "$TOKEN_FILE" == /* ]] || TOKEN_FILE="$CALLER_DIR/$TOKEN_FILE"

export CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
WRANGLER="$PWD/node_modules/.bin/wrangler"
DB=$(scripts/tf.sh --token-file "$TOKEN_FILE" output -raw d1_database_name)
BUCKET=$(scripts/tf.sh --token-file "$TOKEN_FILE" output -raw r2_bucket_name)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Run wrangler from an empty folder so it finds the database by name rather
# than the local placeholder id in wrangler.jsonc.
ids=$(cd "$WORK" && "$WRANGLER" d1 execute "$DB" --remote --json --command 'select id from "user"' | jq -r '.[0].results[].id')
echo "users in $DB: $(printf '%s\n' "$ids" | grep -c . || true)"

deleted=0 failed=0
for id in $ids; do
  if (cd "$WORK" && "$WRANGLER" r2 object delete "$BUCKET/avatars/$id" --remote >/dev/null 2>&1); then
    deleted=$((deleted + 1))
  else
    failed=$((failed + 1))
  fi
done
echo "avatar deletes in $BUCKET: $deleted succeeded, $failed failed or absent"

scripts/tf.sh --token-file "$TOKEN_FILE" plan -destroy -input=false -no-color -out=tfplan-destroy >/dev/null
echo "destroy plan written to infra/terraform/tfplan-destroy"
scripts/plan-audit.sh --token-file "$TOKEN_FILE" tfplan-destroy
