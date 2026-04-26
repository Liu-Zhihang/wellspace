#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/canopy/sync_tiles_index.sh [options]

Options:
  --source URL     Source tiles.geojson URL
  --output PATH    Output tiles.geojson path
  --force          Re-download even if the output already exists
  -h, --help       Show this help
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"

# shellcheck disable=SC1091
source "${repo_root}/scripts/lib/load_shadowmap_env.sh"
shadowmap_load_env "${repo_root}"

source_url="${MOBILITY_CANOPY_TILES_INDEX_SOURCE:-https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/tiles.geojson}"
shadowmap_data_root="${SHADOWMAP_DATA_ROOT:-${HOME}/datasets/wellspace_v2/shadowmap}"
output_path="${shadowmap_data_root}/infra/canopy/meta_wri_chm/index/tiles.geojson"
force="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --source) source_url="${2:-}"; shift 2 ;;
    --output) output_path="${2:-}"; shift 2 ;;
    --force) force="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[Fatal] Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

output_path="$(python3 -c 'import os,sys; print(os.path.realpath(os.path.expanduser(sys.argv[1])))' "${output_path}")"
mkdir -p "$(dirname "${output_path}")"

if [ -f "${output_path}" ] && [ "${force}" != "true" ]; then
  echo "[Info] tiles index already exists: ${output_path}"
  exit 0
fi

tmp_path="${output_path}.part"
rm -f "${tmp_path}"

if command -v curl >/dev/null 2>&1; then
  curl --fail --location --retry 3 --connect-timeout 30 --output "${tmp_path}" "${source_url}"
elif command -v wget >/dev/null 2>&1; then
  wget --tries=3 --timeout=30 -O "${tmp_path}" "${source_url}"
else
  echo "[Fatal] curl or wget is required to download tiles.geojson" >&2
  exit 1
fi

python3 - "${tmp_path}" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
if payload.get("type") != "FeatureCollection":
    raise SystemExit("Downloaded tiles index is not a GeoJSON FeatureCollection")
PY

mv -f "${tmp_path}" "${output_path}"
echo "[OK] tiles index saved to ${output_path}"
