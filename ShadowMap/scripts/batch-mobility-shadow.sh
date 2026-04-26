#!/bin/bash
set -euo pipefail

# Unified entry for mobility shadow batch processing.
# Default engine is Python (local compute). Use `--engine node` to run the HTTP-based Node version.

ENGINE="${ENGINE:-python}"
PYTHON_BIN="${SHADOWMAP_PYTHON_BIN:-${PYTHON_BIN:-python3}}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

# Optional: load a machine profile to avoid hardcoded paths in scripts.
# Priority:
# 1) $SHADOWMAP_ENV_FILE (explicit)
# 2) ShadowMap/.shadowmap.env (local, gitignored)
if [ "${SHADOWMAP_ENV_FILE:-}" = "/dev/null" ]; then
  : # explicitly skip loading any profile
elif [ -n "${SHADOWMAP_ENV_FILE:-}" ] && [ -f "${SHADOWMAP_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${SHADOWMAP_ENV_FILE}"
elif [ -f "${repo_root}/.shadowmap.env" ]; then
  # shellcheck disable=SC1091
  source "${repo_root}/.shadowmap.env"
fi

# Re-resolve the interpreter after sourcing the profile so machine-local env
# files can actually override the Python used by the runner.
PYTHON_BIN="${SHADOWMAP_PYTHON_BIN:-${PYTHON_BIN:-python3}}"

configure_python_engine_env() {
  local py_bin="${1:-python3}"
  local py_prefix proj_dir gdal_dir

  py_prefix="$("${py_bin}" - <<'PY' 2>/dev/null || true
import sys
print(sys.prefix)
PY
)"
  py_prefix="${py_prefix//$'\r'/}"
  py_prefix="${py_prefix//$'\n'/}"
  if [ -z "${py_prefix}" ]; then
    return 0
  fi

  proj_dir="${py_prefix}/share/proj"
  gdal_dir="${py_prefix}/share/gdal"

  if [ -z "${PROJ_LIB:-}" ] && [ -f "${proj_dir}/proj.db" ]; then
    export PROJ_LIB="${proj_dir}"
  fi
  if [ -z "${PROJ_DATA:-}" ] && [ -f "${proj_dir}/proj.db" ]; then
    export PROJ_DATA="${proj_dir}"
  fi
  if [ -z "${GDAL_DATA:-}" ] && [ -d "${gdal_dir}" ]; then
    export GDAL_DATA="${gdal_dir}"
  fi
}

args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --engine)
      ENGINE="${2:-}"
      shift 2
      ;;
    --engine=*)
      ENGINE="${1#*=}"
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  ./batch-mobility-shadow.sh [--engine python|node] [args...]

Engines:
  python (default): local compute using `batch_mobility_shadow.py`
  node:             HTTP pipeline using `batch-mobility-shadow.mjs`

Note:
  Set $SHADOWMAP_PYTHON_BIN when the Python engine requires a non-default interpreter.
  All other args are forwarded to the selected engine script.
EOF
      exit 0
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

case "${ENGINE}" in
  python|py)
    configure_python_engine_env "${PYTHON_BIN}"
    exec "${PYTHON_BIN}" "${script_dir}/batch_mobility_shadow.py" "${args[@]}"
    ;;
  node|js)
    exec node "${script_dir}/batch-mobility-shadow.mjs" "${args[@]}"
    ;;
  *)
    echo "[Fatal] Unknown engine: ${ENGINE} (expected python|node)" >&2
    exit 2
    ;;
esac
