#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run_raw_stay_exact_executor_benchmark.sh \
    --task-graph-db PATH \
    --partition-manifest-csv PATH \
    --input-root PATH \
    --allowlist-dir PATH \
    --run-root PATH \
    --python-bin PATH \
    [--edge-table-name NAME] \
    [--workers N] \
    [--run-as-user USER] \
    [--input-mode raw-stays|minute-rows] \
    [--step-seconds N] \
    [--solar-elevation-threshold-deg N] \
    [--context-m N] \
    [--max-points-per-execution-unit N] \
    [--max-obstacles-per-execution-unit N] \
    [--max-execution-split-depth N] \
    [--min-points-per-execution-unit N] \
    [--max-obstacles-per-shadow-batch N] \
    [--shadow-kernel pybdshadow|fast-ground] \
    [--checkpoint-task-count N] \
    [--execution-unit-bbox-mode child|parent] \
    [--indoor-backend none|postgis] \
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

task_graph_db=""
partition_manifest_csv=""
input_root=""
allowlist_dir=""
run_root=""
python_bin=""
edge_table_name="task_partition_edges_deg05_ctx400"
workers="8"
run_as_user=""
input_mode="raw-stays"
step_seconds="60"
solar_elevation_threshold_deg="0"
context_m="400"
max_points_per_execution_unit="${MOBILITY_MAX_POINTS_PER_EXECUTION_UNIT:-0}"
max_obstacles_per_execution_unit="${MOBILITY_MAX_OBSTACLES_PER_EXECUTION_UNIT:-0}"
max_execution_split_depth="${MOBILITY_MAX_EXECUTION_SPLIT_DEPTH:-8}"
min_points_per_execution_unit="${MOBILITY_MIN_POINTS_PER_EXECUTION_UNIT:-128}"
max_obstacles_per_shadow_batch="${MOBILITY_MAX_OBSTACLES_PER_SHADOW_BATCH:-0}"
shadow_kernel="${MOBILITY_SHADOW_KERNEL:-fast-ground}"
checkpoint_task_count="${MOBILITY_CHECKPOINT_TASK_COUNT:-1000}"
execution_unit_bbox_mode="${MOBILITY_EXECUTION_UNIT_BBOX_MODE:-child}"
indoor_backend="none"
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
    --task-graph-db) task_graph_db="${2:-}"; shift 2 ;;
    --partition-manifest-csv) partition_manifest_csv="${2:-}"; shift 2 ;;
    --input-root) input_root="${2:-}"; shift 2 ;;
    --allowlist-dir) allowlist_dir="${2:-}"; shift 2 ;;
    --run-root) run_root="${2:-}"; shift 2 ;;
    --python-bin) python_bin="${2:-}"; shift 2 ;;
    --edge-table-name) edge_table_name="${2:-}"; shift 2 ;;
    --workers) workers="${2:-}"; shift 2 ;;
    --run-as-user) run_as_user="${2:-}"; shift 2 ;;
    --input-mode) input_mode="${2:-}"; shift 2 ;;
    --step-seconds) step_seconds="${2:-}"; shift 2 ;;
    --solar-elevation-threshold-deg) solar_elevation_threshold_deg="${2:-}"; shift 2 ;;
    --context-m) context_m="${2:-}"; shift 2 ;;
    --max-points-per-execution-unit) max_points_per_execution_unit="${2:-}"; shift 2 ;;
    --max-obstacles-per-execution-unit) max_obstacles_per_execution_unit="${2:-}"; shift 2 ;;
    --max-execution-split-depth) max_execution_split_depth="${2:-}"; shift 2 ;;
    --min-points-per-execution-unit) min_points_per_execution_unit="${2:-}"; shift 2 ;;
    --max-obstacles-per-shadow-batch) max_obstacles_per_shadow_batch="${2:-}"; shift 2 ;;
    --shadow-kernel) shadow_kernel="${2:-}"; shift 2 ;;
    --checkpoint-task-count) checkpoint_task_count="${2:-}"; shift 2 ;;
    --execution-unit-bbox-mode) execution_unit_bbox_mode="${2:-}"; shift 2 ;;
    --indoor-backend) indoor_backend="${2:-}"; shift 2 ;;
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

