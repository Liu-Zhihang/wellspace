#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Build a single canopy VRT from downloaded canopy-height GeoTIFF tiles.

Usage:
  ./scripts/ops/canopy/build_canopy_vrt.sh [options]

Options:
  --input-dir PATH      Directory containing downloaded GeoTIFF tiles
  --output PATH         Output VRT path
  --pattern GLOB        File pattern to include (default: *.tif)
  --gdalbuildvrt PATH   gdalbuildvrt binary to use (default: gdalbuildvrt)
  -h, --help            Show this help

Example:
  ./scripts/ops/canopy/build_canopy_vrt.sh \
    --input-dir ~/datasets/wellspace_v2/shadowmap/infra/canopy/meta_wri_chm/raw_tiles/us_subset \
    --output ~/datasets/wellspace_v2/shadowmap/infra/canopy/meta_wri_chm/derived/us_canopy_height.vrt
EOF
}

DATA_ROOT="${SHADOWMAP_DATA_ROOT:-${HOME}/datasets/wellspace_v2/shadowmap}"
INPUT_DIR="${DATA_ROOT}/infra/canopy/meta_wri_chm/raw_tiles"
OUTPUT_PATH="${DATA_ROOT}/infra/canopy/meta_wri_chm/derived/canopy_height.vrt"
PATTERN="*.tif"
GDALBUILDVRT_BIN="${GDALBUILDVRT_BIN:-gdalbuildvrt}"

while [ $# -gt 0 ]; do
  case "$1" in
    --input-dir)
      INPUT_DIR="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_PATH="${2:-}"
      shift 2
      ;;
    --pattern)
      PATTERN="${2:-}"
      shift 2
      ;;
    --gdalbuildvrt)
      GDALBUILDVRT_BIN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[Fatal] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v "${GDALBUILDVRT_BIN}" >/dev/null 2>&1; then
  echo "[Fatal] gdalbuildvrt not found at '${GDALBUILDVRT_BIN}'." >&2
  echo "        Install GDAL before building a canopy VRT." >&2
  exit 1
fi

if [ ! -d "${INPUT_DIR}" ]; then
  echo "[Fatal] Input directory not found: ${INPUT_DIR}" >&2
  exit 1
fi

tmp_list="$(mktemp)"
trap 'rm -f "${tmp_list}"' EXIT

find -L "${INPUT_DIR}" -type f -name "${PATTERN}" ! -name 'CHM_acquisition_date.tif' | sort > "${tmp_list}"
tile_count="$(wc -l < "${tmp_list}" | tr -d '[:space:]')"

if [ "${tile_count}" = "0" ]; then
  echo "[Fatal] No input tiles found under ${INPUT_DIR} matching ${PATTERN}" >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT_PATH}")"

echo "[Info] Building VRT from ${tile_count} canopy tiles"
echo "[Info] Input=${INPUT_DIR}"
echo "[Info] Output=${OUTPUT_PATH}"

"${GDALBUILDVRT_BIN}" -overwrite -input_file_list "${tmp_list}" "${OUTPUT_PATH}"

echo "[Done] VRT written to ${OUTPUT_PATH}"
