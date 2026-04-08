#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/run_mobility_shadow_sharded.sh [options]

Options:
  --engine node|python   Engine mode, defaults to node
  --input-root PATH      Input root containing CSVs
  --output-root PATH     Output root for *-sunlight.csv
  --targets-file PATH    Manifest of CSV paths relative to input-root
  --run-root PATH        Parent directory for run artifacts
  --run-dir PATH         Explicit run directory
  --tag NAME             Run tag, defaults to mobility_shadow_sharded
  --shards N             Number of shard processes, defaults to 4
  --concurrency N        Per-process bucket concurrency, defaults to 8
  --timeout-seconds N    Optional timeout per shard process (0 disables)
  --backend URL          Backend analysis URL for node engine
  --weather URL          Weather URL for node engine
  --canopy PATH          Canopy raster path
  --include-canopy BOOL  true|false, defaults to false
  --buildings-source MODE file|postgis for python engine
  --buildings PATH       Local buildings file for python engine (file source only)
  --buildings-layer NAME Optional GPKG layer for python engine
  --buildings-mode MODE  bbox|preload, defaults to preload (file source only)
  --postgis-dsn VALUE    Optional PostGIS DSN for python engine
  --postgis-host HOST    PostGIS host for python engine
  --postgis-port PORT    PostGIS port for python engine
  --postgis-database DB  PostGIS database for python engine
  --postgis-user USER    PostGIS user for python engine
  --postgis-table NAME   PostGIS source table for python engine
  --postgis-geom-column NAME   Geometry column in the PostGIS source table
  --postgis-height-column NAME Preferred height column in the PostGIS source table
  --postgis-where SQL    Optional trusted SQL predicate appended to PostGIS WHERE
  --grouping-mode MODE   file-minute|run-cell-minute for python engine
  --cell-size-m N        Spatial cell size in meters for run-cell-minute
  --cell-context-m N     Extra context margin in meters for run-cell-minute
  --shadow-cache-cell-size-m N   Larger cache cell for reusing one shadow result across nearby jobs
  --shadow-cache-max-entries N   Per-worker LRU cache size for shadow results (0 disables)
  --era5-template PATH   ERA5 template for python engine
EOF
}