if [ -z "${task_graph_db}" ] || [ -z "${partition_manifest_csv}" ] || [ -z "${input_root}" ] || [ -z "${allowlist_dir}" ] || [ -z "${run_root}" ] || [ -z "${python_bin}" ]; then
  echo "[Fatal] Missing required arguments." >&2
  usage
  exit 2
fi

mkdir -p "${run_root}"
mkdir -p "${run_root}/logs" "${run_root}/point_cache/shards" "${run_root}/point_cache/file_allowlists" "${run_root}/point_cache/logs" "${run_root}/runs" "${run_root}/meta"

console_log="${run_root}/console.log"
exec > >(tee -a "${console_log}") 2>&1

echo "[Run] repo_root=${repo_root}"
echo "[Run] task_graph_db=${task_graph_db}"
echo "[Run] partition_manifest_csv=${partition_manifest_csv}"
echo "[Run] input_root=${input_root}"
echo "[Run] allowlist_dir=${allowlist_dir}"
echo "[Run] run_root=${run_root}"
echo "[Run] python_bin=${python_bin}"
echo "[Run] edge_table_name=${edge_table_name}"
echo "[Run] workers=${workers}"
echo "[Run] run_as_user=${run_as_user}"
echo "[Run] input_mode=${input_mode}"
echo "[Run] step_seconds=${step_seconds}"
echo "[Run] solar_elevation_threshold_deg=${solar_elevation_threshold_deg}"
echo "[Run] context_m=${context_m}"
echo "[Run] max_points_per_execution_unit=${max_points_per_execution_unit}"
echo "[Run] max_obstacles_per_execution_unit=${max_obstacles_per_execution_unit}"
echo "[Run] max_execution_split_depth=${max_execution_split_depth}"
echo "[Run] min_points_per_execution_unit=${min_points_per_execution_unit}"
echo "[Run] max_obstacles_per_shadow_batch=${max_obstacles_per_shadow_batch}"
echo "[Run] shadow_kernel=${shadow_kernel}"
echo "[Run] checkpoint_task_count=${checkpoint_task_count}"
echo "[Run] execution_unit_bbox_mode=${execution_unit_bbox_mode}"
echo "[Run] indoor_backend=${indoor_backend}"
echo "[Run] postgis_host=${postgis_host}"
echo "[Run] postgis_port=${postgis_port}"
echo "[Run] postgis_database=${postgis_database}"
echo "[Run] postgis_user=${postgis_user}"
echo "[Run] postgis_table=${postgis_table}"

stage_a_start_epoch="$(date -u +%s)"

union_allowlist="${run_root}/meta/all_tasks.txt"
find "${allowlist_dir}" -maxdepth 1 -type f -name 'shard_*.txt' | sort > "${run_root}/meta/allowlist_files.txt"
if [ ! -s "${run_root}/meta/allowlist_files.txt" ]; then
  echo "[Fatal] No shard allowlists found under ${allowlist_dir}" >&2
  exit 1
fi
cat $(cat "${run_root}/meta/allowlist_files.txt") | sed '/^$/d' | sort -u > "${union_allowlist}"
selected_task_count="$(wc -l < "${union_allowlist}" | tr -d ' ')"
echo "[Stage A] selected_task_count=${selected_task_count}"

file_catalog_json="${run_root}/meta/file_catalog.json"
"${python_bin}" - <<PY
import duckdb
import json
from pathlib import Path

db_path = Path(${task_graph_db@Q})
union_allowlist = Path(${union_allowlist@Q})
out_json = Path(${file_catalog_json@Q})

task_ids = [line.strip() for line in union_allowlist.read_text(encoding="utf-8").splitlines() if line.strip()]
if not task_ids:
    raise SystemExit("empty union allowlist")

quoted = ", ".join("'" + task_id.replace("'", "''") + "'" for task_id in task_ids)
con = duckdb.connect(str(db_path), read_only=True)
rows = con.execute(
    f"""
    SELECT DISTINCT file_relpath
    FROM memberships
    WHERE task_id IN ({quoted})
    ORDER BY file_relpath
    """
).fetchall()
con.close()
file_relpaths = [str(row[0]) for row in rows]
out_json.write_text(json.dumps({"file_relpaths": file_relpaths}, indent=2) + "\\n", encoding="utf-8")
print(json.dumps({"file_count": len(file_relpaths)}, indent=2))
PY

