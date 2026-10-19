#!/usr/bin/env bash
# Runs terraform in infra/terraform with the Cloudflare token taken from a file.
# State is local, gitignored, and kept at mode 600 because it holds the
# Turnstile widget secret. Do not run this under bash -x.
# usage: scripts/tf.sh --token-file <file> <terraform args...>
set -euo pipefail

[[ "${1:-}" == "--token-file" && -n "${2:-}" ]] || { sed -n 6p "$0" >&2; exit 1; }
# Resolve a relative token path before changing folder.
TOKEN_FILE="$2"
[[ "$TOKEN_FILE" == /* ]] || TOKEN_FILE="$PWD/$TOKEN_FILE"
[[ -r "$TOKEN_FILE" ]] || { echo "cannot read $TOKEN_FILE" >&2; exit 1; }
shift 2
cd "$(dirname "$0")/../infra/terraform"
export CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")"

umask 077
status=0
terraform "$@" || status=$?
chmod 600 terraform.tfstate* tfplan* 2>/dev/null || true
exit "$status"
