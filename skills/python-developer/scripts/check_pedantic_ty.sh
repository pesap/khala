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

ty_args=(
  check
  --error
  all
  --output-format
  full
)

if command -v uv >/dev/null 2>&1; then
  if [[ -f pyproject.toml || -d .venv ]]; then
    exec uv run ty "${ty_args[@]}" "${paths[@]}"
  fi
  exec uvx ty "${ty_args[@]}" "${paths[@]}"
fi

exec ty "${ty_args[@]}" "${paths[@]}"
