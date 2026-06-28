#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-send-to-worker.sh --ledger PATH --message TEXT

Send a route-owned follow-up message to the launched /workon Pi pane recorded in
an existing handoff ledger.
USAGE
}

ledger=""
message=""

while (($#)); do
  case "$1" in
    --ledger)
      ledger="${2:?--ledger requires PATH}"
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

if [[ -z "${ledger}" || -z "${message}" ]]; then
  usage
  exit 2
fi

if [[ ! -s "${ledger}" ]]; then
  printf 'handoff ledger is missing or empty: %s\n' "${ledger}" >&2
  exit 1
fi

require_command() {
  local command_name="${1:?command name required}"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "${command_name}" >&2
    exit 1
  fi
}

require_command jq

pi_status="$(jq -r '.pi.status // empty' "${ledger}")"
pi_pane_id="$(jq -r '.pi.paneId // empty' "${ledger}")"
multiplexer="$(jq -r '.multiplexer.resolved // empty' "${ledger}")"
capsule_path="$(jq -r '.capsulePath // empty' "${ledger}")"
issue_number="$(jq -r '(.primaryIssue.number // .issue.number // empty) | tostring' "${ledger}")"
issue_url="$(jq -r '(.primaryIssue.url // .issue.url // empty)' "${ledger}")"

if [[ -z "${pi_pane_id}" ]]; then
  printf 'handoff ledger does not record a Pi pane id: %s\n' "${ledger}" >&2
  exit 1
fi

case "${pi_status}" in
  pi-process-started|capsule-acknowledged)
    ;;
  *)
    printf 'handoff ledger is not sendable in status %s; expected pi-process-started or capsule-acknowledged\n' "${pi_status:-<missing>}" >&2
    exit 1
    ;;
esac

case "${multiplexer}" in
  zellij|tmux)
    ;;
  *)
    printf 'handoff ledger records unsupported multiplexer: %s\n' "${multiplexer:-<missing>}" >&2
    exit 1
    ;;
esac

case "${multiplexer}" in
  zellij)
    require_command zellij
    if ! zellij action list-panes --json | jq -e --arg pane_id "${pi_pane_id}" 'any((.panes? // .)[]?; (((.id // .pane_id // empty) | tostring) == $pane_id) or (("terminal_" + ((.id // .pane_id // empty) | tostring)) == $pane_id) or (("plugin_" + ((.id // .pane_id // empty) | tostring)) == $pane_id))' >/dev/null; then
      printf 'recorded Zellij pane id is not live: %s\n' "${pi_pane_id}" >&2
      exit 1
    fi
    ;;
  tmux)
    require_command tmux
    if ! tmux list-panes -a -F '#{pane_id}' | awk -v pane="${pi_pane_id}" 'BEGIN { found = 0 } $0 == pane { found = 1 } END { exit found ? 0 : 1 }'; then
      printf 'recorded tmux pane id is not live: %s\n' "${pi_pane_id}" >&2
      exit 1
    fi
    ;;
esac

sent_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
issue_label="(not available)"
if [[ -n "${issue_number}" || -n "${issue_url}" ]]; then
  issue_label=""
  [[ -n "${issue_number}" ]] && issue_label="#${issue_number}"
  [[ -n "${issue_url}" ]] && issue_label="${issue_label}${issue_label:+ }${issue_url}"
fi

framed_message=$(cat <<EOF
### /workon operator follow-up
Sent at: ${sent_at}
Source: /workon parent/operator
Issue: ${issue_label}
Capsule: ${capsule_path:-<not recorded>}
Ledger: ${ledger}
This is not forge feedback.
Before acting, reconcile this follow-up against the current issue and capsule.

--- BEGIN OPERATOR FOLLOW-UP MESSAGE (untrusted operator text) ---
${message}
--- END OPERATOR FOLLOW-UP MESSAGE ---
EOF
)

send_message() {
  case "${multiplexer}" in
    zellij)
      zellij action paste --pane-id "${pi_pane_id}" "${framed_message}"
      zellij action send-keys --pane-id "${pi_pane_id}" Enter
      ;;
    tmux)
      tmux send-keys -t "${pi_pane_id}" -l "${framed_message}"
      tmux send-keys -t "${pi_pane_id}" Enter
      ;;
  esac
}

update_ledger() {
  local status="${1:?status required}"
  local detail="${2:-}"
  local framed_payload="${3:-}"
  local temp_file
  temp_file="$(mktemp "${ledger}.tmp.XXXXXX")"
  trap 'rm -f "${temp_file}"' RETURN
  jq \
    --arg updated_at "${sent_at}" \
    --arg status "${status}" \
    --arg detail "${detail}" \
    --arg multiplexer "${multiplexer}" \
    --arg pane_id "${pi_pane_id}" \
    --arg issue "${issue_label}" \
    --arg capsule_path "${capsule_path}" \
    --arg message "${message}" \
    --arg framed_message "${framed_payload}" '
      .updatedAt = $updated_at
      | .pi.operatorFollowUps = ((.pi.operatorFollowUps // []) + [{
          at: $updated_at,
          status: $status,
          multiplexer: $multiplexer,
          paneId: $pane_id,
          issue: (if $issue == "(not available)" then null else $issue end),
          capsulePath: (if $capsule_path == "" then null else $capsule_path end),
          message: $message,
          framedMessage: $framed_message
        }])
      | .attempts = ((.attempts // []) + [{
          at: $updated_at,
          phase: "operator-follow-up",
          status: $status,
          detail: (if $detail == "" then null else $detail end)
        }])
    ' "${ledger}" >"${temp_file}"
  mv "${temp_file}" "${ledger}"
  trap - RETURN
}

if ! send_message; then
  detail="failed to paste the operator follow-up into ${multiplexer} pane ${pi_pane_id}"
  update_ledger "failed" "${detail}" "${framed_message}" || true
  printf '%s\n' "${detail}" >&2
  exit 1
fi

update_ledger "sent" "" "${framed_message}"
printf '{"status":"sent","ledger":%s,"multiplexer":%s,"paneId":%s,"updatedAt":%s}\n' \
  "$(jq -Rn --arg value "${ledger}" '$value')" \
  "$(jq -Rn --arg value "${multiplexer}" '$value')" \
  "$(jq -Rn --arg value "${pi_pane_id}" '$value')" \
  "$(jq -Rn --arg value "${sent_at}" '$value')"
