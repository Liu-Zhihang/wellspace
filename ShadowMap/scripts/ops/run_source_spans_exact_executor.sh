#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run_source_spans_exact_executor.sh \
    --task-graph-db PATH \
    --partition-manifest-csv PATH \
    --input-root PATH \
    --allowlist-dir PATH \
    --run-root PATH \
    --python-bin PATH \
    [--source-spans-table NAME] \
    [--edge-table-name NAME] \
    [--workers N] \
    [--context-m N] \
    [--shadow-kernel pybdshadow|fast-ground] \
    [--checkpoint-task-count N] \
    [--checkpoint-max-point-count N] \
    [--max-checkpoint-chunks-per-run N] \
    [--final-output-mode merged-csv|checkpoint-manifest]

Runs the exact executor directly from precomputed source_spans. Each shard and
each executor checkpoint writes _SUCCESS only after all expected outputs exist,
so interrupted runs can be restarted against the same --run-root.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

task_graph_db=""
partition_manifest_csv=""
input_root=""
allowlist_dir=""
run_root=""
python_bin=""
source_spans_table="${MOBILITY_SOURCE_SPANS_TABLE:-source_spans}"
edge_table_name="task_partition_edges_deg05_ctx400"
workers="${MOBILITY_EXECUTOR_WORKERS:-32}"
context_m="${MOBILITY_CONTEXT_M:-400}"
shadow_kernel="${MOBILITY_SHADOW_KERNEL:-fast-ground}"
checkpoint_task_count="${MOBILITY_CHECKPOINT_TASK_COUNT:-1000}"
checkpoint_max_point_count="${MOBILITY_CHECKPOINT_MAX_POINT_COUNT:-0}"
max_checkpoint_chunks_per_run="${MOBILITY_MAX_CHECKPOINT_CHUNKS_PER_RUN:-0}"
final_output_mode="${MOBILITY_FINAL_OUTPUT_MODE:-checkpoint-manifest}"

while [ $# -gt 0 ]; do
  case "$1" in
    --task-graph-db) task_graph_db="${2:-}"; shift 2 ;;
    --partition-manifest-csv) partition_manifest_csv="${2:-}"; shift 2 ;;
    --input-root) input_root="${2:-}"; shift 2 ;;
    --allowlist-dir) allowlist_dir="${2:-}"; shift 2 ;;
    --run-root) run_root="${2:-}"; shift 2 ;;
    --python-bin) python_bin="${2:-}"; shift 2 ;;
    --source-spans-table) source_spans_table="${2:-}"; shift 2 ;;
    --edge-table-name) edge_table_name="${2:-}"; shift 2 ;;
    --workers) workers="${2:-}"; shift 2 ;;
    --context-m) context_m="${2:-}"; shift 2 ;;
    --shadow-kernel) shadow_kernel="${2:-}"; shift 2 ;;
    --checkpoint-task-count) checkpoint_task_count="${2:-}"; shift 2 ;;
    --checkpoint-max-point-count) checkpoint_max_point_count="${2:-}"; shift 2 ;;
    --max-checkpoint-chunks-per-run) max_checkpoint_chunks_per_run="${2:-}"; shift 2 ;;
    --final-output-mode) final_output_mode="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[Fatal] Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "${task_graph_db}" ] || [ -z "${partition_manifest_csv}" ] || [ -z "${input_root}" ] || [ -z "${allowlist_dir}" ] || [ -z "${run_root}" ] || [ -z "${python_bin}" ]; then
  echo "[Fatal] Missing required arguments." >&2
  usage
  exit 2
fi

mkdir -p "${run_root}/logs" "${run_root}/runs" "${run_root}/meta" "${run_root}/status/stage_b/running" "${run_root}/status/stage_b/done" "${run_root}/status/stage_b/failed"
console_log="${run_root}/console.log"
exec > >(tee -a "${console_log}") 2>&1

echo "[Run] repo_root=${repo_root}"
echo "[Run] task_graph_db=${task_graph_db}"
echo "[Run] partition_manifest_csv=${partition_manifest_csv}"
echo "[Run] input_root=${input_root}"
echo "[Run] allowlist_dir=${allowlist_dir}"
echo "[Run] run_root=${run_root}"
echo "[Run] python_bin=${python_bin}"
echo "[Run] source_spans_table=${source_spans_table}"
echo "[Run] edge_table_name=${edge_table_name}"
echo "[Run] workers=${workers}"
echo "[Run] context_m=${context_m}"
echo "[Run] shadow_kernel=${shadow_kernel}"
echo "[Run] checkpoint_task_count=${checkpoint_task_count}"
echo "[Run] checkpoint_max_point_count=${checkpoint_max_point_count}"
echo "[Run] max_checkpoint_chunks_per_run=${max_checkpoint_chunks_per_run}"
echo "[Run] final_output_mode=${final_output_mode}"

