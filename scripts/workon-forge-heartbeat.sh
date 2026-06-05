#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: workon-forge-heartbeat.sh --repo OWNER/REPO --branch BRANCH --interval HOURS.MINUTES [--author LOGIN|@me] [--once]

Poll the forge CLI for feedback from the selected author on the open PR for a
branch. Numeric intervals use HOURS.MINUTES notation: 0.15 means 15 minutes,
1.30 means 1 hour 30 minutes, and 2.0 means 2 hours.
USAGE
}

repo=""
branch=""
interval="1.0"
author="@me"
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
      interval="${2:?--interval requires HOURS.MINUTES}"
      shift 2
      ;;
    --author)
      author="${2:?--author requires LOGIN or @me}"
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
    printf 'invalid interval: %s (expected HOURS.MINUTES, e.g. 0.15 or 2.0)\n' "${value}" >&2
    return 1
  fi

  local hours="${value%%.*}"
  local minutes="0"
  if [[ "${value}" == *.* ]]; then
    minutes="${value#*.}"
  fi
  minutes="${minutes:-0}"
  if ((10#${minutes} >= 60)); then
    printf 'invalid interval minutes: %s (must be 0..59)\n' "${minutes}" >&2
    return 1
  fi

  printf '%d\n' $((10#${hours} * 3600 + 10#${minutes} * 60))
}

json_string() {
  jq -Rn --arg value "$1" '$value'
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
    fi
  fi

  if [[ "${once}" == true ]]; then
    break
  fi
  sleep "${sleep_seconds}"
done
