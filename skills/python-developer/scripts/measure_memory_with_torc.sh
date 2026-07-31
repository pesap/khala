#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Measure a Python command's memory with Torc resource monitoring.

Usage:
  measure_memory_with_torc.sh [options] -- <python-command> [args...]

Options:
  --results-dir DIR        Results directory.
                           Default: $TORC_MEMORY_RESULTS_DIR or torc_output/memory-<timestamp>
  --resource-memory VALUE  Torc resource memory request.
                           Default: $TORC_MEMORY_RESOURCE_MEMORY or 4g
  --runtime VALUE          Torc runtime request, for example PT15M.
                           Default: $TORC_MEMORY_RUNTIME or PT15M
  --cpus N                 Torc CPU request.
                           Default: $TORC_MEMORY_CPUS or 1
  --install-dir DIR        Install directory if Torc is missing.
                           Default: $TORC_INSTALL_DIR or ~/.local/bin
  --no-install-torc        Fail if torc is missing instead of installing latest.
  -h, --help               Show this help.

Examples:
  skills/python-developer/scripts/measure_memory_with_torc.sh -- \
    uv run --locked python benchmarks/ptdf-calculation/ptdf_numpy_banded_direct.py \
      --n 1000 --k 1.5 --query-lines 4

  skills/python-developer/scripts/measure_memory_with_torc.sh \
    --results-dir torc_output/ptdf-memory --cpus 2 -- \
    uv run --locked python benchmarks/ptdf-calculation/ptdf_numpy_banded_direct.py \
      --n 1000 --k 1.5 --query-lines 4

Notes:
  Runtime and peak memory come from Torc's result table, not Python-level
  tracing. Do not use tracemalloc, resource, psutil, or similar Python-side
  probes for benchmark memory numbers.

  If torc is missing, this script installs the latest Torc release by calling:
  skills/torc-hpc/scripts/install-latest-torc.sh
USAGE
}

log_info() {
  printf 'info: %s\n' "$*" >&2
}

usage_error() {
  printf 'error: %s\n' "$*" >&2
  usage >&2
  exit 2
}

fatal() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
torc_installer="${script_dir}/../../torc-hpc/scripts/install-latest-torc.sh"

results_dir="${TORC_MEMORY_RESULTS_DIR:-}"
resource_memory="${TORC_MEMORY_RESOURCE_MEMORY:-4g}"
runtime="${TORC_MEMORY_RUNTIME:-PT15M}"
cpus="${TORC_MEMORY_CPUS:-1}"
install_dir="${TORC_INSTALL_DIR:-}"
auto_install_torc=1

while [[ $# -gt 0 ]]; do
  case "${1}" in
    --)
      shift
      break
      ;;
    --results-dir)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --results-dir'
      fi
      results_dir="${2}"
      shift 2
      ;;
    --resource-memory)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --resource-memory'
      fi
      resource_memory="${2}"
      shift 2
      ;;
    --runtime)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --runtime'
      fi
      runtime="${2}"
      shift 2
      ;;
    --cpus)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --cpus'
      fi
      cpus="${2}"
      shift 2
      ;;
    --install-dir)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --install-dir'
      fi
      install_dir="${2}"
      shift 2
      ;;
    --no-install-torc)
      auto_install_torc=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage_error "unknown argument before --: ${1}"
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  usage_error 'missing command after --'
fi

if [[ -z "${resource_memory}" ]]; then
  usage_error '--resource-memory must not be empty'
fi

if [[ -z "${runtime}" ]]; then
  usage_error '--runtime must not be empty'
fi

if ! [[ "${cpus}" =~ ^[1-9][0-9]*$ ]]; then
  usage_error '--cpus must be a positive integer'
fi

ensure_torc() {
  local installer_args installed_torc_path installed_torc_dir
  installer_args=(--print-path)

  if command -v torc >/dev/null 2>&1; then
    return 0
  fi

  if [[ "${auto_install_torc}" -eq 0 ]]; then
    fatal 'torc is not on PATH; install Torc or omit --no-install-torc'
  fi

  if [[ ! -x "${torc_installer}" ]]; then
    fatal "torc is not on PATH and installer is unavailable: ${torc_installer}"
  fi

  if [[ -n "${install_dir}" ]]; then
    installer_args+=(--install-dir "${install_dir}")
  fi

  log_info 'torc not found; installing latest Torc release'
  installed_torc_path="$("${torc_installer}" "${installer_args[@]}")"
  installed_torc_dir="$(dirname "${installed_torc_path}")"
  export PATH="${installed_torc_dir}:${PATH}"

  if ! command -v torc >/dev/null 2>&1; then
    fatal "Torc installed to ${installed_torc_path}, but torc is still not on PATH"
  fi
}

ensure_torc

if [[ -z "${results_dir}" ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  results_dir="torc_output/memory-${stamp}"
fi

mkdir -p "${results_dir}"
results_dir="$(cd "${results_dir}" && pwd)"
run_script="${results_dir}/run-command.sh"
workflow_file="${results_dir}/torc-memory-workflow.yaml"
db_path="${results_dir}/torc.db"
torc_output_dir="${results_dir}/torc-output"

{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'exec'
  for arg in "$@"; do
    printf ' %q' "${arg}"
  done
  printf '\n'
} > "${run_script}"
chmod +x "${run_script}"

quoted_run_script="$(printf '%q' "${run_script}")"
cat > "${workflow_file}" <<YAML
name: python_command_memory_probe
description: Measure one Python command with Torc resource monitoring.

resource_monitor:
  enabled: true
  granularity: summary
  sample_interval_seconds: 1
  flush_interval_seconds: 300
  generate_plots: false
  jobs:
    enabled: true
    granularity: summary

execution_config:
  mode: direct

resource_requirements:
  - name: measured_command
    num_cpus: ${cpus}
    num_gpus: 0
    num_nodes: 1
    memory: ${resource_memory}
    runtime: ${runtime}

jobs:
  - name: measured_python_command
    command: bash ${quoted_run_script}
    resource_requirements: measured_command
YAML

log_info "Torc workflow: ${workflow_file}"
log_info "Torc DB: ${db_path}"
log_info "Results dir: ${results_dir}"

torc -s --in-memory --db "${db_path}" run -o "${torc_output_dir}" "${workflow_file}"

if command -v sqlite3 >/dev/null 2>&1 && [[ -f "${db_path}" ]]; then
  sqlite3 -header -column "${db_path}" <<'SQL'
SELECT
  j.name AS job_name,
  r.return_code,
  ROUND(r.exec_time_minutes * 60.0, 3) AS seconds,
  ROUND(COALESCE(r.peak_memory_bytes, 0) / 1048576.0, 1) AS peak_memory_mb
FROM result AS r
JOIN job AS j ON j.id = r.job_id
ORDER BY j.name;
SQL
else
  printf 'sqlite3 unavailable or Torc DB missing; inspect the Torc DB manually: %s\n' "${db_path}" >&2
fi
