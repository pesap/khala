#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-tmux-handoff.sh --repo [HOST/]OWNER/REPO --branch BRANCH --capsule PATH --prompt TEXT [--heartbeat HOURS] [--model MODEL] [--thinking LEVEL] [--ledger PATH] [--pi-command COMMAND]
USAGE
}

repo=""
branch=""
capsule=""
prompt=""
heartbeat="0.0834"
model=""
thinking=""
ledger=""
pi_command="${PI_COMMAND:-pi}"

while (($#)); do
  case "$1" in
    --repo) repo="${2:?--repo requires OWNER/REPO}"; shift 2 ;;
    --branch) branch="${2:?--branch requires BRANCH}"; shift 2 ;;
    --capsule) capsule="${2:?--capsule requires PATH}"; shift 2 ;;
    --prompt) prompt="${2:?--prompt requires TEXT}"; shift 2 ;;
    --heartbeat|--heartbeat-hours) heartbeat="${2:?--heartbeat requires HOURS}"; shift 2 ;;
    --model) model="${2:?--model requires MODEL}"; shift 2 ;;
    --thinking) thinking="${2:?--thinking requires LEVEL}"; shift 2 ;;
    --ledger) ledger="${2:?--ledger requires PATH}"; shift 2 ;;
    --pi-command) pi_command="${2:?--pi-command requires COMMAND}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${repo}" || -z "${branch}" || -z "${capsule}" || -z "${prompt}" ]]; then
  usage
  exit 2
fi

slugify() {
  local value="${1:?value required}"
  printf '%s' "${value}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
}

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

json_string_or_null() {
  if [[ -z "$1" ]]; then
    printf 'null'
  else
    json_string "$1"
  fi
}

shell_word() {
  printf '%q' "$1"
}

worktree_path=""
session_name=""
session_id=""
pi_pane_id=""
heartbeat_pane_id=""
worktree_action="not-attempted"
pi_handoff_command=""
heartbeat_command=""

emit_blocked_json() {
  local reason="${1:?blocked reason required}"
  local detail="${2:-}"
  printf '{"status":"blocked","multiplexer":"tmux","reason":%s,"detail":%s,"path":%s,"scopeName":%s,"scopeId":%s,"sessionName":%s,"sessionId":%s,"tabName":%s,"tabId":%s,"piPaneId":%s,"heartbeatPaneId":%s,"worktreeAction":%s,"piHandoffCommand":%s,"heartbeatCommand":%s}\n' \
    "$(json_string "${reason}")" \
    "$(json_string "${detail}")" \
    "$(json_string_or_null "${worktree_path}")" \
    "$(json_string_or_null "${session_name}")" \
    "$(json_string_or_null "${session_id}")" \
    "$(json_string_or_null "${session_name}")" \
    "$(json_string_or_null "${session_id}")" \
    "$(json_string_or_null "${session_name}")" \
    "$(json_string_or_null "${session_id}")" \
    "$(json_string_or_null "${pi_pane_id}")" \
    "$(json_string_or_null "${heartbeat_pane_id}")" \
    "$(json_string "${worktree_action}")" \
    "$(json_string_or_null "${pi_handoff_command}")" \
    "$(json_string_or_null "${heartbeat_command}")"
}

fail_blocked() {
  local reason="${1:?blocked reason required}"
  local detail="${2:-}"
  local status="${3:-1}"
  emit_blocked_json "${reason}" "${detail}" >&2
  [[ -z "${detail}" ]] || printf '%s\n' "${detail}" >&2
  exit "${status}"
}

require_command() {
  local command_name="${1:?command name required}"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail_blocked "missing-command" "required command not found: ${command_name}" 1
  fi
}

validate_heartbeat() {
  [[ "${1:?heartbeat interval required}" =~ ^[0-9]+(\.[0-9]+)?$ ]]
}

validate_thinking() {
  [[ "${1:?thinking level required}" =~ ^(off|minimal|low|medium|high|xhigh)$ ]]
}

validate_model() {
  local selected_model="${1:?model required}"
  if [[ "${selected_model}" =~ [[:cntrl:]] ]]; then
    fail_blocked "invalid-model" "invalid model value contains control characters: ${selected_model}" 2
  fi
}

model_provider() {
  [[ "${1:?model required}" == */* ]] && printf '%s' "${1%%/*}"
}

model_name() {
  if [[ "${1:?model required}" == */* ]]; then
    printf '%s' "${1#*/}"
  else
    printf '%s' "$1"
  fi
}

