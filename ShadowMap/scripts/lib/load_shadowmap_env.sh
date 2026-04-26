#!/usr/bin/env bash

shadowmap_repo_root() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${script_dir}/../.." >/dev/null 2>&1 && pwd
}

shadowmap_load_env() {
  local repo_root="${1:-$(shadowmap_repo_root)}"
  local env_file=""

  if [ "${SHADOWMAP_ENV_FILE:-}" = "/dev/null" ]; then
    return 0
  fi

  if [ -n "${SHADOWMAP_ENV_FILE:-}" ]; then
    env_file="${SHADOWMAP_ENV_FILE}"
  else
    env_file="${repo_root}/.shadowmap.env"
  fi

  if [ -f "${env_file}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

shadowmap_activate_node() {
  local repo_root="${1:-$(shadowmap_repo_root)}"
  local version_file="${2:-${repo_root}/.nvmrc}"
  local nvm_dir="${NVM_DIR:-${HOME}/.nvm}"
  local nvm_script="${nvm_dir}/nvm.sh"
  local requested_version=""

  if [ ! -s "${nvm_script}" ]; then
    return 0
  fi

  # shellcheck disable=SC1090
  source "${nvm_script}"

  if [ -f "${version_file}" ]; then
    requested_version="$(tr -d '[:space:]' < "${version_file}")"
  fi

  if [ -n "${requested_version}" ]; then
    nvm use --silent "${requested_version}" >/dev/null
  fi
}

shadowmap_require_node() {
  local min_major="${1:-18}"
  local current_major=""

  if ! command -v node >/dev/null 2>&1; then
    echo "[Fatal] Node.js is not installed or not on PATH." >&2
    return 1
  fi

  current_major="$(node -p 'process.versions.node.split(".")[0]')"

  if [ "${current_major}" -lt "${min_major}" ]; then
    echo "[Fatal] Node.js >= ${min_major} is required, found $(node -v)." >&2
    echo "        Install the version from .nvmrc and rerun the command." >&2
    return 1
  fi
}
