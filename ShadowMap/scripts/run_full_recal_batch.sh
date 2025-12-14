#!/bin/bash
set -euo pipefail

# Batch recompute runner (pure Python, single process pool).
#
# Why this script exists:
# - `run_full_recal.sh` launches one Python process per file (repeated preload + repeated process pool startup).
# - This script batches all target CSVs into ONE Python invocation so buildings preload + worker pool are created once.
# - Concurrency is applied at the bucket level (minute buckets), avoiding nested process pools.
#
# Notes:
# - `*_retry.txt` files are treated as a file list only (bucket contents ignored).
# - A retry file is removed only if the expected output CSV exists after the run.

BUCKET_DIR="${BUCKET_DIR:-}"
INPUT_ROOT="${INPUT_ROOT:-}"
OUTPUT_ROOT="${OUTPUT_ROOT:-}"
BACKUP_DIR="${BACKUP_DIR:-}"
LOG_FILE="${LOG_FILE:-./full_recalc_batch.log}"

CONCURRENCY="${CONCURRENCY:-96}"
TOTAL_TIMEOUT_SECONDS="${TOTAL_TIMEOUT_SECONDS:-0}" # 0 => no timeout
PROGRESS_INTERVAL_S="${PROGRESS_INTERVAL_S:-}"
PROGRESS_STYLE="${PROGRESS_STYLE:-}" # log|single

BUILDINGS_PATH="${BUILDINGS_PATH:-${BUILDING_LOCAL_GEOJSON:-}}"
BUILDINGS_LAYER="${BUILDINGS_LAYER:-${BUILDING_GPKG_LAYER:-}}"
BUILDINGS_MODE="${BUILDINGS_MODE:-}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"
ERA5_TEMPLATE_PATH="${ERA5_TEMPLATE_PATH:-${ERA5_FILE_TEMPLATE:-}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENGINE_WRAPPER="${ENGINE_WRAPPER:-${SCRIPT_DIR}/batch-mobility-shadow.sh}"

# Optional: load a machine profile to avoid hardcoded paths in scripts.
# Priority:
# 1) $SHADOWMAP_ENV_FILE (explicit)
# 2) ShadowMap/.shadowmap.env (local, gitignored)
if [ "${SHADOWMAP_ENV_FILE:-}" = "/dev/null" ]; then
  : # explicitly skip loading any profile
