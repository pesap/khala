#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: doctor.sh [--host user@host] [--remote-workdir /path] [--remote-command 'command -v torc'] [--require-env NAME]... [--require-remote-env NAME]...

Checks local prerequisites for remote Torc/HPC execution and, when a host is
provided, verifies basic remote reachability, required environment variables,
and shell/tool availability.
EOF
}

HOST=""
REMOTE_WORKDIR=""
REMOTE_COMMAND="printf 'ok   remote torc=%s\n' \"\$(command -v torc || echo '<missing>')\""
REQUIRED_ENVS=()
REQUIRED_REMOTE_ENVS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:?missing value for --host}"
      shift 2
      ;;
    --remote-workdir)
      REMOTE_WORKDIR="${2:?missing value for --remote-workdir}"
      shift 2
      ;;
    --remote-command)
      REMOTE_COMMAND="${2:?missing value for --remote-command}"
      shift 2
      ;;
    --require-env)
      REQUIRED_ENVS+=("${2:?missing value for --require-env}")
      shift 2
      ;;
    --require-remote-env)
      REQUIRED_REMOTE_ENVS+=("${2:?missing value for --require-remote-env}")
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

need_cmd() {
  local cmd="${1:?cmd}"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf 'ok   local %s=%s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf 'fail local missing command: %s\n' "$cmd" >&2
    return 1
  fi
}

ssh_bash() {
  local script="${1:?script}"
  ssh "$HOST" bash -lc "$(printf '%q' "$script")"
}

local_failed=0
for cmd in bash ssh rsync; do
  if ! need_cmd "$cmd"; then
    local_failed=1
  fi
done

if [[ "$local_failed" -ne 0 ]]; then
  exit 1
fi

for env_name in "${REQUIRED_ENVS[@]}"; do
  if [[ -n "${!env_name-}" ]]; then
    printf 'ok   local env %s=%s\n' "$env_name" "${!env_name}"
  else
    printf 'fail local missing env: %s\n' "$env_name" >&2
    local_failed=1
  fi
done

if [[ "$local_failed" -ne 0 ]]; then
  exit 1
fi

if [[ -z "$HOST" ]]; then
  printf 'info no --host provided; local-only checks complete\n'
  exit 0
fi

printf 'info checking ssh connectivity to %s\n' "$HOST"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true
printf 'ok   ssh connectivity\n'

remote_script=$(cat <<'EOF'
set -euo pipefail
printf 'ok   remote hostname=%s\n' "$(hostname)"
printf 'ok   remote bash=%s\n' "$(command -v bash)"
if command -v module >/dev/null 2>&1; then
  printf 'ok   remote module=%s\n' "$(command -v module)"
else
  printf 'warn remote module command unavailable\n'
fi
if command -v conda >/dev/null 2>&1; then
  printf 'ok   remote conda=%s\n' "$(command -v conda)"
else
  printf 'warn remote conda command unavailable\n'
fi
EOF
)

if [[ -n "$REMOTE_WORKDIR" ]]; then
  remote_script+=$'\n'
  remote_script+="if [[ -d $(printf '%q' "$REMOTE_WORKDIR") ]]; then printf 'ok   remote workdir=%s\\n' $(printf '%q' "$REMOTE_WORKDIR"); else printf 'fail remote workdir missing: %s\\n' $(printf '%q' "$REMOTE_WORKDIR") >&2; exit 1; fi"
fi

for env_name in "${REQUIRED_REMOTE_ENVS[@]}"; do
  remote_script+=$'\n'
  remote_script+="if [[ -n \${$(printf '%q' "$env_name"):-} ]]; then printf 'ok   remote env %s=%s\\n' $(printf '%q' "$env_name") \"\${$(printf '%q' "$env_name")}\"; else printf 'fail remote missing env: %s\\n' $(printf '%q' "$env_name") >&2; exit 1; fi"
done

remote_script+=$'\n'
remote_script+="$REMOTE_COMMAND"

ssh_bash "$remote_script"
