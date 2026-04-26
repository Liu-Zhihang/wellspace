#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run_raw_stay_task_graph_parallel.sh \
    --input-csv PATH \
    --run-root PATH \
    --python-bin PATH \
    [--indoor-manifest-csv PATH] \
    [--shard-count N] \
    [--workers N] \
    [--run-as-user USER] \
    [--cell-provider h3|square] \
    [--h3-resolution N] \
    [--cell-size-m N] \
    [--step-seconds N] \
    [--solar-elevation-threshold-deg N] \
    [--indoor-mode none|drop] \
    [--indoor-backend geoparquet|postgis] \
    [--indoor-buildings-buffer-m N] \
    [--flush-every-raw-rows N] \
    [--postgis-dsn DSN] \
    [--postgis-host HOST] \
    [--postgis-port PORT] \
    [--postgis-database DB] \
    [--postgis-user USER] \
    [--postgis-password PASS] \
    [--postgis-table TABLE] \
    [--postgis-geom-column COL]
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

input_csv=""
run_root=""
python_bin=""
indoor_manifest_csv=""
shard_count="32"
workers="32"
run_as_user=""
cell_provider="h3"
h3_resolution="5"
cell_size_m="12000"
step_seconds="60"
solar_elevation_threshold_deg="0"
indoor_mode="drop"
indoor_backend="${MOBILITY_INDOOR_BACKEND:-geoparquet}"
indoor_buildings_buffer_m="0"
flush_every_raw_rows="25000"
postgis_dsn="${MOBILITY_POSTGIS_DSN:-}"
postgis_host="${MOBILITY_POSTGIS_HOST:-${POSTGIS_HOST:-${PGHOST:-}}}"
postgis_port="${MOBILITY_POSTGIS_PORT:-${POSTGIS_PORT:-5432}}"
postgis_database="${MOBILITY_POSTGIS_DATABASE:-${POSTGIS_DATABASE:-${PGDATABASE:-}}}"
postgis_user="${MOBILITY_POSTGIS_USER:-${POSTGIS_USER:-${PGUSER:-}}}"
postgis_password="${MOBILITY_POSTGIS_PASSWORD:-${POSTGIS_PASSWORD:-${PGPASSWORD:-}}}"
postgis_table="${MOBILITY_POSTGIS_TABLE:-${POSTGIS_TABLE:-public.buildings_us_lod1}}"
postgis_geom_column="${MOBILITY_POSTGIS_GEOM_COLUMN:-${POSTGIS_GEOM_COLUMN:-geom}}"

while [ $# -gt 0 ]; do
  case "$1" in
    --input-csv) input_csv="${2:-}"; shift 2 ;;
    --run-root) run_root="${2:-}"; shift 2 ;;
    --python-bin) python_bin="${2:-}"; shift 2 ;;
    --indoor-manifest-csv) indoor_manifest_csv="${2:-}"; shift 2 ;;
    --shard-count) shard_count="${2:-}"; shift 2 ;;
    --workers) workers="${2:-}"; shift 2 ;;
    --run-as-user) run_as_user="${2:-}"; shift 2 ;;
    --cell-provider) cell_provider="${2:-}"; shift 2 ;;
    --h3-resolution) h3_resolution="${2:-}"; shift 2 ;;
    --cell-size-m) cell_size_m="${2:-}"; shift 2 ;;
    --step-seconds) step_seconds="${2:-}"; shift 2 ;;
    --solar-elevation-threshold-deg) solar_elevation_threshold_deg="${2:-}"; shift 2 ;;
    --indoor-mode) indoor_mode="${2:-}"; shift 2 ;;
    --indoor-backend) indoor_backend="${2:-}"; shift 2 ;;
    --indoor-buildings-buffer-m) indoor_buildings_buffer_m="${2:-}"; shift 2 ;;
    --flush-every-raw-rows) flush_every_raw_rows="${2:-}"; shift 2 ;;
    --postgis-dsn) postgis_dsn="${2:-}"; shift 2 ;;
    --postgis-host) postgis_host="${2:-}"; shift 2 ;;
    --postgis-port) postgis_port="${2:-}"; shift 2 ;;
    --postgis-database) postgis_database="${2:-}"; shift 2 ;;
    --postgis-user) postgis_user="${2:-}"; shift 2 ;;
    --postgis-password) postgis_password="${2:-}"; shift 2 ;;
    --postgis-table) postgis_table="${2:-}"; shift 2 ;;
    --postgis-geom-column) postgis_geom_column="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[Fatal] Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "${input_csv}" ] || [ -z "${run_root}" ] || [ -z "${python_bin}" ]; then
  echo "[Fatal] --input-csv, --run-root, and --python-bin are required." >&2
  usage
  exit 2
fi

if [ "${indoor_mode}" != "none" ] && [ "${indoor_backend}" = "geoparquet" ] && [ -z "${indoor_manifest_csv}" ]; then
  echo "[Fatal] --indoor-manifest-csv is required when --indoor-backend=geoparquet and --indoor-mode=${indoor_mode}." >&2
  exit 2
fi

