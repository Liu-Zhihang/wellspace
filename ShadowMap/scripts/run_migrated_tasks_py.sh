#!/bin/bash
set -euo pipefail

# Pure Python migration runner for Server B.
# Replaces the Node invocation with `batch_mobility_shadow.py` while keeping the
# same bucket retry file layout and directory conventions.

export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export NO_PROXY=localhost,127.0.0.1
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY http_proxy https_proxy

BUCKET_DIR="${BUCKET_DIR:-}"
OUTPUT_ROOT="${OUTPUT_ROOT:-}"
INPUT_ROOT_BASE="${INPUT_ROOT_BASE:-${INPUT_ROOT:-}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENGINE_WRAPPER="${ENGINE_WRAPPER:-${SCRIPT_DIR}/batch-mobility-shadow.sh}"

CONC="${CONC:-8}"
TIMEOUT="${TIMEOUT:-2400}"

BUILDINGS_PATH="${BUILDINGS_PATH:-${BUILDING_LOCAL_GEOJSON:-}}"
BUILDINGS_LAYER="${BUILDINGS_LAYER:-${BUILDING_GPKG_LAYER:-}}"
BUILDINGS_MODE="${BUILDINGS_MODE:-${MOBILITY_BUILDINGS_MODE:-preload}}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"
ERA5_TEMPLATE_PATH="${ERA5_TEMPLATE_PATH:-${ERA5_FILE_TEMPLATE:-}}"

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

OUTPUT_ROOT="${OUTPUT_ROOT:-}"
INPUT_ROOT_BASE="${INPUT_ROOT_BASE:-${INPUT_ROOT:-}}"
BUILDINGS_PATH="${BUILDINGS_PATH:-${BUILDING_LOCAL_GEOJSON:-}}"
BUILDINGS_LAYER="${BUILDINGS_LAYER:-${BUILDING_GPKG_LAYER:-}}"
BUILDINGS_MODE="${BUILDINGS_MODE:-${MOBILITY_BUILDINGS_MODE:-preload}}"
CANOPY_PATH="${CANOPY_PATH:-${SHADOW_ENGINE_CANOPY_RASTER_PATH:-${CANOPY_RASTER_PATH:-}}}"
ERA5_TEMPLATE_PATH="${ERA5_TEMPLATE_PATH:-${ERA5_FILE_TEMPLATE:-}}"

if [ -z "${OUTPUT_ROOT}" ]; then
  echo "[Fatal] Missing OUTPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env" >&2
  exit 1
fi
if [ -z "${INPUT_ROOT_BASE}" ]; then
  echo "[Fatal] Missing INPUT_ROOT_BASE/INPUT_ROOT. Set it in env or source ShadowMap/.shadowmap.env" >&2
  exit 1
fi

TASK_ROOT="${SHADOWMAP_TASK_ROOT:-${OUTPUT_ROOT}/_shadowmap_tasks}"
if [ -z "${BUCKET_DIR}" ]; then
  BUCKET_DIR="${TASK_ROOT}/buckets_part1_migrated"
fi
mkdir -p "$BUCKET_DIR"

echo "=== Server B Python runner ==="
echo "Bucket dir: ${BUCKET_DIR}"
echo "Input root: ${INPUT_ROOT_BASE}"
echo "Output root: ${OUTPUT_ROOT}"
echo "Engine wrapper: ${ENGINE_WRAPPER}"
echo "Concurrency: ${CONC} | Timeout: ${TIMEOUT}s"
echo "Buildings: ${BUILDINGS_PATH:-<unset>}"
echo "Buildings layer: ${BUILDINGS_LAYER:-<unset>}"
echo "Buildings mode: ${BUILDINGS_MODE}"
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

engine_wrapper_cmd=("${ENGINE_WRAPPER}")
if [ ! -x "${ENGINE_WRAPPER}" ]; then
  engine_wrapper_cmd=(bash "${ENGINE_WRAPPER}")
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

  cmd=(timeout "${TIMEOUT}s" "${engine_wrapper_cmd[@]}" --engine python)
  cmd+=(--input "${input_dir}")
  cmd+=(--output "${target_dir}")
  cmd+=(--buildings "${BUILDINGS_PATH}")
  if [ -n "${BUILDINGS_LAYER}" ]; then
    cmd+=(--buildings-layer "${BUILDINGS_LAYER}")
  fi
  cmd+=(--buildings-mode "${BUILDINGS_MODE}")
  if [ -n "${CANOPY_PATH}" ]; then
    cmd+=(--canopy "${CANOPY_PATH}")
  fi
  if [ -n "${ERA5_TEMPLATE_PATH}" ]; then
    cmd+=(--era5-template "${ERA5_TEMPLATE_PATH}")
  fi
  cmd+=(--concurrency "${CONC}")
  cmd+=(--buckets-file "${bf}")
  cmd+=(--target-file "${source_name}")

  # NOTE: the script uses `set -e`, so capture exit codes through an if/else
  # block to avoid aborting the entire batch on the first failure/timeout.
  if "${cmd[@]}"; then
    rc=0
  else
    rc=$?
  fi
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
