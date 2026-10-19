#!/usr/bin/env bash
# CPU per invocation for one Worker over a time window, from Workers analytics.
# Read-only. Exits non-zero if analytics returns no rows for the window.
#
# usage: scripts/cpu-report.sh --token-file <file> --account <id> --script <name> --from <ISO> --to <ISO>
set -euo pipefail

TOKEN_FILE="" ACCOUNT="" SCRIPT="" FROM="" TO=""
while (( $# > 0 )); do
  (( $# >= 2 )) || { echo "flag $1 has no value" >&2; exit 1; }
  case "$1" in
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --script) SCRIPT="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done
[[ -n "$TOKEN_FILE" && -n "$ACCOUNT" && -n "$SCRIPT" && -n "$FROM" && -n "$TO" ]] || { sed -n 5p "$0" >&2; exit 1; }

query='query($account: String!, $script: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 50, filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }) {
      dimensions { status }
      sum { requests errors }
      quantiles { cpuTimeP50 cpuTimeP90 cpuTimeP99 cpuTimeP999 }
    }
  } }
}'
body=$(jq -n --arg q "$query" --arg a "$ACCOUNT" --arg s "$SCRIPT" --arg f "$FROM" --arg t "$TO" \
  '{query: $q, variables: {account: $a, script: $s, from: $f, to: $t}}')
# The header comes from a file descriptor so the token never sits on curl's
# command line, where ps can read it.
out=$(curl -sS https://api.cloudflare.com/client/v4/graphql \
  -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") -H "content-type: application/json" -d "$body")

if [[ "$(jq '.errors // [] | length' <<<"$out")" != "0" ]]; then
  echo "graphql errors: $(jq -c '.errors' <<<"$out")" >&2
  exit 1
fi
rows=$(jq '.data.viewer.accounts[0].workersInvocationsAdaptive' <<<"$out")
if [[ "$(jq 'length' <<<"$rows")" == "0" ]]; then
  echo "no invocations for $SCRIPT between $FROM and $TO" >&2
  exit 1
fi
echo "script $SCRIPT, $FROM to $TO (CPU in ms)"
jq -r '.[] | "status=\(.dimensions.status) requests=\(.sum.requests) errors=\(.sum.errors) cpu p50=\(.quantiles.cpuTimeP50/1000) p90=\(.quantiles.cpuTimeP90/1000) p99=\(.quantiles.cpuTimeP99/1000) p99.9=\(.quantiles.cpuTimeP999/1000)"' <<<"$rows"
