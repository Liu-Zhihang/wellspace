#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/repair_dirty_buildings_state.sh [--swap]

What it does:
  1. Materialize a clean service table from public.buildings WHERE geom IS NOT NULL
  2. Prepare a dedicated public.buildings_na_lod1 table for clean North America imports
  3. Optionally swap the clean service table into public.buildings
EOF
}

do_swap="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --swap)
      do_swap="true"
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql_cmd="${SHADOWMAP_POSTGIS_PSQL:-sudo -u postgres psql}"
database_name="${PGDATABASE:-shadowmap_gis}"

${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -f "${script_dir}/clean_service_buildings.sql"
${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -f "${script_dir}/prepare_building_tables.sql"

if [ "${do_swap}" = "true" ]; then
  ${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -f "${script_dir}/swap_service_buildings.sql"
  ${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -c "GRANT SELECT ON public.buildings TO gisuser;" >/dev/null
fi

echo "[OK] Prepared clean service and NA tables in ${database_name}"
