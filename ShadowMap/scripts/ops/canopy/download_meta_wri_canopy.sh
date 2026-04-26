#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Download canopy-height GeoTIFF tiles from the public Meta/WRI AWS dataset.

Usage:
  ./scripts/ops/canopy/download_meta_wri_canopy.sh [options]

Options:
  --source NAME         Dataset source: global|california (default: global)
  --manifest PATH       Text file with one tile per line. Each line can be:
                        - full https URL
                        - full s3:// URI
                        - bucket-relative key
                        - bare file name (resolved under the chosen source prefix)
  --jobs N              Parallel download workers for manifest mode (default: 8)
  --output-dir PATH     Destination directory for downloaded GeoTIFFs
  --aws-bin PATH        AWS CLI binary to use (default: aws)
  --allow-full-global   Permit a full recursive sync of the global CHM prefix
  --dry-run             Print planned downloads without fetching
  -h, --help            Show this help

Examples:
  # Recommended: manifest-driven subset for US tiles
  ./scripts/ops/canopy/download_meta_wri_canopy.sh \
    --source global \
    --manifest ~/datasets/wellspace_v2/shadowmap/infra/canopy/meta_wri_chm/manifests/us_tiles.txt

  # Small regional bucket
  ./scripts/ops/canopy/download_meta_wri_canopy.sh --source california

Notes:
  - The global prefix is large. A manifest is strongly recommended.
  - This dataset is canopy height, not precomputed shade.
  - Public source registry:
    https://registry.opendata.aws/dataforgood-fb-forests/
EOF
}

DATA_ROOT="${SHADOWMAP_DATA_ROOT:-${HOME}/datasets/wellspace_v2/shadowmap}"
SOURCE_NAME="global"
MANIFEST_PATH=""
OUTPUT_DIR=""
AWS_BIN="${AWS_BIN:-aws}"
ALLOW_FULL_GLOBAL="0"
DRY_RUN="0"
JOBS="${JOBS:-8}"
BUCKET="dataforgood-fb-data"

GLOBAL_PREFIX="forests/v1/alsgedi_global_v6_float/chm/"
CALIFORNIA_PREFIX="forests/v1/California/alsgedi_ca_v5_float/chm/"

while [ $# -gt 0 ]; do
  case "$1" in
    --source)
      SOURCE_NAME="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --aws-bin)
      AWS_BIN="${2:-}"
      shift 2
      ;;
    --allow-full-global)
      ALLOW_FULL_GLOBAL="1"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
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

case "${SOURCE_NAME}" in
  global)
    SOURCE_PREFIX="${GLOBAL_PREFIX}"
    SOURCE_SUBDIR="global"
    ;;
  california)
    SOURCE_PREFIX="${CALIFORNIA_PREFIX}"
    SOURCE_SUBDIR="california"
    ;;
  *)
    echo "[Fatal] Unsupported source '${SOURCE_NAME}'. Use global or california." >&2
    exit 1
    ;;
esac

if [ -z "${OUTPUT_DIR}" ]; then
  OUTPUT_DIR="${DATA_ROOT}/infra/canopy/meta_wri_chm/raw_tiles/${SOURCE_SUBDIR}"
fi
mkdir -p "${OUTPUT_DIR}"

download_one_url() {
  local url="$1"
  local dest="$2"

  if [ "${DRY_RUN}" = "1" ]; then
    echo "[DryRun] ${url} -> ${dest}"
    return 0
  fi

  mkdir -p "$(dirname "${dest}")"
  python3 - "$url" "$dest" <<'PY'
import sys
import urllib.request
from pathlib import Path

url, dest = sys.argv[1], sys.argv[2]
dest_path = Path(dest)
tmp_path = dest_path.with_name(f"{dest_path.name}.part")
with urllib.request.urlopen(url, timeout=120) as response, open(tmp_path, "wb") as out:
    while True:
        chunk = response.read(1024 * 1024)
        if not chunk:
            break
        out.write(chunk)
tmp_path.replace(dest_path)
print(dest)
PY
}

