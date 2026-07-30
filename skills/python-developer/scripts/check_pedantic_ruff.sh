#!/usr/bin/env bash
set -euo pipefail

project_root="$(pwd)"
if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  project_root="${git_root}"
fi

cd "${project_root}"

paths=("$@")
if [[ ${#paths[@]} -eq 0 ]]; then
  paths=(.)
fi

ruff_args=(
  check
  --preview
  --select
  ALL
  --show-fixes
  --output-format
  full
)

if command -v uv >/dev/null 2>&1; then
  if [[ -f pyproject.toml || -d .venv ]]; then
    exec uv run ruff "${ruff_args[@]}" "${paths[@]}"
  fi
  exec uvx ruff "${ruff_args[@]}" "${paths[@]}"
fi

exec ruff "${ruff_args[@]}" "${paths[@]}"