engine="node"
input_root=""
output_root=""
targets_file=""
run_root="outputs/mobility_runs"
run_dir=""
tag="mobility_shadow_sharded"
shards="4"
concurrency="8"
timeout_seconds="0"
backend_url="${BACKEND_URL:-http://127.0.0.1:3001/api/analysis/shadow}"
weather_url="${WEATHER_URL:-http://127.0.0.1:3001/api/weather/current}"
canopy_path="${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}"
include_canopy="${MOBILITY_INCLUDE_CANOPY:-false}"
buildings_source="${MOBILITY_BUILDINGS_SOURCE:-file}"
buildings_path="${BUILDING_LOCAL_GEOJSON:-}"
buildings_layer="${BUILDING_GPKG_LAYER:-}"
buildings_mode="${MOBILITY_BUILDINGS_MODE:-preload}"
postgis_dsn="${MOBILITY_POSTGIS_DSN:-${POSTGIS_DSN:-}}"
postgis_host="${MOBILITY_POSTGIS_HOST:-${POSTGIS_HOST:-${PGHOST:-}}}"
postgis_port="${MOBILITY_POSTGIS_PORT:-${POSTGIS_PORT:-5432}}"
postgis_database="${MOBILITY_POSTGIS_DATABASE:-${POSTGIS_DATABASE:-${PGDATABASE:-}}}"
postgis_user="${MOBILITY_POSTGIS_USER:-${POSTGIS_USER:-${PGUSER:-}}}"
postgis_table="${MOBILITY_POSTGIS_TABLE:-${POSTGIS_TABLE:-}}"
postgis_geom_column="${MOBILITY_POSTGIS_GEOM_COLUMN:-${POSTGIS_GEOM_COLUMN:-geom}}"
postgis_height_column="${MOBILITY_POSTGIS_HEIGHT_COLUMN:-${POSTGIS_HEIGHT_COLUMN:-}}"
postgis_where="${MOBILITY_POSTGIS_WHERE:-${POSTGIS_WHERE:-}}"
grouping_mode="${MOBILITY_GROUPING_MODE:-file-minute}"
cell_size_m="${MOBILITY_CELL_SIZE_M:-250}"
cell_context_m="${MOBILITY_CELL_CONTEXT_M:-1500}"
shadow_cache_cell_size_m="${MOBILITY_SHADOW_CACHE_CELL_SIZE_M:-0}"
shadow_cache_max_entries="${MOBILITY_SHADOW_CACHE_MAX_ENTRIES:-128}"
era5_template="${ERA5_FILE_TEMPLATE:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --engine) engine="${2:-}"; shift 2 ;;
    --input-root) input_root="${2:-}"; shift 2 ;;
    --output-root) output_root="${2:-}"; shift 2 ;;
    --targets-file) targets_file="${2:-}"; shift 2 ;;
    --run-root) run_root="${2:-}"; shift 2 ;;
    --run-dir) run_dir="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --shards) shards="${2:-}"; shift 2 ;;
    --concurrency) concurrency="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    --backend) backend_url="${2:-}"; shift 2 ;;
    --weather) weather_url="${2:-}"; shift 2 ;;
    --canopy) canopy_path="${2:-}"; shift 2 ;;
    --include-canopy) include_canopy="${2:-}"; shift 2 ;;
    --buildings-source) buildings_source="${2:-}"; shift 2 ;;
    --buildings) buildings_path="${2:-}"; shift 2 ;;
    --buildings-layer) buildings_layer="${2:-}"; shift 2 ;;
    --buildings-mode) buildings_mode="${2:-}"; shift 2 ;;
    --postgis-dsn) postgis_dsn="${2:-}"; shift 2 ;;
    --postgis-host) postgis_host="${2:-}"; shift 2 ;;
    --postgis-port) postgis_port="${2:-}"; shift 2 ;;
    --postgis-database) postgis_database="${2:-}"; shift 2 ;;
    --postgis-user) postgis_user="${2:-}"; shift 2 ;;
    --postgis-table) postgis_table="${2:-}"; shift 2 ;;
    --postgis-geom-column) postgis_geom_column="${2:-}"; shift 2 ;;
    --postgis-height-column) postgis_height_column="${2:-}"; shift 2 ;;
    --postgis-where) postgis_where="${2:-}"; shift 2 ;;
    --grouping-mode) grouping_mode="${2:-}"; shift 2 ;;
    --cell-size-m) cell_size_m="${2:-}"; shift 2 ;;
    --cell-context-m) cell_context_m="${2:-}"; shift 2 ;;
    --shadow-cache-cell-size-m) shadow_cache_cell_size_m="${2:-}"; shift 2 ;;
    --shadow-cache-max-entries) shadow_cache_max_entries="${2:-}"; shift 2 ;;
    --era5-template) era5_template="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[Fatal] Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "${input_root}" ] || [ -z "${output_root}" ] || [ -z "${targets_file}" ]; then
  echo "[Fatal] --input-root, --output-root, and --targets-file are required." >&2
  exit 1
fi

