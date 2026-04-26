#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/run_mobility_shadow_sharded.sh [options]

Options:
  --engine node|python   Engine mode, defaults to node
  --preset NAME          national-sparse|urban-dense convenience preset
  --input-root PATH      Input root containing CSVs
  --output-root PATH     Output root for *-sunlight.csv
  --targets-file PATH    Manifest of CSV paths relative to input-root
  --run-root PATH        Parent directory for run artifacts
  --run-dir PATH         Explicit run directory
  --tag NAME             Run tag, defaults to mobility_shadow_sharded
  --shards N             Number of shard processes, defaults to 4
  --shard-strategy NAME  round-robin|spatial target assignment, defaults to round-robin
  --spatial-shard-bin-deg N  Degree bin size for spatial target sharding, defaults to 2.0
  --concurrency N        Per-process bucket concurrency, defaults to 8
  --timeout-seconds N    Optional timeout per shard process (0 disables)
  --backend URL          Backend analysis URL for node engine
  --weather URL          Weather URL for node engine
  --canopy PATH          Canopy raster path
  --include-canopy BOOL  true|false, defaults to false
  --canopy-auto-prepare BOOL   Auto-build shard-local canopy VRTs from the Meta/WRI tile index
  --canopy-prefetch-mode NAME  off|union canopy cache preparation strategy
  --canopy-source NAME   Canopy download source: global|california
  --canopy-cache-dir PATH      Persistent raw canopy tile cache directory
  --canopy-tiles-index PATH    Optional local tiles.geojson override for manifest generation
  --canopy-download-jobs N     Parallel canopy download workers per shard
  --canopy-bbox-margin-m N     Extra bbox margin for canopy manifest selection
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

# shellcheck disable=SC1091
source "${repo_root}/scripts/lib/load_shadowmap_env.sh"
shadowmap_load_env "${repo_root}"

engine="${ENGINE:-node}"
preset="${MOBILITY_RUNNER_PRESET:-}"
python_bin="${SHADOWMAP_PYTHON_BIN:-${PYTHON_BIN:-python3}}"
input_root=""
output_root=""
targets_file=""
run_root="outputs/mobility_runs"
run_dir=""
tag="mobility_shadow_sharded"
shards="4"
shard_strategy="${MOBILITY_SHARD_STRATEGY:-round-robin}"
spatial_shard_bin_deg="${MOBILITY_SPATIAL_SHARD_BIN_DEG:-2.0}"
concurrency="8"
timeout_seconds="0"
backend_url="${BACKEND_URL:-http://127.0.0.1:3001/api/analysis/shadow}"
weather_url="${WEATHER_URL:-http://127.0.0.1:3001/api/weather/current}"
canopy_path="${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}"
include_canopy="${MOBILITY_INCLUDE_CANOPY:-false}"
canopy_auto_prepare="${MOBILITY_CANOPY_AUTO_PREP:-false}"
canopy_prefetch_mode="${MOBILITY_CANOPY_PREFETCH_MODE:-off}"
canopy_source="${MOBILITY_CANOPY_SOURCE:-global}"
canopy_cache_dir="${MOBILITY_CANOPY_CACHE_DIR:-${SHADOWMAP_DATA_ROOT:-${HOME}/datasets/wellspace_v2/shadowmap}/infra/canopy/meta_wri_chm/raw_tiles/global}"
canopy_tiles_index="${MOBILITY_CANOPY_TILES_INDEX:-}"
canopy_download_jobs="${MOBILITY_CANOPY_DOWNLOAD_JOBS:-8}"
canopy_bbox_margin_m="${MOBILITY_CANOPY_BBOX_MARGIN_M:-}"
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
default_canopy_tiles_index="${SHADOWMAP_DATA_ROOT:-${HOME}/datasets/wellspace_v2/shadowmap}/infra/canopy/meta_wri_chm/index/tiles.geojson"