file_count="$("${python_bin}" - <<PY
import json
from pathlib import Path
data = json.loads(Path(${file_catalog_json@Q}).read_text(encoding="utf-8"))
print(len(data["file_relpaths"]))
PY
)"
echo "[Stage A] selected_file_count=${file_count}"

"${python_bin}" - <<PY
import json
from pathlib import Path

file_catalog = Path(${file_catalog_json@Q})
out_dir = Path(${run_root@Q}) / "point_cache" / "file_allowlists"
workers = int(${workers@Q})
data = json.loads(file_catalog.read_text(encoding="utf-8"))
file_relpaths = list(data["file_relpaths"])
groups = [[] for _ in range(workers)]
for idx, file_relpath in enumerate(file_relpaths):
    groups[idx % workers].append(file_relpath)
for idx, group in enumerate(groups):
    path = out_dir / f"worker_{idx:02d}.txt"
    path.write_text("\\n".join(group) + ("\\n" if group else ""), encoding="utf-8")
PY

run_user_cmd() {
  if [ -n "${RAW_STAY_BENCH_RUN_AS_USER:-}" ] && [ "$(id -un)" != "${RAW_STAY_BENCH_RUN_AS_USER}" ]; then
    sudo -u "${RAW_STAY_BENCH_RUN_AS_USER}" "$@"
  else
    "$@"
  fi
}

executor_success() {
  local out_dir="$1"
  [ -f "${out_dir}/_SUCCESS" ] && [ -f "${out_dir}/summary.json" ] && { [ -f "${out_dir}/task_point_results.csv" ] || [ -f "${out_dir}/result_manifest.json" ]; }
}

stage_a_worker() {
  local worker_idx="$1"
  local file_allowlist="${RAW_STAY_BENCH_RUN_ROOT}/point_cache/file_allowlists/worker_${worker_idx}.txt"
  local output_csv="${RAW_STAY_BENCH_RUN_ROOT}/point_cache/shards/point_cache_${worker_idx}.csv"
  local summary_json="${RAW_STAY_BENCH_RUN_ROOT}/point_cache/shards/summary_${worker_idx}.json"
  local success_marker="${RAW_STAY_BENCH_RUN_ROOT}/point_cache/shards/success_${worker_idx}.json"
  local stdout_log="${RAW_STAY_BENCH_RUN_ROOT}/point_cache/logs/materialize_${worker_idx}.stdout.log"
  local stderr_log="${RAW_STAY_BENCH_RUN_ROOT}/point_cache/logs/materialize_${worker_idx}.stderr.log"
  mkdir -p "${RAW_STAY_BENCH_RUN_ROOT}/point_cache/shards" "${RAW_STAY_BENCH_RUN_ROOT}/point_cache/logs"
  chmod 777 "${RAW_STAY_BENCH_RUN_ROOT}/point_cache" "${RAW_STAY_BENCH_RUN_ROOT}/point_cache/shards" "${RAW_STAY_BENCH_RUN_ROOT}/point_cache/logs" || true
  if [ -f "${success_marker}" ] && [ -f "${summary_json}" ] && [ -f "${output_csv}" ]; then
    echo "[Stage A] skip worker_${worker_idx}" >&2
    return 0
  fi
  if [ ! -f "${success_marker}" ] && [ -f "${summary_json}" ] && [ -f "${output_csv}" ]; then
    printf '{"status":"ok","worker":"%s","summaryJson":"%s","outputCsv":"%s","legacyPromoted":true}\n' "${worker_idx}" "${summary_json}" "${output_csv}" > "${success_marker}"
    echo "[Stage A] promote existing worker_${worker_idx}" >&2
    return 0
  fi
  run_user_cmd \
    "${RAW_STAY_BENCH_PYTHON_BIN}" "${RAW_STAY_BENCH_REPO_ROOT}/scripts/ops/materialize_task_point_cache.py" \
      --task-graph-db "${RAW_STAY_BENCH_TASK_GRAPH_DB}" \
      --partition-manifest-csv "${RAW_STAY_BENCH_PARTITION_MANIFEST_CSV}" \
      --edge-table-name "${RAW_STAY_BENCH_EDGE_TABLE_NAME}" \
      --input-root "${RAW_STAY_BENCH_INPUT_ROOT}" \
      --output-csv "${output_csv}" \
      --summary-json "${summary_json}" \
      --task-id-file "${RAW_STAY_BENCH_UNION_ALLOWLIST}" \
      --input-mode "${RAW_STAY_BENCH_INPUT_MODE}" \
      --step-seconds "${RAW_STAY_BENCH_STEP_SECONDS}" \
      --solar-elevation-threshold-deg "${RAW_STAY_BENCH_SOLAR_ELEVATION_THRESHOLD_DEG}" \
      --indoor-backend "${RAW_STAY_BENCH_INDOOR_BACKEND}" \
      --postgis-dsn "${RAW_STAY_BENCH_POSTGIS_DSN}" \
      --postgis-host "${RAW_STAY_BENCH_POSTGIS_HOST}" \
      --postgis-port "${RAW_STAY_BENCH_POSTGIS_PORT}" \
      --postgis-database "${RAW_STAY_BENCH_POSTGIS_DATABASE}" \
      --postgis-user "${RAW_STAY_BENCH_POSTGIS_USER}" \
      --postgis-password "${RAW_STAY_BENCH_POSTGIS_PASSWORD}" \
      --postgis-table "${RAW_STAY_BENCH_POSTGIS_TABLE}" \
      --postgis-geom-column "${RAW_STAY_BENCH_POSTGIS_GEOM_COLUMN}" \
      --file-relpath-file "${file_allowlist}" \
      > "${stdout_log}" 2> "${stderr_log}"
  printf '{"status":"ok","worker":"%s","summaryJson":"%s","outputCsv":"%s"}\n' "${worker_idx}" "${summary_json}" "${output_csv}" > "${success_marker}"
}

