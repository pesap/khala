#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Install the latest Torc release binary from GitHub.

Usage:
  install-latest-torc.sh [options]

Options:
  --install-dir DIR  Directory for the torc executable.
                     Default: $TORC_INSTALL_DIR or ~/.local/bin
  --target TARGET    Override platform target auto-detection.
  --print-path       Print the installed executable path on stdout.
  -h, --help         Show this help.

Supported auto-detected targets:
  aarch64-apple-darwin
  x86_64-unknown-linux-musl
  x86_64-pc-windows-msvc

Environment:
  TORC_INSTALL_DIR   Default install directory.
  GITHUB_TOKEN       Optional token for GitHub API rate limits.

Notes:
  This installs from https://github.com/NatLabRockies/torc/releases/latest and
  writes only the selected torc executable into the install directory.
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

detect_target() {
  local uname_s uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"

  case "${uname_s}/${uname_m}" in
    Darwin/arm64|Darwin/aarch64)
      printf 'aarch64-apple-darwin\n'
      ;;
    Linux/x86_64|Linux/amd64)
      printf 'x86_64-unknown-linux-musl\n'
      ;;
    MINGW*/*|MSYS*/*|CYGWIN*/*)
      printf 'x86_64-pc-windows-msvc\n'
      ;;
    *)
      fatal "no known Torc release asset for ${uname_s}/${uname_m}; pass --target or see https://github.com/NatLabRockies/torc/releases"
      ;;
  esac
}

find_python() {
  local python_bin
  python_bin="$(command -v python3 || command -v python || true)"
  if [[ -z "${python_bin}" ]]; then
    fatal 'python3 or python is required to inspect the latest Torc release'
  fi
  printf '%s\n' "${python_bin}"
}

select_torc_asset_url() {
  local target python_bin
  target="${1:?target}"
  python_bin="$(find_python)"

  "${python_bin}" - "${target}" <<'PY'
from __future__ import annotations

import json
import os
import sys
import urllib.request

release_url = "https://api.github.com/repos/NatLabRockies/torc/releases/latest"
target = sys.argv[1]
headers = {}
token = os.environ.get("GITHUB_TOKEN")
if token:
    headers["Authorization"] = f"Bearer {token}"
request = urllib.request.Request(release_url, headers=headers)
with urllib.request.urlopen(request, timeout=30) as response:
    release = json.load(response)
for asset in release.get("assets", []):
    name = asset.get("name", "")
    if target in name and name.endswith((".tar.gz", ".zip")):
        print(asset["browser_download_url"])
        raise SystemExit(0)
release_name = release.get("name") or release.get("tag_name") or "latest"
raise SystemExit(f"no Torc asset for target {target!r} in {release_name}")
PY
}

install_dir=""
target=""
print_path=0

while [[ $# -gt 0 ]]; do
  case "${1}" in
    --install-dir)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --install-dir'
      fi
      install_dir="${2}"
      shift 2
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        usage_error 'missing value for --target'
      fi
      target="${2}"
      shift 2
      ;;
    --print-path)
      print_path=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage_error "unknown argument: ${1}"
      ;;
  esac
done

if [[ -z "${install_dir}" ]]; then
  if [[ -n "${TORC_INSTALL_DIR:-}" ]]; then
    install_dir="${TORC_INSTALL_DIR}"
  elif [[ -n "${HOME:-}" ]]; then
    install_dir="${HOME}/.local/bin"
  else
    fatal 'set --install-dir or TORC_INSTALL_DIR because HOME is not set'
  fi
fi

if [[ -z "${target}" ]]; then
  target="$(detect_target)"
fi

for required_cmd in curl tar; do
  if ! command -v "${required_cmd}" >/dev/null 2>&1; then
    fatal "${required_cmd} is required to install Torc from GitHub releases"
  fi
done

mkdir -p "${install_dir}"

tmp_dir=""
tmp_binary=""
cleanup() {
  local status=$?
  if [[ -n "${tmp_binary}" && -e "${tmp_binary}" ]]; then
    rm -f "${tmp_binary}" || true
  fi
  if [[ -n "${tmp_dir}" && -d "${tmp_dir}" ]]; then
    rm -rf "${tmp_dir}" || true
  fi
  exit "${status}"
}
trap cleanup EXIT

tmp_dir="$(mktemp -d)"
asset_url="$(select_torc_asset_url "${target}")"
archive="${tmp_dir}/${asset_url##*/}"

log_info "installing latest Torc release for ${target}"
log_info "download: ${asset_url}"
curl --fail --location --show-error --silent "${asset_url}" --output "${archive}"

case "${archive}" in
  *.tar.gz)
    tar -xzf "${archive}" -C "${tmp_dir}"
    ;;
  *.zip)
    if ! command -v unzip >/dev/null 2>&1; then
      fatal 'unzip is required for Windows Torc release assets'
    fi
    unzip -q "${archive}" -d "${tmp_dir}"
    ;;
  *)
    fatal "unsupported Torc archive type: ${archive}"
    ;;
esac

torc_path="$(find "${tmp_dir}" -type f \( -name torc -o -name torc.exe \) -print -quit)"
if [[ -z "${torc_path}" ]]; then
  fatal 'downloaded Torc archive did not contain a torc executable'
fi

destination="${install_dir}/$(basename "${torc_path}")"
tmp_binary="${destination}.tmp.$$"
cp "${torc_path}" "${tmp_binary}"
chmod +x "${tmp_binary}"
mv -f "${tmp_binary}" "${destination}"
tmp_binary=""

log_info "installed: ${destination}"
if [[ ":${PATH}:" != *":${install_dir}:"* ]]; then
  log_info "add ${install_dir} to PATH before running torc from a new shell"
fi

if [[ "${print_path}" -eq 1 ]]; then
  printf '%s\n' "${destination}"
fi
