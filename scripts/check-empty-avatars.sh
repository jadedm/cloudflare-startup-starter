#!/usr/bin/env bash
# Checks scripts/empty-avatars.mjs, and teardown-prepare.sh around it, against
# scripts/fake-r2-api.mjs: no Cloudflare account, no Terraform, no network
# beyond 127.0.0.1. teardown-prepare runs in a throwaway tree with a fake
# `terraform` first on PATH and a stub plan-audit.sh.
# usage: scripts/check-empty-avatars.sh
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

work=$(mktemp -d)
server=""
trap '[[ -z "$server" ]] || kill "$server" 2>/dev/null; rm -rf "$work"' EXIT
TOKEN="check-token-$RANDOM$RANDOM-not-real"
pass=0
fail=0

check() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1)); echo "PASS $name: $got"
    return
  fi
  fail=$((fail + 1)); echo "FAIL $name: got '$got', want '$want'"
}

# Starts the fake with the given keys (JSON array) and mode; sets $base.
start() {
  stop
  : >"$work/log"
  FAKE_KEYS="$1" FAKE_MODE="${2:-}" FAKE_LOG="$work/log" node "$repo/scripts/fake-r2-api.mjs" >"$work/port" &
  server=$!
  for _ in $(seq 50); do [[ -s "$work/port" ]] && break; sleep 0.1; done
  [[ -s "$work/port" ]] || { echo "fake API did not start" >&2; exit 1; }
  base="http://127.0.0.1:$(cat "$work/port")/client/v4"
}
# The braces keep bash's "Terminated" note about the killed fake out of the output.
stop() { [[ -z "$server" ]] || { { kill "$server"; wait "$server"; } 2>/dev/null || true; server=""; }; }

# Runs empty-avatars.mjs; prints "exit <code>" and keeps its output in $work/out.
# A run still going after 60 s is killed and reported as "hung", so a loop
# that never ends fails the case instead of stalling the suite.
empty() {
  local code=0 pid
  CF_API_BASE="$base" CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID=acct \
    node "$repo/scripts/empty-avatars.mjs" --bucket bucket >"$work/out" 2>&1 &
  pid=$!
  for _ in $(seq 600); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then
    { kill "$pid"; wait "$pid"; } 2>/dev/null || true
    echo hung
    return
  fi
  wait "$pid" || code=$?
  echo "exit $code"
}
deletes() { grep -c '"method":"DELETE"' "$work/log" || true; }
keys_json() { node -e 'const n=+process.argv[1], p=process.argv[2]; console.log(JSON.stringify(Array.from({length:n},(_,i)=>`${p}${String(i).padStart(5,"0")}`)))' "$1" "$2"; }

# T1, T3: avatars of current and deleted users alike; the user table is never read.
start '["avatars/u1","avatars/u2"]'
check "T1 two avatars" "$(empty)" "exit 0"
check "T1 deletes, then empty" "$(deletes) $(grep -c 'is empty' "$work/out")" "2 1"
check "T1 every call carries the token" "$(grep -vc "\"auth\":\"Bearer $TOKEN\"" "$work/log" || true)" "0"

# T2: nothing to delete (a Postgres deploy's empty D1 no longer matters).
start '[]'
check "T2 empty bucket" "$(empty)" "exit 0"
check "T2 no deletes" "$(deletes)" "0"

# T4: three pages of avatars; every page is listed before the first delete.
start "$(keys_json 2500 avatars/u)"
check "T4 2500 avatars" "$(empty)" "exit 0"
check "T4 all deleted" "$(deletes)" "2500"
first_delete=$(awk '/"method":"DELETE"/ { print NR; exit }' "$work/log")
last_avatar_list=$(awk '/"prefix":"avatars\/"/ { n = NR } END { print n }' "$work/log")
check "T4 avatar list pages, listed before any delete" "$(grep -c '"prefix":"avatars/"' "$work/log") $((last_avatar_list < first_delete))" "3 1"

# T5, T10: refused or malformed list answers fail closed, and nothing is deleted.
for mode in list-403 list-success-false list-no-result list-repeat-cursor list-no-cursor; do
  start '["avatars/u1","avatars/u2"]' "$mode"
  check "T5/T10 $mode" "$(empty) deletes=$(deletes)" "exit 1 deletes=0"
done

# T6: an object outside avatars/ is left alone and reported.
start '["avatars/u1","exports/report.csv"]'
check "T6 object outside avatars/" "$(empty)" "exit 1"
check "T6 only the avatar deleted, other reported" "$(deletes) $(grep -c 'not deleted: exports/report.csv' "$work/out")" "1 1"

