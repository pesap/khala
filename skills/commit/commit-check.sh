#!/usr/bin/env bash
set -euo pipefail

REV_RANGE="${1:-HEAD^!}"

exec uvx --from commitizen cz check --rev-range "$REV_RANGE"