apply_preset() {
  local value="${1:-}"
  case "${value}" in
    national-sparse)
      grouping_mode="run-cell-minute"
      cell_size_m="12000"
      cell_context_m="800"
      shadow_cache_cell_size_m="0"
      shadow_cache_max_entries="0"
      shard_strategy="spatial"
      canopy_prefetch_mode="union"
      ;;
    urban-dense)
      grouping_mode="run-cell-minute"
      cell_size_m="500"
      cell_context_m="800"
      shadow_cache_cell_size_m="0"
      shadow_cache_max_entries="0"
      ;;
    "")
      ;;
    *)
      echo "[Fatal] Unknown preset: ${value} (expected national-sparse|urban-dense)" >&2
      exit 2
      ;;
  esac
}

for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  case "${arg}" in
    --preset)
      next_index=$((i + 1))
      if [ "${next_index}" -le "$#" ]; then
        preset="${!next_index}"
      fi
      ;;
    --preset=*)
      preset="${arg#*=}"
      ;;
  esac
done

apply_preset "${preset}"

while [ $# -gt 0 ]; do
  case "$1" in
    --engine) engine="${2:-}"; shift 2 ;;
    --preset) preset="${2:-}"; shift 2 ;;
    --preset=*) preset="${1#*=}"; shift ;;
    --input-root) input_root="${2:-}"; shift 2 ;;
    --output-root) output_root="${2:-}"; shift 2 ;;
    --targets-file) targets_file="${2:-}"; shift 2 ;;
    --run-root) run_root="${2:-}"; shift 2 ;;
    --run-dir) run_dir="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --shards) shards="${2:-}"; shift 2 ;;
    --shard-strategy) shard_strategy="${2:-}"; shift 2 ;;
    --spatial-shard-bin-deg) spatial_shard_bin_deg="${2:-}"; shift 2 ;;
    --concurrency) concurrency="${2:-}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:-}"; shift 2 ;;
    --backend) backend_url="${2:-}"; shift 2 ;;
    --weather) weather_url="${2:-}"; shift 2 ;;
    --canopy) canopy_path="${2:-}"; shift 2 ;;
    --include-canopy) include_canopy="${2:-}"; shift 2 ;;
    --canopy-auto-prepare) canopy_auto_prepare="${2:-}"; shift 2 ;;
    --canopy-prefetch-mode) canopy_prefetch_mode="${2:-}"; shift 2 ;;
    --canopy-source) canopy_source="${2:-}"; shift 2 ;;
    --canopy-cache-dir) canopy_cache_dir="${2:-}"; shift 2 ;;
    --canopy-tiles-index) canopy_tiles_index="${2:-}"; shift 2 ;;
    --canopy-download-jobs) canopy_download_jobs="${2:-}"; shift 2 ;;
    --canopy-bbox-margin-m) canopy_bbox_margin_m="${2:-}"; shift 2 ;;
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
case "${shard_strategy}" in
  round-robin|spatial)
    ;;
  *)
    echo "[Fatal] --shard-strategy must be round-robin or spatial." >&2
    exit 1
    ;;
esac
case "${canopy_prefetch_mode}" in
  off|union)
    ;;
  *)
    echo "[Fatal] --canopy-prefetch-mode must be off or union." >&2
    exit 1
    ;;
esac
if ! python3 - "${spatial_shard_bin_deg}" <<'PY' >/dev/null 2>&1
import sys
value = float(sys.argv[1])
raise SystemExit(0 if value > 0 else 1)
PY
then
  echo "[Fatal] --spatial-shard-bin-deg must be a positive number." >&2
  exit 1
fi

if [ "${engine}" = "node" ]; then
  shadowmap_activate_node "${repo_root}"
  shadowmap_require_node 18
fi

input_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${input_root}")"
output_root="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${output_root}")"
targets_file="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${targets_file}")"
canopy_cache_dir="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "${canopy_cache_dir}")"
if [ -n "${canopy_tiles_index}" ]; then
  canopy_tiles_index="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "${canopy_tiles_index}")"
