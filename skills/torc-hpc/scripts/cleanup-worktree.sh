#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: cleanup-worktree.sh --git-dir /path/to/repo --worktree /path/to/worktree [--remote name] [--ref refs/heads/runs/<id>]

Remove a per-run git worktree, prune stale worktree metadata, and optionally
delete a temporary remote ref used to make the commit fetchable.
EOF
}

GIT_DIR=""
WORKTREE=""
REMOTE=""
TEMP_REF=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --git-dir)
      GIT_DIR="${2:?missing value for --git-dir}"
      shift 2
      ;;
    --worktree)
      WORKTREE="${2:?missing value for --worktree}"
      shift 2
      ;;
    --remote)
      REMOTE="${2:?missing value for --remote}"
      shift 2
      ;;
    --ref)
      TEMP_REF="${2:?missing value for --ref}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_cmd() {
  local cmd="${1:?cmd}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$cmd" >&2
    return 1
  fi
}

if [[ -z "$GIT_DIR" || -z "$WORKTREE" ]]; then
  usage >&2
  exit 2
fi

require_cmd git

if ! git -C "$GIT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'Not a git repository: %s\n' "$GIT_DIR" >&2
  exit 1
fi

failed=0

if [[ -d "$WORKTREE" ]]; then
  printf 'info removing worktree: %s\n' "$WORKTREE"
  if ! git -C "$GIT_DIR" worktree remove --force "$WORKTREE"; then
    printf 'warn git worktree remove failed; trying rm -rf: %s\n' "$WORKTREE" >&2
    if ! rm -rf -- "$WORKTREE"; then
      printf 'fail unable to remove worktree path: %s\n' "$WORKTREE" >&2
      failed=1
    fi
  fi
else
  printf 'info worktree path already absent: %s\n' "$WORKTREE"
fi

printf 'info pruning stale worktree metadata\n'
if ! git -C "$GIT_DIR" worktree prune; then
  printf 'fail git worktree prune failed\n' >&2
  failed=1
fi

if [[ -n "$REMOTE" && -n "$TEMP_REF" ]]; then
  printf 'info deleting temp ref %s on %s\n' "$TEMP_REF" "$REMOTE"
  if ! git -C "$GIT_DIR" push "$REMOTE" ":$TEMP_REF"; then
    printf 'fail deleting temp ref failed: %s on %s\n' "$TEMP_REF" "$REMOTE" >&2
    failed=1
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

printf 'ok   cleanup complete\n'