if ! [[ "${shards}" =~ ^[1-9][0-9]*$ ]] || ! [[ "${concurrency}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[Fatal] --shards and --concurrency must be positive integers." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

# shellcheck disable=SC1091
source "${repo_root}/scripts/lib/load_shadowmap_env.sh"
shadowmap_load_env "${repo_root}"
if [ "${engine}" = "node" ]; then
  shadowmap_activate_node "${repo_root}"
  shadowmap_require_node 18
fi

input_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${input_root}")"
output_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${output_root}")"
targets_file="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${targets_file}")"

if [ ! -d "${input_root}" ]; then
  echo "[Fatal] input root not found: ${input_root}" >&2
  exit 1
fi
if [ ! -f "${targets_file}" ]; then
  echo "[Fatal] targets file not found: ${targets_file}" >&2
  exit 1
fi
if [ "${engine}" = "python" ] && [ "${buildings_source}" = "file" ] && [ ! -f "${buildings_path}" ]; then
  echo "[Fatal] python engine with --buildings-source file requires --buildings pointing to an existing file." >&2
  exit 1
fi
if [ "${engine}" = "python" ] && [ "${buildings_source}" = "postgis" ] && [ -z "${postgis_table}" ]; then
  echo "[Fatal] python engine with --buildings-source postgis requires --postgis-table or \$MOBILITY_POSTGIS_TABLE." >&2
  exit 1
fi

if [ -z "${run_dir}" ]; then
  run_dir="${run_root%/}/${tag}_${timestamp}"
fi

mkdir -p "${run_dir}/logs" "${run_dir}/shards" "${output_root}"

run_log="${run_dir}/run.log"
summary_path="${run_dir}/run_summary.json"
command_path="${run_dir}/command.sh"
targets_copy="${run_dir}/targets.txt"

cp "${targets_file}" "${targets_copy}"

cat > "${command_path}" <<EOF
cd "${repo_root}"
./scripts/ops/run_mobility_shadow_sharded.sh \\
  --engine "${engine}" \\
  --input-root "${input_root}" \\
  --output-root "${output_root}" \\
  --targets-file "${targets_file}" \\
  --run-dir "${run_dir}" \\
  --shards "${shards}" \\
  --concurrency "${concurrency}" \\
  --timeout-seconds "${timeout_seconds}" \\
  --buildings-source "${buildings_source}" \\
  --grouping-mode "${grouping_mode}" \\
  --cell-size-m "${cell_size_m}" \\
  --cell-context-m "${cell_context_m}" \\
  --shadow-cache-cell-size-m "${shadow_cache_cell_size_m}" \\
  --shadow-cache-max-entries "${shadow_cache_max_entries}"
EOF
chmod +x "${command_path}"

target_count="$(grep -c . "${targets_copy}" || true)"
if [ "${target_count}" -eq 0 ]; then
  echo "[Fatal] targets file is empty: ${targets_file}" >&2
  exit 1
fi

for ((i=0; i<shards; i++)); do
  : > "$(printf '%s/shards/targets_%02d.txt' "${run_dir}" "${i}")"
done

awk -v shards="${shards}" -v outdir="${run_dir}/shards" '
NF {
  idx = count % shards;
  file = sprintf("%s/targets_%02d.txt", outdir, idx);
  print $0 >> file;
  close(file);
  count++;
}
' "${targets_copy}"

write_summary() {
  local status="$1"
  local ended_at="$2"
  local completed_shards failed_shards output_count
  completed_shards="$(grep -cE '^\[Shard [0-9][0-9]\] completed ' "${run_log}" 2>/dev/null || true)"
  failed_shards="$(grep -cE '^\[Shard [0-9][0-9]\] failed ' "${run_log}" 2>/dev/null || true)"
  output_count="$(find "${output_root}" -type f -name '*-sunlight.csv' | wc -l | tr -d ' ')"
  completed_shards="${completed_shards:-0}"
  failed_shards="${failed_shards:-0}"
  cat > "${summary_path}" <<EOF
{
  "tag": "${tag}",
  "status": "${status}",
  "started_at_utc": "${timestamp}",
  "ended_at_utc": "${ended_at}",
  "engine": "${engine}",
  "input_root": "${input_root}",
  "output_root": "${output_root}",
  "targets_file": "${targets_copy}",
  "target_count": ${target_count},
  "shards": ${shards},
  "per_process_concurrency": ${concurrency},
  "timeout_seconds": ${timeout_seconds},
  "completed_shards": ${completed_shards},
  "failed_shards": ${failed_shards},
  "output_count": ${output_count},
  "run_log": "${run_log}"
}
EOF
}

write_summary "running" ""

run_shard() {
  local shard_idx="$1"
  local shard_targets shard_log
  shard_targets="$(printf '%s/shards/targets_%02d.txt' "${run_dir}" "${shard_idx}")"
  shard_log="$(printf '%s/logs/shard_%02d.log' "${run_dir}" "${shard_idx}")"
  if [ ! -s "${shard_targets}" ]; then
    echo "[Shard $(printf '%02d' "${shard_idx}")] completed targets=0" | tee -a "${run_log}"
    return 0
  fi

  local cmd=( bash "${repo_root}/scripts/batch-mobility-shadow.sh" --engine "${engine}" )
  cmd+=(--input "${input_root}" --output "${output_root}")
  cmd+=(--concurrency "${concurrency}")
  cmd+=(--targets-file "${shard_targets}")
  if [ "${engine}" = "node" ]; then
    cmd+=(--backend "${backend_url}" --weather "${weather_url}")
    if [ -n "${canopy_path}" ]; then
      cmd+=(--canopy "${canopy_path}")
    fi
    cmd+=(--include-canopy "${include_canopy}")
  else
    cmd+=(--buildings-source "${buildings_source}")
    if [ "${buildings_source}" = "file" ]; then
      cmd+=(--buildings "${buildings_path}")
      if [ -n "${buildings_layer}" ]; then
        cmd+=(--buildings-layer "${buildings_layer}")
      fi
      cmd+=(--buildings-mode "${buildings_mode}")
    else
      if [ -n "${postgis_dsn}" ]; then
        cmd+=(--postgis-dsn "${postgis_dsn}")
      fi
      if [ -n "${postgis_host}" ]; then
        cmd+=(--postgis-host "${postgis_host}")
      fi
      if [ -n "${postgis_port}" ]; then
        cmd+=(--postgis-port "${postgis_port}")
      fi
      if [ -n "${postgis_database}" ]; then
        cmd+=(--postgis-database "${postgis_database}")
      fi
      if [ -n "${postgis_user}" ]; then
        cmd+=(--postgis-user "${postgis_user}")
      fi
      if [ -n "${postgis_table}" ]; then
        cmd+=(--postgis-table "${postgis_table}")
      fi
      if [ -n "${postgis_geom_column}" ]; then
        cmd+=(--postgis-geom-column "${postgis_geom_column}")
      fi
      if [ -n "${postgis_height_column}" ]; then
        cmd+=(--postgis-height-column "${postgis_height_column}")
      fi
      if [ -n "${postgis_where}" ]; then
        cmd+=(--postgis-where "${postgis_where}")
      fi
    fi
    cmd+=(--grouping-mode "${grouping_mode}")
    cmd+=(--cell-size-m "${cell_size_m}")
    cmd+=(--cell-context-m "${cell_context_m}")
    cmd+=(--shadow-cache-cell-size-m "${shadow_cache_cell_size_m}")
    cmd+=(--shadow-cache-max-entries "${shadow_cache_max_entries}")
    if [ -n "${canopy_path}" ]; then
      cmd+=(--canopy "${canopy_path}")
    fi
    if [ -n "${era5_template}" ]; then
      cmd+=(--era5-template "${era5_template}")
    fi
  fi

  echo "[Shard $(printf '%02d' "${shard_idx}")] start targets=$(grep -c . "${shard_targets}")" | tee -a "${run_log}"
  if [ "${timeout_seconds}" != "0" ]; then
    if timeout "${timeout_seconds}s" "${cmd[@]}" > "${shard_log}" 2>&1; then
      :
    else
      return 1
    fi
  else
    if "${cmd[@]}" > "${shard_log}" 2>&1; then
      :
    else
      return 1
    fi
  fi
  echo "[Shard $(printf '%02d' "${shard_idx}")] completed targets=$(grep -c . "${shard_targets}")" | tee -a "${run_log}"
}

status=0
for ((i=0; i<shards; i++)); do
  (
    if run_shard "${i}"; then
      exit 0
    fi
    echo "[Shard $(printf '%02d' "${i}")] failed" | tee -a "${run_log}"
    exit 1
  ) &
done

while [ "$(jobs -pr | wc -l | tr -d ' ')" -gt 0 ]; do
  if ! wait -n; then
    status=1
    jobs -pr | xargs -r kill >/dev/null 2>&1 || true
    wait || true
    break
  fi
done

if [ "${status}" -ne 0 ]; then
  write_summary "failed" ""
  exit 1
fi

ended_at="$(date -u +%Y%m%dT%H%M%SZ)"
write_summary "completed" "${ended_at}"
echo "[Meta] Completed sharded mobility shadow run" | tee -a "${run_log}"