fi
if [ -z "${canopy_bbox_margin_m}" ]; then
  canopy_bbox_margin_m="${cell_context_m}"
fi
if [ -z "${canopy_tiles_index}" ] && [ -f "${default_canopy_tiles_index}" ]; then
  canopy_tiles_index="${default_canopy_tiles_index}"
fi

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
if [ "${engine}" = "python" ] && [ "${buildings_source}" = "postgis" ] && [ "${buildings_mode}" = "preload" ]; then
  buildings_mode="bbox"
fi
if ! [[ "${canopy_download_jobs}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[Fatal] --canopy-download-jobs must be a positive integer." >&2
  exit 1
fi

if [ -z "${run_dir}" ]; then
  run_dir="${run_root%/}/${tag}_${timestamp}"
fi

mkdir -p "${run_dir}/logs" "${run_dir}/shards" "${run_dir}/canopy" "${output_root}"

run_log="${run_dir}/run.log"
summary_path="${run_dir}/run_summary.json"
summary_lock="${run_dir}/run_summary.lock"
summary_monitor_flag="${run_dir}/.run_summary.monitor"
command_path="${run_dir}/command.sh"
targets_copy="${run_dir}/targets.txt"

cp "${targets_file}" "${targets_copy}"

cat > "${command_path}" <<EOF
cd "${repo_root}"
./scripts/ops/run_mobility_shadow_sharded.sh \\
  --engine "${engine}" \\
  --preset "${preset}" \\
  --input-root "${input_root}" \\
  --output-root "${output_root}" \\
  --targets-file "${targets_file}" \\
  --run-dir "${run_dir}" \\
  --shards "${shards}" \\
  --shard-strategy "${shard_strategy}" \\
  --spatial-shard-bin-deg "${spatial_shard_bin_deg}" \\
  --concurrency "${concurrency}" \\
  --timeout-seconds "${timeout_seconds}" \\
  --canopy "${canopy_path}" \\
  --include-canopy "${include_canopy}" \\
  --canopy-auto-prepare "${canopy_auto_prepare}" \\
  --canopy-prefetch-mode "${canopy_prefetch_mode}" \\
  --canopy-source "${canopy_source}" \\
  --canopy-cache-dir "${canopy_cache_dir}" \\
  --canopy-download-jobs "${canopy_download_jobs}" \\
  --canopy-bbox-margin-m "${canopy_bbox_margin_m}" \\
  --buildings-source "${buildings_source}" \\
  --grouping-mode "${grouping_mode}" \\
  --cell-size-m "${cell_size_m}" \\
  --cell-context-m "${cell_context_m}" \\
  --shadow-cache-cell-size-m "${shadow_cache_cell_size_m}" \\
  --shadow-cache-max-entries "${shadow_cache_max_entries}" \\
EOF
if [ -n "${canopy_tiles_index}" ]; then
  cat >> "${command_path}" <<EOF
  --canopy-tiles-index "${canopy_tiles_index}" \\
EOF
fi
cat >> "${command_path}" <<EOF
  --era5-template "${era5_template}"
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

"${python_bin}" "${repo_root}/scripts/ops/assign_targets_to_shards.py" \
  --input-root "${input_root}" \
  --targets-file "${targets_copy}" \
  --output-dir "${run_dir}/shards" \
  --shards "${shards}" \
  --strategy "${shard_strategy}" \
  --spatial-shard-bin-deg "${spatial_shard_bin_deg}" \
  --output-summary "${run_dir}/shards/assignment_summary.json" >> "${run_log}" 2>&1

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

write_summary() {
  local status="$1"
  local ended_at="$2"
  local completed_shards failed_shards output_count
  local tmp_summary
  completed_shards="$(grep -cE '^\[Shard [0-9][0-9]\] completed ' "${run_log}" 2>/dev/null || true)"
  failed_shards="$(grep -cE '^\[Shard [0-9][0-9]\] failed ' "${run_log}" 2>/dev/null || true)"
  output_count="$(find "${output_root}" -type f -name '*-sunlight.csv' | wc -l | tr -d ' ')"
  completed_shards="${completed_shards:-0}"
  failed_shards="${failed_shards:-0}"
  tmp_summary="${summary_path}.tmp.$$"

  if command -v flock >/dev/null 2>&1; then
    exec 8>"${summary_lock}"
    flock 8
  fi

  cat > "${tmp_summary}" <<EOF
{
  "tag": "${tag}",
  "status": "${status}",
  "started_at_utc": "${timestamp}",
  "ended_at_utc": "${ended_at}",
  "engine": "${engine}",
  "preset": "${preset}",
  "input_root": "${input_root}",
  "output_root": "${output_root}",
  "targets_file": "${targets_copy}",
  "target_count": ${target_count},
  "shards": ${shards},
  "shard_strategy": "${shard_strategy}",
  "spatial_shard_bin_deg": ${spatial_shard_bin_deg},
  "per_process_concurrency": ${concurrency},
  "timeout_seconds": ${timeout_seconds},
  "include_canopy": $(is_truthy "${include_canopy}" && printf 'true' || printf 'false'),
  "canopy_path": "${canopy_path}",
  "canopy_auto_prepare": $(is_truthy "${canopy_auto_prepare}" && printf 'true' || printf 'false'),
  "canopy_prefetch_mode": "${canopy_prefetch_mode}",
  "canopy_source": "${canopy_source}",
  "canopy_cache_dir": "${canopy_cache_dir}",
  "canopy_download_jobs": ${canopy_download_jobs},
  "canopy_bbox_margin_m": ${canopy_bbox_margin_m},
  "completed_shards": ${completed_shards},
  "failed_shards": ${failed_shards},
  "output_count": ${output_count},
  "run_log": "${run_log}"
}
EOF
  mv -f "${tmp_summary}" "${summary_path}"

  if command -v flock >/dev/null 2>&1; then
    flock -u 8 || true
    exec 8>&-
  fi
}

refresh_running_summary() {
  write_summary "running" ""
}

start_summary_monitor() {
  : > "${summary_monitor_flag}"
  (
    while [ -f "${summary_monitor_flag}" ]; do
      refresh_running_summary
      sleep 15
    done
  ) >/dev/null 2>&1 &
  summary_monitor_pid=$!
  disown "${summary_monitor_pid}" || true
}

stop_summary_monitor() {
  rm -f "${summary_monitor_flag}"
  if [ -n "${summary_monitor_pid:-}" ]; then
    kill "${summary_monitor_pid}" >/dev/null 2>&1 || true
  fi
}

trap stop_summary_monitor EXIT

refresh_running_summary
start_summary_monitor

prepared_canopy_path=""
prepared_include_canopy="${include_canopy}"

canopy_shard_dir() {
  local shard_idx="$1"
  printf '%s/canopy/shard_%02d' "${run_dir}" "${shard_idx}"
}

canopy_manifest_path() {
  local shard_idx="$1"
  printf '%s/tiles.txt' "$(canopy_shard_dir "${shard_idx}")"
}

ensure_canopy_manifest_for_shard() {
  local shard_idx="$1"
  local shard_targets="$2"
  local shard_log="$3"
  local shard_canopy_dir bbox_summary manifest_path manifest_summary manifest_geojson
  local bbox_value valid_points tile_count

  shard_canopy_dir="$(canopy_shard_dir "${shard_idx}")"
  bbox_summary="${shard_canopy_dir}/bbox_summary.json"
  manifest_path="${shard_canopy_dir}/tiles.txt"
  manifest_summary="${shard_canopy_dir}/tiles.summary.json"
  manifest_geojson="${shard_canopy_dir}/tiles.geojson"

  mkdir -p "${shard_canopy_dir}" "${canopy_cache_dir}"

  if [ -s "${manifest_path}" ] && [ -f "${bbox_summary}" ]; then
    return 0
  fi

  echo "[Shard $(printf '%02d' "${shard_idx}")] canopy prep start" | tee -a "${run_log}" >> "${shard_log}"

  "${python_bin}" "${repo_root}/scripts/ops/canopy/compute_targets_bbox.py" \
    --input-root "${input_root}" \
    --targets-file "${shard_targets}" \
    --expand-meters "${canopy_bbox_margin_m}" \
    --output-summary "${bbox_summary}" >> "${shard_log}" 2>&1 || return 1

  valid_points="$("${python_bin}" - "${bbox_summary}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(int(payload.get("valid_points") or 0))
PY
)"
  if [ "${valid_points}" -le 0 ]; then
    rm -f "${manifest_path}"
    echo "[Shard $(printf '%02d' "${shard_idx}")] canopy skipped reason=no_valid_points" | tee -a "${run_log}" >> "${shard_log}"
    return 0
  fi

  bbox_value="$("${python_bin}" - "${bbox_summary}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
bbox = payload.get("bbox_expanded") or {}
print(f"{bbox.get('west')},{bbox.get('south')},{bbox.get('east')},{bbox.get('north')}")
PY
)"

  local manifest_cmd=( "${python_bin}" "${repo_root}/scripts/ops/canopy/generate_meta_wri_manifest.py" )
  manifest_cmd+=("--bbox=${bbox_value}")
  manifest_cmd+=(--output-manifest "${manifest_path}")
  manifest_cmd+=(--output-summary "${manifest_summary}")
  manifest_cmd+=(--output-tiles-geojson "${manifest_geojson}")
  if [ -n "${canopy_tiles_index}" ]; then
    manifest_cmd+=(--tiles-index "${canopy_tiles_index}")
  fi
  "${manifest_cmd[@]}" >> "${shard_log}" 2>&1 || return 1

  tile_count="$(grep -c . "${manifest_path}" || true)"
  tile_count="${tile_count:-0}"
  if [ "${tile_count}" -le 0 ]; then
    rm -f "${manifest_path}"
    echo "[Shard $(printf '%02d' "${shard_idx}")] canopy skipped reason=no_tiles" | tee -a "${run_log}" >> "${shard_log}"
  fi
}

