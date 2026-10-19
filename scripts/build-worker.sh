#!/usr/bin/env bash
# Builds what Terraform uploads: the frontend into dist/client and the Worker
# bundle into dist/worker/index.js.
# usage: scripts/build-worker.sh --turnstile-sitekey <sitekey>
set -euo pipefail
cd "$(dirname "$0")/.."

SITEKEY=""
while (( $# > 0 )); do
  (( $# >= 2 )) || { echo "flag $1 has no value" >&2; exit 1; }
  case "$1" in
    --turnstile-sitekey) SITEKEY="$2"; shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
done
[[ -n "$SITEKEY" ]] || { sed -n 4p "$0" >&2; exit 1; }

VITE_TURNSTILE_SITE_KEY="$SITEKEY" pnpm -s build
rm -rf dist/worker
npx wrangler deploy --dry-run --outdir dist/worker >/dev/null
[[ -s dist/worker/index.js ]] || { echo "no bundle at dist/worker/index.js" >&2; exit 1; }
grep -q "$SITEKEY" dist/client/assets/*.js || { echo "site key not in the client build" >&2; exit 1; }
echo "built dist/client and dist/worker/index.js ($(wc -c < dist/worker/index.js) bytes)"
