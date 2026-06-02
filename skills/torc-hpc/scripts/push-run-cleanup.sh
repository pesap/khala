#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: push-run-cleanup.sh \
  --host user@host \
  --remote-git-dir /scratch/user/git/repo.git \
  --script path/in/repo.sh \
  [--repo .] \
  [--sha <sha-or-ref>] \
  [--run-id <run-id>] \
  [--run-parent /scratch/user/torc-runs] \
  [--ref refs/heads/runs/<run-id>] \
  [--cleanup on-success|always|never] \
  [--delete-ref] \
  [--out-dir ./artifacts] \
  [--fetch out]... \
  [--] [script-arg ...]

Push the selected local commit to a remote bare Git repository, materialize that
exact commit as an isolated remote worktree, run a Bash script from the worktree,
optionally fetch logs/artifacts, and clean up the temporary worktree.

Defaults:
  --sha       HEAD
  --run-id    run-<UTC timestamp>-<short sha>
  --run-parent /scratch/<remote-user>/torc-runs
  --ref       refs/heads/runs/<run-id>
  --cleanup   on-success

The remote script runs on the SSH target login host. Use it for lightweight
orchestration/submission scripts. Do not run solver, build, or benchmark payloads
on login nodes; submit those through Slurm/Torc from the remote script instead.
EOF
}

log() { printf 'info %s\n' "$*" >&2; }
ok() { printf 'ok   %s\n' "$*" >&2; }
warn() { printf 'warn %s\n' "$*" >&2; }
fail() { printf 'fail %s\n' "$*" >&2; exit 1; }

require_arg() {
  local name="${1:?name}"
  local value="${2-}"
  [[ -n "$value" ]] || {
    usage >&2
    fail "missing required argument: $name"
  }
}

need_cmd() {
  local cmd="${1:?cmd}"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required local command: $cmd"
}

remote_quote() {
  printf '%q' "$1"
}

safe_run_id() {
  local run_id="${1:?run id}"
  [[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]]
}