prefetch_canopy_cache_union() {
  local union_manifest prefetch_log total_tiles

  union_manifest="${run_dir}/canopy/union_tiles.txt"
  prefetch_log="${run_dir}/canopy/prefetch.log"
  mkdir -p "${run_dir}/canopy"

  : > "${union_manifest}"
  for ((i=0; i<shards; i++)); do
    local shard_targets shard_log manifest_path
    shard_targets="$(printf '%s/shards/targets_%02d.txt' "${run_dir}" "${i}")"
    shard_log="$(printf '%s/logs/shard_%02d.log' "${run_dir}" "${i}")"
    if [ ! -s "${shard_targets}" ]; then
      continue
    fi
    ensure_canopy_manifest_for_shard "${i}" "${shard_targets}" "${shard_log}" || return 1
    manifest_path="$(canopy_manifest_path "${i}")"
    if [ -s "${manifest_path}" ]; then
      cat "${manifest_path}" >> "${union_manifest}"
    fi
  done

  awk 'NF' "${union_manifest}" | sort -u > "${union_manifest}.tmp"
  mv -f "${union_manifest}.tmp" "${union_manifest}"
  total_tiles="$(grep -c . "${union_manifest}" || true)"
  total_tiles="${total_tiles:-0}"
  echo "[Meta] canopy union manifest tiles=${total_tiles} path=${union_manifest}" | tee -a "${run_log}"
  if [ "${total_tiles}" -le 0 ]; then
    return 0
  fi

  "${repo_root}/scripts/ops/canopy/download_meta_wri_canopy.sh" \
    --source "${canopy_source}" \
    --manifest "${union_manifest}" \
    --output-dir "${canopy_cache_dir}" \
    --jobs "${canopy_download_jobs}" >> "${prefetch_log}" 2>&1 || return 1
  echo "[Meta] canopy union prefetch completed tiles=${total_tiles}" | tee -a "${run_log}"
}

