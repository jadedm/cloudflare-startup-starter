#!/usr/bin/env bash
# Checks scripts/redact-logs.mjs, and tf.sh around it, against
# scripts/fake-script-settings-api.mjs: no Cloudflare account, no Terraform,
# no network beyond 127.0.0.1. tf.sh runs in a throwaway tree with a fake
# `terraform` first on PATH that serves state from files, per workspace.
# usage: scripts/check-redact-logs.sh
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

work=$(mktemp -d)
server=""
trap '[[ -z "$server" ]] || kill "$server" 2>/dev/null; rm -rf "$work"' EXIT
TOKEN="check-token-$RANDOM$RANDOM-not-real"
pass=0
fail=0
: >"$work/all-output"

check() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); echo "PASS $name: $got"
    return
  fi
  fail=$((fail + 1)); echo "FAIL $name: got '$got', want '$want'"
}

# Settings as the real API returned them for starter-app on 21 Oct 2026, plus
# fields this starter does not use, to show they come back unchanged.
SETTINGS='{"logpush":false,"tags":["t1"],"tail_consumers":[{"service":"tail"}],"observability":{"enabled":true,"head_sampling_rate":1,"redact_query_string":false,"issues":{"enabled":true},"logs":{"enabled":true,"head_sampling_rate":1,"persist":true,"invocation_logs":true,"destinations":["d1"]},"traces":{"enabled":false,"persist":true,"head_sampling_rate":1}}}'
REDACTED=$(node -e 'const s=JSON.parse(process.argv[1]); s.observability.redact_query_string=true; console.log(JSON.stringify(s))' "$SETTINGS")
state_with() { printf '{"version":4,"resources":[{"mode":"managed","type":"cloudflare_workers_script","name":"app","instances":[{"attributes":{"account_id":"%s","script_name":"%s"}}]}]}' "$1" "$2"; }
STATE_NO_WORKER='{"version":4,"resources":[{"mode":"managed","type":"cloudflare_d1_database","name":"main","instances":[{"attributes":{"id":"x"}}]}]}'
STATE_MODULE_WORKER='{"version":4,"resources":[{"module":"module.other","mode":"managed","type":"cloudflare_workers_script","name":"app","instances":[{"attributes":{"account_id":"a","script_name":"b"}}]}]}'

# Starts the fake with the given settings and mode; sets $base.
start() {
  stop
  : >"$work/log"
  FAKE_SETTINGS="$1" FAKE_MODE="${2:-}" FAKE_LOG="$work/log" node "$repo/scripts/fake-script-settings-api.mjs" >"$work/port" &
  server=$!
  for _ in $(seq 50); do [[ -s "$work/port" ]] && break; sleep 0.1; done
  [[ -s "$work/port" ]] || { echo "fake API did not start" >&2; exit 1; }
  base="http://127.0.0.1:$(cat "$work/port")/client/v4"
}
# The braces keep bash's "Terminated" note about the killed fake out of the output.
stop() { [[ -z "$server" ]] || { { kill "$server"; wait "$server"; } 2>/dev/null || true; server=""; }; }

# Runs redact-logs.mjs with the given state on stdin; prints "exit <code>".
redact() {
  local code=0
  printf '%s' "$1" | CF_API_BASE="${2:-$base}" CLOUDFLARE_API_TOKEN="$TOKEN" \
    node "$repo/scripts/redact-logs.mjs" >"$work/out" 2>&1 || code=$?
  cat "$work/out" >>"$work/all-output"
  echo "exit $code"
}
count() { grep -c "\"method\":\"$1\"" "$work/log" || true; }
# What the fake now holds, read through its own GET.
held() { curl -s "$base/accounts/a/workers/scripts/w/script-settings" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).result))'; }
same_json() { node -e 'const [a,b]=process.argv.slice(1).map(JSON.parse); const sort=(o)=>Array.isArray(o)?o.map(sort):o&&typeof o==="object"?Object.fromEntries(Object.keys(o).sort().map(k=>[k,sort(o[k])])):o; console.log(JSON.stringify(sort(a))===JSON.stringify(sort(b))?"same":"differs")' "$1" "$2"; }