export RAW_STAY_BENCH_REPO_ROOT="${repo_root}"
export RAW_STAY_BENCH_TASK_GRAPH_DB="${task_graph_db}"
export RAW_STAY_BENCH_PARTITION_MANIFEST_CSV="${partition_manifest_csv}"
export RAW_STAY_BENCH_INPUT_ROOT="${input_root}"
export RAW_STAY_BENCH_RUN_ROOT="${run_root}"
export RAW_STAY_BENCH_PYTHON_BIN="${python_bin}"
export RAW_STAY_BENCH_EDGE_TABLE_NAME="${edge_table_name}"
export RAW_STAY_BENCH_UNION_ALLOWLIST="${union_allowlist}"
export RAW_STAY_BENCH_INPUT_MODE="${input_mode}"
export RAW_STAY_BENCH_STEP_SECONDS="${step_seconds}"
export RAW_STAY_BENCH_SOLAR_ELEVATION_THRESHOLD_DEG="${solar_elevation_threshold_deg}"
export RAW_STAY_BENCH_RUN_AS_USER="${run_as_user}"
export RAW_STAY_BENCH_INDOOR_BACKEND="${indoor_backend}"
export RAW_STAY_BENCH_POSTGIS_DSN="${postgis_dsn}"
export RAW_STAY_BENCH_POSTGIS_HOST="${postgis_host}"
export RAW_STAY_BENCH_POSTGIS_PORT="${postgis_port}"
export RAW_STAY_BENCH_POSTGIS_DATABASE="${postgis_database}"
export RAW_STAY_BENCH_POSTGIS_USER="${postgis_user}"
export RAW_STAY_BENCH_POSTGIS_PASSWORD="${postgis_password}"
export RAW_STAY_BENCH_POSTGIS_TABLE="${postgis_table}"
export RAW_STAY_BENCH_POSTGIS_GEOM_COLUMN="${postgis_geom_column}"
export -f run_user_cmd
export -f executor_success
export -f stage_a_worker

printf '%02d\n' $(seq 0 $((workers - 1))) | xargs -I{} -P "${workers}" bash -lc 'stage_a_worker "$@"' _ {}