mkdir -p "${run_root}"
mkdir -p "${run_root}/logs" "${run_root}/shards" "${run_root}/shard_graphs"

summary_path="${run_root}/run_summary.json"
console_log="${run_root}/console.log"

exec > >(tee -a "${console_log}") 2>&1

echo "[Run] repo_root=${repo_root}"
echo "[Run] input_csv=${input_csv}"
echo "[Run] run_root=${run_root}"
echo "[Run] python_bin=${python_bin}"
echo "[Run] shard_count=${shard_count}"
echo "[Run] workers=${workers}"
echo "[Run] run_as_user=${run_as_user}"
echo "[Run] cell_provider=${cell_provider}"
echo "[Run] h3_resolution=${h3_resolution}"
echo "[Run] cell_size_m=${cell_size_m}"
echo "[Run] step_seconds=${step_seconds}"
echo "[Run] indoor_mode=${indoor_mode}"
echo "[Run] indoor_backend=${indoor_backend}"
echo "[Run] indoor_manifest_csv=${indoor_manifest_csv}"
echo "[Run] flush_every_raw_rows=${flush_every_raw_rows}"

start_epoch="$(date -u +%s)"

shard_manifest="${run_root}/shards/shards.txt"
if [ -s "${shard_manifest}" ] && [ -f "${run_root}/shards/shard_summary.json" ]; then
  echo "[Run] reusing existing shard manifest: ${shard_manifest}"
else
  "${python_bin}" "${repo_root}/scripts/ops/shard_raw_stay_csv.py" \
    --input-csv "${input_csv}" \
    --output-root "${run_root}/shards" \
    --shard-count "${shard_count}" \
    > "${run_root}/shards/stdout.json" 2> "${run_root}/shards/stderr.log"
  if [ ! -s "${shard_manifest}" ]; then
    echo "[Fatal] Missing shard manifest: ${shard_manifest}" >&2
    exit 1
  fi
fi

export RAW_TASKGRAPH_REPO_ROOT="${repo_root}"
export RAW_TASKGRAPH_RUN_ROOT="${run_root}"
export RAW_TASKGRAPH_PYTHON_BIN="${python_bin}"
export RAW_TASKGRAPH_CELL_PROVIDER="${cell_provider}"
export RAW_TASKGRAPH_H3_RESOLUTION="${h3_resolution}"
export RAW_TASKGRAPH_CELL_SIZE_M="${cell_size_m}"
export RAW_TASKGRAPH_STEP_SECONDS="${step_seconds}"
export RAW_TASKGRAPH_SOLAR_ELEVATION_THRESHOLD_DEG="${solar_elevation_threshold_deg}"
export RAW_TASKGRAPH_INDOOR_MODE="${indoor_mode}"
export RAW_TASKGRAPH_INDOOR_BACKEND="${indoor_backend}"
export RAW_TASKGRAPH_INDOOR_MANIFEST_CSV="${indoor_manifest_csv}"
export RAW_TASKGRAPH_INDOOR_BUILDINGS_BUFFER_M="${indoor_buildings_buffer_m}"
export RAW_TASKGRAPH_FLUSH_EVERY_RAW_ROWS="${flush_every_raw_rows}"
export RAW_TASKGRAPH_RUN_AS_USER="${run_as_user}"
export RAW_TASKGRAPH_POSTGIS_DSN="${postgis_dsn}"
export RAW_TASKGRAPH_POSTGIS_HOST="${postgis_host}"
export RAW_TASKGRAPH_POSTGIS_PORT="${postgis_port}"
export RAW_TASKGRAPH_POSTGIS_DATABASE="${postgis_database}"
export RAW_TASKGRAPH_POSTGIS_USER="${postgis_user}"
export RAW_TASKGRAPH_POSTGIS_PASSWORD="${postgis_password}"
export RAW_TASKGRAPH_POSTGIS_TABLE="${postgis_table}"
export RAW_TASKGRAPH_POSTGIS_GEOM_COLUMN="${postgis_geom_column}"