# L1, L14: flag set; the PATCH sends the observability read with only the flag changed.
start "$SETTINGS"
check "L1 sets the flag" "$(redact "$(state_with acct1 starter-app)")" "exit 0"
check "L1 one GET before, one after, one PATCH" "$(count GET) $(count PATCH)" "2 1"
sent=$({ grep '"method":"PATCH"' "$work/log" || echo '{"body":null}'; } | head -1 | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).body))')
check "L14 PATCH body is the read observability plus the flag" "$(same_json "$sent" "$(node -e 'const s=JSON.parse(process.argv[1]); console.log(JSON.stringify({observability:s.observability}))' "$REDACTED")")" "same"
check "L1 JSON content type, token on every call" "$(grep -c '"type":"application/json"' "$work/log") $(grep -vc "\"auth\":\"Bearer $TOKEN\"" "$work/log" || true)" "1 0"
check "L11 path from state" "$(grep -c '/accounts/acct1/workers/scripts/starter-app/script-settings' "$work/log")" "3"
# Read last: the check's own GET carries no token.
check "R2d every other setting unchanged" "$(same_json "$(held)" "$REDACTED")" "same"

# Already redacted: read once, nothing sent.
start "$REDACTED"
check "already redacted" "$(redact "$(state_with a w)") patches=$(count PATCH)" "exit 0 patches=0"

# L2, L3: a refused or ignored PATCH fails.
for mode in patch-403 patch-success-false patch-network patch-ignored; do
  start "$SETTINGS" "$mode"
  check "L2/L3 $mode" "$(redact "$(state_with a w)")" "exit 1"
done

# L8 and bad reads: nothing is sent.
for mode in get-403 get-success-false get-bad-json get-no-observability get-observability-not-object; do
  start "$SETTINGS" "$mode"
  check "L8 $mode" "$(redact "$(state_with a w)") patches=$(count PATCH)" "exit 1 patches=0"
done

# L4, L10, L12: no Worker in state (destroyed, never created, or only in a module): nothing asked.
start "$SETTINGS"
for s in "$STATE_NO_WORKER" '' '{"version":4,"resources":[]}' "$STATE_MODULE_WORKER"; do
  check "L4/L12 no Worker: ${s:0:40}" "$(redact "$s") requests=$(wc -l <"$work/log" | tr -d ' ')" "exit 0 requests=0"
done
check "not state" "$(redact 'garbage')" "exit 1"

# A stalled API gives up at 30 s rather than hanging tf.sh; killed at 45 s if not.
start "$SETTINGS" get-stall
printf '%s' "$(state_with a w)" | CF_API_BASE="$base" CLOUDFLARE_API_TOKEN="$TOKEN" node "$repo/scripts/redact-logs.mjs" >"$work/out" 2>&1 &
pid=$!
for _ in $(seq 450); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then { kill "$pid"; wait "$pid"; } 2>/dev/null || true; stalled=hung; else code=0; wait "$pid" || code=$?; stalled="exit $code"; fi
cat "$work/out" >>"$work/all-output"
check "stalled API times out" "$stalled $(grep -c 'GET failed' "$work/out")" "exit 1 1"

# L7: the token goes nowhere but 127.0.0.1 or the real API, and is required.
# The refused bases all reach the fake, so only the guard can stop the request.
start "$SETTINGS"
port=$(cat "$work/port")
for b in "http://localhost:$port/client/v4" "http://u:p@127.0.0.1:$port/client/v4" "http://[::ffff:127.0.0.1]:$port/client/v4"; do
  check "L7 refused base $b" "$(redact "$(state_with a w)" "$b") $(grep -c 'may only point at' "$work/out")" "exit 1 1"
done
check "L7 no request reached the fake" "$(wc -l <"$work/log" | tr -d ' ')" "0"
code=0
printf '%s' "$(state_with a w)" | CF_API_BASE="$base" CLOUDFLARE_API_TOKEN="" node "$repo/scripts/redact-logs.mjs" >/dev/null 2>&1 || code=$?
check "L7 no token" "exit $code" "exit 1"

# tf.sh, in a throwaway tree with a fake terraform. FAKE_APPLY_STATE is the
# state the apply leaves (a file name, or "none"); FAKE_APPLY_EXIT its code.
tree="$work/tree"
mkdir -p "$tree/scripts" "$tree/infra/terraform" "$tree/dist/client/assets" "$work/bin"
cp "$repo/scripts/tf.sh" "$repo/scripts/redact-logs.mjs" "$tree/scripts/"
echo 'console.log("built")' >"$tree/dist/client/assets/app.js"
echo "$TOKEN" >"$work/token"
cat >"$work/bin/terraform" <<'EOF'
#!/usr/bin/env bash
ws="${FAKE_WS:-default}"
st="$FAKE_TF_DIR/state-$ws.json"
echo "$*" >>"$FAKE_TF_DIR/calls"
case "$1 ${2:-}" in
  "workspace show") echo "$ws" ;;
  "state pull") [[ ! -e "$st" ]] || cat "$st" ;;
  "state list") [[ -e "$st" ]] || exit 1 ;;
  apply*)
    if [[ "${FAKE_APPLY_STATE:-keep}" == none ]]; then rm -f "$st"
    elif [[ "${FAKE_APPLY_STATE:-keep}" != keep ]]; then cp "$FAKE_TF_DIR/$FAKE_APPLY_STATE" "$st"; fi
    exit "${FAKE_APPLY_EXIT:-0}" ;;
