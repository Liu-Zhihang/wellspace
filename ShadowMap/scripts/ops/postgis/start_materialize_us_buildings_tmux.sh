#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/start_materialize_us_buildings_tmux.sh

Options:
  --session NAME      tmux session name, defaults to gba-us-derive
  --tag NAME          Run tag, defaults to us_lod1_materialize
  --run-root PATH     Parent directory for run artifacts
  --workers N|auto    Parallel shard workers, defaults to auto
  --na-run-dir PATH   Completed North America import run directory
  --source-table NAME Source table, defaults to public.buildings_na_lod1
  --target-table NAME Target table, defaults to public.buildings_us_lod1
EOF
}

session_name="${SHADOWMAP_US_BUILDINGS_TMUX_SESSION:-gba-us-derive}"
tag="us_lod1_materialize"
run_root="outputs/postgis_derivations"
workers="auto"
na_run_dir="${SHADOWMAP_NA_IMPORT_RUN_DIR:-}"
source_table="${SHADOWMAP_US_SOURCE_TABLE:-public.buildings_na_lod1}"
target_table="${SHADOWMAP_US_TARGET_TABLE:-public.buildings_us_lod1}"

while [ $# -gt 0 ]; do
  case "$1" in
    --session)
      session_name="${2:-}"
      shift 2
      ;;
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --run-root)
      run_root="${2:-}"
      shift 2
      ;;
    --workers)
      workers="${2:-}"
      shift 2
      ;;
    --na-run-dir)
      na_run_dir="${2:-}"
      shift 2
      ;;
    --source-table)
      source_table="${2:-}"
      shift 2
      ;;
    --target-table)
      target_table="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[Fatal] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "[Fatal] tmux is not installed on this host." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="${run_root%/}/${tag}_${timestamp}"

if tmux has-session -t "${session_name}" 2>/dev/null; then
  echo "[Fatal] tmux session already exists: ${session_name}" >&2
  exit 1
fi

mkdir -p "${run_dir}"

cmd=(./scripts/ops/postgis/run_materialize_us_buildings.sh
  --tag "${tag}"
  --run-dir "${run_dir}"
  --workers "${workers}"
  --source-table "${source_table}"
  --target-table "${target_table}")

if [ -n "${na_run_dir}" ]; then
  cmd+=(--na-run-dir "${na_run_dir}")
fi

printf -v tmux_cmd '%q ' "${cmd[@]}"
tmux new-session -d -s "${session_name}" "cd \"${repo_root}\" && ${tmux_cmd}"

echo "Session: ${session_name}"
echo "Run dir: ${run_dir}"
echo "Log file: ${run_dir}/run.log"
