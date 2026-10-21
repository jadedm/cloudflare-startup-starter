#!/usr/bin/env bash
# Prepares a teardown. Deletes every avatar object from R2 (a bucket must be
# empty before it can be deleted), then writes a saved destroy plan to
# infra/terraform/tfplan-destroy and prints its audit. Deletes nothing else;
# the destroy is `scripts/tf.sh --token-file <file> apply tfplan-destroy`.
# Any earlier tfplan-destroy is removed first, so a run that stops partway
# never leaves an old plan behind to apply.
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
[[ -n "$TOKEN_FILE" && -n "$ACCOUNT" ]] || { sed -n 8p "$0" >&2; exit 1; }
# Resolve a relative token path against where the script was run from.
[[ "$TOKEN_FILE" == /* ]] || TOKEN_FILE="$CALLER_DIR/$TOKEN_FILE"

export CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
rm -f infra/terraform/tfplan-destroy
BUCKET=$(scripts/tf.sh --token-file "$TOKEN_FILE" output -raw r2_bucket_name)

# The keys come from listing the bucket, so this works for D1 and Postgres
# alike (#13). It exits non-zero, and no plan is written, if anything is left.
node scripts/empty-avatars.mjs --bucket "$BUCKET"

scripts/tf.sh --token-file "$TOKEN_FILE" plan -destroy -input=false -no-color -out=tfplan-destroy >/dev/null
echo "destroy plan written to infra/terraform/tfplan-destroy"
scripts/plan-audit.sh --token-file "$TOKEN_FILE" tfplan-destroy
