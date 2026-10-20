#!/usr/bin/env bash
# Runs terraform in infra/terraform with the Cloudflare token taken from a file.
# State is local, gitignored, and kept at mode 600 because it holds the
# Turnstile widget secret and, with db_driver = "pg", the Hyperdrive database
# password. Do not run this under bash -x.
# usage: scripts/tf.sh --token-file <file> [--first-deploy] <terraform args...>
set -euo pipefail

[[ "${1:-}" == "--token-file" && -n "${2:-}" ]] || { sed -n 6p "$0" >&2; exit 1; }
# Resolve a relative token path before changing folder.
TOKEN_FILE="$2"
[[ "$TOKEN_FILE" == /* ]] || TOKEN_FILE="$PWD/$TOKEN_FILE"
[[ -r "$TOKEN_FILE" ]] || { echo "cannot read $TOKEN_FILE" >&2; exit 1; }
shift 2
FIRST_DEPLOY=no
if [[ "${1:-}" == "--first-deploy" ]]; then FIRST_DEPLOY=yes; shift; fi
cd "$(dirname "$0")/../infra/terraform"
export CLOUDFLARE_API_TOKEN="$(cat "$TOKEN_FILE")"

# A plain `pnpm build` (scripts/local-suite.sh runs one) bakes Turnstile's
# always-pass test site key into dist/client, and a plan would upload it and
# break sign-up on the real site (it happened twice in the spike this starter
# came from). Any of Turnstile's test site keys (1x, 2x, 3x) counts, and apply
# is covered too, since an apply without a saved plan plans implicitly. No
# built assets is refused as well, so a missing build cannot pass the check.
# The first deploy is the exception: the real site key exists only once the
# widget does (docs/DEPLOY.md, steps 2 and 6). It has to be asked for with
# --first-deploy, because a missing state file alone is also what a second
# clone of a live deployment looks like. Even then the current workspace must
# have no state file, or a state that holds no widget; `terraform state list`
# exits 1 both when there is no state and when it fails, so the file is
# checked first and a failed listing refuses.
widget_absent() {
  local ws state listed
  ws=$(terraform workspace show) || return 1
  state="terraform.tfstate"
  [[ "$ws" == "default" ]] || state="terraform.tfstate.d/${ws}/terraform.tfstate"
  [[ -e "$state" ]] || return 0
  listed=$(terraform state list) || return 1
  ! grep -qE '^cloudflare_turnstile_widget\.app(\[[^]]*\])?$' <<<"$listed"
}
# Only a step that uploads the build is checked: a plan that is not a destroy,
# or an apply without a saved plan (which plans implicitly). A saved plan was
# checked by this script when it was made, and a destroy uploads nothing.
uploads_build() {
  local a
  case "${1:-}" in
    plan) for a in "$@"; do [[ "$a" != "-destroy" ]] || return 1; done; return 0 ;;
    apply) for a in "${@:2}"; do [[ "$a" == -* || ! -f "$a" ]] || return 1; done; return 0 ;;
    *) return 1 ;;
  esac
}
if uploads_build "$@"; then
  assets=(../../dist/client/assets/*.js)
  [[ -e "${assets[0]}" ]] || { echo "no built assets in dist/client; run scripts/build-worker.sh first" >&2; exit 1; }
  if grep -qE "[0-9]x0{20}[A-Z]{2}" "${assets[@]}"; then
    [[ "$FIRST_DEPLOY" == yes ]] || { echo "dist/client carries Turnstile's test site key; run scripts/build-worker.sh first (or pass --first-deploy, docs/DEPLOY.md step 3)" >&2; exit 1; }
    widget_absent || { echo "--first-deploy, but this workspace's state already holds the Turnstile widget (or could not be read); rebuild with the real site key" >&2; exit 1; }
    echo "first deploy: Turnstile's test site key is allowed until the widget exists; rebuild with the real key after (docs/DEPLOY.md step 6)" >&2
  fi
fi

umask 077
status=0
terraform "$@" || status=$?
# Files only: the glob would also match terraform.tfstate.d/, the workspaces'
# folder, and mode 600 on a folder makes everything in it unreachable.
find . -maxdepth 3 -type f \( -name 'terraform.tfstate*' -o -name 'tfplan*' \) -exec chmod 600 {} + ||
  echo "warning: could not set mode 600 on the state and plan files" >&2
exit "$status"