find "${allowlist_dir}" -maxdepth 1 -type f -name 'shard_*.txt' | sort > "${run_root}/meta/allowlist_files.txt"
if [ ! -s "${run_root}/meta/allowlist_files.txt" ]; then
  echo "[Fatal] No shard allowlists found under ${allowlist_dir}" >&2
  exit 1
fi
cat $(cat "${run_root}/meta/allowlist_files.txt") | sed '/^$/d' | sort -u > "${run_root}/meta/all_tasks.txt"
selected_task_count="$(wc -l < "${run_root}/meta/all_tasks.txt" | tr -d ' ')"
allowlist_shard_count="$(find "${allowlist_dir}" -maxdepth 1 -type f -name 'shard_*.txt' | wc -l | tr -d ' ')"
echo "[Run] selected_task_count=${selected_task_count}"
echo "[Run] allowlist_shard_count=${allowlist_shard_count}"

executor_success() {
  local out_dir="$1"
  [ -f "${out_dir}/_SUCCESS" ] && [ -f "${out_dir}/summary.json" ] && { [ -f "${out_dir}/task_point_results.csv" ] || [ -f "${out_dir}/result_manifest.json" ]; }
}

stage_worker() {
  local allowlist_path="$1"
  local shard_name
  shard_name="$(basename "${allowlist_path}" .txt)"
  local out_dir="${RAW_SPANS_RUN_ROOT}/runs/${shard_name}"
  local stdout_log="${RAW_SPANS_RUN_ROOT}/logs/${shard_name}.stdout.log"
  local stderr_log="${RAW_SPANS_RUN_ROOT}/logs/${shard_name}.stderr.log"
  local status_dir="${RAW_SPANS_RUN_ROOT}/status/stage_b"

  mkdir -p "${out_dir}" "${status_dir}/running" "${status_dir}/done" "${status_dir}/failed"

  if executor_success "${out_dir}"; then
    echo "[Stage B] skip ${shard_name}" >&2
    rm -f "${status_dir}/failed/${shard_name}.json" "${status_dir}/running/${shard_name}.json"
    printf '{"status":"skipped","shard":"%s","outputDir":"%s"}\n' "${shard_name}" "${out_dir}" > "${status_dir}/done/${shard_name}.json"
    return 0
  fi
  rm -f "${status_dir}/failed/${shard_name}.json" "${status_dir}/done/${shard_name}.json"

  printf '{"status":"running","shard":"%s","outputDir":"%s"}\n' "${shard_name}" "${out_dir}" > "${status_dir}/running/${shard_name}.json"
  local rc=0
  local attempt=0
  while ! executor_success "${out_dir}"; do
    attempt=$((attempt + 1))
    local attempt_stdout_log="${stdout_log%.log}.attempt_${attempt}.log"
    local attempt_stderr_log="${stderr_log%.log}.attempt_${attempt}.log"
    echo "[Stage B] run ${shard_name} attempt=${attempt}" >&2
    set +e
    "${RAW_SPANS_PYTHON_BIN}" "${RAW_SPANS_REPO_ROOT}/scripts/ops/run_exact_partition_executor.py" \
      --task-graph-db "${RAW_SPANS_TASK_GRAPH_DB}" \
      --partition-manifest-csv "${RAW_SPANS_PARTITION_MANIFEST_CSV}" \
      --input-root "${RAW_SPANS_INPUT_ROOT}" \
      --edge-table-name "${RAW_SPANS_EDGE_TABLE_NAME}" \
      --output-dir "${out_dir}" \
      --task-id-file "${allowlist_path}" \
      --source-spans-table "${RAW_SPANS_SOURCE_SPANS_TABLE}" \
      --context-m "${RAW_SPANS_CONTEXT_M}" \
      --max-tasks 0 \
      --shadow-kernel "${RAW_SPANS_SHADOW_KERNEL}" \
      --checkpoint-task-count "${RAW_SPANS_CHECKPOINT_TASK_COUNT}" \
      --checkpoint-max-point-count "${RAW_SPANS_CHECKPOINT_MAX_POINT_COUNT}" \
      --max-checkpoint-chunks-per-run "${RAW_SPANS_MAX_CHECKPOINT_CHUNKS_PER_RUN}" \
      --final-output-mode "${RAW_SPANS_FINAL_OUTPUT_MODE}" \
      --resume true \
      > "${attempt_stdout_log}" 2> "${attempt_stderr_log}"
    rc=$?
    set -e
    ln -sfn "$(basename "${attempt_stdout_log}")" "${stdout_log}" 2>/dev/null || cp "${attempt_stdout_log}" "${stdout_log}"
    ln -sfn "$(basename "${attempt_stderr_log}")" "${stderr_log}" 2>/dev/null || cp "${attempt_stderr_log}" "${stderr_log}"
    if [ "${rc}" -ne 0 ]; then
      break
    fi
    if [ "${RAW_SPANS_MAX_CHECKPOINT_CHUNKS_PER_RUN}" = "0" ]; then
      break
    fi
  done

  rm -f "${status_dir}/running/${shard_name}.json"
  if [ "${rc}" -eq 0 ] && executor_success "${out_dir}"; then
    rm -f "${status_dir}/failed/${shard_name}.json"
    printf '{"status":"ok","shard":"%s","outputDir":"%s","summaryJson":"%s"}\n' "${shard_name}" "${out_dir}" "${out_dir}/summary.json" > "${status_dir}/done/${shard_name}.json"
    return 0
  fi

  printf '{"status":"failed","shard":"%s","exitCode":%s,"outputDir":"%s","stderrLog":"%s"}\n' "${shard_name}" "${rc}" "${out_dir}" "${stderr_log}" > "${status_dir}/failed/${shard_name}.json"
  return "${rc}"
}