normalize_to_key() {
  local raw="$1"

  if [[ "${raw}" =~ ^https?:// ]]; then
    printf '%s\n' "${raw}"
    return 0
  fi

  if [[ "${raw}" == s3://* ]]; then
    raw="${raw#s3://}"
    raw="${raw#${BUCKET}/}"
    printf 'https://%s.s3.amazonaws.com/%s\n' "${BUCKET}" "${raw}"
    return 0
  fi

  raw="${raw#./}"
  raw="${raw#/}"
  if [[ "${raw}" != forests/* ]]; then
    raw="${SOURCE_PREFIX}${raw}"
  fi
  printf 'https://%s.s3.amazonaws.com/%s\n' "${BUCKET}" "${raw}"
}

if [ -n "${MANIFEST_PATH}" ]; then
  if [ ! -f "${MANIFEST_PATH}" ]; then
    echo "[Fatal] Manifest not found: ${MANIFEST_PATH}" >&2
    exit 1
  fi

  echo "[Info] Source=${SOURCE_NAME} manifest=${MANIFEST_PATH}"
  echo "[Info] Output=${OUTPUT_DIR}"

  if ! [[ "${JOBS}" =~ ^[0-9]+$ ]] || [ "${JOBS}" -lt 1 ]; then
    echo "[Fatal] --jobs must be a positive integer." >&2
    exit 1
  fi

  tmp_jobs="$(mktemp)"
  trap 'rm -f "${tmp_jobs}"' EXIT

  downloaded=0
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "${line}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -z "${line}" ]; then
      continue
    fi

    url="$(normalize_to_key "${line}")"
    file_name="$(basename "${url%%\?*}")"
    printf '%s\t%s\n' "${url}" "${OUTPUT_DIR}/${file_name}" >> "${tmp_jobs}"
    downloaded=$((downloaded + 1))
  done < "${MANIFEST_PATH}"

  if [ "${DRY_RUN}" = "1" ]; then
    while IFS=$'\t' read -r url dest; do
      [ -n "${url}" ] || continue
      echo "[DryRun] ${url} -> ${dest}"
    done < "${tmp_jobs}"
    echo "[Done] Manifest downloads processed=${downloaded} output=${OUTPUT_DIR}"
    exit 0
  fi

  export SHADOWMAP_CANOPY_TMP_JOBS="${tmp_jobs}"
  export SHADOWMAP_CANOPY_JOBS="${JOBS}"
  /usr/bin/env python3 - <<'PY'
import concurrent.futures
import os
import sys
import urllib.request

jobs_file = os.environ["SHADOWMAP_CANOPY_TMP_JOBS"]
max_workers = int(os.environ.get("SHADOWMAP_CANOPY_JOBS", "8"))

jobs = []
with open(jobs_file, "r", encoding="utf-8") as handle:
    for raw in handle:
        raw = raw.rstrip("\n")
        if not raw:
            continue
        url, dest = raw.split("\t", 1)
        jobs.append((url, dest))

def fetch(job):
    url, dest = job
    if os.path.exists(dest):
        return ("skip", dest)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp_dest = f"{dest}.part"
    with urllib.request.urlopen(url, timeout=120) as response, open(tmp_dest, "wb") as out:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp_dest, dest)
    return ("ok", dest)

completed = 0
total = len(jobs)
failed = False

with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
    future_map = {pool.submit(fetch, job): job for job in jobs}
    for future in concurrent.futures.as_completed(future_map):
        url, dest = future_map[future]
        completed += 1
        try:
            status, path = future.result()
            print(f"[{completed}/{total}] {status} {path}", flush=True)
        except Exception as exc:
            failed = True
            print(f"[{completed}/{total}] error {dest}: {exc}", file=sys.stderr, flush=True)

if failed:
    raise SystemExit(1)
PY

  echo "[Done] Manifest downloads processed=${downloaded} output=${OUTPUT_DIR}"
  exit 0
fi

if [ "${SOURCE_NAME}" = "global" ] && [ "${ALLOW_FULL_GLOBAL}" != "1" ]; then
  echo "[Fatal] Refusing full global recursive download without --allow-full-global." >&2
  echo "        Use --manifest for a reproducible subset, or pass --allow-full-global intentionally." >&2
  exit 1
fi

if ! command -v "${AWS_BIN}" >/dev/null 2>&1; then
  echo "[Fatal] AWS CLI not found at '${AWS_BIN}'." >&2
  echo "        Install awscli, or use --manifest which can fall back to Python HTTPS downloads." >&2
  exit 1
fi

echo "[Info] Recursive public S3 sync from s3://${BUCKET}/${SOURCE_PREFIX}"
echo "[Info] Output=${OUTPUT_DIR}"
if [ "${DRY_RUN}" = "1" ]; then
  echo "[DryRun] ${AWS_BIN} s3 sync --no-sign-request s3://${BUCKET}/${SOURCE_PREFIX} ${OUTPUT_DIR}"
  exit 0
fi

"${AWS_BIN}" s3 sync \
  --no-sign-request \
  "s3://${BUCKET}/${SOURCE_PREFIX}" \
  "${OUTPUT_DIR}" \
  --exclude "*" \
  --include "*.tif" \
  --include "*.tif.msk"

echo "[Done] Synced public canopy tiles into ${OUTPUT_DIR}"
