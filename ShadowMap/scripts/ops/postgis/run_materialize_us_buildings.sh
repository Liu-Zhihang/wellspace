#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ops/postgis/run_materialize_us_buildings.sh

Options:
  --tag NAME          Run tag, defaults to us_lod1_materialize
  --run-root PATH     Parent directory for run artifacts
  --run-dir PATH      Explicit run directory; overrides --tag/--run-root naming
  --workers N|auto    Parallel shard workers, defaults to auto
  --na-run-dir PATH   Completed North America import run directory
  --source-table NAME Source table, defaults to public.buildings_na_lod1
  --target-table NAME Target table, defaults to public.buildings_us_lod1

Environment:
  PGDATABASE               Defaults to shadowmap_gis
  SHADOWMAP_POSTGIS_PSQL   Defaults to "sudo -u postgres psql"
EOF
}

tag="us_lod1_materialize"
run_root="outputs/postgis_derivations"
run_dir=""
workers="auto"
na_run_dir="${SHADOWMAP_NA_IMPORT_RUN_DIR:-}"
source_table="${SHADOWMAP_US_SOURCE_TABLE:-public.buildings_na_lod1}"
target_table="${SHADOWMAP_US_TARGET_TABLE:-public.buildings_us_lod1}"

while [ $# -gt 0 ]; do
  case "$1" in
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
    --workers)
      workers="${2:-}"
      shift 2
      ;;
    --na-run-dir)
      na_run_dir="${2:-}"
      shift 2
      ;;
    --source-table)
      source_table="${2:-}"
      shift 2
      ;;
    --target-table)
      target_table="${2:-}"
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
database_name="${PGDATABASE:-shadowmap_gis}"
psql_cmd="${SHADOWMAP_POSTGIS_PSQL:-sudo -u postgres psql}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

if [ -z "${na_run_dir}" ]; then
  na_run_dir="$(ls -dt "${HOME}/datasets/shared/buildings/na_lod1/import_logs"/na_lod1_full_* 2>/dev/null | head -n 1 || true)"
fi

if [ -z "${na_run_dir}" ] || [ ! -d "${na_run_dir}" ]; then
  echo "[Fatal] Could not locate a completed North America import run directory." >&2
  exit 1
fi

na_manifest_path="${na_run_dir}/manifest.txt"
na_log_path="${na_run_dir}/run.log"

if [ ! -f "${na_manifest_path}" ]; then
  echo "[Fatal] Missing manifest.txt in ${na_run_dir}" >&2
  exit 1
fi

detect_workers() {
  local cpus
  cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)"
  if [ "${cpus}" -ge 32 ]; then
    echo 12
  elif [ "${cpus}" -ge 24 ]; then
    echo 8
  elif [ "${cpus}" -ge 16 ]; then
    echo 6
  elif [ "${cpus}" -ge 8 ]; then
    echo 4
  else
    echo 2
  fi
}

if [ "${workers}" = "auto" ]; then
  workers="$(detect_workers)"
fi

