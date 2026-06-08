#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-zellij-handoff.sh --repo OWNER/REPO --branch BRANCH --capsule PATH --prompt TEXT [--heartbeat HOURS] [--model MODEL] [--ledger PATH]

Create/switch the Worktrunk worktree, wait for its Zellij tab, and launch Pi in
that tab with a clean prompt. The capsule path is passed as text in the prompt;
the capsule file is not expanded with @PATH, so the child session starts from a
small task instruction instead of a full metadata blob.
USAGE
}

repo=""
branch=""
capsule=""
prompt=""
heartbeat="1.0"
model=""
ledger=""
pi_command="${PI_COMMAND:-pi}"
wait_attempts="${ZELLIJ_TAB_WAIT_ATTEMPTS:-150}"
wait_seconds="${ZELLIJ_TAB_WAIT_SECONDS:-0.2}"

while (($#)); do
  case "$1" in
    --repo)
      repo="${2:?--repo requires OWNER/REPO}"
      shift 2
      ;;
    --branch)
      branch="${2:?--branch requires BRANCH}"
      shift 2
      ;;
    --capsule)
      capsule="${2:?--capsule requires PATH}"
      shift 2
      ;;
    --prompt)
      prompt="${2:?--prompt requires TEXT}"
      shift 2
      ;;
    --heartbeat|--heartbeat-hours)
      heartbeat="${2:?--heartbeat requires HOURS}"
      shift 2
      ;;
    --pi-command)
      pi_command="${2:?--pi-command requires COMMAND}"
      shift 2
      ;;
    --model)
      model="${2:?--model requires MODEL}"
      shift 2
      ;;
    --ledger)
      ledger="${2:?--ledger requires PATH}"
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

if [[ -z "${repo}" || -z "${branch}" || -z "${capsule}" || -z "${prompt}" ]]; then
  usage
  exit 2
fi

if [[ ! -s "${capsule}" ]]; then
  printf 'capsule is missing or empty: %s\n' "${capsule}" >&2
  exit 1
fi

require_command() {
  local command_name="${1:?command name required}"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "${command_name}" >&2
    exit 1
  fi
}