elif [ -n "${SHADOWMAP_ENV_FILE:-}" ] && [ -f "${SHADOWMAP_ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  source "${SHADOWMAP_ENV_FILE}"
elif [ -f "${REPO_ROOT}/.shadowmap.env" ]; then
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.shadowmap.env"
fi

# Re-evaluate derived defaults after sourcing the profile.
BUILDINGS_PATH="${BUILDINGS_PATH:-${BUILDING_LOCAL_GEOJSON:-}}"
BUILDINGS_LAYER="${BUILDINGS_LAYER:-${BUILDING_GPKG_LAYER:-}}"
BUILDINGS_MODE="${BUILDINGS_MODE:-${MOBILITY_BUILDINGS_MODE:-preload}}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"
ERA5_TEMPLATE_PATH="${ERA5_TEMPLATE_PATH:-${ERA5_FILE_TEMPLATE:-}}"
PROGRESS_INTERVAL_S="${PROGRESS_INTERVAL_S:-${MOBILITY_PROGRESS_INTERVAL:-10}}"
PROGRESS_STYLE="${PROGRESS_STYLE:-${MOBILITY_PROGRESS_STYLE:-single}}"

if [ -z "${INPUT_ROOT}" ]; then
  echo "[Fatal] Missing INPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env" | tee -a "$LOG_FILE"
  exit 1
fi
if [ -z "${OUTPUT_ROOT}" ]; then
  echo "[Fatal] Missing OUTPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env" | tee -a "$LOG_FILE"
  exit 1
fi
if [ -z "${BACKUP_DIR}" ]; then
  BACKUP_DIR="${OUTPUT_ROOT}_backup"
fi

TASK_ROOT="${SHADOWMAP_TASK_ROOT:-${OUTPUT_ROOT}/_shadowmap_tasks}"
if [ -z "${BUCKET_DIR}" ]; then
  BUCKET_DIR="${TASK_ROOT}/buckets_part1_migrated"
fi

mkdir -p "$BUCKET_DIR"
mkdir -p "$BACKUP_DIR"
touch "$LOG_FILE"

if [ ! -f "$BUILDINGS_PATH" ]; then
  echo "[Fatal] Buildings file not found: $BUILDINGS_PATH" | tee -a "$LOG_FILE"
  exit 1
fi
if [ ! -f "$ENGINE_WRAPPER" ]; then
  echo "[Fatal] Engine wrapper not found: $ENGINE_WRAPPER" | tee -a "$LOG_FILE"
  exit 1
fi

engine_wrapper_cmd=("$ENGINE_WRAPPER")
if [ ! -x "$ENGINE_WRAPPER" ]; then
  # Some mounts (e.g. /media with noexec) drop executable bits. Running via bash is more robust.
  engine_wrapper_cmd=(bash "$ENGINE_WRAPPER")
fi

tmp_targets="$(mktemp -t mobility_targets.XXXXXX.txt)"
tmp_manifest="$(mktemp -t mobility_manifest.XXXXXX.tsv)"
cleanup() {
  rm -f "$tmp_targets" "$tmp_manifest" || true
}
trap cleanup EXIT

shopt -s nullglob
retry_files=("$BUCKET_DIR"/*_retry.txt)
shopt -u nullglob

total=${#retry_files[@]}
if [ "$total" -eq 0 ]; then
  echo "No remaining tasks under $BUCKET_DIR."
  exit 0
fi

echo "=== Full recompute (Python, batched): ${total} files (workers=${CONCURRENCY}) ==="
echo "=== Info: FILE-level recompute; *_retry.txt is treated as a file list (bucket contents ignored) ==="
echo "=== Progress: every ${PROGRESS_INTERVAL_S}s (set PROGRESS_INTERVAL_S=0 to disable) ==="
echo "=== Logs: stderr is appended to ${LOG_FILE} ==="

count=0
for bf in "${retry_files[@]}"; do
  count=$((count + 1))
  stem=$(basename "$bf" "_retry.txt")
  pure_stem=${stem%-sunlight}

  mapfile -t matches < <(find "$INPUT_ROOT" -name "${pure_stem}.csv" -print)
  if [ "${#matches[@]}" -eq 0 ]; then
    echo "[$count/$total] [Skip] Missing input for stem=${pure_stem}" | tee -a "$LOG_FILE"
    continue
  fi
  if [ "${#matches[@]}" -gt 1 ]; then
    echo "[$count/$total] [Warn] Multiple inputs matched ${pure_stem}.csv; picking the first after sort:" >> "$LOG_FILE"
    printf '  - %s\n' "${matches[@]}" >> "$LOG_FILE"
    mapfile -t matches < <(printf '%s\n' "${matches[@]}" | sort)
  fi
  input_csv="${matches[0]}"

  rel_path="${input_csv#$INPUT_ROOT/}"
  out_dir="$OUTPUT_ROOT/$(dirname "$rel_path")"
  mkdir -p "$out_dir"

  base="$(basename "$input_csv" .csv)"
  expected_out="$out_dir/${base}-sunlight.csv"

  if [ -f "$expected_out" ]; then
    backup_path="$BACKUP_DIR/$(basename "$expected_out")_$(date +%s)"
    mv "$expected_out" "$backup_path"
    echo "[$count/$total] [Backup] $expected_out -> $backup_path" >> "$LOG_FILE"
  fi

  printf '%s\n' "$input_csv" >> "$tmp_targets"
  printf '%s\t%s\n' "$bf" "$expected_out" >> "$tmp_manifest"
done

if [ ! -s "$tmp_targets" ]; then
  echo "[Fatal] No valid targets collected; check INPUT_ROOT and BUCKET_DIR." | tee -a "$LOG_FILE"
  exit 2
fi

MOBILITY_SKIP_MISSING_TARGETS="${MOBILITY_SKIP_MISSING_TARGETS:-true}"
export MOBILITY_SKIP_MISSING_TARGETS

cmd=("${engine_wrapper_cmd[@]}" --engine python)
cmd+=(--input "$INPUT_ROOT")
cmd+=(--output "$OUTPUT_ROOT")
cmd+=(--buildings "$BUILDINGS_PATH")
if [ -n "$BUILDINGS_LAYER" ]; then
  cmd+=(--buildings-layer "$BUILDINGS_LAYER")
fi
cmd+=(--buildings-mode "$BUILDINGS_MODE")
if [ -n "$CANOPY_PATH" ]; then
  cmd+=(--canopy "$CANOPY_PATH")
fi
if [ -n "$ERA5_TEMPLATE_PATH" ]; then
  cmd+=(--era5-template "$ERA5_TEMPLATE_PATH")
fi
cmd+=(--concurrency "$CONCURRENCY")
cmd+=(--progress-interval "$PROGRESS_INTERVAL_S")
cmd+=(--progress-style "$PROGRESS_STYLE")
cmd+=(--targets-file "$tmp_targets")
cmd+=(--force)

echo "[Run] ${cmd[*]}"

rc=0
if [ "${TOTAL_TIMEOUT_SECONDS}" != "0" ]; then
  if timeout "${TOTAL_TIMEOUT_SECONDS}s" "${cmd[@]}" 2>>"$LOG_FILE"; then
    rc=0
  else
    rc=$?
  fi
else
  if "${cmd[@]}" 2>>"$LOG_FILE"; then
    rc=0
  else
    rc=$?
  fi
fi

ok=0
failed=0
while IFS=$'\t' read -r retry_file expected_out; do
  if [ -f "$expected_out" ]; then
    rm -f "$retry_file"
    ok=$((ok + 1))
  else
    failed=$((failed + 1))
    echo "[Failed] expected output missing: $expected_out" >> "$LOG_FILE"
  fi
done < "$tmp_manifest"

echo "=== Summary: ok=${ok} failed=${failed} exit=${rc} ==="
exit "${rc}"
