#!/usr/bin/env bash
# Runs terraform in infra/terraform with the Cloudflare token taken from a file.
# State is local, gitignored, and kept at mode 600 because it holds the
# Turnstile widget secret. Do not run this under bash -x.
# usage: scripts/tf.sh --token-file <file> <terraform args...>
set -euo pipefail
cd "$(dirname "$0")/../infra/terraform"

[[ "${1:-}" == "--token-file" && -n "${2:-}" ]] || { sed -n 6p "$0" >&2; exit 1; }
[[ -r "$2" ]] || { echo "cannot read $2" >&2; exit 1; }
export CLOUDFLARE_API_TOKEN="$(cat "$2")"
shift 2

umask 077
status=0
terraform "$@" || status=$?
chmod 600 terraform.tfstate* tfplan* 2>/dev/null || true
exit "$status"
