#!/usr/bin/env bash
# Summarises a saved Terraform plan for review before apply: counts by action,
# every destroy or replace, and the top-level attributes each update changes.
# Worker code and sensitive values are not printed.
# usage: scripts/plan-audit.sh --token-file <file> [planfile]
set -euo pipefail
[[ "${1:-}" == "--token-file" && -n "${2:-}" ]] || { sed -n 5p "$0" >&2; exit 1; }
TOKEN_FILE="$2"; PLAN="${3:-tfplan}"
# Resolve a relative token path before changing folder.
[[ "$TOKEN_FILE" == /* ]] || TOKEN_FILE="$PWD/$TOKEN_FILE"
cd "$(dirname "$0")/.."
[[ -f "infra/terraform/$PLAN" ]] || { echo "no plan at infra/terraform/$PLAN" >&2; exit 1; }

json=$(scripts/tf.sh --token-file "$TOKEN_FILE" show -json "$PLAN")
echo "plan file sha256: $(shasum -a 256 "infra/terraform/$PLAN" | cut -d' ' -f1)"
echo "== counts"
jq -r '[.resource_changes[] | (if .change.importing then "import+" else "" end) + (.change.actions | join("/"))] | group_by(.) | map("\(length) \(.[0])") | .[]' <<<"$json"
echo "== destroys and replaces (must be empty unless intended)"
jq -r '.resource_changes[] | select(.change.actions | index("delete")) | "\(.address): \(.change.actions | join("/"))"' <<<"$json"
echo "== per resource"
jq -r '
  def changed: (.change.before // {}) as $b | (.change.after // {}) as $a
    | [($a | keys[]), ($b | keys[])] | unique
    | map(select(. as $k | ($b[$k]) != ($a[$k]) and (["content","content_sha256","content_file"] | index($k) | not)));
  .resource_changes[]
  | "\(.address): \(if .change.importing then "import, " else "" end)\(.change.actions | join("/"))"
    + (if (.change.actions | index("update")) then "  changes: " + (changed | join(", ")) else "" end)
' <<<"$json"
echo "== unknown after apply (computed)"
jq -r '.resource_changes[] | select(.change.actions | index("update") or index("create")) | (.change.after_unknown // {}) as $u | "\(.address): \([$u | to_entries[] | select(.value == true) | .key] | join(", "))"' <<<"$json"