completed_stage_a="$(find "${run_root}/point_cache/shards" -maxdepth 1 -type f -name 'success_*.json' | wc -l | tr -d ' ')"
if [ "${completed_stage_a}" != "${workers}" ]; then
  echo "[Fatal] Only ${completed_stage_a}/${workers} point-cache workers completed." >&2
  exit 1
fi

point_cache_csv="${run_root}/point_cache/merged_task_points.csv"
point_cache_summary="${run_root}/point_cache/summary.json"
"${python_bin}" - <<PY
import csv
import json
from pathlib import Path

run_root = Path(${run_root@Q})
shard_dir = run_root / "point_cache" / "shards"
output_csv = Path(${point_cache_csv@Q})
summary_path = Path(${point_cache_summary@Q})

summary_paths = sorted(shard_dir.glob("summary_*.json"))
csv_paths = sorted(shard_dir.glob("point_cache_*.csv"))
fieldnames = ["task_id", "file_relpath", "row_index", "timestamp", "lon", "lat"]
row_count = 0
materialized_tasks = set()
selected_files = 0
scanned_files = 0
scanned_rows = 0
elapsed = 0.0
with output_csv.open("w", encoding="utf-8", newline="") as out_handle:
    writer = csv.DictWriter(out_handle, fieldnames=fieldnames, lineterminator="\\n")
    writer.writeheader()
    for csv_path in csv_paths:
        with csv_path.open("r", encoding="utf-8", newline="") as in_handle:
            reader = csv.DictReader(in_handle)
            for row in reader:
                writer.writerow({name: row[name] for name in fieldnames})
                row_count += 1
                materialized_tasks.add(row["task_id"])
for summary_file in summary_paths:
    summary = json.loads(summary_file.read_text(encoding="utf-8"))
    selected_files += int(summary.get("selectedFileCount", 0))
    scanned_files += int(summary.get("scannedFileCount", 0))
    scanned_rows += int(summary.get("scannedRowCount", 0))
    elapsed += float(summary.get("elapsedSeconds", 0.0))
payload = {
    "selectedTaskCount": int(${selected_task_count@Q}),
    "selectedFileCount": selected_files,
    "scannedFileCount": scanned_files,
    "scannedRowCount": scanned_rows,
    "materializedTaskCount": len(materialized_tasks),
    "materializedPointRowCount": row_count,
    "elapsedSecondsSum": elapsed,
    "outputCsv": str(output_csv),
}
summary_path.write_text(json.dumps(payload, indent=2) + "\\n", encoding="utf-8")
print(json.dumps(payload, indent=2))
PY

stage_a_end_epoch="$(date -u +%s)"

stage_b_start_epoch="$(date -u +%s)"

