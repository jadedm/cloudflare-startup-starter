#!/usr/bin/env bash
# Sets the Worker secrets that Terraform leaves alone (keep_bindings).
# TURNSTILE_SECRET comes from Terraform state. The Google client is set when
# both --google-id-file and --google-secret-file are given. BETTER_AUTH_SECRET
# is generated only with --rotate-auth-secret (always on the first run), since
# rotating it signs everyone out. Values are never printed or passed on a
# command line. Do not run this under bash -x.
# usage: scripts/secrets.sh --token-file <file> --account <id> --script <name>
#          [--google-id-file <file> --google-secret-file <file>] [--rotate-auth-secret]
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN_FILE="" ACCOUNT="" SCRIPT="" GID="" GSECRET="" ROTATE=no
while (( $# > 0 )); do
  if [[ "$1" == "--rotate-auth-secret" ]]; then ROTATE=yes; shift; continue; fi
  (( $# >= 2 )) || { echo "flag $1 has no value" >&2; exit 1; }
  case "$1" in
    --token-file) TOKEN_FILE="$2" ;;
    --account) ACCOUNT="$2" ;;
    --script) SCRIPT="$2" ;;
    --google-id-file) GID="$2" ;;
    --google-secret-file) GSECRET="$2" ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
  shift 2
done
[[ -n "$TOKEN_FILE" && -n "$ACCOUNT" && -n "$SCRIPT" ]] || { sed -n 8,9p "$0" >&2; exit 1; }
[[ -z "$GID" && -z "$GSECRET" ]] || [[ -r "$GID" && -r "$GSECRET" ]] || { echo "give both Google files, readable" >&2; exit 1; }

export CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"

FILE=$(mktemp)
chmod 600 "$FILE"
trap 'rm -f "$FILE"' EXIT

TS=$(scripts/tf.sh --token-file "$TOKEN_FILE" output -raw turnstile_secret)
[[ -n "$TS" ]] || { echo "no turnstile_secret in Terraform state; apply first" >&2; exit 1; }
# Values reach jq through its environment, never its command line.
json=$(TS="$TS" jq -n '{TURNSTILE_SECRET: env.TS}')

if [[ -n "$GID" ]]; then
  json=$(jq --rawfile id "$GID" --rawfile s "$GSECRET" \
    '. + {GOOGLE_CLIENT_ID: ($id|rtrimstr("\n")), GOOGLE_CLIENT_SECRET: ($s|rtrimstr("\n"))}' <<<"$json")
fi
if [[ "$ROTATE" == yes ]]; then
  json=$(A="$(openssl rand -hex 32)" jq '. + {BETTER_AUTH_SECRET: env.A}' <<<"$json")
fi
printf '%s' "$json" >"$FILE"

npx wrangler secret bulk "$FILE" --name "$SCRIPT"
echo "secrets set on $SCRIPT: $(jq -r 'keys | join(", ")' "$FILE") (values not shown)"