if ! [[ "${workers}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[Fatal] --workers must be a positive integer or auto" >&2
  exit 1
fi

if [ -z "${run_dir}" ]; then
  run_dir="${run_root%/}/${tag}_${timestamp}"
fi

mkdir -p "${run_dir}"

run_log_path="${run_dir}/run.log"
summary_path="${run_dir}/run_summary.json"
command_path="${run_dir}/command.sh"
candidate_manifest_path="${run_dir}/candidate_tiles.tsv"
shards_dir="${run_dir}/shards"
shard_summary_path="${run_dir}/shard_summary.tsv"
prepare_sql_path="${run_dir}/prepare_target.sql"
finalize_sql_path="${run_dir}/finalize_target.sql"

mkdir -p "${shards_dir}"

cat > "${command_path}" <<EOF
cd "${repo_root}"
./scripts/ops/postgis/run_materialize_us_buildings.sh \\
  --tag "${tag}" \\
  --run-dir "${run_dir}" \\
  --workers "${workers}" \\
  --na-run-dir "${na_run_dir}" \\
  --source-table "${source_table}" \\
  --target-table "${target_table}"
EOF
chmod +x "${command_path}"

bbox_intersects() {
  local west="$1"
  local south="$2"
  local east="$3"
  local north="$4"
  local box_west="$5"
  local box_south="$6"
  local box_east="$7"
  local box_north="$8"

  awk \
    -v west="${west}" \
    -v south="${south}" \
    -v east="${east}" \
    -v north="${north}" \
    -v box_west="${box_west}" \
    -v box_south="${box_south}" \
    -v box_east="${box_east}" \
    -v box_north="${box_north}" \
    'BEGIN { exit (east < box_west || west > box_east || north < box_south || south > box_north) ? 1 : 0 }'
}

tile_intersects_us() {
  local tile_id="$1"
  local lon_a lat_a lon_b lat_b west east south north

  if [[ ! "${tile_id}" =~ ^([we])([0-9]{3})_([ns])([0-9]{2})_([we])([0-9]{3})_([ns])([0-9]{2})$ ]]; then
    return 1
  fi

  lon_a="${BASH_REMATCH[2]}"
  lat_a="${BASH_REMATCH[4]}"
  lon_b="${BASH_REMATCH[6]}"
  lat_b="${BASH_REMATCH[8]}"

  if [ "${BASH_REMATCH[1]}" = "w" ]; then lon_a="-$lon_a"; fi
  if [ "${BASH_REMATCH[3]}" = "s" ]; then lat_a="-$lat_a"; fi
  if [ "${BASH_REMATCH[5]}" = "w" ]; then lon_b="-$lon_b"; fi
  if [ "${BASH_REMATCH[7]}" = "s" ]; then lat_b="-$lat_b"; fi

  west="$(awk -v a="${lon_a}" -v b="${lon_b}" 'BEGIN { print (a < b ? a : b) }')"
  east="$(awk -v a="${lon_a}" -v b="${lon_b}" 'BEGIN { print (a > b ? a : b) }')"
  south="$(awk -v a="${lat_a}" -v b="${lat_b}" 'BEGIN { print (a < b ? a : b) }')"
  north="$(awk -v a="${lat_a}" -v b="${lat_b}" 'BEGIN { print (a > b ? a : b) }')"

  bbox_intersects "${west}" "${south}" "${east}" "${north}" -125 24 -66 50 && return 0
  bbox_intersects "${west}" "${south}" "${east}" "${north}" -180 51 -129 72.5 && return 0
  bbox_intersects "${west}" "${south}" "${east}" "${north}" -161 18.5 -154 23 && return 0
  bbox_intersects "${west}" "${south}" "${east}" "${north}" -68.5 17.5 -64 19 && return 0

  return 1
}

build_tile_values() {
  local shard_file="$1"
  awk -F'\t' 'NF { printf "%s('\''%s'\'')", (count++ ? ",\n  " : "  "), $1 }' "${shard_file}"
}

write_summary() {
  local status="$1"
  local end_ts="$2"
  local candidate_tiles shard_total completed_shards failed_shards estimated_rows
  local total_rows="unknown"
  local distinct_tiles="unknown"
  local null_geom="unknown"

  candidate_tiles="$(wc -l < "${candidate_manifest_path}" | tr -d ' ' 2>/dev/null || echo 0)"
  shard_total="$(find "${shards_dir}" -maxdepth 1 -name 'shard_*.tsv' -type f -size +0c 2>/dev/null | wc -l | tr -d ' ')"
  completed_shards="$(grep -cE '^\[Shard [0-9][0-9]\] completed ' "${run_log_path}" 2>/dev/null || true)"
  failed_shards="$(grep -cE '^\[Shard [0-9][0-9]\] failed ' "${run_log_path}" 2>/dev/null || true)"
  estimated_rows="$(awk '
    match($0, /inserted=([0-9]+)/, m) { sum += m[1] }
    END { printf "%.0f", sum + 0 }
  ' "${run_log_path}" 2>/dev/null || echo 0)"

  if total_rows="$(${psql_cmd} -d "${database_name}" -Atqc "SELECT count(*) FROM ${target_table};" 2>/dev/null)"; then
    :
  else
    total_rows="unknown"
  fi

  if distinct_tiles="$(${psql_cmd} -d "${database_name}" -Atqc "SELECT count(DISTINCT tile_id) FROM ${target_table};" 2>/dev/null)"; then
    :
  else
    distinct_tiles="unknown"
  fi

  if null_geom="$(${psql_cmd} -d "${database_name}" -Atqc "SELECT count(*) FROM ${target_table} WHERE geom IS NULL;" 2>/dev/null)"; then
    :
  else
    null_geom="unknown"
  fi

  completed_shards="${completed_shards:-0}"
  failed_shards="${failed_shards:-0}"

  cat > "${summary_path}" <<EOF
{
  "tag": "${tag}",
  "status": "${status}",
  "started_at_utc": "${timestamp}",
  "ended_at_utc": "${end_ts}",
  "strategy": "parallel_tile_insert",
  "source_table": "${source_table}",
  "target_table": "${target_table}",
  "na_run_dir": "${na_run_dir}",
  "candidate_manifest_path": "${candidate_manifest_path}",
  "shard_summary_path": "${shard_summary_path}",
  "run_log_path": "${run_log_path}",
  "worker_count": ${workers},
  "candidate_tile_count": ${candidate_tiles},
  "shard_count": ${shard_total},
  "completed_shards": ${completed_shards},
  "failed_shards": ${failed_shards},
  "estimated_inserted_rows_from_logs": "${estimated_rows}",
  "table_row_count": "${total_rows}",
  "table_distinct_tiles": "${distinct_tiles}",
  "null_geom_count": "${null_geom}"
}
EOF
}

declare -A tile_counts=()
if [ -f "${na_log_path}" ]; then
  while read -r tile_id count; do
    tile_counts["${tile_id}"]="${count}"
  done < <(awk '$1=="[OK]" && $2=="Imported" { split($6, a, "/"); print $3, a[1] }' "${na_log_path}")
fi

: > "${candidate_manifest_path}"
while IFS= read -r manifest_entry; do
  [ -z "${manifest_entry}" ] && continue
  tile_id="$(basename "${manifest_entry}" .geojson)"
  if tile_intersects_us "${tile_id}"; then
    printf '%s\t%s\n' "${tile_id}" "${tile_counts[${tile_id}]:-0}" >> "${candidate_manifest_path}"
  fi
done < "${na_manifest_path}"

sort -t $'\t' -k2,2nr -k1,1 "${candidate_manifest_path}" -o "${candidate_manifest_path}"

candidate_tile_count="$(wc -l < "${candidate_manifest_path}" | tr -d ' ')"
if [ "${candidate_tile_count}" -eq 0 ]; then
  echo "[Fatal] No US-overlapping candidate tiles were derived from ${na_manifest_path}" >&2
  exit 1
fi

rm -f "${shards_dir}"/shard_*.tsv
for ((i = 0; i < workers; i++)); do
  : > "$(printf '%s/shard_%02d.tsv' "${shards_dir}" "${i}")"
done

awk -F'\t' -v shards="${workers}" -v outdir="${shards_dir}" '
BEGIN {
  for (i = 0; i < shards; i++) {
    load[i] = 0;
    count[i] = 0;
    files[i] = sprintf("%s/shard_%02d.tsv", outdir, i);
  }
}
{
  best = 0;
  for (i = 1; i < shards; i++) {
    if (load[i] < load[best]) {
      best = i;
    }
  }
  print $0 >> files[best];
  close(files[best]);
  load[best] += $2 + 0;
  count[best] += 1;
}
END {
  for (i = 0; i < shards; i++) {
    printf "%02d\t%d\t%.0f\n", i, count[i], load[i];
  }
}
' "${candidate_manifest_path}" > "${shard_summary_path}"

cat > "${prepare_sql_path}" <<EOF
DROP TABLE IF EXISTS ${target_table} CASCADE;

CREATE TABLE ${target_table} (
  LIKE ${source_table}
  INCLUDING DEFAULTS
  INCLUDING GENERATED
  INCLUDING STORAGE
  INCLUDING COMMENTS
);

ALTER TABLE ${target_table}
  ALTER COLUMN geom SET NOT NULL,
  ALTER COLUMN tile_id SET NOT NULL;
EOF

cat > "${finalize_sql_path}" <<EOF
ALTER TABLE ${target_table}
  ADD CONSTRAINT $(basename "${target_table//./_}")_pkey PRIMARY KEY (ogc_fid);

CREATE INDEX $(basename "${target_table//./_}")_geom_idx
  ON ${target_table} USING gist (geom);

CREATE INDEX $(basename "${target_table//./_}")_tile_idx
  ON ${target_table} (tile_id);

ANALYZE ${target_table};

GRANT SELECT ON ${target_table} TO gisuser;
EOF

write_summary "running" ""

echo "[Meta] Preparing ${target_table} from ${source_table}; candidate_tiles=${candidate_tile_count}; workers=${workers}" | tee -a "${run_log_path}"
${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -P pager=off -f "${prepare_sql_path}" >> "${run_log_path}" 2>&1

run_shard() {
  local shard_file="$1"
  local shard_name shard_id shard_sql shard_log tile_count expected_rows tile_values inserted_rows

  shard_name="$(basename "${shard_file}" .tsv)"
  shard_id="${shard_name#shard_}"
  tile_count="$(grep -c . "${shard_file}" || true)"
  if [ "${tile_count}" -eq 0 ]; then
    return 0
  fi

  expected_rows="$(awk -F'\t' 'NF { sum += $2 } END { printf "%.0f", sum + 0 }' "${shard_file}")"
  shard_sql="${run_dir}/${shard_name}.sql"
  shard_log="${run_dir}/${shard_name}.log"
  tile_values="$(build_tile_values "${shard_file}")"

  cat > "${shard_sql}" <<EOF
SET synchronous_commit = off;

WITH us_aoi AS (
  SELECT ST_UnaryUnion(
    ST_Collect(ARRAY[
      ST_MakeEnvelope(-125.0, 24.0, -66.0, 50.0, 4326),
      ST_MakeEnvelope(-180.0, 51.0, -129.0, 72.5, 4326),
      ST_MakeEnvelope(-161.0, 18.5, -154.0, 23.0, 4326),
      ST_MakeEnvelope(-68.5, 17.5, -64.0, 19.0, 4326)
    ])
  ) AS geom
),
selected_tiles(tile_id) AS (
  VALUES
${tile_values}
)
INSERT INTO ${target_table} (ogc_fid, source, id, height, var, region, geom, tile_id)
SELECT na.ogc_fid, na.source, na.id, na.height, na.var, na.region, na.geom, na.tile_id
FROM ${source_table} AS na
JOIN selected_tiles USING (tile_id)
CROSS JOIN us_aoi
WHERE ST_Intersects(na.geom, us_aoi.geom);
EOF

  echo "[Shard ${shard_id}] start tiles=${tile_count} expected_rows=${expected_rows}" | tee -a "${run_log_path}"
  if ${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -P pager=off -f "${shard_sql}" > "${shard_log}" 2>&1; then
    inserted_rows="$(sed -n 's/^INSERT 0 //p' "${shard_log}" | tail -n 1)"
    inserted_rows="${inserted_rows:-unknown}"
    echo "[Shard ${shard_id}] completed inserted=${inserted_rows} tiles=${tile_count} expected_rows=${expected_rows}" | tee -a "${run_log_path}"
    return 0
  fi

  echo "[Shard ${shard_id}] failed tiles=${tile_count} expected_rows=${expected_rows}" | tee -a "${run_log_path}"
  tail -n 40 "${shard_log}" >> "${run_log_path}" || true
  return 1
}

status=0
for shard_file in "${shards_dir}"/shard_*.tsv; do
  while [ "$(jobs -pr | wc -l | tr -d ' ')" -ge "${workers}" ]; do
    if ! wait -n; then
      status=1
      break 2
    fi
  done
  run_shard "${shard_file}" &
done

if [ "${status}" -eq 0 ]; then
  while [ "$(jobs -pr | wc -l | tr -d ' ')" -gt 0 ]; do
    if ! wait -n; then
      status=1
      break
    fi
  done
fi

if [ "${status}" -ne 0 ]; then
  jobs -pr | xargs -r kill >/dev/null 2>&1 || true
  wait || true
  write_summary "failed" ""
  exit 1
fi

echo "[Meta] Finalizing ${target_table} indexes and grants" | tee -a "${run_log_path}"
if ! ${psql_cmd} -v ON_ERROR_STOP=1 -d "${database_name}" -P pager=off -f "${finalize_sql_path}" >> "${run_log_path}" 2>&1; then
  write_summary "failed" ""
  exit 1
fi

end_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
write_summary "completed" "${end_timestamp}"

echo "[Meta] Completed ${target_table}" | tee -a "${run_log_path}"
