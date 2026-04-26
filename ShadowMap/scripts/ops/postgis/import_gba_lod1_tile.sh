#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/import_gba_lod1_tile.sh \
    --file /path/to/tile.geojson \
    --table public.buildings_na_lod1

Options:
  --file PATH        Source GeoJSON tile
  --table NAME       Target table (schema.table)
  --tile-id ID       Override tile_id; defaults to filename stem
  --replace-tile     Delete existing rows for the tile before inserting
  --keep-staging     Keep staging table for debugging

Environment:
  PGDATABASE               Defaults to shadowmap_gis
  SHADOWMAP_POSTGIS_PSQL   Defaults to "sudo -u postgres psql"
  SHADOWMAP_POSTGIS_OGR2OGR Defaults to "sudo -u postgres ogr2ogr"
EOF
}

file_path=""
target_table=""
tile_id=""
replace_tile="false"
keep_staging="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --file)
      file_path="${2:-}"
      shift 2
      ;;
    --table)
      target_table="${2:-}"
      shift 2
      ;;
    --tile-id)
      tile_id="${2:-}"
      shift 2
      ;;
    --replace-tile)
      replace_tile="true"
      shift
      ;;
    --keep-staging)
      keep_staging="true"
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

if [ -z "${file_path}" ] || [ -z "${target_table}" ]; then
  usage >&2
  exit 2
fi

if [ ! -f "${file_path}" ]; then
  echo "[Fatal] Missing source file: ${file_path}" >&2
  exit 1
fi

if [ -z "${tile_id}" ]; then
  tile_id="$(basename "${file_path}" .geojson)"
fi

if [[ "${target_table}" != *.* ]]; then
  echo "[Fatal] --table must be schema-qualified, for example public.buildings_na_lod1" >&2
  exit 1
fi

schema_name="${target_table%%.*}"
table_name="${target_table#*.}"
database_name="${PGDATABASE:-shadowmap_gis}"
psql_cmd="${SHADOWMAP_POSTGIS_PSQL:-sudo -u postgres psql}"
ogr2ogr_cmd="${SHADOWMAP_POSTGIS_OGR2OGR:-sudo -u postgres ogr2ogr}"
layer_name="$(ogrinfo -ro -so "${file_path}" 2>/dev/null | awk -F': ' '/^[0-9]+: / {sub(/ \(.*$/, "", $2); print $2; exit}')"

if [ -z "${layer_name}" ]; then
  echo "[Fatal] Could not detect layer name from ${file_path}" >&2
  exit 1
fi

staging_table="_staging_${table_name}_$(printf '%s' "${tile_id}" | tr -c '[:alnum:]' '_' | cut -c1-40)"
staging_target="${schema_name}.${staging_table}"

cleanup() {
  if [ "${keep_staging}" != "true" ]; then
    ${psql_cmd} -d "${database_name}" -c "DROP TABLE IF EXISTS ${staging_target};" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

${psql_cmd} -d "${database_name}" -c "DROP TABLE IF EXISTS ${staging_target};" >/dev/null

${ogr2ogr_cmd} \
  -f PostgreSQL \
  PG:"dbname=${database_name}" \
  "${file_path}" \
  -overwrite \
  -nln "${staging_table}" \
  -lco "SCHEMA=${schema_name}" \
  -nlt PROMOTE_TO_MULTI \
  -s_srs EPSG:3857 \
  -t_srs EPSG:4326 \
  -lco GEOMETRY_NAME=geom \
  -dialect SQLite \
  -sql "SELECT *, '${tile_id}' AS tile_id FROM \"${layer_name}\""

validation_counts="$(${psql_cmd} -d "${database_name}" -Atqc "SELECT count(*) FILTER (WHERE geom IS NULL), count(*) FILTER (WHERE geom IS NOT NULL), count(*) FROM ${staging_target};")"
null_count="${validation_counts%%|*}"
rest="${validation_counts#*|}"
nonnull_count="${rest%%|*}"
total_count="${validation_counts##*|}"

if [ "${total_count}" = "0" ]; then
  echo "[Fatal] Staging import produced zero rows for ${tile_id}" >&2
  exit 1
fi

if [ "${null_count}" != "0" ]; then
  echo "[Fatal] Staging import produced ${null_count} NULL geometries for ${tile_id}" >&2
  exit 1
fi

if [ "${replace_tile}" = "true" ]; then
  ${psql_cmd} -d "${database_name}" -c "DELETE FROM ${target_table} WHERE tile_id = '${tile_id}';" >/dev/null
fi

${psql_cmd} -d "${database_name}" -c "INSERT INTO ${target_table} (source, id, height, var, region, geom, tile_id) SELECT source, id, height, var, region, geom, tile_id FROM ${staging_target};" >/dev/null

echo "[OK] Imported ${tile_id} into ${target_table}: ${nonnull_count}/${total_count} geometries valid"
