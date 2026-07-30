#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Validate an infrasys system JSON using python -m json.tool piped to jq.

Usage:
  check_system_json.sh <path/to/system.json> [--strict]

Options:
  --strict   Require common system keys: uuid, name
  -h, --help Show this help
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

json_path=""
strict=0

for arg in "$@"; do
  case "$arg" in
    --strict)
      strict=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$json_path" ]]; then
        json_path="$arg"
      else
        echo "error: unexpected argument: $arg" >&2
        usage
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$json_path" ]]; then
  echo "error: missing json path" >&2
  usage
  exit 2
fi

if [[ ! -f "$json_path" ]]; then
  echo "error: file not found: $json_path"
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found in PATH"
  exit 2
fi

PYTHON_BIN="${PYTHON:-python}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  else
    echo "error: python interpreter not found (set PYTHON or install python/python3)"
    exit 2
  fi
fi

JQ_FILTER='def sysobj: if has("system") then .system else . end;
[
  (((.time_series // sysobj.time_series) | type) == "object"),
  ((((.time_series // sysobj.time_series).directory? // null) | type) == "string"),
  ((sysobj.components? | type) == "array"),
  ((sysobj.supplemental_attributes? | type) == "array"),
  (sysobj | has("uuid")),
  (sysobj | has("name")),
  ((sysobj.components? // []) | length),
  ((sysobj.supplemental_attributes? // []) | length),
  ((.time_series // sysobj.time_series).directory? // "<missing>")
] | @tsv'

tmp_json="$(mktemp)"
tmp_err="$(mktemp)"
cleanup() {
  rm -f "$tmp_json" "$tmp_err"
}
trap cleanup EXIT

if ! "$PYTHON_BIN" -m json.tool "$json_path" >"$tmp_json" 2>"$tmp_err"; then
  err_msg="$(cat "$tmp_err")"
  echo "malformed JSON: ${err_msg}"
  exit 1
fi

if ! summary="$(jq -r "$JQ_FILTER" <"$tmp_json" 2>"$tmp_err")"; then
  err_msg="$(cat "$tmp_err")"
  echo "jq failed: ${err_msg}"
  exit 1
fi

IFS=$'\t' read -r has_time_series has_time_series_directory has_components_list has_supplemental_attributes_list has_uuid has_name components_count supplemental_count ts_dir <<<"$summary"

errors=()

[[ "$has_time_series" == "true" ]] || errors+=("missing key: time_series")
[[ "$has_time_series_directory" == "true" ]] || errors+=("time_series.directory missing or not a string")
[[ "$has_components_list" == "true" ]] || errors+=("system/components must be a list")
[[ "$has_supplemental_attributes_list" == "true" ]] || errors+=("system/supplemental_attributes must be a list")

if [[ "$strict" -eq 1 ]]; then
  [[ "$has_uuid" == "true" ]] || errors+=("missing system key (strict): uuid")
  [[ "$has_name" == "true" ]] || errors+=("missing system key (strict): name")
fi

if [[ ${#errors[@]} -gt 0 ]]; then
  echo "invalid infrasys JSON:"
  for err in "${errors[@]}"; do
    echo "- $err"
  done
  exit 1
fi

echo "JSON validation passed."
echo "- components: ${components_count}"
echo "- supplemental_attributes: ${supplemental_count}"
echo "- time_series.directory: ${ts_dir}"
