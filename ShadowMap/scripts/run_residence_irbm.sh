#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Optional: load a machine profile to avoid hardcoded paths.
if [ "${SHADOWMAP_ENV_FILE:-}" = "/dev/null" ]; then
  : # explicitly skip loading any profile
elif [ -n "${SHADOWMAP_ENV_FILE:-}" ] && [ -f "${SHADOWMAP_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${SHADOWMAP_ENV_FILE}"
elif [ -f "${REPO_ROOT}/.shadowmap.env" ]; then
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.shadowmap.env"
fi

python3 "${SCRIPT_DIR}/residence_irbm.py" "$@"

