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

health_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$repo_root/khala/index.ts" \
    --offline \
    --no-session \
    --no-tools \
    -p "/khala-health" 2>&1
)"

grep -q "Khala health (read-only):" <<<"$health_output"
grep -q "enabled (session): no" <<<"$health_output"
grep -q "Compliance modes" <<<"$health_output"
grep -q "Model profiles" <<<"$health_output"

mode_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$repo_root/khala/index.ts" \
    --offline \
    --no-session \
    --no-tools \
    -p "/khala-mode" 2>&1
)"

grep -q "Khala health (read-only):" <<<"$mode_output"
grep -q "Compliance modes" <<<"$mode_output"

rpc_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$repo_root/khala/index.ts" \
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
    -e "$repo_root/khala/index.ts" \
    --offline \
    --no-session \
    --no-tools \
    -p "/workflow-list" 2>&1
)"

grep -q "No khala learned workflows found" <<<"$workflow_list_output"

python3 - "$repo_root" "$tmpdir" <<'PY'
import subprocess
import sys

repo_root = sys.argv[1]
tmpdir = sys.argv[2]

proc = subprocess.run(
    [
        "pi",
        "--no-extensions",
        "-e",
        f"{repo_root}/khala/index.ts",
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

learn_output="$(
  cd "$tmpdir"
  pi --no-extensions \
    -e "$repo_root/khala/index.ts" \
    --offline \
    --no-session \
    --no-tools \
    -p "/learn-skill repeated repo audit --dry-run" 2>&1
)"

grep -q "Started learn-skill dry run for khala-repeated-repo-audit" <<<"$learn_output"

echo "pi khala memory smoke passed"
