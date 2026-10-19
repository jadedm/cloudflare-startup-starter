#!/usr/bin/env bash
# Runs every local group from scripts/smoke.mjs, each against a freshly booted
# compiled Worker with that group's config. D1 is migrated from scratch once
# per suite run into the suite's own folder (not .wrangler/state, so your
# `pnpm dev` data is left alone); its rows carry across groups.
# usage: scripts/local-suite.sh [group ...]   (default: all local groups)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8787
BASE="https://127.0.0.1:${PORT}"
LOG_DIR="${TMPDIR:-/tmp}/starter-app-suite"
mkdir -p "$LOG_DIR"

# Extra wrangler dev flags per group. macOS ships bash 3.2, so no associative arrays.
extra_for() {
  case "$1" in
    base) echo "" ;;
    no-worker-first) echo "-c wrangler.no-worker-first.jsonc" ;;
    ts-fail) echo "--var TURNSTILE_SECRET:2x0000000000000000000000000000000AA" ;;
    ts-spent) echo "--var TURNSTILE_SECRET:3x0000000000000000000000000000000AA" ;;
    ts-host) echo "--var TURNSTILE_ALLOWED_HOSTNAMES:localhost" ;;
    kv) echo "--var SESSION_CACHE:kv" ;;
    cookie-cache) echo "--var COOKIE_CACHE:on" ;;
    fault-siteverify) echo "--var FAULT:siteverify" ;;
    fault-d1) echo "--var FAULT:d1 --var AUTH_VALIDATE_SCHEMA:off" ;;
    fault-kv) echo "--var SESSION_CACHE:kv --var FAULT:kv" ;;
    fault-kv-delete) echo "--var SESSION_CACHE:kv --var SESSION_CACHE_MAX_TTL:60 --var FAULT:kv-delete" ;;
    fault-r2) echo "--var FAULT:r2" ;;
    first-admin) echo "" ;;
    pw-on) echo "" ;;
    pw-off) echo "--var PASSWORD_LOGIN:off --var TURNSTILE_SECRET:2x0000000000000000000000000000000AA" ;;
    pw-bad) echo "--var PASSWORD_LOGIN:yes" ;;
    no-secret) echo "--var BETTER_AUTH_SECRET:better-auth-secret-12345678901234567890" ;;
    *) return 1 ;;
  esac
}
ORDER=(base no-worker-first ts-fail ts-spent ts-host kv cookie-cache fault-siteverify fault-d1 fault-kv fault-kv-delete fault-r2 first-admin pw-on pw-off pw-bad no-secret)
if (( $# > 0 )); then GROUPS_TO_RUN=("$@"); else GROUPS_TO_RUN=("${ORDER[@]}"); fi

if lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null; then
  echo "port ${PORT} already in use; stop that server first" >&2
  exit 1
fi

pnpm -s build
export SMOKE_PERSIST="$LOG_DIR/d1-state"
rm -rf "$SMOKE_PERSIST"
export SMOKE_STATE_DIR="$LOG_DIR/state"
rm -rf "$SMOKE_STATE_DIR" && mkdir -m 700 "$SMOKE_STATE_DIR"
npx wrangler d1 migrations apply starter-app-db --local --persist-to "$SMOKE_PERSIST" >/dev/null

PID=""
# PID is npx, which may not pass the signal on to workerd, so wait for the port
# itself to close; a survivor would answer the next group with the old config.
stop_server() {
  [[ -n "$PID" ]] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null || true
  PID=""
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:${PORT} -sTCP:LISTEN >/dev/null || return 0
    sleep 0.5
  done
  echo "port ${PORT} still in use after stopping the server" >&2
  return 1
}
trap stop_server EXIT

failed=()
for g in "${GROUPS_TO_RUN[@]}"; do
  flags=$(extra_for "$g") || { echo "unknown group $g" >&2; exit 1; }
  log="$LOG_DIR/$g.log"
  # shellcheck disable=SC2086
  npx wrangler dev --local-protocol https --ip 127.0.0.1 --port ${PORT} --persist-to "$SMOKE_PERSIST" ${flags} >"$log" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do
    grep -q "Ready on" "$log" && break
    kill -0 "$PID" 2>/dev/null || { echo "server for $g exited; see $log" >&2; exit 1; }
    sleep 1
  done
  grep -q "Ready on" "$log" || { echo "server for $g never became ready; see $log" >&2; exit 1; }

  echo "== $g"
  SMOKE_SERVER_LOG="$log" node scripts/smoke.mjs "$g" "$BASE" || failed+=("$g")
  stop_server
done

if (( ${#failed[@]} > 0 )); then
  echo "FAILED groups: ${failed[*]}" >&2
  exit 1
fi
echo "all groups passed: ${GROUPS_TO_RUN[*]}"
