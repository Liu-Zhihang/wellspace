#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/start_gba_lod1_import_tmux.sh \
    --dir /path/to/northamerica \
    --table public.buildings_na_lod1

Options:
  --dir PATH          Directory containing *.geojson tiles
  --table NAME        Target table (schema.table)
  --session NAME      tmux session name, defaults to gba-na-import
  --tag NAME          Run tag, defaults to gba_lod1_import
  --run-root PATH     Parent directory for run artifacts
  --match GLOB        Optional filename glob, defaults to *.geojson
  --skip-existing     Skip tiles already present in the target table
  --replace-tile      Replace existing rows for each tile before inserting
EOF
}

dir_path=""
target_table=""
session_name="${SHADOWMAP_GBA_IMPORT_TMUX_SESSION:-gba-na-import}"
tag="gba_lod1_import"
run_root="outputs/postgis_imports"
match_glob="*.geojson"
skip_existing="false"
replace_tile="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      dir_path="${2:-}"
      shift 2
      ;;
    --table)
      target_table="${2:-}"
      shift 2
      ;;
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
    --match)
      match_glob="${2:-}"
      shift 2
      ;;
    --skip-existing)
      skip_existing="true"
      shift
      ;;
    --replace-tile)
      replace_tile="true"
      shift
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

if [ -z "${dir_path}" ] || [ -z "${target_table}" ]; then
  usage >&2
  exit 2
fi

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

cmd=(./scripts/ops/postgis/run_gba_lod1_import.sh
  --dir "${dir_path}"
  --table "${target_table}"
  --tag "${tag}"
  --run-dir "${run_dir}"
  --match "${match_glob}")

if [ "${skip_existing}" = "true" ]; then
  cmd+=(--skip-existing)
fi
if [ "${replace_tile}" = "true" ]; then
  cmd+=(--replace-tile)
fi

printf -v tmux_cmd '%q ' "${cmd[@]}"
tmux new-session -d -s "${session_name}" "cd \"${repo_root}\" && ${tmux_cmd}"

echo "Session: ${session_name}"
echo "Run dir: ${run_dir}"
echo "Log file: ${run_dir}/run.log"
