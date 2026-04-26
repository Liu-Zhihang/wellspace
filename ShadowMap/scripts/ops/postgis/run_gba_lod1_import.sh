#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/run_gba_lod1_import.sh \
    --dir /path/to/northamerica \
    --table public.buildings_na_lod1

Options:
  --dir PATH          Directory containing *.geojson tiles
  --table NAME        Target table (schema.table)
  --tag NAME          Run tag, defaults to gba_lod1_import
  --run-root PATH     Parent directory for run artifacts
  --run-dir PATH      Explicit run directory; overrides --tag/--run-root naming
  --match GLOB        Optional filename glob, defaults to *.geojson
  --skip-existing     Skip tiles already present in the target table
  --replace-tile      Replace existing rows for each tile before inserting
EOF
}

dir_path=""
target_table=""
tag="gba_lod1_import"
run_root="outputs/postgis_imports"
run_dir=""
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
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --run-root)
      run_root="${2:-}"
      shift 2
      ;;
    --run-dir)
      run_dir="${2:-}"
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
repo_root="$(cd "${script_dir}/../../.." && pwd)"
import_script="${script_dir}/import_gba_lod1_dir.sh"
database_name="${PGDATABASE:-shadowmap_gis}"
psql_cmd="${SHADOWMAP_POSTGIS_PSQL:-sudo -u postgres psql}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [ -z "${run_dir}" ]; then
  run_dir="${run_root%/}/${tag}_${timestamp}"
fi

mkdir -p "${run_dir}"

manifest_path="${run_dir}/manifest.txt"
run_log_path="${run_dir}/run.log"
summary_path="${run_dir}/run_summary.json"
command_path="${run_dir}/command.sh"
skip_existing_cmd=""
replace_tile_cmd=""

find -L "${dir_path}" -maxdepth 1 -type f -name "${match_glob}" | sort > "${manifest_path}"
manifest_count="$(wc -l < "${manifest_path}" | tr -d ' ')"

if [ "${skip_existing}" = "true" ]; then
  skip_existing_cmd=" \\
  --skip-existing"
fi

if [ "${replace_tile}" = "true" ]; then
  replace_tile_cmd=" \\
  --replace-tile"
fi

cat > "${command_path}" <<EOF
cd "${repo_root}"
./scripts/ops/postgis/run_gba_lod1_import.sh \\
  --dir "${dir_path}" \\
  --table "${target_table}" \\
  --tag "${tag}" \\
  --run-dir "${run_dir}" \\
  --match "${match_glob}"${skip_existing_cmd}${replace_tile_cmd}
EOF
chmod +x "${command_path}"

write_summary() {
  local status="$1"
  local end_ts="$2"
  local total_rows="unknown"
  local distinct_tiles="unknown"
  local total_rows_query=""
  local distinct_tiles_query=""

  if total_rows_query="$(${psql_cmd} -d "${database_name}" -Atqc "SELECT count(*) FROM ${target_table};" 2>/dev/null)"; then
    total_rows="${total_rows_query}"
  fi

  if distinct_tiles_query="$(${psql_cmd} -d "${database_name}" -Atqc "SELECT count(DISTINCT tile_id) FROM ${target_table};" 2>/dev/null)"; then
    distinct_tiles="${distinct_tiles_query}"
  fi

  cat > "${summary_path}" <<EOF
{
  "tag": "${tag}",
  "status": "${status}",
  "started_at_utc": "${timestamp}",
  "ended_at_utc": "${end_ts}",
  "source_dir": "${dir_path}",
  "target_table": "${target_table}",
  "match_glob": "${match_glob}",
  "skip_existing": ${skip_existing},
  "replace_tile": ${replace_tile},
  "manifest_path": "${manifest_path}",
  "manifest_count": ${manifest_count},
  "run_log_path": "${run_log_path}",
  "table_row_count": "${total_rows}",
  "table_distinct_tiles": "${distinct_tiles}"
}
EOF
}

write_summary "running" ""

cmd=("${import_script}" --dir "${dir_path}" --table "${target_table}" --match "${match_glob}")
if [ "${skip_existing}" = "true" ]; then
  cmd+=(--skip-existing)
fi
if [ "${replace_tile}" = "true" ]; then
  cmd+=(--replace-tile)
fi

set +e
"${cmd[@]}" 2>&1 | tee "${run_log_path}"
cmd_status="${PIPESTATUS[0]}"
set -e

end_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [ "${cmd_status}" -eq 0 ]; then
  write_summary "completed" "${end_timestamp}"
else
  write_summary "failed" "${end_timestamp}"
fi

exit "${cmd_status}"