# T6b: the leftover is past the first page of the whole-bucket list.
start "$(node -e 'const a=Array.from({length:1000},(_,i)=>`avatars/u${String(i).padStart(4,"0")}`); a.push("zz/left-over"); console.log(JSON.stringify(a))')"
check "T6b leftover on page two" "$(empty)" "exit 1"
check "T6b reported" "$(grep -c 'not deleted: zz/left-over' "$work/out")" "1"

# T7: a failed delete stops the run.
start '["avatars/u1"]' delete-500
check "T7 delete answers 500" "$(empty)" "exit 1"

# T9: keys that need encoding reach the right object.
start '["avatars/u 1","avatars/ü%2","avatars/a/b"]'
check "T9 keys needing encoding" "$(empty)" "exit 0"
check "T9 all deleted" "$(deletes)" "3"

# The list returning more than avatars/: nothing outside it is deleted.
start '["avatars/u1","exports/report.csv"]' list-ignores-prefix
check "M2 list ignores the prefix" "$(empty) deletes=$(deletes)" "exit 1 deletes=1"

# Rate limited twice on a delete: waits Retry-After, then carries on.
start '["avatars/u1","avatars/u2"]' delete-429-twice
check "M1 429 then success" "$(empty) deletes=$(deletes) waits=$(grep -c 'rate limited; waiting 1 s' "$work/out")" "exit 0 deletes=4 waits=2"

# A key already gone (404 on delete) counts as deleted.
start '["avatars/u1","avatars/u2"]' delete-404
check "L3 avatar removed between list and delete" "$(empty) $(grep -c 'is empty' "$work/out")" "exit 0 1"

# The API base can only be the real API or the local fake.
for other in https://example.com http://127.0.0.1:1@example.com http://:pw@127.0.0.1:1 http://127.0.0.1.example.com:80; do
  check "L5 API base $other refused" "$(CF_API_BASE="$other" CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID=acct node "$repo/scripts/empty-avatars.mjs" --bucket bucket >/dev/null 2>&1; echo "exit $?")" "exit 2"
done

# Nothing answering: a clean message, no stack trace, no token.
stop
check "L6 API unreachable" "$(empty) $(grep -c 'GET failed' "$work/out") $(grep -c "$TOKEN" "$work/out" || true)" "exit 1 1 0"

# An upload between the list and the final check is caught.
start '["avatars/u1","avatars/u2"]' upload-during
check "upload during the run" "$(empty) $(grep -c 'uploaded since the list' "$work/out")" "exit 1 1"

# T8: the token never appears in anything printed, failures included.
start '["avatars/u1"]' list-403
empty >/dev/null
check "T8 token not printed" "$(grep -c "$TOKEN" "$work/out" || true)" "0"

# teardown-prepare: an old plan is removed, and no plan is written when emptying fails.
tree="$work/tree"
mkdir -p "$tree/scripts" "$tree/infra/terraform" "$work/bin"
cp scripts/teardown-prepare.sh scripts/tf.sh scripts/empty-avatars.mjs "$tree/scripts/"
printf '#!/usr/bin/env bash\necho audit\n' >"$tree/scripts/plan-audit.sh"
chmod +x "$tree/scripts/"*.sh
printf '%s' "$TOKEN" >"$work/token"
cat >"$work/bin/terraform" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  output) echo bucket ;;
  plan) for a in "$@"; do [[ "$a" != -out=* ]] || echo new >"${a#-out=}"; done ;;
esac
EOF
chmod +x "$work/bin/terraform"
prepare() {
  local code=0
  PATH="$work/bin:$PATH" CF_API_BASE="$base" "$tree/scripts/teardown-prepare.sh" --token-file "$work/token" --account acct >"$work/out" 2>&1 || code=$?
  echo "exit $code"
}
plan_file="$tree/infra/terraform/tfplan-destroy"

echo old >"$plan_file"
start '["avatars/u1"]' delete-500
check "T7 prepare stops on a failed delete" "$(prepare)" "exit 1"
check "T7 old plan removed, none written" "$([[ -e "$plan_file" ]] && echo present || echo absent)" "absent"

echo old >"$plan_file"
start '["avatars/u1"]'
check "T1 prepare succeeds" "$(prepare)" "exit 0"
check "T1 prepare wrote a new plan" "$(cat "$plan_file")" "new"
check "T8 token not printed by prepare" "$(grep -c "$TOKEN" "$work/out" || true)" "0"

stop
echo "pass $pass, fail $fail"
[[ $fail -eq 0 && $pass -gt 0 ]]
