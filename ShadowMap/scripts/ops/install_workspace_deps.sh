#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
clean_install="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --clean)
      clean_install="true"
      shift
      ;;
    *)
      echo "[Fatal] Unknown option: $1" >&2
      echo "Usage: ./scripts/ops/install_workspace_deps.sh [--clean]" >&2
      exit 2
      ;;
  esac
done

# shellcheck disable=SC1091
source "${repo_root}/scripts/lib/load_shadowmap_env.sh"

shadowmap_load_env "${repo_root}"
shadowmap_activate_node "${repo_root}"
shadowmap_require_node 18

for app_dir in \
  "${repo_root}/shadow-map-backend" \
  "${repo_root}/shadow-map-frontend/react-shadow-app"
do
  if [ "${clean_install}" = "true" ] && [ -d "${app_dir}/node_modules" ]; then
    rm -rf "${app_dir}/node_modules"
  fi

  (
    cd "${app_dir}"
    npm install --no-fund --no-audit
  )
done
