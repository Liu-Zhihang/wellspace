#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/import_gba_lod1_dir.sh \
    --dir /path/to/northamerica \
    --table public.buildings_na_lod1

Options:
  --dir PATH         Directory containing *.geojson tiles
  --table NAME       Target table (schema.table)
  --match GLOB       Optional filename glob, defaults to *.geojson
  --skip-existing    Skip tiles already present in the target table
  --replace-tile     Replace existing rows for each tile before inserting
EOF
}

dir_path=""
target_table=""
match_glob="*.geojson"
skip_existing="false"
replace_tile="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)
      dir_path="${2:-}"
      shift 2
      ;;
    --table)
      target_table="${2:-}"
      shift 2
      ;;
    --match)
      match_glob="${2:-}"
      shift 2
      ;;
    --skip-existing)
      skip_existing="true"
      shift
      ;;
    --replace-tile)
      replace_tile="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[Fatal] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "${dir_path}" ] || [ -z "${target_table}" ]; then
  usage >&2
  exit 2
fi

if [ ! -d "${dir_path}" ]; then
  echo "[Fatal] Missing directory: ${dir_path}" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tile_script="${script_dir}/import_gba_lod1_tile.sh"
database_name="${PGDATABASE:-shadowmap_gis}"
psql_cmd="${SHADOWMAP_POSTGIS_PSQL:-sudo -u postgres psql}"

mapfile -d '' files < <(find -L "${dir_path}" -maxdepth 1 -type f -name "${match_glob}" -print0 | sort -z)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[Fatal] No files matched ${dir_path}/${match_glob}" >&2
  exit 1
fi

for file_path in "${files[@]}"; do
  tile_id="$(basename "${file_path}" .geojson)"
  if [ "${skip_existing}" = "true" ]; then
    if ${psql_cmd} -d "${database_name}" -Atqc "SELECT 1 FROM ${target_table} WHERE tile_id = '${tile_id}' LIMIT 1;" | grep -qx '1'; then
      echo "[Skip] ${tile_id} already exists in ${target_table}"
      continue
    fi
  fi
  cmd=("${tile_script}" --file "${file_path}" --table "${target_table}")
  if [ "${replace_tile}" = "true" ]; then
    cmd+=(--replace-tile)
  fi
  "${cmd[@]}"
done
