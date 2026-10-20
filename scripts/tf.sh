#!/usr/bin/env bash
# Runs terraform in infra/terraform with the Cloudflare token taken from a file.
# State is local, gitignored, and kept at mode 600 because it holds the
# Turnstile widget secret and, with db_driver = "pg", the Hyperdrive database
# password. Do not run this under bash -x.
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

# A plain `pnpm build` (scripts/local-suite.sh runs one) bakes Turnstile's
# always-pass test site key into dist/client, and a plan would upload it and
# break sign-up on the real site (it happened twice in the spike this starter
# came from). Any of Turnstile's test site keys (1x, 2x, 3x) counts, and apply
# is covered too, since an apply without a saved plan plans implicitly. No
# built assets is refused as well, so a missing build cannot pass the check.
if [[ "${1:-}" == "plan" || "${1:-}" == "apply" ]]; then
  assets=(../../dist/client/assets/*.js)
  [[ -e "${assets[0]}" ]] || { echo "no built assets in dist/client; run scripts/build-worker.sh first" >&2; exit 1; }
  if grep -qE "[0-9]x0{20}[A-Z]{2}" "${assets[@]}"; then
    echo "dist/client carries Turnstile's test site key; run scripts/build-worker.sh first" >&2
    exit 1
  fi
fi

umask 077
status=0
terraform "$@" || status=$?
chmod 600 terraform.tfstate* tfplan* 2>/dev/null || true
exit "$status"
