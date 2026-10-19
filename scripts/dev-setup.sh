#!/usr/bin/env bash
# Writes .dev.vars for local development: a random auth secret and Cloudflare's
# always-pass Turnstile test secret. Refuses to overwrite an existing file.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -e .dev.vars ]] && { echo ".dev.vars already exists; delete it first to regenerate" >&2; exit 1; }
umask 077
printf 'BETTER_AUTH_SECRET=%s\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\n' "$(openssl rand -hex 32)" > .dev.vars
echo "wrote .dev.vars (mode 600)"
