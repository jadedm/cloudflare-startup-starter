#!/usr/bin/env bash
# Checks scripts/tf.sh's Turnstile test-key guard and its file modes without
# Terraform or a network: tf.sh is copied into a throwaway tree with a fake
# `terraform` first on PATH. The fake answers `workspace show` and
# `state list` from environment variables and otherwise prints "ran".
# usage: scripts/check-tf-guard.sh
set -euo pipefail
cd "$(dirname "$0")/.."

work=$(mktemp -d)
# chmod first: a broken run can leave folders unsearchable, which rm cannot enter.
trap 'chmod -R u+rwx "$work"; rm -rf "$work"' EXIT
mkdir -p "$work/tree/scripts" "$work/tree/infra/terraform" "$work/tree/dist/client/assets" "$work/bin"
cp scripts/tf.sh "$work/tree/scripts/tf.sh"
printf 'not-a-real-token' >"$work/token"
cat >"$work/bin/terraform" <<'EOF'
#!/usr/bin/env bash
case "$1 ${2:-}" in
  "workspace show") echo "${FAKE_WS:-default}" ;;
  "state list") [[ "${FAKE_LIST_FAIL:-}" != yes ]] || exit 1; printf '%s\n' ${FAKE_LIST:-} ;;
  *) echo ran ;;
esac
EOF
chmod +x "$work/bin/terraform"
tf_dir="$work/tree/infra/terraform"
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
build() { printf 'const k="%s";\n' "$1" >"$work/tree/dist/client/assets/index.js"; }
# Prints "ran" when terraform was reached, else "refused"; the exit code is
# part of the answer so a refusal that exits 0 does not pass.
run() {
  local out code
  out=$(PATH="$work/bin:$PATH" "$work/tree/scripts/tf.sh" --token-file "$work/token" "$@" 2>/dev/null) && code=0 || code=$?
  [[ "$out" == *ran* && $code -eq 0 ]] && echo ran && return
  [[ "$out" != *ran* && $code -eq 1 ]] && echo refused && return
  echo "unexpected exit $code"
}
reset_state() { rm -rf "$tf_dir"/terraform.tfstate* "$tf_dir"/tfplan*; }

TEST_KEY=1x00000000000000000000AA
REAL_KEY=0x4AAAAAAAB1234567890abc

build "$REAL_KEY"
check "G1 real key, plan" "$(run plan)" "ran"
build "$TEST_KEY"
check "G2 test key, plan" "$(run plan)" "refused"
check "G2 test key, apply without a plan file" "$(run apply)" "refused"
check "G3 --first-deploy, no state file" "$(run --first-deploy plan)" "ran"
touch "$tf_dir/terraform.tfstate"
check "G4 --first-deploy, widget in state" "$(FAKE_LIST='cloudflare_turnstile_widget.app cloudflare_d1_database.main' run --first-deploy plan)" "refused"
check "G4 --first-deploy, indexed widget in state" "$(FAKE_LIST='cloudflare_turnstile_widget.app[0]' run --first-deploy plan)" "refused"
check "G5 --first-deploy, state list fails" "$(FAKE_LIST_FAIL=yes run --first-deploy plan)" "refused"
check "G6 --first-deploy, state without a widget" "$(FAKE_LIST='cloudflare_d1_database.main' run --first-deploy plan)" "ran"
check "G7 destroy plan" "$(FAKE_LIST='cloudflare_turnstile_widget.app' run plan -destroy -out=tfplan-destroy)" "ran"
touch "$tf_dir/tfplan"
check "G8 apply of a saved plan" "$(FAKE_LIST='cloudflare_turnstile_widget.app' run apply tfplan)" "ran"
check "G8 apply naming a missing plan" "$(FAKE_LIST='cloudflare_turnstile_widget.app' run apply nope)" "refused"
reset_state
# Terraform makes these under tf.sh's umask 077; a run must leave them searchable.
mkdir -m 700 -p "$tf_dir/terraform.tfstate.d" && mkdir -m 700 "$tf_dir/terraform.tfstate.d/case23"
touch "$tf_dir/terraform.tfstate.d/case23/terraform.tfstate"
check "G10 workspace state holds the widget" "$(FAKE_WS=case23 FAKE_LIST='cloudflare_turnstile_widget.app' run --first-deploy plan)" "refused"
check "G10 workspace with no state file" "$(FAKE_WS=fresh run --first-deploy plan)" "ran"
check "G11 workspace folder mode" "$(stat -f '%Lp' "$tf_dir/terraform.tfstate.d") $(stat -f '%Lp' "$tf_dir/terraform.tfstate.d/case23")" "700 700"
check "G11 state file mode" "$(stat -f '%Lp' "$tf_dir/terraform.tfstate.d/case23/terraform.tfstate")" "600"
reset_state
rm "$work/tree/dist/client/assets/index.js"
check "G9 no built assets" "$(run plan)" "refused"

echo "pass $pass, fail $fail"
[[ $fail -eq 0 && $pass -gt 0 ]]