parallel_worker() {
  local shard_name="$1"
  local shard_path="${RAW_TASKGRAPH_RUN_ROOT}/shards/${shard_name}"
  local shard_id="${shard_name%.csv}"
  local out_dir="${RAW_TASKGRAPH_RUN_ROOT}/shard_graphs/${shard_id}"
  local stdout_json="${RAW_TASKGRAPH_RUN_ROOT}/logs/${shard_id}.stdout.json"
  local stderr_log="${RAW_TASKGRAPH_RUN_ROOT}/logs/${shard_id}.stderr.log"
  local -a cmd
  mkdir -p "${out_dir}"
  chmod 777 "${out_dir}" "${RAW_TASKGRAPH_RUN_ROOT}/logs"
  if [ -f "${out_dir}/summary.json" ] && [ -f "${out_dir}/tasks.csv" ]; then
    echo "[Run] skip completed shard ${shard_id}" >&2
    return 0
  fi
  cmd=(
    "${RAW_TASKGRAPH_PYTHON_BIN}" "${RAW_TASKGRAPH_REPO_ROOT}/scripts/ops/build_national_task_graph_raw_stays.py"
    --input-csv "${shard_path}" \
    --output-dir "${out_dir}" \
    --cell-provider "${RAW_TASKGRAPH_CELL_PROVIDER}" \
    --h3-resolution "${RAW_TASKGRAPH_H3_RESOLUTION}" \
    --cell-size-m "${RAW_TASKGRAPH_CELL_SIZE_M}" \
    --step-seconds "${RAW_TASKGRAPH_STEP_SECONDS}" \
    --flush-every-raw-rows "${RAW_TASKGRAPH_FLUSH_EVERY_RAW_ROWS}" \
    --resume \
    --solar-elevation-threshold-deg "${RAW_TASKGRAPH_SOLAR_ELEVATION_THRESHOLD_DEG}" \
    --indoor-mode "${RAW_TASKGRAPH_INDOOR_MODE}" \
    --indoor-backend "${RAW_TASKGRAPH_INDOOR_BACKEND}" \
    --indoor-partition-manifest-csv "${RAW_TASKGRAPH_INDOOR_MANIFEST_CSV}" \
    --indoor-buildings-buffer-m "${RAW_TASKGRAPH_INDOOR_BUILDINGS_BUFFER_M}" \
    --postgis-dsn "${RAW_TASKGRAPH_POSTGIS_DSN}" \
    --postgis-host "${RAW_TASKGRAPH_POSTGIS_HOST}" \
    --postgis-port "${RAW_TASKGRAPH_POSTGIS_PORT}" \
    --postgis-database "${RAW_TASKGRAPH_POSTGIS_DATABASE}" \
    --postgis-user "${RAW_TASKGRAPH_POSTGIS_USER}" \
    --postgis-password "${RAW_TASKGRAPH_POSTGIS_PASSWORD}" \
    --postgis-table "${RAW_TASKGRAPH_POSTGIS_TABLE}" \
    --postgis-geom-column "${RAW_TASKGRAPH_POSTGIS_GEOM_COLUMN}"
  )
  if [ -n "${RAW_TASKGRAPH_RUN_AS_USER}" ]; then
    if [ "$(id -un)" = "${RAW_TASKGRAPH_RUN_AS_USER}" ]; then
      "${cmd[@]}" > "${stdout_json}" 2> "${stderr_log}"
    else
      sudo -u "${RAW_TASKGRAPH_RUN_AS_USER}" "${cmd[@]}" > "${stdout_json}" 2> "${stderr_log}"
    fi
  else
    "${cmd[@]}" > "${stdout_json}" 2> "${stderr_log}"
  fi
}

export -f parallel_worker

echo "[Run] starting parallel shard preprocessing"
< "${shard_manifest}" xargs -I{} -P "${workers}" bash -lc 'parallel_worker "$@"' _ {}

completed_shards="$(find "${run_root}/shard_graphs" -mindepth 2 -maxdepth 2 -name summary.json | wc -l | tr -d ' ')"
if [ "${completed_shards}" != "${shard_count}" ]; then
  echo "[Fatal] Only ${completed_shards}/${shard_count} shard summaries completed. Refusing to merge partial run." >&2
  exit 1
fi

echo "[Run] merging shard task graphs"
mkdir -p "${run_root}/merged"
"${python_bin}" "${repo_root}/scripts/ops/merge_task_graph_shards_duckdb.py" \
  --input-glob "${run_root}/shard_graphs/*/tasks.csv" \
  --membership-glob "${run_root}/shard_graphs/*/task_membership_counts.csv" \
  --source-span-glob "${run_root}/shard_graphs/*/task_source_spans.csv" \
  --summary-glob "${run_root}/shard_graphs/*/summary.json" \
  --output-dir "${run_root}/merged" \
  > "${run_root}/merged/stdout.json"

end_epoch="$(date -u +%s)"

python3 - <<PY
import json
from pathlib import Path
run_root = Path(${run_root@Q})
merged_summary = json.loads((run_root / "merged" / "summary.json").read_text(encoding="utf-8"))
payload = {
    "input_csv": ${input_csv@Q},
    "run_root": str(run_root),
    "shard_count": int(${shard_count@Q}),
    "workers": int(${workers@Q}),
    "cell_provider": ${cell_provider@Q},
    "h3_resolution": int(${h3_resolution@Q}),
    "cell_size_m": float(${cell_size_m@Q}),
    "step_seconds": int(${step_seconds@Q}),
    "solar_elevation_threshold_deg": float(${solar_elevation_threshold_deg@Q}),
    "indoor_mode": ${indoor_mode@Q},
    "indoor_manifest_csv": ${indoor_manifest_csv@Q},
    "start_epoch_utc": int(${start_epoch@Q}),
    "end_epoch_utc": int(${end_epoch@Q}),
    "elapsed_seconds": int(${end_epoch@Q}) - int(${start_epoch@Q}),
    "merged_summary_path": str(run_root / "merged" / "summary.json"),
    "merged": merged_summary,
}
(run_root / "run_summary.json").write_text(json.dumps(payload, indent=2) + "\\n", encoding="utf-8")
print(json.dumps(payload, indent=2))
PY

echo "[Run] completed"