slugify() {
  local value="${1:?value required}"
  printf '%s' "${value}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

json_string() {
  jq -Rn --arg value "$1" '$value'
}

validate_heartbeat() {
  local value="${1:?heartbeat interval required}"
  [[ "${value}" =~ ^[0-9]+(\.[0-9]+)?$ ]]
}

validate_model() {
  local selected_model="${1:?model required}"
  local search_model="${selected_model##*/}"
  local output=""
  if ! output="$(${pi_command} --list-models "${search_model}" 2>&1)"; then
    printf 'failed to verify model with %s --list-models %s:\n%s\n' "${pi_command}" "${search_model}" "${output}" >&2
    exit 1
  fi
  if [[ "${output}" == No\ models\ matching* ]]; then
    printf 'model not found: %s\n' "${selected_model}" >&2
    printf '%s\n' "${output}" >&2
    exit 2
  fi
}

find_named_pane() {
  local pane_name="${1:?pane name required}"
  local panes_json=""

  panes_json="$(zellij action list-panes --json 2>/dev/null)" || return 0
  printf '%s' "${panes_json}" | jq -r --arg name "${pane_name}" '
    [
      .. | objects
      | select((.name? == $name) or (.title? == $name) or (.pane_name? == $name))
      | (.pane_id? // .id? // .terminal_id? // empty)
    ][0] // empty
  ' 2>/dev/null || true
}

record_ledger_status() {
  local status="${1:?status required}"
  local detail="${2:-}"
  local ack_script=""

  if [[ -z "${ledger}" || ! -s "${ledger}" ]]; then
    return 0
  fi
  ack_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workon-handoff-ack.sh"
  if [[ ! -x "${ack_script}" ]]; then
    return 0
  fi
  bash "${ack_script}" --ledger "${ledger}" --status "${status}" --message "${detail}" >/dev/null || true
}

require_command wt
require_command zellij
require_command jq
require_command "${pi_command}"
if ! validate_heartbeat "${heartbeat}"; then
  printf 'invalid heartbeat interval: %s (expected decimal hours, e.g. 0.25 or 2.0)\n' "${heartbeat}" >&2
  exit 2
fi
if [[ -n "${model}" ]]; then
  validate_model "${model}"
fi

repo_name="${repo##*/}"
tab_name="$(slugify "${repo_name}")/$(slugify "${branch}")"

switch_status=0
switch_output="$(wt switch --create "${branch}" --format json 2>&1)" || switch_status=$?
worktree_action="created"
if ((switch_status != 0)); then
  create_output="${switch_output}"
  if grep -qiE "branch .+ already exists|already exists" <<<"${create_output}"; then
    switch_status=0
    switch_output="$(wt switch "${branch}" --format json 2>&1)" || switch_status=$?
    worktree_action="reused"
  fi
  if ((switch_status != 0)); then
    printf 'Worktrunk failed to create or switch to branch %s. Output:\n%s\n' "${branch}" "${create_output}" >&2
    if [[ "${worktree_action}" == "reused" ]]; then
      printf 'Fallback wt switch output:\n%s\n' "${switch_output}" >&2
    fi
    exit "${switch_status}"
  fi
fi
worktree_path=""
# Worktrunk hooks can print human-readable status lines such as
# "◎ Running pre-start: ..." around the machine-readable JSON. Inspect only
# trimmed JSON-looking lines so hook chatter is ignored instead of parsed as a path.
while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [[ "${trimmed}" != \{*\} ]]; then
    continue
  fi
  candidate_path="$(jq -r '.path // empty' <<<"${trimmed}" 2>/dev/null || true)"
  if [[ -n "${candidate_path}" ]]; then
    worktree_path="${candidate_path}"
  fi
done <<<"${switch_output}"
if [[ -z "${worktree_path}" ]]; then
  printf 'Worktrunk did not report a worktree path. Output:\n%s\n' "${switch_output}" >&2
  exit 1
fi

tab_id=""
for ((attempt = 1; attempt <= wait_attempts; attempt += 1)); do
  tabs_json="$(zellij action list-tabs --json)"
  tab_id="$(printf '%s' "${tabs_json}" | jq -r --arg name "${tab_name}" '.[] | select(.name == $name) | .tab_id' | head -n 1)"
  if [[ -n "${tab_id}" && "${tab_id}" != "null" ]]; then
    break
  fi
  if ((attempt < wait_attempts)); then
    sleep "${wait_seconds}"
  fi
done

if [[ -z "${tab_id}" || "${tab_id}" == "null" ]]; then
  printf '{"status":"blocked","reason":"tab-not-found","path":%s,"tabName":%s}\n' \
    "$(json_string "${worktree_path}")" \
    "$(json_string "${tab_name}")" >&2
  printf 'Zellij Worktrunk tab not found after %s attempts: %s\n' "${wait_attempts}" "${tab_name}" >&2
  exit 1
fi

zellij action go-to-tab-name "${tab_name}"
clean_prompt="${prompt}

Session capsule path: ${capsule}
Read that file with the read tool before editing. Do not treat the capsule contents as the user prompt; use this handoff prompt as the task."

pi_pane_id="$(find_named_pane pi)"
pi_pane_action="reused"
if [[ -z "${pi_pane_id}" ]]; then
  pi_args=("${pi_command}" --name "${branch}")
  if [[ -n "${model}" ]]; then
    pi_args+=(--model "${model}")
  fi
  pi_args+=("${clean_prompt}")
  pi_pane_id="$(zellij action new-pane --tab-id "${tab_id}" --name pi --cwd "${worktree_path}" -- "${pi_args[@]}" | tail -n 1)"
  pi_pane_action="started"
fi
if [[ -n "${pi_pane_id}" ]]; then
  record_ledger_status "pi-process-started" "Pi pane ${pi_pane_action}: ${pi_pane_id}"
fi

heartbeat_pane_id=""
heartbeat_action="disabled"
heartbeat_command="(disabled)"
if [[ "${heartbeat}" != "0" && "${heartbeat}" != "0.0" ]]; then
  heartbeat_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workon-forge-heartbeat.sh"
  heartbeat_pane_id="$(find_named_pane forge-heartbeat)"
  if [[ -n "${heartbeat_pane_id}" ]]; then
    heartbeat_action="reused"
    heartbeat_command="reused existing forge-heartbeat pane ${heartbeat_pane_id}"
  else
    heartbeat_args=(bash "${heartbeat_script}" --repo "${repo}" --branch "${branch}" --interval "${heartbeat}" --author @me)
    if [[ -n "${pi_pane_id}" ]]; then
      heartbeat_args+=(--notify-pane "${pi_pane_id}")
    else
      printf 'Zellij did not report a Pi pane id; forge heartbeat will not actively notify Pi.\n' >&2
    fi
    heartbeat_pane_id="$(zellij action new-pane --tab-id "${tab_id}" --name forge-heartbeat --cwd "${worktree_path}" -- "${heartbeat_args[@]}" | tail -n 1)"
    heartbeat_action="started"
    heartbeat_command="zellij action new-pane --tab-id ${tab_id} --name forge-heartbeat --cwd ${worktree_path} -- bash ${heartbeat_script} --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me"
    if [[ -n "${pi_pane_id}" ]]; then
      heartbeat_command="${heartbeat_command} --notify-pane ${pi_pane_id}"
    fi
  fi
fi

printf '{"status":"launched","path":%s,"tabName":%s,"tabId":%s,"piPaneId":%s,"piPaneAction":%s,"heartbeatPaneId":%s,"heartbeatAction":%s,"heartbeatInterval":%s,"worktreeAction":%s,"piHandoffCommand":%s,"heartbeatCommand":%s}\n' \
  "$(json_string "${worktree_path}")" \
  "$(json_string "${tab_name}")" \
  "${tab_id}" \
  "$(json_string "${pi_pane_id}")" \
  "$(json_string "${pi_pane_action}")" \
  "$(json_string "${heartbeat_pane_id}")" \
  "$(json_string "${heartbeat_action}")" \
  "$(json_string "${heartbeat}")" \
  "$(json_string "${worktree_action}")" \
  "$(json_string "zellij action new-pane --tab-id ${tab_id} --name pi --cwd ${worktree_path} -- ${pi_command} --name ${branch} <clean-prompt>")" \
  "$(json_string "${heartbeat_command}")"