safe_relative_path() {
  local path="${1:?path}"
  [[ "$path" != /* && "$path" != *..* && -n "$path" ]]
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

HOST=""
REMOTE_GIT_DIR=""
REPO="."
SHA_INPUT="HEAD"
RUN_ID=""
RUN_PARENT=""
REF=""
RUN_SCRIPT=""
CLEANUP_MODE="on-success"
DELETE_REF=0
OUT_DIR=""
FETCH_PATHS=()
SCRIPT_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?missing value for --host}"; shift 2 ;;
    --remote-git-dir) REMOTE_GIT_DIR="${2:?missing value for --remote-git-dir}"; shift 2 ;;
    --repo) REPO="${2:?missing value for --repo}"; shift 2 ;;
    --sha) SHA_INPUT="${2:?missing value for --sha}"; shift 2 ;;
    --run-id) RUN_ID="${2:?missing value for --run-id}"; shift 2 ;;
    --run-parent) RUN_PARENT="${2:?missing value for --run-parent}"; shift 2 ;;
    --ref) REF="${2:?missing value for --ref}"; shift 2 ;;
    --script) RUN_SCRIPT="${2:?missing value for --script}"; shift 2 ;;
    --cleanup) CLEANUP_MODE="${2:?missing value for --cleanup}"; shift 2 ;;
    --delete-ref) DELETE_REF=1; shift ;;
    --out-dir) OUT_DIR="${2:?missing value for --out-dir}"; shift 2 ;;
    --fetch) FETCH_PATHS+=("${2:?missing value for --fetch}"); shift 2 ;;
    --) shift; SCRIPT_ARGS+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

require_arg --host "$HOST"
require_arg --remote-git-dir "$REMOTE_GIT_DIR"
require_arg --script "$RUN_SCRIPT"

case "$CLEANUP_MODE" in
  on-success|always|never) ;;
  *) fail "--cleanup must be one of: on-success, always, never" ;;
esac

safe_relative_path "$RUN_SCRIPT" || fail "--script must be a safe relative path inside the repo: $RUN_SCRIPT"
for fetch_path in "${FETCH_PATHS[@]}"; do
  safe_relative_path "$fetch_path" || fail "--fetch must be a safe relative path under the remote run root: $fetch_path"
done

need_cmd git
need_cmd ssh
need_cmd mktemp
if [[ -n "$OUT_DIR" ]]; then
  need_cmd rsync
fi

repo_root="$(git -C "$REPO" rev-parse --show-toplevel)"
sha="$(git -C "$repo_root" rev-parse --verify "${SHA_INPUT}^{commit}")"
short_sha="${sha:0:12}"

if [[ "$SHA_INPUT" == "HEAD" ]]; then
  if ! git -C "$repo_root" diff --quiet || ! git -C "$repo_root" diff --cached --quiet; then
    warn 'local worktree has uncommitted changes; pushing committed HEAD only'
  fi
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="run-$(date -u +%Y%m%d-%H%M%S)-$short_sha"
fi
safe_run_id "$RUN_ID" || fail "--run-id may only contain letters, numbers, dot, underscore, and dash: $RUN_ID"

if [[ -z "$RUN_PARENT" ]]; then
  remote_user="${HOST%@*}"
  [[ "$remote_user" != "$HOST" ]] || remote_user="${USER:?USER}"
  RUN_PARENT="/scratch/$remote_user/torc-runs"
fi
RUN_PARENT="${RUN_PARENT%/}"
run_root="$RUN_PARENT/$RUN_ID"
run_src="$run_root/src"
run_logs="$run_root/logs"
remote_url="$HOST:$REMOTE_GIT_DIR"

if [[ -z "$REF" ]]; then
  REF="refs/heads/runs/$RUN_ID"
fi

log "repo=$repo_root"
log "host=$HOST"
log "remote_git_dir=$REMOTE_GIT_DIR"
log "sha=$sha"
log "ref=$REF"
log "run_root=$run_root"
log "script=$RUN_SCRIPT"

ssh "$HOST" bash -s -- "$REMOTE_GIT_DIR" <<'REMOTE_INIT'
set -euo pipefail
remote_git_dir="${1:?remote git dir}"
parent_dir="$(dirname -- "$remote_git_dir")"
mkdir -p -- "$parent_dir"
if [[ -e "$remote_git_dir" ]]; then
  git --git-dir="$remote_git_dir" rev-parse --git-dir >/dev/null 2>&1 || {
    printf 'Remote path exists but is not a git repository: %s\n' "$remote_git_dir" >&2
    exit 1
  }
else
  git init --bare "$remote_git_dir" >/dev/null
fi
REMOTE_INIT

log "pushing commit to remote ref"
git -C "$repo_root" push "$remote_url" "$sha:$REF"

"$script_dir/prepare-git-run.sh" \
  --host "$HOST" \
  --remote-git-dir "$REMOTE_GIT_DIR" \
  --sha "$sha" \
  --ref "$REF" \
  --run-root "$run_root" \
  --name "$RUN_ID"

remote_script="$(mktemp)"
trap 'rm -f "$remote_script"' EXIT

{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'readonly remote_git_dir=%s\n' "$(remote_quote "$REMOTE_GIT_DIR")"
  printf 'readonly run_root=%s\n' "$(remote_quote "$run_root")"
  printf 'readonly src=%s\n' "$(remote_quote "$run_src")"
  printf 'readonly logs=%s\n' "$(remote_quote "$run_logs")"
  printf 'readonly sha=%s\n' "$(remote_quote "$sha")"
  printf 'readonly ref=%s\n' "$(remote_quote "$REF")"
  printf 'readonly run_script=%s\n' "$(remote_quote "$RUN_SCRIPT")"
  printf 'run_args=(\n'
  for script_arg in "${SCRIPT_ARGS[@]}"; do
    printf '  %s\n' "$(remote_quote "$script_arg")"
  done
  printf ')\n'
  cat <<'REMOTE_RUN'
mkdir -p -- "$logs"
actual_sha="$(git -C "$src" rev-parse HEAD)"
if [[ "$actual_sha" != "$sha" ]]; then
  printf 'Worktree SHA mismatch: expected=%s actual=%s\n' "$sha" "$actual_sha" >&2
  exit 1
fi
if [[ ! -f "$src/$run_script" ]]; then
  printf 'Run script not found in worktree: %s\n' "$src/$run_script" >&2
  exit 1
fi

export RUN_ROOT="$run_root"
export RUN_SRC="$src"
export RUN_OUT="$run_root/out"
export RUN_LOGS="$logs"
export RUN_SHA="$sha"
export RUN_REF="$ref"
export REMOTE_GIT_DIR="$remote_git_dir"

cd "$src"
exec > >(tee "$logs/script.stdout.log") 2> >(tee "$logs/script.stderr.log" >&2)
printf 'ok   running remote script\n'
printf 'RUN_ROOT=%s\n' "$RUN_ROOT"
printf 'RUN_SRC=%s\n' "$RUN_SRC"
printf 'RUN_OUT=%s\n' "$RUN_OUT"
printf 'RUN_LOGS=%s\n' "$RUN_LOGS"
printf 'RUN_SHA=%s\n' "$RUN_SHA"
printf 'RUN_REF=%s\n' "$RUN_REF"
printf 'SCRIPT=%s\n' "$run_script"
bash "$run_script" "${run_args[@]}"
REMOTE_RUN
} > "$remote_script"

run_status=0
ssh "$HOST" 'bash -s' < "$remote_script" || run_status=$?

fetch_status=0
if [[ -n "$OUT_DIR" ]]; then
  local_run_dir="${OUT_DIR%/}/$RUN_ID"
  mkdir -p "$local_run_dir"
  log "fetching logs to $local_run_dir"
  rsync -az "$HOST:$run_root/metadata.env" "$local_run_dir/" || fetch_status=$?
  rsync -az "$HOST:$run_root/logs/" "$local_run_dir/logs/" || fetch_status=$?
  for fetch_path in "${FETCH_PATHS[@]}"; do
    clean_fetch="${fetch_path#./}"
    log "fetching $clean_fetch"
    rsync -az --relative "$HOST:${run_root%/}/./$clean_fetch" "$local_run_dir/" || fetch_status=$?
  done
fi

cleanup_status=0
should_cleanup=0
case "$CLEANUP_MODE" in
  always) should_cleanup=1 ;;
  on-success) [[ "$run_status" -eq 0 ]] && should_cleanup=1 ;;
  never) should_cleanup=0 ;;
esac

if [[ "$should_cleanup" -eq 1 ]]; then
  cleanup_args=(
    --host "$HOST"
    --remote-git-dir "$REMOTE_GIT_DIR"
    --run-root "$RUN_PARENT"
    --run-id "$RUN_ID"
    --execute
  )
  if [[ "$DELETE_REF" -eq 1 ]]; then
    cleanup_args+=(--delete-ref)
  fi
  "$script_dir/cleanup-worktree.sh" "${cleanup_args[@]}" || cleanup_status=$?
else
  log "cleanup skipped; mode=$CLEANUP_MODE run_status=$run_status"
fi

if [[ "$run_status" -ne 0 ]]; then
  fail "remote script failed with exit code $run_status"
fi
if [[ "$fetch_status" -ne 0 ]]; then
  fail "artifact fetch failed with exit code $fetch_status"
fi
if [[ "$cleanup_status" -ne 0 ]]; then
  fail "cleanup failed with exit code $cleanup_status"
fi

ok "remote run complete: $RUN_ID"
