#!/bin/bash
set -euo pipefail

# Unified entry for mobility shadow batch processing.
# Default engine is Python (local compute). Use `--engine node` to run the HTTP-based Node version.

ENGINE="${ENGINE:-python}"

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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${ENGINE}" in
  python|py)
    exec python3 "${script_dir}/batch_mobility_shadow.py" "${args[@]}"
    ;;
  node|js)
    exec node "${script_dir}/batch-mobility-shadow.mjs" "${args[@]}"
    ;;
  *)
    echo "[Fatal] Unknown engine: ${ENGINE} (expected python|node)" >&2
    exit 2
    ;;
esac

