#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

backend_session="${SHADOWMAP_BACKEND_TMUX_SESSION:-shadow-v2-backend}"
frontend_session="${SHADOWMAP_FRONTEND_TMUX_SESSION:-shadow-v2-frontend}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "[Fatal] tmux is not installed on this host." >&2
  exit 1
fi

tmux has-session -t "${backend_session}" 2>/dev/null && tmux kill-session -t "${backend_session}"
tmux has-session -t "${frontend_session}" 2>/dev/null && tmux kill-session -t "${frontend_session}"

tmux new-session -d -s "${backend_session}" "cd \"${repo_root}\" && ./scripts/dev/run_backend_dev.sh"
tmux new-session -d -s "${frontend_session}" "cd \"${repo_root}\" && ./scripts/dev/run_frontend_dev.sh"

echo "Backend session: ${backend_session}"
echo "Frontend session: ${frontend_session}"
