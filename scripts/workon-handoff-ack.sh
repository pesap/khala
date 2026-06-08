#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-handoff-ack.sh --ledger PATH --status STATUS [--message TEXT]

Record child-session progress in a /workon handoff ledger. STATUS must be one of:
  pi-process-started
  capsule-acknowledged
  implementation-begun
USAGE
}

ledger=""
status=""
message=""

while (($#)); do
  case "$1" in
    --ledger)
      ledger="${2:?--ledger requires PATH}"
      shift 2
      ;;
    --status)
      status="${2:?--status requires STATUS}"
      shift 2
      ;;
    --message)
      message="${2:?--message requires TEXT}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${ledger}" || -z "${status}" ]]; then
  usage
  exit 2
fi

case "${status}" in
  pi-process-started|capsule-acknowledged|implementation-begun)
    ;;
  *)
    printf 'invalid status: %s\n' "${status}" >&2
    usage
    exit 2
    ;;
esac

if [[ ! -s "${ledger}" ]]; then
  printf 'handoff ledger is missing or empty: %s\n' "${ledger}" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'required command not found: jq\n' >&2
  exit 1
fi

updated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp "${ledger}.tmp.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT

jq \
  --arg updated_at "${updated_at}" \
  --arg status "${status}" \
  --arg message "${message}" '
    .updatedAt = $updated_at
    | .pi.status = $status
    | .phases.pi = $status
    | .attempts = ((.attempts // []) + [{
        at: $updated_at,
        phase: "child-session",
        status: $status,
        detail: (if $message == "" then null else $message end)
      }])
  ' "${ledger}" >"${tmp}"
mv "${tmp}" "${ledger}"
trap - EXIT

printf '{"status":"recorded","ledger":%s,"childStatus":%s,"updatedAt":%s}\n' \
  "$(jq -Rn --arg value "${ledger}" '$value')" \
  "$(jq -Rn --arg value "${status}" '$value')" \
  "$(jq -Rn --arg value "${updated_at}" '$value')"