export RAW_SPANS_REPO_ROOT="${repo_root}"
export RAW_SPANS_TASK_GRAPH_DB="${task_graph_db}"
export RAW_SPANS_PARTITION_MANIFEST_CSV="${partition_manifest_csv}"
export RAW_SPANS_INPUT_ROOT="${input_root}"
export RAW_SPANS_RUN_ROOT="${run_root}"
export RAW_SPANS_PYTHON_BIN="${python_bin}"
export RAW_SPANS_SOURCE_SPANS_TABLE="${source_spans_table}"
export RAW_SPANS_EDGE_TABLE_NAME="${edge_table_name}"
export RAW_SPANS_CONTEXT_M="${context_m}"
export RAW_SPANS_SHADOW_KERNEL="${shadow_kernel}"
export RAW_SPANS_CHECKPOINT_TASK_COUNT="${checkpoint_task_count}"
export RAW_SPANS_CHECKPOINT_MAX_POINT_COUNT="${checkpoint_max_point_count}"
export RAW_SPANS_MAX_CHECKPOINT_CHUNKS_PER_RUN="${max_checkpoint_chunks_per_run}"
export RAW_SPANS_FINAL_OUTPUT_MODE="${final_output_mode}"
export -f executor_success
export -f stage_worker

stage_start_epoch="$(date -u +%s)"
find "${allowlist_dir}" -maxdepth 1 -type f -name 'shard_*.txt' | sort | \
  xargs -I{} -P "${workers}" bash -lc 'stage_worker "$@"' _ {}
stage_end_epoch="$(date -u +%s)"

completed_shards="$(find "${run_root}/runs" -mindepth 2 -maxdepth 2 -type f -name '_SUCCESS' | wc -l | tr -d ' ')"
failed_shards="$(find "${run_root}/status/stage_b/failed" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"

summary_path="${run_root}/run_summary.json"
"${python_bin}" - <<PY
import json
from pathlib import Path

run_root = Path(${run_root@Q})
summary_paths = sorted((run_root / "runs").glob("*/summary.json"))
rows = [json.loads(path.read_text(encoding="utf-8")) for path in summary_paths]
payload = {
    "status": "ok" if int(${failed_shards@Q}) == 0 and int(${completed_shards@Q}) == int(${allowlist_shard_count@Q}) else "incomplete",
    "runRoot": str(run_root),
    "sourceSpansTable": ${source_spans_table@Q},
    "shardCount": int(${allowlist_shard_count@Q}),
    "completedShardCount": int(${completed_shards@Q}),
    "failedShardCount": int(${failed_shards@Q}),
    "selectedTaskCount": int(${selected_task_count@Q}),
    "processedTaskCount": sum(int(row.get("processedTaskCount", 0)) for row in rows),
    "resultRowCount": sum(int(row.get("resultRowCount", 0)) for row in rows),
    "checkpointTaskCount": int(${checkpoint_task_count@Q}),
    "finalOutputMode": ${final_output_mode@Q},
    "shadowKernel": ${shadow_kernel@Q},
    "stageElapsedSeconds": int(${stage_end_epoch@Q}) - int(${stage_start_epoch@Q}),
}
Path(${summary_path@Q}).write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\\n", encoding="utf-8")
print(json.dumps(payload, indent=2, ensure_ascii=False))
PY

if [ "${failed_shards}" != "0" ] || [ "${completed_shards}" != "${allowlist_shard_count}" ]; then
  echo "[Fatal] Incomplete run: completed=${completed_shards}/${allowlist_shard_count}, failed=${failed_shards}" >&2
  exit 1
fi

echo "[Run] summary written to ${summary_path}"