stage_b_worker() {
  local allowlist_path="$1"
  local shard_name
  shard_name="$(basename "${allowlist_path}" .txt)"
  local out_dir="${RAW_STAY_BENCH_RUN_ROOT}/runs/${shard_name}"
  local stdout_log="${RAW_STAY_BENCH_RUN_ROOT}/logs/${shard_name}.stdout.log"
  local stderr_log="${RAW_STAY_BENCH_RUN_ROOT}/logs/${shard_name}.stderr.log"
  local status_dir="${RAW_STAY_BENCH_RUN_ROOT}/status/stage_b"
  mkdir -p "${out_dir}" "${status_dir}/running" "${status_dir}/done" "${status_dir}/failed"
  chmod 777 "${out_dir}" "${RAW_STAY_BENCH_RUN_ROOT}/logs" "${status_dir}" "${status_dir}/running" "${status_dir}/done" "${status_dir}/failed" || true
  if executor_success "${out_dir}"; then
    echo "[Stage B] skip ${shard_name}" >&2
    rm -f "${status_dir}/failed/${shard_name}.json" "${status_dir}/running/${shard_name}.json"
    printf '{"status":"skipped","shard":"%s","outputDir":"%s"}\n' "${shard_name}" "${out_dir}" > "${status_dir}/done/${shard_name}.json"
    return 0
  fi
  rm -f "${status_dir}/failed/${shard_name}.json" "${status_dir}/done/${shard_name}.json"
  printf '{"status":"running","shard":"%s","outputDir":"%s"}\n' "${shard_name}" "${out_dir}" > "${status_dir}/running/${shard_name}.json"
  set +e
  run_user_cmd \
    "${RAW_STAY_BENCH_PYTHON_BIN}" "${RAW_STAY_BENCH_REPO_ROOT}/scripts/ops/run_exact_partition_executor.py" \
      --task-graph-db "${RAW_STAY_BENCH_TASK_GRAPH_DB}" \
      --partition-manifest-csv "${RAW_STAY_BENCH_PARTITION_MANIFEST_CSV}" \
      --input-root "${RAW_STAY_BENCH_INPUT_ROOT}" \
      --edge-table-name "${RAW_STAY_BENCH_EDGE_TABLE_NAME}" \
      --output-dir "${out_dir}" \
      --task-id-file "${allowlist_path}" \
      --point-cache-csv "${RAW_STAY_BENCH_POINT_CACHE_CSV}" \
      --input-mode "${RAW_STAY_BENCH_INPUT_MODE}" \
      --context-m "${RAW_STAY_BENCH_CONTEXT_M}" \
      --max-points-per-execution-unit "${RAW_STAY_BENCH_MAX_POINTS_PER_EXECUTION_UNIT}" \
      --max-obstacles-per-execution-unit "${RAW_STAY_BENCH_MAX_OBSTACLES_PER_EXECUTION_UNIT}" \
      --max-execution-split-depth "${RAW_STAY_BENCH_MAX_EXECUTION_SPLIT_DEPTH}" \
      --min-points-per-execution-unit "${RAW_STAY_BENCH_MIN_POINTS_PER_EXECUTION_UNIT}" \
      --max-obstacles-per-shadow-batch "${RAW_STAY_BENCH_MAX_OBSTACLES_PER_SHADOW_BATCH}" \
      --shadow-kernel "${RAW_STAY_BENCH_SHADOW_KERNEL}" \
      --checkpoint-task-count "${RAW_STAY_BENCH_CHECKPOINT_TASK_COUNT}" \
      --resume true \
      --execution-unit-bbox-mode "${RAW_STAY_BENCH_EXECUTION_UNIT_BBOX_MODE}" \
      --step-seconds "${RAW_STAY_BENCH_STEP_SECONDS}" \
      --solar-elevation-threshold-deg "${RAW_STAY_BENCH_SOLAR_ELEVATION_THRESHOLD_DEG}" \
      > "${stdout_log}" 2> "${stderr_log}"
  local rc=$?
  set -e
  rm -f "${status_dir}/running/${shard_name}.json"
  if [ "${rc}" -eq 0 ] && executor_success "${out_dir}"; then
    rm -f "${status_dir}/failed/${shard_name}.json"
    printf '{"status":"ok","shard":"%s","outputDir":"%s","summaryJson":"%s"}\n' "${shard_name}" "${out_dir}" "${out_dir}/summary.json" > "${status_dir}/done/${shard_name}.json"
    return 0
  fi
  printf '{"status":"failed","shard":"%s","exitCode":%s,"outputDir":"%s","stderrLog":"%s"}\n' "${shard_name}" "${rc}" "${out_dir}" "${stderr_log}" > "${status_dir}/failed/${shard_name}.json"
  return "${rc}"
}

export RAW_STAY_BENCH_POINT_CACHE_CSV="${point_cache_csv}"
export RAW_STAY_BENCH_CONTEXT_M="${context_m}"
export RAW_STAY_BENCH_MAX_POINTS_PER_EXECUTION_UNIT="${max_points_per_execution_unit}"
export RAW_STAY_BENCH_MAX_OBSTACLES_PER_EXECUTION_UNIT="${max_obstacles_per_execution_unit}"
export RAW_STAY_BENCH_MAX_EXECUTION_SPLIT_DEPTH="${max_execution_split_depth}"
export RAW_STAY_BENCH_MIN_POINTS_PER_EXECUTION_UNIT="${min_points_per_execution_unit}"
export RAW_STAY_BENCH_MAX_OBSTACLES_PER_SHADOW_BATCH="${max_obstacles_per_shadow_batch}"
export RAW_STAY_BENCH_SHADOW_KERNEL="${shadow_kernel}"
export RAW_STAY_BENCH_CHECKPOINT_TASK_COUNT="${checkpoint_task_count}"
export RAW_STAY_BENCH_EXECUTION_UNIT_BBOX_MODE="${execution_unit_bbox_mode}"
export -f stage_b_worker