prepare_canopy_for_shard() {
  local shard_idx="$1"
  local shard_targets="$2"
  local shard_log="$3"
  local shard_name shard_canopy_dir manifest_path
  local shard_tiles_dir canopy_vrt tile_count lock_file

  prepared_canopy_path="${canopy_path:-}"
  prepared_include_canopy="${include_canopy}"

  if ! is_truthy "${include_canopy}"; then
    return 0
  fi
  if [ "${engine}" != "python" ]; then
    return 0
  fi
  if ! is_truthy "${canopy_auto_prepare}"; then
    if [ -z "${prepared_canopy_path}" ]; then
      echo "[Shard $(printf '%02d' "${shard_idx}")] canopy enabled but no raster path configured" | tee -a "${run_log}" >> "${shard_log}"
    fi
    return 0
  fi

  shard_name="$(printf 'shard_%02d' "${shard_idx}")"
  shard_canopy_dir="${run_dir}/canopy/${shard_name}"
  manifest_path="${shard_canopy_dir}/tiles.txt"
  shard_tiles_dir="${shard_canopy_dir}/tiles"
  canopy_vrt="${shard_canopy_dir}/canopy_height.vrt"

  mkdir -p "${shard_canopy_dir}" "${canopy_cache_dir}"
  ensure_canopy_manifest_for_shard "${shard_idx}" "${shard_targets}" "${shard_log}" || return 1

  tile_count="$(grep -c . "${manifest_path}" || true)"
  tile_count="${tile_count:-0}"
  if [ "${tile_count}" -le 0 ]; then
    prepared_canopy_path=""
    prepared_include_canopy="false"
    echo "[Shard $(printf '%02d' "${shard_idx}")] canopy skipped reason=no_tiles" | tee -a "${run_log}" >> "${shard_log}"
    return 0
  fi

  if [ "${canopy_prefetch_mode}" = "off" ]; then
    lock_file="${canopy_cache_dir}/.download.lock"
    if command -v flock >/dev/null 2>&1; then
      exec 9>"${lock_file}"
      flock 9
    fi
    "${repo_root}/scripts/ops/canopy/download_meta_wri_canopy.sh" \
      --source "${canopy_source}" \
      --manifest "${manifest_path}" \
      --output-dir "${canopy_cache_dir}" \
      --jobs "${canopy_download_jobs}" >> "${shard_log}" 2>&1 || return 1
    if command -v flock >/dev/null 2>&1; then
      flock -u 9 || true
      exec 9>&-
    fi
  fi

  rm -rf "${shard_tiles_dir}"
  mkdir -p "${shard_tiles_dir}"
  while IFS= read -r manifest_line || [ -n "${manifest_line}" ]; do
    local file_name source_path
    manifest_line="${manifest_line%%#*}"
    manifest_line="$(printf '%s' "${manifest_line}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -z "${manifest_line}" ]; then
      continue
    fi
    file_name="$(basename "${manifest_line%%\?*}")"
    source_path="${canopy_cache_dir}/${file_name}"
    if [ ! -f "${source_path}" ]; then
      echo "[Fatal] Missing canopy tile after download: ${source_path}" >> "${shard_log}"
      return 1
    fi
    ln -sfn "${source_path}" "${shard_tiles_dir}/${file_name}"
  done < "${manifest_path}"

  "${repo_root}/scripts/ops/canopy/build_canopy_vrt.sh" \
    --input-dir "${shard_tiles_dir}" \
    --output "${canopy_vrt}" >> "${shard_log}" 2>&1 || return 1

  prepared_canopy_path="${canopy_vrt}"
  prepared_include_canopy="true"
  echo "[Shard $(printf '%02d' "${shard_idx}")] canopy prepared tiles=${tile_count} vrt=${canopy_vrt}" | tee -a "${run_log}" >> "${shard_log}"
}

