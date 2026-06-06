#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-forge-heartbeat.sh --repo OWNER/REPO --branch BRANCH --interval HOURS [--author LOGIN|@me] [--notify-pane PANE_ID] [--once]

Poll the forge CLI for feedback from the selected author on the open PR for a
branch. Numeric intervals are decimal hours: 0.25 means 15 minutes, and 2.0
means 2 hours. When --notify-pane is set, new feedback is pasted into that
Zellij pane so the launched Pi session can react while it is still running.
USAGE
}

repo=""
branch=""
interval="1.0"
author="@me"
notify_pane=""
last_notified_comments=""
once=false

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
    --interval|--interval-hours)
      interval="${2:?--interval requires HOURS}"
      shift 2
      ;;
    --author)
      author="${2:?--author requires LOGIN or @me}"
      shift 2
      ;;
    --notify-pane)
      notify_pane="${2:?--notify-pane requires PANE_ID}"
      shift 2
      ;;
    --once)
      once=true
      shift
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

if [[ -z "${repo}" || -z "${branch}" ]]; then
  usage
  exit 2
fi

require_command() {
  local command_name="${1:?command name required}"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "${command_name}" >&2
    exit 1
  fi
}

interval_seconds() {
  local value="${1:?interval required}"
  if [[ ! "${value}" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf 'invalid interval: %s (expected decimal hours, e.g. 0.25 or 2.0)\n' "${value}" >&2
    return 1
  fi

  awk -v hours="${value}" 'BEGIN { seconds = int(hours * 3600); print (seconds > 0 ? seconds : 1) }'
}

json_string() {
  jq -Rn --arg value "$1" '$value'
}

notify_pi_pane() {
  local pr_url="${1:?PR URL required}"
  local comments="${2:?comments required}"
  local message=""

  if [[ -z "${notify_pane}" || "${comments}" == "${last_notified_comments}" ]]; then
    return 0
  fi

  message="Forge feedback heartbeat found feedback from ${author} on ${pr_url}.

Review it before continuing. Prefer in-thread replies for review comments. Do not merge, mark ready, close issues/PRs, label, or post broad public comments unless explicitly told.

${comments}"
  zellij action paste --pane-id "${notify_pane}" "${message}"
  zellij action send-keys --pane-id "${notify_pane}" Enter
  last_notified_comments="${comments}"
  printf '{"status":"notified-pi","paneId":%s,"prUrl":%s}\n' \
    "$(json_string "${notify_pane}")" \
    "$(json_string "${pr_url}")"
}

print_author_comments() {
  local pr_number="${1:?pr number required}"
  local feedback_author="${2:?author required}"
  local endpoint=""
  local label=""
  local raw=""

  for spec in \
    "issue:repos/${repo}/issues/${pr_number}/comments" \
    "review-comment:repos/${repo}/pulls/${pr_number}/comments" \
    "review:repos/${repo}/pulls/${pr_number}/reviews"; do
    label="${spec%%:*}"
    endpoint="${spec#*:}"
    raw="$(gh api "${endpoint}" --paginate)"
    printf '%s\n' "${raw}" | jq -r --arg author "${feedback_author}" --arg label "${label}" '
      .[]
      | select(.user.login == $author)
      | [(.submitted_at // .created_at // ""), $label, (.html_url // ""), ((.body // "") | gsub("[\r\n]+"; " ") | .[0:300])]
      | @tsv
    '
  done | sort
}

require_command gh
require_command jq
if [[ -n "${notify_pane}" ]]; then
  require_command zellij
fi

sleep_seconds="$(interval_seconds "${interval}")"
if [[ "${author}" == "@me" ]]; then
  author="$(gh api user --jq .login)"
fi

while true; do
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pr_json="$(gh pr list --repo "${repo}" --state open --head "${branch}" --json number,title,url --jq '.[0] // empty')"
  if [[ -z "${pr_json}" ]]; then
    printf '{"status":"no-open-pr","checkedAt":%s,"repo":%s,"branch":%s,"author":%s}\n' \
      "$(json_string "${checked_at}")" \
      "$(json_string "${repo}")" \
      "$(json_string "${branch}")" \
      "$(json_string "${author}")"
  else
    pr_number="$(printf '%s' "${pr_json}" | jq -r '.number')"
    pr_url="$(printf '%s' "${pr_json}" | jq -r '.url')"
    printf '== %s feedback from %s on %s ==\n' "${checked_at}" "${author}" "${pr_url}"
    comments="$(print_author_comments "${pr_number}" "${author}")"
    if [[ -z "${comments}" ]]; then
      printf 'No matching feedback comments found.\n'
    else
      printf '%s\n' "${comments}"
      notify_pi_pane "${pr_url}" "${comments}"
    fi
  fi

  if [[ "${once}" == true ]]; then
    break
  fi
  sleep "${sleep_seconds}"
done
