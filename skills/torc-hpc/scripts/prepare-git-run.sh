#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: prepare-git-run.sh \
  --host user@host \
  --remote-git-dir /scratch/user/git/repo.git \
  --sha <commit-sha> \
  --run-root /scratch/user/torc-runs/run-id \
  [--ref branch-or-ref] \
  [--name run-id]

Create an isolated exact-SHA worktree on the HPC login node for a Torc/Slurm
run. The script creates:

  <run-root>/src   # git worktree at --sha
  <run-root>/out   # intended output directory
  <run-root>/logs  # intended log directory
  <run-root>/metadata.env

It does not submit jobs and does not sync data. Jobs should run from RUN_SRC and
write outputs/logs under RUN_OUT/RUN_LOGS or explicit remote data/output paths.
EOF
}

HOST=""
REMOTE_GIT_DIR=""
SHA=""
REF=""
RUN_ROOT=""
NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:?missing value for --host}"
      shift 2
      ;;
    --remote-git-dir)
      REMOTE_GIT_DIR="${2:?missing value for --remote-git-dir}"
      shift 2
      ;;
    --sha)
      SHA="${2:?missing value for --sha}"
      shift 2
      ;;
    --ref)
      REF="${2:?missing value for --ref}"
      shift 2
      ;;
    --run-root)
      RUN_ROOT="${2:?missing value for --run-root}"
      shift 2
      ;;
    --name)
      NAME="${2:?missing value for --name}"
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

require_arg() {
  local name="${1:?name}"
  local value="${2-}"
  if [[ -z "$value" ]]; then
    printf 'Missing required argument: %s\n' "$name" >&2
    usage >&2
    exit 2
  fi
}

need_cmd() {
  local cmd="${1:?cmd}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'Missing required local command: %s\n' "$cmd" >&2
    exit 1
  fi
}

require_arg --host "$HOST"
require_arg --remote-git-dir "$REMOTE_GIT_DIR"
require_arg --sha "$SHA"
require_arg --run-root "$RUN_ROOT"
need_cmd ssh

if [[ -z "$NAME" ]]; then
  short_sha="${SHA:0:12}"
  NAME="run-$short_sha"
fi

ssh "$HOST" bash -s -- "$REMOTE_GIT_DIR" "$SHA" "$RUN_ROOT" "$NAME" "$REF" <<'REMOTE'
set -euo pipefail
remote_git_dir="${1:?remote git dir}"
sha="${2:?sha}"
run_root="${3:?run root}"
name="${4:?name}"
ref="${5-}"
src="$run_root/src"
out="$run_root/out"
logs="$run_root/logs"
metadata_env="$run_root/metadata.env"

if ! git --git-dir="$remote_git_dir" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'Remote git dir is not a git repo: %s\n' "$remote_git_dir" >&2
  exit 1
fi

if ! git --git-dir="$remote_git_dir" cat-file -e "$sha^{commit}" 2>/dev/null; then
  printf 'Commit is not present in remote git dir: %s\n' "$sha" >&2
  printf 'Push it first, for example: git push hpc HEAD:refs/heads/<run-branch>\n' >&2
  exit 1
fi

if [[ -e "$src" ]]; then
  printf 'Run source already exists: %s\n' "$src" >&2
  printf 'Choose a new --run-root or clean up the existing worktree first.\n' >&2
  exit 1
fi

mkdir -p "$run_root" "$out" "$logs"
git --git-dir="$remote_git_dir" worktree add --detach "$src" "$sha" >/dev/null
actual_sha="$(git -C "$src" rev-parse HEAD)"
if [[ "$actual_sha" != "$sha" ]]; then
  printf 'Worktree SHA mismatch: expected=%s actual=%s\n' "$sha" "$actual_sha" >&2
  exit 1
fi

cat > "$metadata_env" <<EOF_ENV
RUN_NAME=$(printf '%q' "$name")
RUN_ROOT=$(printf '%q' "$run_root")
RUN_SRC=$(printf '%q' "$src")
RUN_OUT=$(printf '%q' "$out")
RUN_LOGS=$(printf '%q' "$logs")
RUN_SHA=$(printf '%q' "$sha")
RUN_REF=$(printf '%q' "$ref")
REMOTE_GIT_DIR=$(printf '%q' "$remote_git_dir")
EOF_ENV

printf 'ok   prepared git worktree\n'
printf 'RUN_ROOT=%s\n' "$run_root"
printf 'RUN_SRC=%s\n' "$src"
printf 'RUN_OUT=%s\n' "$out"
printf 'RUN_LOGS=%s\n' "$logs"
printf 'RUN_SHA=%s\n' "$sha"
printf 'METADATA_ENV=%s\n' "$metadata_env"
REMOTE