model_list_has_exact_match() {
  local selected_model="${1:?model required}"
  local models_output="${2:-}"
  local provider=""
  local name=""
  provider="$(model_provider "${selected_model}")"
  name="$(model_name "${selected_model}")"
  awk -v provider="${provider}" -v name="${name}" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    {
      line = trim($0)
      if (line == "") next
      column_count = split(line, columns, /[[:space:]][[:space:]]+/)
      if (column_count >= 2) {
        row_provider = trim(columns[1])
        row_model = trim(columns[2])
      } else {
        row_provider = $1
        row_model = $2
      }
      if (row_provider == "provider" && row_model == "model") next
      if (provider != "" && row_provider == provider && row_model == name) { found = 1 }
      if (provider == "" && (row_model == name || row_provider == name)) { found = 1 }
    }
    END { exit found ? 0 : 1 }
  ' <<<"${models_output}"
}

resolve_pi_agent_dir() {
  local value="${PI_CODING_AGENT_DIR:-}"
  if [[ -z "${value}" ]]; then
    value="${HOME:-.}/.pi/agent"
  elif [[ "${value}" == "~" ]]; then
    value="${HOME:?HOME is required to expand PI_CODING_AGENT_DIR=~}"
  elif [[ "${value:0:1}" == "~" && "${value:1:1}" == "/" ]]; then
    value="${HOME:?HOME is required to expand PI_CODING_AGENT_DIR=~/...}/${value:2}"
  elif [[ "${value}" != /* ]]; then
    value="$(pwd -P)/${value}"
  fi
  printf '%s' "${value}"
}

preflight_selected_model() {
  local selected_model="${1:?model required}"
  local selected_thinking="${2:-}"
  local name=""
  local models_output=""
  local model_status=0
  local auth_output=""
  local auth_status=0
  local auth_args=()

  name="$(model_name "${selected_model}")"
  models_output="$(PI_CODING_AGENT_DIR="${pi_agent_dir}" "${pi_command}" --list-models "${name}" 2>&1)" || model_status=$?
  if ((model_status != 0)); then
    fail_blocked "pi-model-lookup-failed" "model lookup failed for ${selected_model}. Output:
${models_output}" "${model_status}"
  fi
  if ! model_list_has_exact_match "${selected_model}" "${models_output}"; then
    fail_blocked "pi-model-not-found" "model not found: ${selected_model}" 1
  fi
  if [[ -s "${pi_agent_dir}/auth.json" ]]; then
    auth_args=(--no-session --no-tools --model "${selected_model}")
    [[ -z "${selected_thinking}" ]] || auth_args+=(--thinking "${selected_thinking}")
    auth_args+=(-p "Return exactly: ok")
    auth_output="$(PI_CODING_AGENT_DIR="${pi_agent_dir}" "${pi_command}" "${auth_args[@]}" 2>&1)" || auth_status=$?
    if ((auth_status != 0)); then
      fail_blocked "pi-auth-preflight-failed" "Pi model auth preflight failed for ${selected_model}. Output:
${auth_output}" "${auth_status}"
    fi
  fi
}

handoff_state_dir() {
  if [[ -n "${ledger}" ]]; then
    dirname "${ledger}"
  else
    dirname "${capsule}"
  fi
}

write_pi_bootstrap() {
  local state_dir="${1:?state dir required}"
  local prompt_content="${2:?prompt content required}"
  local slug=""
  local prompt_path=""
  local script_path=""

  slug="$(slugify "${branch}")"
  mkdir -p "${state_dir}/handoff"
  chmod 700 "${state_dir}" "${state_dir}/handoff" 2>/dev/null || true
  prompt_path="${state_dir}/handoff/${slug}-prompt.txt"
  script_path="${state_dir}/handoff/${slug}-pi.sh"
  umask 077
  printf '%s\n' "${prompt_content}" >"${prompt_path}"
  chmod 600 "${prompt_path}" 2>/dev/null || true
  cat >"${script_path}" <<SCRIPT
#!/usr/bin/env bash
set -uo pipefail

export PI_CODING_AGENT_DIR=$(shell_word "${pi_agent_dir}")
pi_command=$(shell_word "${pi_command}")
branch=$(shell_word "${branch}")
model=$(shell_word "${model}")
thinking=$(shell_word "${thinking}")
prompt_path=$(shell_word "${prompt_path}")

if ! prompt="\$(cat "\${prompt_path}")"; then
  printf 'Failed to read handoff prompt: %s\n' "\${prompt_path}" >&2
  exec "\${SHELL:-/bin/sh}" -l
fi

args=(-a --name "\${branch}")
[[ -z "\${model}" ]] || args+=(--model "\${model}")
[[ -z "\${thinking}" ]] || args+=(--thinking "\${thinking}")
"\${pi_command}" "\${args[@]}" "\${prompt}"
status=\$?
printf '\nPi exited with status %s. Prompt file: %s\n' "\${status}" "\${prompt_path}" >&2
exec "\${SHELL:-/bin/sh}" -l
SCRIPT
  chmod 700 "${script_path}"
  printf '%s' "${script_path}"
}

record_ledger_status() {
  local status="${1:?status required}"
  local detail="${2:-}"
  local ack_script=""
  [[ -n "${ledger}" && -s "${ledger}" ]] || return 0
  ack_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workon-handoff-ack.sh"
  [[ -x "${ack_script}" ]] || return 0
  bash "${ack_script}" --ledger "${ledger}" --status "${status}" --message "${detail}" >/dev/null || true
}

require_command jq
require_command wt
require_command tmux
if [[ ! -s "${capsule}" ]]; then
  fail_blocked "capsule-missing" "capsule is missing or empty: ${capsule}" 1
fi
pi_agent_dir="$(resolve_pi_agent_dir)"
if ! validate_heartbeat "${heartbeat}"; then
  fail_blocked "invalid-heartbeat" "invalid heartbeat interval: ${heartbeat} (expected decimal hours, e.g. 0.25 or 2.0)" 2
fi
if [[ -n "${thinking}" ]] && ! validate_thinking "${thinking}"; then
  fail_blocked "invalid-thinking" "invalid thinking level: ${thinking} (expected one of: off, minimal, low, medium, high, xhigh)" 2
fi
if [[ -n "${model}" ]]; then
  validate_model "${model}"
  require_command "${pi_command}"
  preflight_selected_model "${model}" "${thinking}"
fi

repo_name="${repo##*/}"
session_name="khala-$(slugify "${repo_name}")-$(slugify "${branch}")"

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
    fail_blocked "worktrunk-switch-failed" "Worktrunk failed to create or switch to branch ${branch}. Output:
${create_output}
Fallback wt switch output:
${switch_output}" "${switch_status}"
  fi
fi

while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [[ "${trimmed}" == \{*\} ]] || continue
  candidate_path="$(jq -r '.path // empty' <<<"${trimmed}" 2>/dev/null || true)"
  [[ -z "${candidate_path}" ]] || worktree_path="${candidate_path}"
done <<<"${switch_output}"
if [[ -z "${worktree_path}" ]]; then
  fail_blocked "worktree-path-missing" "Worktrunk did not report a worktree path. Output:
${switch_output}" 1
fi

if tmux has-session -t "${session_name}" 2>/dev/null; then
  session_id="$(tmux display-message -p -t "${session_name}" '#{session_id}' 2>/dev/null || true)"
else
  session_id="$(tmux new-session -d -s "${session_name}" -c "${worktree_path}" -n khala -P -F '#{session_id}' 2>&1)" || {
    fail_blocked "tmux-session-create-failed" "${session_id}" 1
  }
fi

ack_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workon-handoff-ack.sh"
ack_command="bash $(shell_word "${ack_script}") --ledger $(shell_word "${ledger}") --status capsule-acknowledged"
clean_prompt="${prompt}

First-turn required actions:
1. Read the session capsule path with the read tool: ${capsule}
2. Run the acknowledgement command with the bash tool exactly after reading the capsule: ${ack_command}
3. Confirm this session is in the Worktrunk worktree recorded in the capsule; only edit files inside that worktree.
4. If no readiness blocker is found, create/reuse the draft PR immediately with an empty bootstrap commit, then start the smallest scoped implementation slice without waiting for another operator instruction.
5. Final answer must include: capsule-acknowledged; readiness status; draft PR status or exact blocker; first implementation action or escalation.

Session capsule path: ${capsule}
Read that file with the read tool before editing. Do not treat the capsule contents as the user prompt; use this handoff prompt as the task."
pi_bootstrap_script="$(write_pi_bootstrap "$(handoff_state_dir)" "${clean_prompt}")"

pi_launch_summary="env PI_CODING_AGENT_DIR=$(shell_word "${pi_agent_dir}") ${pi_command} -a --name ${branch}"
[[ -z "${model}" ]] || pi_launch_summary="${pi_launch_summary} --model $(shell_word "${model}")"
[[ -z "${thinking}" ]] || pi_launch_summary="${pi_launch_summary} --thinking $(shell_word "${thinking}")"
pi_launch_summary="${pi_launch_summary} <clean-prompt>"
pi_handoff_command="tmux new-window -t ${session_name}: -n pi -c ${worktree_path} bash $(shell_word "${pi_bootstrap_script}") (launches: ${pi_launch_summary})"

if tmux list-windows -t "${session_name}" -F '#{window_name}' | grep -Fxq pi; then
  pi_pane_id="$(tmux display-message -p -t "${session_name}:pi" '#{pane_id}' 2>/dev/null || true)"
  pi_pane_action="reused"
else
  pi_pane_id="$(tmux new-window -d -t "${session_name}:" -n pi -c "${worktree_path}" -P -F '#{pane_id}' bash "${pi_bootstrap_script}" 2>&1)" || {
    fail_blocked "pi-pane-launch-failed" "${pi_pane_id}" 1
  }
  pi_pane_action="started"
fi
if [[ -n "${pi_pane_id}" ]]; then
  record_ledger_status "pi-process-started" "Pi tmux window ${pi_pane_action}: ${pi_pane_id}"
fi

heartbeat_action="disabled"
heartbeat_command="(disabled)"
if [[ "${heartbeat}" != "0" && "${heartbeat}" != "0.0" ]]; then
  heartbeat_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workon-forge-heartbeat.sh"
  if tmux list-windows -t "${session_name}" -F '#{window_name}' | grep -Fxq forge-heartbeat; then
    heartbeat_pane_id="$(tmux display-message -p -t "${session_name}:forge-heartbeat" '#{pane_id}' 2>/dev/null || true)"
    heartbeat_action="reused"
    heartbeat_command="reused existing forge-heartbeat tmux window ${heartbeat_pane_id}"
  else
    heartbeat_command="tmux new-window -t ${session_name}: -n forge-heartbeat -c ${worktree_path} bash ${heartbeat_script} --multiplexer tmux --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me --trusted-author @me --trusted-author copilot-pull-request-reviewer[bot]"
    [[ -z "${pi_pane_id}" ]] || heartbeat_command="${heartbeat_command} --notify-pane ${pi_pane_id}"
    heartbeat_args=(bash "${heartbeat_script}" --multiplexer tmux --repo "${repo}" --branch "${branch}" --interval "${heartbeat}" --author @me --trusted-author @me --trusted-author copilot-pull-request-reviewer[bot])
    [[ -z "${pi_pane_id}" ]] || heartbeat_args+=(--notify-pane "${pi_pane_id}")
    heartbeat_pane_id="$(tmux new-window -d -t "${session_name}:" -n forge-heartbeat -c "${worktree_path}" -P -F '#{pane_id}' "${heartbeat_args[@]}" 2>&1)" || {
      heartbeat_action="failed"
      heartbeat_command=""
      printf 'Warning: failed to launch forge heartbeat tmux window; Pi handoff remains launched. Output:\n%s\n' "${heartbeat_pane_id}" >&2
      heartbeat_pane_id=""
    }
    [[ -z "${heartbeat_pane_id}" ]] || heartbeat_action="started"
  fi
fi

printf '{"status":"launched","multiplexer":"tmux","path":%s,"scopeName":%s,"scopeId":%s,"sessionName":%s,"sessionId":%s,"tabName":%s,"tabId":%s,"piPaneId":%s,"piPaneAction":%s,"heartbeatPaneId":%s,"heartbeatAction":%s,"heartbeatInterval":%s,"worktreeAction":%s,"piHandoffCommand":%s,"heartbeatCommand":%s}\n' \
  "$(json_string "${worktree_path}")" \
  "$(json_string "${session_name}")" \
  "$(json_string_or_null "${session_id}")" \
  "$(json_string "${session_name}")" \
  "$(json_string_or_null "${session_id}")" \
  "$(json_string "${session_name}")" \
  "$(json_string_or_null "${session_id}")" \
  "$(json_string_or_null "${pi_pane_id}")" \
  "$(json_string "${pi_pane_action}")" \
  "$(json_string_or_null "${heartbeat_pane_id}")" \
  "$(json_string "${heartbeat_action}")" \
  "$(json_string "${heartbeat}")" \
  "$(json_string "${worktree_action}")" \
  "$(json_string "${pi_handoff_command}")" \
  "$(json_string_or_null "${heartbeat_command}")"