find "${allowlist_dir}" -maxdepth 1 -type f -name 'shard_*.txt' | sort | \
  xargs -I{} -P "${workers}" bash -lc 'stage_b_worker "$@"' _ {}

completed_stage_b="$(find "${run_root}/runs" -mindepth 2 -maxdepth 2 -type f -name '_SUCCESS' | wc -l | tr -d ' ')"
allowlist_shard_count="$(find "${allowlist_dir}" -maxdepth 1 -type f -name 'shard_*.txt' | wc -l | tr -d ' ')"
if [ "${completed_stage_b}" != "${allowlist_shard_count}" ]; then
  echo "[Fatal] Only ${completed_stage_b}/${allowlist_shard_count} executor shards completed." >&2
  exit 1
fi

stage_b_end_epoch="$(date -u +%s)"
benchmark_summary="${run_root}/benchmark_summary.json"
"${python_bin}" - <<PY
import json
from pathlib import Path

run_root = Path(${run_root@Q})
allowlist_dir = Path(${allowlist_dir@Q})
summary_paths = sorted((run_root / "runs").glob("*/summary.json"))
rows = [json.loads(path.read_text(encoding="utf-8")) for path in summary_paths]
wall_elapsed = 0.0
if rows:
    wall_elapsed = max(float(row.get("elapsedSeconds", 0.0)) for row in rows)
payload = {
    "runRoot": str(run_root),
    "shardCount": len(rows),
    "selectedTaskCount": int(${selected_task_count@Q}),
    "processedTaskCount": sum(int(row.get("processedTaskCount", 0)) for row in rows),
    "splitTaskCount": sum(int(row.get("splitTaskCount", 0)) for row in rows),
    "executionUnitCount": sum(int(row.get("executionUnitCount", 0)) for row in rows),
    "engineExecutionUnitCount": sum(int(row.get("engineExecutionUnitCount", 0)) for row in rows),
    "emptyExecutionUnitCount": sum(int(row.get("emptyExecutionUnitCount", 0)) for row in rows),
    "shadowBatchCount": sum(int(row.get("shadowBatchCount", 0)) for row in rows),
    "maxExecutionDepth": max((int(row.get("maxExecutionDepth", 0)) for row in rows), default=0),
    "maxExecutionUnitObstacleRows": max((int(row.get("maxExecutionUnitObstacleRows", 0)) for row in rows), default=0),
    "resultRowCount": sum(int(row.get("resultRowCount", 0)) for row in rows),
    "stageAElapsedSeconds": int(${stage_a_end_epoch@Q}) - int(${stage_a_start_epoch@Q}),
    "stageBElapsedSeconds": int(${stage_b_end_epoch@Q}) - int(${stage_b_start_epoch@Q}),
    "wallElapsedSeconds": wall_elapsed,
    "pointCacheSummaryPath": str(Path(${point_cache_summary@Q})),
    "maxPointsPerExecutionUnit": int(${max_points_per_execution_unit@Q}),
    "maxObstaclesPerExecutionUnit": int(${max_obstacles_per_execution_unit@Q}),
    "maxExecutionSplitDepth": int(${max_execution_split_depth@Q}),
    "minPointsPerExecutionUnit": int(${min_points_per_execution_unit@Q}),
    "maxObstaclesPerShadowBatch": int(${max_obstacles_per_shadow_batch@Q}),
    "shadowKernel": ${shadow_kernel@Q},
    "checkpointTaskCount": int(${checkpoint_task_count@Q}),
    "executionUnitBboxMode": ${execution_unit_bbox_mode@Q},
}
Path(${benchmark_summary@Q}).write_text(json.dumps(payload, indent=2) + "\\n", encoding="utf-8")
print(json.dumps(payload, indent=2))
PY

echo "[Run] benchmark summary written to ${benchmark_summary}"