if is_truthy "${include_canopy}" \
  && [ "${engine}" = "python" ] \
  && is_truthy "${canopy_auto_prepare}" \
  && [ "${canopy_prefetch_mode}" = "union" ]; then
  prefetch_canopy_cache_union || {
    write_summary "failed" ""
    exit 1
  }
fi

run_shard() {
  local shard_idx="$1"
  local shard_targets shard_log shard_canopy_path shard_include_canopy
  shard_targets="$(printf '%s/shards/targets_%02d.txt' "${run_dir}" "${shard_idx}")"
  shard_log="$(printf '%s/logs/shard_%02d.log' "${run_dir}" "${shard_idx}")"
  if [ ! -s "${shard_targets}" ]; then
    echo "[Shard $(printf '%02d' "${shard_idx}")] completed targets=0" | tee -a "${run_log}"
    refresh_running_summary
    return 0
  fi

  local cmd=( bash "${repo_root}/scripts/batch-mobility-shadow.sh" --engine "${engine}" )
  prepare_canopy_for_shard "${shard_idx}" "${shard_targets}" "${shard_log}" || return 1
  shard_canopy_path="${prepared_canopy_path:-}"
  shard_include_canopy="${prepared_include_canopy:-${include_canopy}}"
  cmd+=(--input "${input_root}" --output "${output_root}")
  cmd+=(--concurrency "${concurrency}")
  cmd+=(--targets-file "${shard_targets}")
  if [ "${engine}" = "node" ]; then
    cmd+=(--backend "${backend_url}" --weather "${weather_url}")
    if [ -n "${shard_canopy_path}" ]; then
      cmd+=(--canopy "${shard_canopy_path}")
    fi
    cmd+=(--include-canopy "${shard_include_canopy}")
  else
    cmd+=(--buildings-source "${buildings_source}")
    cmd+=(--buildings-mode "${buildings_mode}")
    if [ "${buildings_source}" = "file" ]; then
      cmd+=(--buildings "${buildings_path}")
      if [ -n "${buildings_layer}" ]; then
        cmd+=(--buildings-layer "${buildings_layer}")
      fi
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
    if [ -n "${shard_canopy_path}" ]; then
      cmd+=(--canopy "${shard_canopy_path}")
    fi
    if [ -n "${shard_include_canopy}" ]; then
      cmd+=(--include-canopy "${shard_include_canopy}")
    fi
    if [ -n "${era5_template}" ]; then
      cmd+=(--era5-template "${era5_template}")
    fi
  fi

  echo "[Shard $(printf '%02d' "${shard_idx}")] start targets=$(grep -c . "${shard_targets}")" | tee -a "${run_log}"
  if [ "${timeout_seconds}" != "0" ]; then
    if timeout "${timeout_seconds}s" "${cmd[@]}" >> "${shard_log}" 2>&1; then
      :
    else
      return 1
    fi
  else
    if "${cmd[@]}" >> "${shard_log}" 2>&1; then
      :
    else
      return 1
    fi
  fi
  echo "[Shard $(printf '%02d' "${shard_idx}")] completed targets=$(grep -c . "${shard_targets}")" | tee -a "${run_log}"
  refresh_running_summary
}

status=0
for ((i=0; i<shards; i++)); do
  (
    if run_shard "${i}"; then
      exit 0
    fi
    echo "[Shard $(printf '%02d' "${i}")] failed" | tee -a "${run_log}"
    refresh_running_summary
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
  stop_summary_monitor
  write_summary "failed" ""
  exit 1
fi

ended_at="$(date -u +%Y%m%dT%H%M%SZ)"
stop_summary_monitor
write_summary "completed" "${ended_at}"
echo "[Meta] Completed sharded mobility shadow run" | tee -a "${run_log}"
