#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

# shellcheck disable=SC1091
source "${repo_root}/scripts/lib/load_shadowmap_env.sh"

shadowmap_load_env "${repo_root}"
shadowmap_activate_node "${repo_root}"
shadowmap_require_node 18

cd "${repo_root}/shadow-map-backend"

if [ ! -x "./node_modules/.bin/nodemon" ]; then
  echo "[Fatal] Missing backend dependencies. Run ./scripts/ops/install_workspace_deps.sh first." >&2
  exit 1
fi

exec ./node_modules/.bin/nodemon "$@"
