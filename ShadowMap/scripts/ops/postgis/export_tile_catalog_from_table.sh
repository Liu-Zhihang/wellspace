#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/export_tile_catalog_from_table.sh --output PATH [options]

Options:
  --table NAME        Source table, defaults to public.buildings
  --output PATH       Output JSON path
  --region NAME       Region label for each tile entry
  --description TEXT  Description label for each tile entry

Environment:
  PGDATABASE               Defaults to shadowmap_gis
  SHADOWMAP_POSTGIS_PSQL   Defaults to "sudo -u postgres psql"
EOF
}

table_name="public.buildings"
output_path=""
region_label=""
description_label=""

while [ $# -gt 0 ]; do
  case "$1" in
    --table)
      table_name="${2:-}"
      shift 2
      ;;
    --output)
      output_path="${2:-}"
      shift 2
      ;;
    --region)
      region_label="${2:-}"
      shift 2
      ;;
    --description)
      description_label="${2:-}"
      shift 2
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

if [ -z "${output_path}" ]; then
  echo "[Fatal] --output is required." >&2
  exit 1
fi

if [[ ! "${table_name}" =~ ^[A-Za-z0-9_.]+$ ]]; then
  echo "[Fatal] Unsafe table name: ${table_name}" >&2
  exit 1
fi

database_name="${PGDATABASE:-shadowmap_gis}"
psql_cmd="${SHADOWMAP_POSTGIS_PSQL:-sudo -u postgres psql}"
output_dir="$(cd "$(dirname "${output_path}")" && pwd)"
output_file="${output_dir}/$(basename "${output_path}")"
tmp_file="${output_file}.tmp"

mkdir -p "${output_dir}"

mapfile -t tile_ids < <(
  ${psql_cmd} -d "${database_name}" -Atqc \
    "SELECT DISTINCT tile_id FROM ${table_name} WHERE tile_id IS NOT NULL ORDER BY tile_id;"
)

if [ "${#tile_ids[@]}" -eq 0 ]; then
  echo "[Fatal] No tile_id rows found in ${table_name}" >&2
  exit 1
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

region_json="$(json_escape "${region_label}")"
description_json="$(json_escape "${description_label}")"

{
  printf '[\n'
  for idx in "${!tile_ids[@]}"; do
    tile_id="${tile_ids[${idx}]}"

    if [[ ! "${tile_id}" =~ ^([we])([0-9]{3})_([ns])([0-9]{2})_([we])([0-9]{3})_([ns])([0-9]{2})$ ]]; then
      echo "[Fatal] Unrecognized tile_id format: ${tile_id}" >&2
      exit 1
    fi

    lon_a=$((10#${BASH_REMATCH[2]}))
    lat_a=$((10#${BASH_REMATCH[4]}))
    lon_b=$((10#${BASH_REMATCH[6]}))
    lat_b=$((10#${BASH_REMATCH[8]}))

    if [ "${BASH_REMATCH[1]}" = "w" ]; then lon_a=$((-lon_a)); fi
    if [ "${BASH_REMATCH[3]}" = "s" ]; then lat_a=$((-lat_a)); fi
    if [ "${BASH_REMATCH[5]}" = "w" ]; then lon_b=$((-lon_b)); fi
    if [ "${BASH_REMATCH[7]}" = "s" ]; then lat_b=$((-lat_b)); fi

    west="$(awk -v a="${lon_a}" -v b="${lon_b}" 'BEGIN { printf "%g", (a < b ? a : b) + 0 }')"
    east="$(awk -v a="${lon_a}" -v b="${lon_b}" 'BEGIN { printf "%g", (a > b ? a : b) + 0 }')"
    south="$(awk -v a="${lat_a}" -v b="${lat_b}" 'BEGIN { printf "%g", (a < b ? a : b) + 0 }')"
    north="$(awk -v a="${lat_a}" -v b="${lat_b}" 'BEGIN { printf "%g", (a > b ? a : b) + 0 }')"

    printf '  {\n'
    printf '    "tileId": "%s",\n' "$(json_escape "${tile_id}")"
    printf '    "minLon": %s,\n' "${west}"
    printf '    "minLat": %s,\n' "${south}"
    printf '    "maxLon": %s,\n' "${east}"
    printf '    "maxLat": %s' "${north}"

    if [ -n "${region_label}" ]; then
      printf ',\n    "region": "%s"' "${region_json}"
    fi

    if [ -n "${description_label}" ]; then
      printf ',\n    "description": "%s"' "${description_json}"
    fi

    printf '\n  }'
    if [ "${idx}" -lt "$(( ${#tile_ids[@]} - 1 ))" ]; then
      printf ','
    fi
    printf '\n'
  done
  printf ']\n'
} > "${tmp_file}"

mv "${tmp_file}" "${output_file}"
echo "[OK] Wrote ${#tile_ids[@]} tile catalog entries to ${output_file}"
