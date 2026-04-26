#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

# shellcheck disable=SC1091
source "${repo_root}/scripts/lib/load_shadowmap_env.sh"

shadowmap_load_env "${repo_root}"
shadowmap_activate_node "${repo_root}"
shadowmap_require_node 18

frontend_host="${SHADOWMAP_FRONTEND_HOST:-0.0.0.0}"
frontend_port="${SHADOWMAP_FRONTEND_PORT:-5173}"

cd "${repo_root}/shadow-map-frontend/react-shadow-app"

if [ ! -x "./node_modules/.bin/vite" ]; then
  echo "[Fatal] Missing frontend dependencies. Run ./scripts/ops/install_workspace_deps.sh first." >&2
  exit 1
fi

exec ./node_modules/.bin/vite --host "${frontend_host}" --port "${frontend_port}" --strictPort "$@"
