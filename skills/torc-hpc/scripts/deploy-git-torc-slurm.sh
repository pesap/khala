#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-git-torc-slurm.sh \
  --host user@host \
  --remote-git-dir /scratch/user/git/repo.git \
  --sha <commit-sha> \
  --run-id <run-id> \
  --workflow path/to/workflow.slurm.yaml \
  --torc-api-url http://host:port/torc-service/v1 \
  [--run-parent /scratch/user/torc-runs] \
  [--ref refs/heads/runs/run-id] \
  [--module gams/51.3.0 --module xpressmp/9.7.0] \
  [--modules 'gams/51.3.0 xpressmp/9.7.0'] \
  [--remote-torc-bin /scratch/user/torc/0.30.3/torc] \
  [--remote-path-prefix /scratch/user/torc/0.30.3/bin] \
  [--output-subdir torc_output] \
  [--dry-run]

Prepare an exact-SHA remote worktree from an existing HPC bare Git repo and
submit a Torc Slurm workflow from that worktree.

This script does not commit, push, build, install dependencies, or run solver
payloads on login nodes. The commit must already exist in --remote-git-dir.

Notes:
- `--sha` accepts a short or full commit hash (minimum 6 hex chars).
- `--run-parent` defaults to `/scratch/<remote-user>/torc-runs` when omitted.
- Use `--remote-torc-bin` only when `torc` is not already on remote PATH.
- `--remote-path-prefix` prepends a directory to remote PATH before resolving `torc`.
- Prefer repeated `--module` flags; `--modules` remains supported for compatibility.
EOF
}

log() {
  printf 'info %s\n' "$*" >&2
}

ok() {
  printf 'ok   %s\n' "$*" >&2
}

fail() {
  printf 'fail %s\n' "$*" >&2
  exit 1
}

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

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

HOST=""
REMOTE_GIT_DIR=""
SHA=""
RUN_ID=""
WORKFLOW=""
TORC_API_URL_VALUE=""
RUN_PARENT=""
REF=""
MODULES=""
MODULE_LIST=()
REMOTE_TORC_BIN=""
REMOTE_PATH_PREFIX=""
OUTPUT_SUBDIR="torc_output"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?missing value for --host}"; shift 2 ;;
    --remote-git-dir) REMOTE_GIT_DIR="${2:?missing value for --remote-git-dir}"; shift 2 ;;
    --sha) SHA="${2:?missing value for --sha}"; shift 2 ;;
    --run-id) RUN_ID="${2:?missing value for --run-id}"; shift 2 ;;
    --workflow) WORKFLOW="${2:?missing value for --workflow}"; shift 2 ;;
    --torc-api-url) TORC_API_URL_VALUE="${2:?missing value for --torc-api-url}"; shift 2 ;;
    --run-parent) RUN_PARENT="${2:?missing value for --run-parent}"; shift 2 ;;
    --ref) REF="${2:?missing value for --ref}"; shift 2 ;;
    --module) MODULE_LIST+=("${2:?missing value for --module}"); shift 2 ;;
    --modules) MODULES="${2:?missing value for --modules}"; shift 2 ;;
    --remote-torc-bin) REMOTE_TORC_BIN="${2:?missing value for --remote-torc-bin}"; shift 2 ;;
    --remote-path-prefix) REMOTE_PATH_PREFIX="${2:?missing value for --remote-path-prefix}"; shift 2 ;;
    --output-subdir) OUTPUT_SUBDIR="${2:?missing value for --output-subdir}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

require_arg --host "$HOST"
require_arg --remote-git-dir "$REMOTE_GIT_DIR"
require_arg --sha "$SHA"
require_arg --run-id "$RUN_ID"
require_arg --workflow "$WORKFLOW"
require_arg --torc-api-url "$TORC_API_URL_VALUE"
need_cmd ssh
need_cmd mktemp

if [[ ! "$SHA" =~ ^[0-9a-fA-F]{6,40}$ ]]; then
  fail "--sha must be 6-40 hex characters (short or full commit hash): $SHA"
fi
if [[ -z "$MODULES" && "${#MODULE_LIST[@]}" -gt 0 ]]; then
  MODULES="${MODULE_LIST[*]}"
fi

