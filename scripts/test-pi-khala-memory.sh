#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/khala-pi-smoke.XXXXXX")"
dailylog="$repo_root/runtime/memory/runtime/live/dailylog.md"
dailylog_backup="$tmpdir/dailylog.md"
if [[ -f "$dailylog" ]]; then
  cp "$dailylog" "$dailylog_backup"
fi

cleanup() {
  if [[ -f "$dailylog_backup" ]]; then
    cp "$dailylog_backup" "$dailylog"
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

mkdir -p "$tmpdir/.pi"
khala_extension="$repo_root/extensions/index.ts"

health_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$khala_extension" \
    --offline \
    --no-session \
    --no-tools \
    -p "/khala-health" 2>&1
)"

grep -q "Khala health:" <<<"$health_output"
grep -q "enabled: no" <<<"$health_output"
grep -q "compliance:" <<<"$health_output"
grep -q "Model profiles" <<<"$health_output"

mode_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$khala_extension" \
    --offline \
    --no-session \
    --no-tools \
    -p "/khala-mode" 2>&1
)"

grep -q "Khala health:" <<<"$mode_output"
grep -q "compliance:" <<<"$mode_output"

rpc_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$khala_extension" \
    --offline \
    --no-session \
    --no-tools \
    --mode rpc \
    -p "/khala-health" 2>&1
)"

grep -q '"type":"extension_ui_request"' <<<"$rpc_output"

workflow_list_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$khala_extension" \
    --offline \
    --no-session \
    --no-tools \
    -p "/workflow-list" 2>&1
)"

grep -q "No khala learned workflows found" <<<"$workflow_list_output"

python3 - "$khala_extension" "$tmpdir" <<'PY'
import subprocess
import sys

khala_extension = sys.argv[1]
tmpdir = sys.argv[2]

proc = subprocess.run(
    [
        "pi",
        "--no-extensions",
        "-e",
        khala_extension,
        "--offline",
        "--no-session",
        "--no-tools",
        "--mode",
        "rpc",
    ],
    cwd=tmpdir,
    input='{"id":"cmds","type":"get_commands"}\n',
    text=True,
    capture_output=True,
    timeout=30,
)

output = proc.stdout + proc.stderr
if proc.returncode != 0:
    print(output)
    raise SystemExit(proc.returncode)

required_commands = {
    "khala-health",
    "khala-mode",
    "khala-reload",
    "workflow-list",
    "workflow-show",
    "workflow-run",
}
missing = {command for command in required_commands if command not in output}
if missing:
    print(output)
    raise SystemExit(f"missing commands: {sorted(missing)}")
PY

set +e
learn_output="$(
  cd "$tmpdir"
  timeout 10 pi --no-extensions \
    -e "$khala_extension" \
    --offline \
    --no-session \
    --no-tools \
    -p "/learn-skill repeated repo audit --dry-run" 2>&1
)"
learn_status=$?
set -e
if [[ $learn_status -ne 0 && $learn_status -ne 124 ]]; then
  printf '%s\n' "$learn_output"
  exit "$learn_status"
fi

grep -q "Started learn-skill dry run for khala-repeated-repo-audit" <<<"$learn_output"

echo "pi khala memory smoke passed"
