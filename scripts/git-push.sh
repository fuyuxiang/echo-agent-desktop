#!/usr/bin/env bash
# Push the current branch through a configured Git remote.
#
# Usage:
#   bash scripts/git-push.sh
#   bash scripts/git-push.sh --remote upstream
#   bash scripts/git-push.sh v0.3.8
#   bash scripts/git-push.sh --tags --force-with-lease

set -euo pipefail

log_step() { printf '\n\033[36m===> %s\033[0m\n' "$1"; }
log_ok()   { printf '  \033[32m[OK]\033[0m   %s\n' "$1"; }
log_err()  { printf '  \033[31m[ERR]\033[0m  %s\n' "$1"; }
log_info() { printf '         %s\n' "$1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

REMOTE="${GIT_PUSH_REMOTE:-origin}"
PUSH_ALL_TAGS=0
FORCE_WITH_LEASE=0
TAGS=()
EXTRA_ARGS=()

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --tags) PUSH_ALL_TAGS=1; shift ;;
    --force-with-lease) FORCE_WITH_LEASE=1; shift ;;
    --remote)
      REMOTE="${2:?--remote requires a value}"
      shift 2
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    -*)
      log_err "unknown flag: $1"
      usage 1
      ;;
    *)
      TAGS+=("$1")
      shift
      ;;
  esac
done

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  log_err "Git remote not found: $REMOTE"
  exit 1
fi

BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ -z "$BRANCH" ]]; then
  log_err "detached HEAD -- checkout a branch before pushing"
  exit 1
fi

PUSH_FLAGS=()
if [[ "$FORCE_WITH_LEASE" -eq 1 ]]; then
  PUSH_FLAGS+=(--force-with-lease)
fi
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  PUSH_FLAGS+=("${EXTRA_ARGS[@]}")
fi

log_step "Pushing branch '$BRANCH'"
log_info "remote: $REMOTE ($(git remote get-url --push "$REMOTE"))"
git push "$REMOTE" "HEAD:refs/heads/$BRANCH" "${PUSH_FLAGS[@]+"${PUSH_FLAGS[@]}"}"
log_ok "branch $BRANCH pushed"

push_one_tag() {
  local tag="$1"
  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    log_err "local tag not found: $tag"
    return 1
  fi
  log_step "Pushing tag $tag"
  git push "$REMOTE" "refs/tags/$tag"
  log_ok "tag $tag pushed"
}

if [[ ${#TAGS[@]} -gt 0 ]]; then
  for tag in "${TAGS[@]}"; do
    push_one_tag "$tag"
  done
fi

if [[ "$PUSH_ALL_TAGS" -eq 1 ]]; then
  log_step "Pushing all local tags"
  git push "$REMOTE" --tags
  log_ok "all tags pushed"
fi

log_step "Status"
git status -sb
