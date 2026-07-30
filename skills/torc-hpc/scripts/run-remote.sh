#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: run-remote.sh \
  --host user@host \
  --remote-root /path/for/run-state \
  --workdir /remote/project/path \
  --command 'torc ...' \
  --out-dir ./artifacts \
  [--fetch relative/path]... \
  [--name label] \
  [--poll-sec 15]

Runs a remote command via ssh, waits until it finishes, and rsyncs requested
result paths plus run logs back to this machine.

This script does not sync the repository itself. Prepare the target code on the
remote side first (for example with a remote checkout or per-run worktree),
then use --workdir to run inside that prepared location.
EOF
}

HOST=""
REMOTE_ROOT=""
WORKDIR=""
COMMAND_TEXT=""
OUT_DIR=""
NAME=""
POLL_SEC=15
FETCH_PATHS=()
EXIT_CODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:?missing value for --host}"
      shift 2
      ;;
    --remote-root)
      REMOTE_ROOT="${2:?missing value for --remote-root}"
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:?missing value for --workdir}"
      shift 2
      ;;
    --command)
      COMMAND_TEXT="${2:?missing value for --command}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?missing value for --out-dir}"
      shift 2
      ;;
    --fetch)
      FETCH_PATHS+=("${2:?missing value for --fetch}")
      shift 2
      ;;
    --name)
      NAME="${2:?missing value for --name}"
      shift 2
      ;;
    --poll-sec)
      POLL_SEC="${2:?missing value for --poll-sec}"
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

ssh_bash() {
  local script="${1:?script}"
  ssh "$HOST" bash -lc "$(printf '%q' "$script")"
}

for cmd in bash ssh rsync mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || {
    printf 'Missing required local command: %s\n' "$cmd" >&2
    exit 1
  }
done

require_arg --host "$HOST"
require_arg --remote-root "$REMOTE_ROOT"
require_arg --workdir "$WORKDIR"
require_arg --command "$COMMAND_TEXT"
require_arg --out-dir "$OUT_DIR"

if ! [[ "$POLL_SEC" =~ ^[0-9]+$ ]] || [[ "$POLL_SEC" -lt 1 ]]; then
  printf 'Invalid --poll-sec: %s\n' "$POLL_SEC" >&2
  exit 2
fi

if [[ -z "$NAME" ]]; then
  NAME="run-$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$OUT_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RUN_ID="$NAME"
REMOTE_RUN_DIR="${REMOTE_ROOT%/}/$RUN_ID"
LOCAL_RUN_DIR="${OUT_DIR%/}/$RUN_ID"
COMMAND_FILE="$TMP_DIR/command.sh"
RUNNER_FILE="$TMP_DIR/runner.sh"
mkdir -p "$LOCAL_RUN_DIR"

printf '%s\n' "$COMMAND_TEXT" > "$COMMAND_FILE"
cat > "$RUNNER_FILE" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd $(printf '%q' "$WORKDIR")
set +e
bash $(printf '%q' "$REMOTE_RUN_DIR/command.sh") > $(printf '%q' "$REMOTE_RUN_DIR/command.stdout.log") 2> $(printf '%q' "$REMOTE_RUN_DIR/command.stderr.log")
rc=\$?
set -e
printf '%s\n' "\$rc" > $(printf '%q' "$REMOTE_RUN_DIR/exit_code")
exit "\$rc"
EOF

printf 'info remote run dir: %s:%s\n' "$HOST" "$REMOTE_RUN_DIR"
printf 'info local artifact dir: %s\n' "$LOCAL_RUN_DIR"

ssh_bash "mkdir -p $(printf '%q' "$REMOTE_RUN_DIR")"
rsync -az "$COMMAND_FILE" "$RUNNER_FILE" "$HOST:$REMOTE_RUN_DIR/"
ssh_bash "chmod +x $(printf '%q' "$REMOTE_RUN_DIR/command.sh") $(printf '%q' "$REMOTE_RUN_DIR/runner.sh")"

launch_script=$(cat <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_RUN_DIR")
nohup bash ./runner.sh > launcher.log 2>&1 < /dev/null &
printf '%s\n' "\$!" > pid
EOF
)
ssh_bash "$launch_script"

printf 'info started remote run %s\n' "$RUN_ID"

while true; do
  status_script=$(cat <<EOF
set -euo pipefail
cd $(printf '%q' "$REMOTE_RUN_DIR")
if [[ -f exit_code ]]; then
  printf 'done:%s' "\$(cat exit_code)"
elif [[ -f pid ]] && kill -0 "\$(cat pid)" 2>/dev/null; then
  printf 'running'
else
  printf 'unknown'
fi
EOF
)
  status="$(ssh_bash "$status_script" | tr -d '\r')"

  case "$status" in
    done:*)
      EXIT_CODE="${status#done:}"
      printf 'info remote run finished with exit code %s\n' "$EXIT_CODE"
      break
      ;;
    running)
      printf 'info remote run still running; sleeping %ss\n' "$POLL_SEC"
      sleep "$POLL_SEC"
      ;;
    *)
      printf 'warn remote run status=%s; sleeping %ss\n' "$status" "$POLL_SEC" >&2
      sleep "$POLL_SEC"
      ;;
  esac
done

rsync -az "$HOST:$REMOTE_RUN_DIR/" "$LOCAL_RUN_DIR/remote-run-state/"

for fetch_path in "${FETCH_PATHS[@]}"; do
  clean_fetch="${fetch_path#./}"
  printf 'info fetching %s\n' "$clean_fetch"
  rsync -az --relative "$HOST:${WORKDIR%/}/./$clean_fetch" "$LOCAL_RUN_DIR/fetched/"
done

printf 'ok   local artifacts: %s\n' "$LOCAL_RUN_DIR"
exit "$EXIT_CODE"
