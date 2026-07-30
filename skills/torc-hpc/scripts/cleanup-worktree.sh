#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: cleanup-worktree.sh \
  --host user@host \
  --remote-git-dir /scratch/user/git/repo.git \
  --run-root /scratch/user/torc-runs \
  --run-id <run-id> [--run-id <run-id> ...] \
  [--keep <run-id>] \
  [--delete-ref] \
  [--force-path-delete] \
  [--dry-run] \
  [--execute]

Clean temporary exact-SHA Git worktrees for HPC Torc runs.

Default mode is dry-run. Use --execute to make changes.
`--dry-run` is accepted explicitly and is equivalent to the default.
By default this removes only <run-root>/<run-id>/src worktrees and prunes
worktree metadata. It preserves logs, outputs, and metadata files.

Safety:
  - Uses the remote host over SSH; no local path hacks.
  - Uses git --git-dir=<bare-repo> worktree remove for tracked worktrees.
  - Does not run rm -rf unless --force-path-delete is also provided.
  - Does not delete refs unless --delete-ref is provided.
EOF
}

log() { printf 'info %s\n' "$*" >&2; }
ok() { printf 'ok   %s\n' "$*" >&2; }
fail() { printf 'fail %s\n' "$*" >&2; exit 1; }

need_cmd() {
  local cmd="${1:?cmd}"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required local command: $cmd"
}

require_arg() {
  local name="${1:?name}"
  local value="${2-}"
  [[ -n "$value" ]] || {
    usage >&2
    fail "missing required argument: $name"
  }
}

remote_quote() {
  printf '%q' "$1"
}

HOST=""
REMOTE_GIT_DIR=""
RUN_ROOT=""
RUN_IDS=()
KEEP_RUN_IDS=()
DELETE_REF=0
FORCE_PATH_DELETE=0
EXECUTE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?missing value for --host}"; shift 2 ;;
    --remote-git-dir) REMOTE_GIT_DIR="${2:?missing value for --remote-git-dir}"; shift 2 ;;
    --run-root) RUN_ROOT="${2:?missing value for --run-root}"; shift 2 ;;
    --run-id) RUN_IDS+=("${2:?missing value for --run-id}"); shift 2 ;;
    --keep) KEEP_RUN_IDS+=("${2:?missing value for --keep}"); shift 2 ;;
    --delete-ref) DELETE_REF=1; shift ;;
    --force-path-delete) FORCE_PATH_DELETE=1; shift ;;
    --dry-run) EXECUTE=0; shift ;;
    --execute) EXECUTE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

require_arg --host "$HOST"
require_arg --remote-git-dir "$REMOTE_GIT_DIR"
require_arg --run-root "$RUN_ROOT"
[[ "${#RUN_IDS[@]}" -gt 0 ]] || {
  usage >&2
  fail "at least one --run-id is required"
}
need_cmd ssh
need_cmd mktemp

remote_script="$(mktemp)"
trap 'rm -f "$remote_script"' EXIT

{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'readonly remote_git_dir=%s\n' "$(remote_quote "$REMOTE_GIT_DIR")"
  printf 'readonly run_root=%s\n' "$(remote_quote "${RUN_ROOT%/}")"
  printf 'readonly delete_ref=%s\n' "$(remote_quote "$DELETE_REF")"
  printf 'readonly force_path_delete=%s\n' "$(remote_quote "$FORCE_PATH_DELETE")"
  printf 'readonly execute=%s\n' "$(remote_quote "$EXECUTE")"
  printf 'run_ids=(\n'
  for run_id in "${RUN_IDS[@]}"; do
    printf '  %s\n' "$(remote_quote "$run_id")"
  done
  printf ')\n'
  printf 'keep_run_ids=(\n'
  for run_id in "${KEEP_RUN_IDS[@]}"; do
    printf '  %s\n' "$(remote_quote "$run_id")"
  done
  printf ')\n'
  cat <<'REMOTE'

log() { printf 'info %s\n' "$*" >&2; }
ok() { printf 'ok   %s\n' "$*" >&2; }
warn() { printf 'warn %s\n' "$*" >&2; }
fail() { printf 'fail %s\n' "$*" >&2; exit 1; }

is_kept() {
  local run_id="${1:?run id}"
  local keep=""
  for keep in "${keep_run_ids[@]}"; do
    [[ "$run_id" == "$keep" ]] && return 0
  done
  return 1
}

safe_run_id() {
  local run_id="${1:?run id}"
  [[ "$run_id" != /* && "$run_id" != *..* && "$run_id" != *'/'* ]]
}

command -v git >/dev/null 2>&1 || fail 'missing remote command: git'
[[ -d "$remote_git_dir" ]] || fail "remote git dir not found: $remote_git_dir"
git --git-dir="$remote_git_dir" rev-parse --git-dir >/dev/null 2>&1 || fail "not a git repository: $remote_git_dir"

if [[ "$execute" -eq 0 ]]; then
  log 'dry-run mode; pass --execute to remove worktrees'
fi

removed=0
skipped=0
failed=0

for run_id in "${run_ids[@]}"; do
  if ! safe_run_id "$run_id"; then
    warn "unsafe run id skipped: $run_id"
    failed=1
    continue
  fi
  if is_kept "$run_id"; then
    log "keep run: $run_id"
    skipped=$((skipped + 1))
    continue
  fi

  src="$run_root/$run_id/src"
  ref="refs/heads/runs/$run_id"

  if [[ ! -e "$src" ]]; then
    log "already absent: $src"
  elif [[ "$execute" -eq 0 ]]; then
    printf 'would remove src=%s\n' "$src"
  else
    log "remove worktree: $src"
    if git --git-dir="$remote_git_dir" worktree remove --force "$src"; then
      removed=$((removed + 1))
    elif [[ "$force_path_delete" -eq 1 ]]; then
      warn "git worktree remove failed; force deleting path: $src"
      rm -rf -- "$src"
      removed=$((removed + 1))
    else
      warn "git worktree remove failed; rerun with --force-path-delete only if this path is safe: $src"
      failed=1
    fi
  fi

  if [[ "$delete_ref" -eq 1 ]]; then
    if [[ "$execute" -eq 0 ]]; then
      printf 'would delete ref=%s\n' "$ref"
    else
      if git --git-dir="$remote_git_dir" show-ref --verify --quiet "$ref"; then
        log "delete ref: $ref"
        git --git-dir="$remote_git_dir" update-ref -d "$ref" || failed=1
      else
        log "ref already absent: $ref"
      fi
    fi
  fi
done

if [[ "$execute" -eq 0 ]]; then
  printf 'would prune worktree metadata in %s\n' "$remote_git_dir"
else
  log 'prune worktree metadata'
  git --git-dir="$remote_git_dir" worktree prune || failed=1
fi

printf 'summary removed=%s skipped=%s failed=%s execute=%s\n' "$removed" "$skipped" "$failed" "$execute"
[[ "$failed" -eq 0 ]] || exit 1
ok 'cleanup complete'
REMOTE
} > "$remote_script"

log "host=$HOST"
log "remote_git_dir=$REMOTE_GIT_DIR"
log "run_root=${RUN_ROOT%/}"
log "run_count=${#RUN_IDS[@]}"
if [[ "$EXECUTE" -eq 0 ]]; then
  log "mode=dry-run"
else
  log "mode=execute"
fi

ssh "$HOST" 'bash -s' < "$remote_script"
