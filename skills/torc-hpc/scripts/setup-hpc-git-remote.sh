#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: setup-hpc-git-remote.sh \
  --host user@host \
  --remote-git-dir /scratch/user/git/repo.git \
  [--remote-name hpc] \
  [--repo .] \
  [--force] \
  [--push-current]

Create or reuse a bare Git repository on an HPC login node and configure the
local repository with a Git remote such as `hpc`. This sets up code transport
for reproducible Torc/HPC runs:

  git push hpc HEAD:refs/heads/my-run

Data is not synced. Jobs must point at data already present on the remote
filesystem.
EOF
}

HOST=""
REMOTE_GIT_DIR=""
REMOTE_NAME="hpc"
REPO="."
FORCE=0
PUSH_CURRENT=0

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
    --remote-name)
      REMOTE_NAME="${2:?missing value for --remote-name}"
      shift 2
      ;;
    --repo)
      REPO="${2:?missing value for --repo}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --push-current)
      PUSH_CURRENT=1
      shift
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
require_arg --remote-name "$REMOTE_NAME"
require_arg --repo "$REPO"

need_cmd git
need_cmd ssh

repo_root="$(git -C "$REPO" rev-parse --show-toplevel)"
current_branch="$(git -C "$repo_root" branch --show-current || true)"
remote_url="${HOST}:${REMOTE_GIT_DIR}"

if [[ -z "$current_branch" && "$PUSH_CURRENT" -eq 1 ]]; then
  printf 'Cannot --push-current from detached HEAD. Provide/push an explicit ref manually.\n' >&2
  exit 2
fi

printf 'info repo: %s\n' "$repo_root"
printf 'info remote bare repo: %s:%s\n' "$HOST" "$REMOTE_GIT_DIR"

ssh "$HOST" bash -s -- "$REMOTE_GIT_DIR" <<'REMOTE'
set -euo pipefail
remote_git_dir="${1:?remote git dir}"
parent_dir="$(dirname "$remote_git_dir")"
mkdir -p "$parent_dir"
if [[ -e "$remote_git_dir" ]]; then
  if git --git-dir="$remote_git_dir" rev-parse --git-dir >/dev/null 2>&1; then
    printf 'ok   remote bare repo exists: %s\n' "$remote_git_dir"
  else
    printf 'Remote path exists but is not a git repo: %s\n' "$remote_git_dir" >&2
    exit 1
  fi
else
  git init --bare "$remote_git_dir" >/dev/null
  printf 'ok   created remote bare repo: %s\n' "$remote_git_dir"
fi
REMOTE

if git -C "$repo_root" remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  existing_url="$(git -C "$repo_root" remote get-url "$REMOTE_NAME")"
  if [[ "$existing_url" != "$remote_url" && "$FORCE" -ne 1 ]]; then
    printf 'Remote %s already exists with different URL:\n  existing: %s\n  desired:  %s\nUse --force to replace it.\n' "$REMOTE_NAME" "$existing_url" "$remote_url" >&2
    exit 1
  fi
  git -C "$repo_root" remote set-url "$REMOTE_NAME" "$remote_url"
  printf 'ok   updated local remote %s=%s\n' "$REMOTE_NAME" "$remote_url"
else
  git -C "$repo_root" remote add "$REMOTE_NAME" "$remote_url"
  printf 'ok   added local remote %s=%s\n' "$REMOTE_NAME" "$remote_url"
fi

if git -C "$repo_root" ls-remote "$REMOTE_NAME" >/dev/null 2>&1; then
  printf 'ok   verified git remote %s\n' "$REMOTE_NAME"
else
  printf 'fail could not verify git remote %s\n' "$REMOTE_NAME" >&2
  exit 1
fi

if [[ "$PUSH_CURRENT" -eq 1 ]]; then
  printf 'info pushing current HEAD to %s:%s\n' "$REMOTE_NAME" "$current_branch"
  git -C "$repo_root" push "$REMOTE_NAME" "HEAD:refs/heads/$current_branch"
fi

cat <<EOF

Next:
  git push $REMOTE_NAME HEAD:refs/heads/<run-branch>
  SHA=\$(git rev-parse HEAD)
  skills/torc-hpc/scripts/prepare-git-run.sh --host $HOST --remote-git-dir $REMOTE_GIT_DIR --sha \$SHA --run-root /scratch/\$USER/torc-runs/<run-id>
EOF
