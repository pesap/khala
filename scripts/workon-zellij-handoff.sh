#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-zellij-handoff.sh --repo OWNER/REPO --branch BRANCH --capsule PATH --prompt TEXT [--heartbeat HOURS] [--model MODEL] [--thinking LEVEL] [--ledger PATH]

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
thinking=""
ledger=""
pi_command="${PI_COMMAND:-pi}"
wait_attempts="${ZELLIJ_TAB_WAIT_ATTEMPTS:-150}"
wait_seconds="${ZELLIJ_TAB_WAIT_SECONDS:-0.2}"
pane_attempts="${ZELLIJ_PANE_LAUNCH_ATTEMPTS:-3}"
pane_wait_seconds="${ZELLIJ_PANE_LAUNCH_WAIT_SECONDS:-0.5}"

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
    --thinking)
      thinking="${2:?--thinking requires LEVEL}"
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

slugify() {
  local value="${1:?value required}"
  printf '%s' "${value}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'
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

worktree_path=""
tab_name=""
tab_id=""
pi_pane_id=""
heartbeat_pane_id=""
worktree_action="not-attempted"
pi_handoff_command=""
heartbeat_command=""

emit_blocked_json() {
  local reason="${1:?blocked reason required}"
  local detail="${2:-}"
  printf '{"status":"blocked","multiplexer":"zellij","reason":%s,"detail":%s,"path":%s,"scopeName":%s,"scopeId":%s,"tabName":%s,"tabId":%s,"piPaneId":%s,"heartbeatPaneId":%s,"worktreeAction":%s,"piHandoffCommand":%s,"heartbeatCommand":%s}\n' \
    "$(json_string "${reason}")" \
    "$(json_string "${detail}")" \
    "$(json_string_or_null "${worktree_path}")" \
    "$(json_string_or_null "${tab_name}")" \
    "$(json_string_or_null "${tab_id}")" \
    "$(json_string_or_null "${tab_name}")" \
    "$(json_string_or_null "${tab_id}")" \
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
  if [[ -n "${detail}" ]]; then
    printf '%s\n' "${detail}" >&2
  fi
  exit "${status}"
}

require_command() {
  local command_name="${1:?command name required}"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail_blocked "missing-command" "required command not found: ${command_name}" 1
  fi
}

shell_word() {
  printf '%q' "$1"
}

last_nonempty_line() {
  awk 'NF { line = $0 } END { if (line != "") print line }'
}

resolve_pi_agent_dir() {
  local value="${PI_CODING_AGENT_DIR:-}"
  if [[ -z "${value}" ]]; then
    if [[ -z "${HOME:-}" ]]; then
      printf 'HOME is not set and PI_CODING_AGENT_DIR was not provided; cannot resolve Pi auth config\n' >&2
      exit 1
    fi
    value="${HOME}/.pi/agent"
  elif [[ "${value}" == "~" ]]; then
    if [[ -z "${HOME:-}" ]]; then
      printf 'HOME is required to expand PI_CODING_AGENT_DIR=~\n' >&2
      exit 1
    fi
    value="${HOME}"
  elif [[ "${value:0:1}" == "~" && "${value:1:1}" == "/" ]]; then
    if [[ -z "${HOME:-}" ]]; then
      printf 'HOME is required to expand PI_CODING_AGENT_DIR=~/...\n' >&2
      exit 1
    fi
    value="${HOME}/${value:2}"
  elif [[ "${value}" != /* ]]; then
    value="$(pwd -P)/${value}"
  fi
  printf '%s' "${value}"
}

validate_heartbeat() {
  local value="${1:?heartbeat interval required}"
  [[ "${value}" =~ ^[0-9]+(\.[0-9]+)?$ ]]
}

validate_thinking() {
  local value="${1:?thinking level required}"
  [[ "${value}" =~ ^(off|minimal|low|medium|high|xhigh)$ ]]
}

validate_model() {
  local selected_model="${1:?model required}"
  if [[ "${selected_model}" =~ [[:space:]] ]]; then
    fail_blocked "invalid-model" "invalid model value contains whitespace: ${selected_model}" 2
  fi
}

model_provider() {
  local selected_model="${1:?model required}"
  if [[ "${selected_model}" == */* ]]; then
    printf '%s' "${selected_model%%/*}"
  fi
}

model_name() {
  local selected_model="${1:?model required}"
  if [[ "${selected_model}" == */* ]]; then
    printf '%s' "${selected_model#*/}"
  else
    printf '%s' "${selected_model}"
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
    NF < 2 { next }
    $1 == "provider" && $2 == "model" { next }
    provider != "" && $1 == provider && $2 == name { found = 1 }
    provider == "" && ($2 == name || $1 == name) { found = 1 }
    END { exit found ? 0 : 1 }
  ' <<<"${models_output}"
}

pi_preflight_lock_failure() {
  local output="${1:-}"
  grep -qiE 'EPERM|operation not permitted|trust\.json\.lock|lock' <<<"${output}"
}

auth_fingerprint() {
  local auth_path="${pi_agent_dir}/auth.json"

  if [[ ! -s "${auth_path}" ]]; then
    printf 'missing'
    return 0
  fi
  cksum "${auth_path}" 2>/dev/null | awk '{ print $1 ":" $2 }'
}

file_mtime() {
  local file_path="${1:?file path required}"
  local modified=""

  modified="$(stat -f '%m' "${file_path}" 2>/dev/null || true)"
  if [[ "${modified}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${modified}"
    return 0
  fi
  modified="$(stat -c '%Y' "${file_path}" 2>/dev/null || true)"
  if [[ "${modified}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${modified}"
    return 0
  fi
  printf '0'
}

preflight_cache_ttl_seconds() {
  local ttl="${WORKON_PI_PREFLIGHT_CACHE_SECONDS:-21600}"

  if [[ "${ttl}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${ttl}"
  else
    printf '0'
  fi
}

preflight_cache_path() {
  local selected_model="${1:?model required}"
  local selected_thinking="${2:-}"
  local cache_dir=""
  local cache_slug=""

  cache_dir="$(handoff_state_dir)/handoff/preflight-cache"
  cache_slug="$(slugify "${selected_model}-${selected_thinking:-default}")"
  mkdir -p "${cache_dir}" 2>/dev/null || true
  printf '%s/%s.txt' "${cache_dir}" "${cache_slug}"
}

preflight_cache_key() {
  local selected_model="${1:?model required}"
  local selected_thinking="${2:-}"
  local pi_command_path=""

  pi_command_path="$(command -v "${pi_command}" 2>/dev/null || printf '%s' "${pi_command}")"
  printf 'v1|agent=%s|command=%s|model=%s|thinking=%s|auth=%s' \
    "${pi_agent_dir}" \
    "${pi_command_path}" \
    "${selected_model}" \
    "${selected_thinking}" \
    "$(auth_fingerprint)"
}

preflight_cache_hit() {
  local cache_path="${1:?cache path required}"
  local expected_key="${2:?cache key required}"
  local ttl=""
  local now=""
  local modified=""
  local cached_key=""

  ttl="$(preflight_cache_ttl_seconds)"
  if [[ "${ttl}" == "0" || ! -s "${cache_path}" ]]; then
    return 1
  fi
  now="$(date +%s)"
  modified="$(file_mtime "${cache_path}")"
  if ((now - modified > ttl)); then
    return 1
  fi
  IFS= read -r cached_key <"${cache_path}" || return 1
  [[ "${cached_key}" == "${expected_key}" ]]
}

store_preflight_cache() {
  local cache_path="${1:?cache path required}"
  local cache_key="${2:?cache key required}"
  local temp_path="${cache_path}.$$"

  {
    printf '%s\n' "${cache_key}" >"${temp_path}" && mv "${temp_path}" "${cache_path}"
  } 2>/dev/null || true
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
  local cache_path=""
  local cache_key=""

  if [[ -n "${PI_CODING_AGENT_DIR:-}" && ! -s "${pi_agent_dir}/auth.json" ]]; then
    return 0
  fi

  name="$(model_name "${selected_model}")"
  cache_path="$(preflight_cache_path "${selected_model}" "${selected_thinking}")"
  cache_key="$(preflight_cache_key "${selected_model}" "${selected_thinking}")"
  if preflight_cache_hit "${cache_path}" "${cache_key}"; then
    return 0
  fi

  models_output="$(PI_CODING_AGENT_DIR="${pi_agent_dir}" "${pi_command}" --list-models "${name}" 2>&1)" || model_status=$?
  if ((model_status != 0)); then
    if pi_preflight_lock_failure "${models_output}"; then
      return 0
    fi
    fail_blocked "pi-model-lookup-failed" "model lookup failed for ${selected_model}. Output:
${models_output}" "${model_status}"
  fi

  if ! model_list_has_exact_match "${selected_model}" "${models_output}"; then
    fail_blocked "pi-model-not-found" "model not found: ${selected_model}" 1
  fi

  if [[ ! -s "${pi_agent_dir}/auth.json" ]]; then
    store_preflight_cache "${cache_path}" "${cache_key}"
    return 0
  fi

  auth_args=(--no-session --no-tools --model "${selected_model}")
  if [[ -n "${selected_thinking}" ]]; then
    auth_args+=(--thinking "${selected_thinking}")
  fi
  auth_args+=(-p "Return exactly: ok")

  auth_output="$(PI_CODING_AGENT_DIR="${pi_agent_dir}" "${pi_command}" "${auth_args[@]}" 2>&1)" || auth_status=$?
  if ((auth_status != 0)); then
    fail_blocked "pi-auth-preflight-failed" "Pi model auth preflight failed for ${selected_model}. Output:
${auth_output}" "${auth_status}"
  fi
  store_preflight_cache "${cache_path}" "${cache_key}"
}

find_named_pane() {
  local pane_name="${1:?pane name required}"
  local target_tab_id="${2:?target tab id required}"
  local panes_json=""

  panes_json="$(zellij action list-panes --json 2>/dev/null)" || return 0
  printf '%s' "${panes_json}" | jq -r --arg name "${pane_name}" --arg tab_id "${target_tab_id}" '
    def has_target_tab_id:
      ((.tab_id? // .tabId? // .tab? // empty) | tostring) == $tab_id;
    def has_pane_name:
      (.name? == $name) or (.title? == $name) or (.pane_name? == $name);
    def pane_identifier:
      .pane_id? // .id? // .terminal_id? // empty;
    [
      .. | objects
      | select(has_target_tab_id)
      | .. | objects
      | select(has_pane_name)
      | pane_identifier
    ][0] // empty
  ' 2>/dev/null || true
}

find_tab_id() {
  local tabs_json="${1:?tabs json required}"
  local target_name="${2:?target tab name required}"

  printf '%s' "${tabs_json}" | jq -r --arg name "${target_name}" '
    [
      .. | objects
      | select((.name? // .title? // .tab_name? // .tabName? // "") == $name)
      | (.tab_id? // .tabId? // .id? // empty)
    ][0] // empty
  ' 2>/dev/null || true
}

zellij_new_pane_output=""
zellij_new_pane_error=""
run_zellij_new_pane() {
  local attempt=1
  local status=0
  local output=""

  zellij_new_pane_output=""
  zellij_new_pane_error=""
  for ((attempt = 1; attempt <= pane_attempts; attempt += 1)); do
    if output="$(zellij action new-pane "$@" 2>&1)"; then
      zellij_new_pane_output="${output}"
      return 0
    fi
    status=$?
    zellij_new_pane_error="${output}"
    if ((attempt < pane_attempts)); then
      sleep "${pane_wait_seconds}"
    fi
  done
  return "${status}"
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
  prompt_path="${state_dir}/handoff/${slug}-prompt.txt"
  script_path="${state_dir}/handoff/${slug}-pi.sh"
  printf '%s\n' "${prompt_content}" >"${prompt_path}"
  cat >"${script_path}" <<SCRIPT
#!/usr/bin/env bash
set -uo pipefail

export PI_CODING_AGENT_DIR=$(shell_word "${pi_agent_dir}")
pi_command=$(shell_word "${pi_command}")
branch=$(shell_word "${branch}")
model=$(shell_word "${model}")
thinking=$(shell_word "${thinking}")
prompt_path=$(shell_word "${prompt_path}")

if ! command -v "\${pi_command}" >/dev/null 2>&1; then
  printf 'Pi command not found in child pane: %s\n' "\${pi_command}" >&2
  printf 'Prompt file: %s\n' "\${prompt_path}" >&2
  exec "\${SHELL:-/bin/sh}" -l
fi

if ! prompt="\$(cat "\${prompt_path}")"; then
  printf 'Failed to read handoff prompt: %s\n' "\${prompt_path}" >&2
  exec "\${SHELL:-/bin/sh}" -l
fi

args=(-a --name "\${branch}")
if [[ -n "\${model}" ]]; then
  args+=(--model "\${model}")
fi
if [[ -n "\${thinking}" ]]; then
  args+=(--thinking "\${thinking}")
fi

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

  if [[ -z "${ledger}" || ! -s "${ledger}" ]]; then
    return 0
  fi
  ack_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/workon-handoff-ack.sh"
  if [[ ! -x "${ack_script}" ]]; then
    return 0
  fi
  bash "${ack_script}" --ledger "${ledger}" --status "${status}" --message "${detail}" >/dev/null || true
}

repo_name="${repo##*/}"
tab_name="$(slugify "${repo_name}")/$(slugify "${branch}")"

require_command jq
require_command wt
require_command zellij
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
    detail="Worktrunk failed to create or switch to branch ${branch}. Output:
${create_output}"
    if [[ "${worktree_action}" == "reused" ]]; then
      detail="${detail}
Fallback wt switch output:
${switch_output}"
    fi
    fail_blocked "worktrunk-switch-failed" "${detail}" "${switch_status}"
  fi
fi
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
  fail_blocked "worktree-path-missing" "Worktrunk did not report a worktree path. Output:
${switch_output}" 1
fi

tabs_error=""
for ((attempt = 1; attempt <= wait_attempts; attempt += 1)); do
  if tabs_json="$(zellij action list-tabs --json 2>&1)"; then
    tab_id="$(find_tab_id "${tabs_json}" "${tab_name}")"
  else
    tabs_error="${tabs_json}"
    tab_id=""
  fi
  if [[ -n "${tab_id}" && "${tab_id}" != "null" ]]; then
    break
  fi
  if ((attempt < wait_attempts)); then
    sleep "${wait_seconds}"
  fi
done

if [[ -z "${tab_id}" || "${tab_id}" == "null" ]]; then
  emit_blocked_json "tab-not-found" "${tabs_error}" >&2
  printf 'Zellij Worktrunk tab not found after %s attempts: %s\n' "${wait_attempts}" "${tab_name}" >&2
  if [[ -n "${tabs_error}" ]]; then
    printf 'Last zellij list-tabs error/output:\n%s\n' "${tabs_error}" >&2
  fi
  exit 1
fi

if ! go_to_tab_output="$(zellij action go-to-tab-name "${tab_name}" 2>&1)"; then
  printf 'Warning: failed to focus Zellij tab %s before handoff; continuing with --tab-id %s. Output:\n%s\n' "${tab_name}" "${tab_id}" "${go_to_tab_output}" >&2
fi
clean_prompt="${prompt}

Session capsule path: ${capsule}
Read that file with the read tool before editing. Do not treat the capsule contents as the user prompt; use this handoff prompt as the task."

pi_bootstrap_script="$(write_pi_bootstrap "$(handoff_state_dir)" "${clean_prompt}")"
pi_launch_summary="env PI_CODING_AGENT_DIR=$(shell_word "${pi_agent_dir}") ${pi_command} -a --name ${branch}"
if [[ -n "${model}" ]]; then
  pi_launch_summary="${pi_launch_summary} --model ${model}"
fi
if [[ -n "${thinking}" ]]; then
  pi_launch_summary="${pi_launch_summary} --thinking ${thinking}"
fi
pi_launch_summary="${pi_launch_summary} <clean-prompt>"
pi_handoff_command="zellij action new-pane --tab-id ${tab_id} --name pi --cwd ${worktree_path} -- bash $(shell_word "${pi_bootstrap_script}") (launches: ${pi_launch_summary})"

pi_pane_id="$(find_named_pane pi "${tab_id}")"
pi_pane_action="reused"
if [[ -z "${pi_pane_id}" ]]; then
  if ! run_zellij_new_pane --tab-id "${tab_id}" --name pi --cwd "${worktree_path}" -- bash "${pi_bootstrap_script}"; then
    emit_blocked_json "pi-pane-launch-failed" "${zellij_new_pane_error}" >&2
    printf 'Zellij failed to launch Pi pane in tab %s (%s). Output:\n%s\n' "${tab_name}" "${tab_id}" "${zellij_new_pane_error}" >&2
    exit 1
  fi
  pi_pane_id="$(printf '%s\n' "${zellij_new_pane_output}" | last_nonempty_line)"
  if [[ -z "${pi_pane_id}" ]]; then
    sleep "${wait_seconds}"
    pi_pane_id="$(find_named_pane pi "${tab_id}")"
  fi
  if [[ -z "${pi_pane_id}" ]]; then
    emit_blocked_json "pi-pane-id-missing" "${zellij_new_pane_output}" >&2
    printf 'Zellij launched the Pi pane command but did not report a pane id in tab %s (%s). Output:\n%s\n' "${tab_name}" "${tab_id}" "${zellij_new_pane_output}" >&2
    exit 1
  fi
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
  heartbeat_pane_id="$(find_named_pane forge-heartbeat "${tab_id}")"
  if [[ -n "${heartbeat_pane_id}" ]]; then
    heartbeat_action="reused"
    heartbeat_command="reused existing forge-heartbeat pane ${heartbeat_pane_id}"
  else
    heartbeat_args=(bash "${heartbeat_script}" --multiplexer zellij --repo "${repo}" --branch "${branch}" --interval "${heartbeat}" --author @me)
    if [[ -n "${pi_pane_id}" ]]; then
      heartbeat_args+=(--notify-pane "${pi_pane_id}")
    else
      printf 'Zellij did not report a Pi pane id; forge heartbeat will not actively notify Pi.\n' >&2
    fi
    heartbeat_command="zellij action new-pane --tab-id ${tab_id} --name forge-heartbeat --cwd ${worktree_path} -- bash ${heartbeat_script} --multiplexer zellij --repo ${repo} --branch ${branch} --interval ${heartbeat} --author @me"
    if [[ -n "${pi_pane_id}" ]]; then
      heartbeat_command="${heartbeat_command} --notify-pane ${pi_pane_id}"
    fi
    if run_zellij_new_pane --tab-id "${tab_id}" --name forge-heartbeat --cwd "${worktree_path}" -- "${heartbeat_args[@]}"; then
      heartbeat_pane_id="$(printf '%s\n' "${zellij_new_pane_output}" | last_nonempty_line)"
      if [[ -z "${heartbeat_pane_id}" ]]; then
        sleep "${wait_seconds}"
        heartbeat_pane_id="$(find_named_pane forge-heartbeat "${tab_id}")"
      fi
      if [[ -n "${heartbeat_pane_id}" ]]; then
        heartbeat_action="started"
      else
        heartbeat_action="failed"
        heartbeat_command=""
        heartbeat_error="${zellij_new_pane_output}"
        printf 'Warning: failed to launch forge heartbeat pane; Pi handoff remains launched. Output:\n%s\n' "${heartbeat_error}" >&2
      fi
    else
      heartbeat_action="failed"
      heartbeat_error="${zellij_new_pane_error}"
      heartbeat_command=""
      printf 'Warning: failed to launch forge heartbeat pane; Pi handoff remains launched. Output:\n%s\n' "${heartbeat_error}" >&2
    fi
  fi
fi

printf '{"status":"launched","multiplexer":"zellij","path":%s,"scopeName":%s,"scopeId":%s,"tabName":%s,"tabId":%s,"piPaneId":%s,"piPaneAction":%s,"heartbeatPaneId":%s,"heartbeatAction":%s,"heartbeatInterval":%s,"worktreeAction":%s,"piHandoffCommand":%s,"heartbeatCommand":%s}\n' \
  "$(json_string "${worktree_path}")" \
  "$(json_string "${tab_name}")" \
  "${tab_id}" \
  "$(json_string "${tab_name}")" \
  "${tab_id}" \
  "$(json_string_or_null "${pi_pane_id}")" \
  "$(json_string "${pi_pane_action}")" \
  "$(json_string_or_null "${heartbeat_pane_id}")" \
  "$(json_string "${heartbeat_action}")" \
  "$(json_string "${heartbeat}")" \
  "$(json_string "${worktree_action}")" \
  "$(json_string "${pi_handoff_command}")" \
  "$(json_string_or_null "${heartbeat_command}")"
