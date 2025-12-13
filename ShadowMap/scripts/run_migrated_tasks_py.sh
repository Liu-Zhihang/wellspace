#!/bin/bash
set -euo pipefail

# Pure Python migration runner for Server B.
# Replaces the Node invocation with `batch_mobility_shadow.py` while keeping the
# same bucket retry file layout and directory conventions.

export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export NO_PROXY=localhost,127.0.0.1
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

BUCKET_DIR="${BUCKET_DIR:-/tmp/buckets_part1}"
OUTPUT_ROOT="${OUTPUT_ROOT:-/media/liuzhihang/repo/projects/wellspace/GLAN_processed}"
INPUT_ROOT_BASE="${INPUT_ROOT_BASE:-/media/liuzhihang/repo/projects/wellspace/GLAN/PHASE1/spatial_temporal_merge}"

PY_SCRIPT="${PY_SCRIPT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/batch_mobility_shadow.py"}"

CONC="${CONC:-8}"
TIMEOUT="${TIMEOUT:-2400}"

BUILDINGS_PATH="${BUILDINGS_PATH:-${BUILDING_LOCAL_GEOJSON:-}}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"
ERA5_TEMPLATE_PATH="${ERA5_TEMPLATE_PATH:-${ERA5_FILE_TEMPLATE:-}}"

echo "=== Server B Python runner ==="
echo "Bucket dir: ${BUCKET_DIR}"
echo "Input root: ${INPUT_ROOT_BASE}"
echo "Output root: ${OUTPUT_ROOT}"
echo "Script: ${PY_SCRIPT}"
echo "Concurrency: ${CONC} | Timeout: ${TIMEOUT}s"
echo "Buildings: ${BUILDINGS_PATH:-<unset>}"
echo "Canopy: ${CANOPY_PATH:-<unset>}"
echo "ERA5 template: ${ERA5_TEMPLATE_PATH:-<unset>}"

if [ -z "${BUILDINGS_PATH}" ]; then
  echo "[Fatal] Missing buildings path. Set BUILDING_LOCAL_GEOJSON or BUILDINGS_PATH." >&2
  exit 1
fi

if [ ! -f "${BUILDINGS_PATH}" ]; then
  echo "[Fatal] Buildings file not found: ${BUILDINGS_PATH}" >&2
  exit 1
fi

shopt -s nullglob
files=("${BUCKET_DIR}"/*_retry.txt)
shopt -u nullglob
total=${#files[@]}

if [ "${total}" -eq 0 ]; then
  echo "No remaining tasks under ${BUCKET_DIR}."
  exit 0
fi

count=0
for bf in "${files[@]}"; do
  count=$((count + 1))
  [ -f "${bf}" ] || continue

  stem=$(basename "${bf}" "_retry.txt")

  target_csv=$(find "${OUTPUT_ROOT}" -name "${stem}.csv" -print -quit)
  [ -z "${target_csv}" ] && target_csv=$(find "${OUTPUT_ROOT}" -name "${stem}-sunlight.csv" -print -quit)

  if [ -z "${target_csv}" ]; then
    echo "[${count}/${total}] [Skip] missing output CSV for stem: ${stem}"
    continue
  fi

  target_dir=$(dirname "${target_csv}")
  input_dir="${target_dir/${OUTPUT_ROOT}/${INPUT_ROOT_BASE}}"

  input_dir=$(realpath "${input_dir}")
  target_dir=$(realpath "${target_dir}")

  pure_stem=${stem%-sunlight}
  if [ -f "${input_dir}/${pure_stem}.csv" ]; then
    source_name="${pure_stem}.csv"
  elif [ -f "${input_dir}/${stem}.csv" ]; then
    source_name="${stem}.csv"
  else
    echo "[${count}/${total}] [Skip] missing source CSV: ${input_dir}/${pure_stem}.csv"
    continue
  fi

  echo "[${count}/${total}] Processing: ${source_name}"

  cmd=(timeout "${TIMEOUT}s" python3 "${PY_SCRIPT}")
  cmd+=(--input "${input_dir}")
  cmd+=(--output "${target_dir}")
  cmd+=(--buildings "${BUILDINGS_PATH}")
  if [ -n "${CANOPY_PATH}" ]; then
    cmd+=(--canopy "${CANOPY_PATH}")
  fi
  if [ -n "${ERA5_TEMPLATE_PATH}" ]; then
    cmd+=(--era5-template "${ERA5_TEMPLATE_PATH}")
  fi
  cmd+=(--concurrency "${CONC}")
  cmd+=(--buckets-file "${bf}")
  cmd+=(--target-file "${source_name}")

  "${cmd[@]}"

  rc=$?
  if [ ${rc} -eq 0 ]; then
    echo "  [OK] remove ${bf}"
    rm "${bf}"
  elif [ ${rc} -eq 124 ]; then
    echo "  [Timeout] ${stem} (rc=124)"
  else
    echo "  [Failed] ${stem} (rc=${rc})"
  fi
done

echo "=== All tasks completed ==="