esac
EOF
chmod +x "$work/bin/terraform"
mkdir "$work/tf"
state_with acct1 starter-app >"$work/tf/worker.json"
state_with acct2 staging-app >"$work/tf/worker-staging.json"
printf '%s' "$STATE_NO_WORKER" >"$work/tf/no-worker.json"
: >"$tree/infra/terraform/tfplan"

# Runs tf.sh with the given args; prints "exit <code>".
tf() {
  local code=0
  PATH="$work/bin:$PATH" FAKE_TF_DIR="$work/tf" CF_API_BASE="$base" \
    "$tree/scripts/tf.sh" --token-file "$work/token" "$@" >"$work/out" 2>&1 || code=$?
  cat "$work/out" >>"$work/all-output"
  echo "exit $code"
}
reset_state() { rm -f "$work/tf"/state-*.json; [[ -z "${1:-}" ]] || cp "$work/tf/$1" "$work/tf/state-default.json"; }

# L9: saved plan, implicit apply, and a saved plan with no changes all run the step.
for args in "apply tfplan" "apply -auto-approve"; do
  start "$SETTINGS"; reset_state worker.json
  check "L9 $args" "$(tf $args) patches=$(count PATCH)" "exit 0 patches=1"
done
start "$REDACTED"; reset_state worker.json
check "L9 no-change saved plan, already redacted" "$(tf apply tfplan) gets=$(count GET) patches=$(count PATCH)" "exit 0 gets=1 patches=0"

# L6b: a failed apply that left the Worker in state still runs the step and keeps terraform's code.
start "$SETTINGS"; reset_state
check "L6b failed apply, Worker in state" "$(FAKE_APPLY_EXIT=3 FAKE_APPLY_STATE=worker.json tf apply tfplan) patches=$(count PATCH)" "exit 3 patches=1"
# L6: a failed apply with no state asks nothing.
start "$SETTINGS"; reset_state
check "L6 failed apply, no state" "$(FAKE_APPLY_EXIT=1 FAKE_APPLY_STATE=none tf apply tfplan) requests=$(wc -l <"$work/log" | tr -d ' ')" "exit 1 requests=0"
# L2 through tf.sh: the apply worked, the step did not.
start "$SETTINGS" patch-403; reset_state worker.json
check "L2 via tf.sh" "$(tf apply tfplan) $(grep -c 'the apply went through, but query strings are not redacted' "$work/out")" "exit 1 1"
# Both failed: terraform's code wins.
start "$SETTINGS" patch-403; reset_state worker.json
check "terraform's code wins" "$(FAKE_APPLY_EXIT=4 tf apply tfplan)" "exit 4"

# L10, L12: a destroy, or an apply that never created the Worker, asks nothing.
start "$SETTINGS"; reset_state worker.json
check "L10 saved destroy plan" "$(FAKE_APPLY_STATE=no-worker.json tf apply tfplan) requests=$(wc -l <"$work/log" | tr -d ' ')" "exit 0 requests=0"
start "$SETTINGS"; reset_state
check "L12 targeted apply without the Worker" "$(FAKE_APPLY_STATE=no-worker.json tf apply -auto-approve -target=cloudflare_d1_database.main) requests=$(wc -l <"$work/log" | tr -d ' ')" "exit 0 requests=0"

# L11: a named workspace patches its own Worker, not default's.
start "$SETTINGS"; reset_state worker.json; cp "$work/tf/worker-staging.json" "$work/tf/state-staging.json"
check "L11 staging workspace" "$(FAKE_WS=staging tf apply tfplan) $(grep -c '/accounts/acct2/workers/scripts/staging-app/' "$work/log") $(grep -c '/acct1/' "$work/log" || true)" "exit 0 3 0"

# L5: other commands never run the step.
start "$SETTINGS"; reset_state worker.json
for args in "plan -out tfplan" "output -raw r2_bucket_name" "state list"; do
  tf $args >/dev/null
done
check "L5 plan, output, state list" "$(wc -l <"$work/log" | tr -d ' ')" "0"

# L13: no output from any run above carries the token.
check "L13 token in no output" "$(grep -c "$TOKEN" "$work/all-output" || true)" "0"

stop
echo "pass $pass, fail $fail"
(( fail == 0 ))
