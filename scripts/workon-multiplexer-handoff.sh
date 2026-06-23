#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-multiplexer-handoff.sh --multiplexer zellij|tmux --repo OWNER/REPO --branch BRANCH --capsule PATH --prompt TEXT [--heartbeat HOURS] [--model MODEL] [--thinking LEVEL] [--ledger PATH] [--pi-command COMMAND]
USAGE
}

multiplexer=""
args=()

json_string() {
  local value="${1:-}"
  if command -v jq >/dev/null 2>&1; then
    jq -Rn --arg value "${value}" '$value'
    return 0
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "${value}"
}

emit_unsupported() {
  local value="${1:-}"
  printf '{"status":"blocked","reason":"unsupported-multiplexer","detail":%s,"multiplexer":%s}\n' \
    "$(json_string "unsupported multiplexer: ${value}")" \
    "$(json_string "${value}")" >&2
}

while (($#)); do
  case "$1" in
    --multiplexer)
      multiplexer="${2:?--multiplexer requires zellij or tmux}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

if [[ -z "${multiplexer}" ]]; then
  usage
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${multiplexer}" in
  zellij)
    exec bash "${script_dir}/workon-zellij-handoff.sh" "${args[@]}"
    ;;
  tmux)
    exec bash "${script_dir}/workon-tmux-handoff.sh" "${args[@]}"
    ;;
  *)
    emit_unsupported "${multiplexer}"
    exit 2
    ;;
esac