if [[ -z "$RUN_PARENT" ]]; then
  remote_user="${HOST%@*}"
  [[ "$remote_user" != "$HOST" ]] || remote_user="${USER:?USER}"
  RUN_PARENT="/scratch/${remote_user}/torc-runs"
fi
if [[ -z "$REF" ]]; then
  REF="refs/heads/runs/$RUN_ID"
fi
if [[ -z "$REMOTE_TORC_BIN" && -n "$REMOTE_PATH_PREFIX" ]]; then
  REMOTE_TORC_BIN="${REMOTE_PATH_PREFIX%/}/torc"
fi

run_root="${RUN_PARENT%/}/$RUN_ID"
run_src="$run_root/src"
run_out="$run_root/out"

log "host=$HOST"
log "run_id=$RUN_ID"
log "run_root=$run_root"
log "sha=$SHA"
log "workflow=$WORKFLOW"
if [[ -n "$REMOTE_TORC_BIN" ]]; then
  log "remote_torc_bin=$REMOTE_TORC_BIN"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  ok "dry run complete; no remote changes made"
  exit 0
fi

"$script_dir/prepare-git-run.sh" \
  --host "$HOST" \
  --remote-git-dir "$REMOTE_GIT_DIR" \
  --sha "$SHA" \
  --ref "$REF" \
  --run-root "$run_root" \
  --name "$RUN_ID"

remote_script="$(mktemp)"
trap 'rm -f "$remote_script"' EXIT

cat > "$remote_script" <<REMOTE
#!/usr/bin/env bash
set -euo pipefail
readonly run_root=$(remote_quote "$run_root")
readonly src=$(remote_quote "$run_src")
readonly out=$(remote_quote "$run_out")
readonly sha=$(remote_quote "$SHA")
readonly workflow=$(remote_quote "$WORKFLOW")
readonly torc_api_url=$(remote_quote "$TORC_API_URL_VALUE")
readonly modules=$(remote_quote "$MODULES")
readonly output_subdir=$(remote_quote "$OUTPUT_SUBDIR")
readonly remote_path_prefix=$(remote_quote "$REMOTE_PATH_PREFIX")
readonly requested_torc_bin=$(remote_quote "$REMOTE_TORC_BIN")

if [[ -n "\$remote_path_prefix" ]]; then
  export PATH="\${remote_path_prefix%/}:\$PATH"
fi

actual_sha="\$(git -C "\$src" rev-parse HEAD)"
if [[ "\$actual_sha" != "\$sha" ]]; then
  printf 'Worktree SHA mismatch: expected=%s actual=%s\n' "\$sha" "\$actual_sha" >&2
  exit 1
fi
if [[ ! -f "\$src/\$workflow" ]]; then
  printf 'Workflow file not found in worktree: %s\n' "\$src/\$workflow" >&2
  exit 1
fi

if [[ -n "\$requested_torc_bin" ]]; then
  torc_bin="\$requested_torc_bin"
else
  torc_bin="\$(command -v torc || true)"
fi
if [[ -z "\$torc_bin" || ! -x "\$torc_bin" ]]; then
  printf 'torc command not found or not executable: %s\n' "\$torc_bin" >&2
  exit 1
fi
command -v sbatch >/dev/null 2>&1 || {
  printf 'sbatch command not found on remote host\n' >&2
  exit 1
}

export TORC_API_URL="\$torc_api_url"
if [[ -n "\$modules" ]]; then
  export FRAMEWORK_COMPARISON_MODULES="\$modules"
fi

cd "\$src"
printf 'ok   submitting Torc workflow\n'
printf 'RUN_ROOT=%s\n' "\$run_root"
printf 'RUN_SRC=%s\n' "\$src"
printf 'RUN_OUT=%s\n' "\$out"
printf 'RUN_SHA=%s\n' "\$sha"
printf 'TORC_API_URL=%s\n' "\$TORC_API_URL"
printf 'TORC=%s\n' "\$torc_bin"
"\$torc_bin" --version
printf 'WORKFLOW=%s\n' "\$workflow"
"\$torc_bin" submit -o "\$out/\$output_subdir" "\$workflow"
REMOTE

ssh "$HOST" 'bash -s' < "$remote_script"
