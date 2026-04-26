#!/usr/bin/env bash
set -euo pipefail

DATASETS_HOME="${DATASETS_HOME:-${HOME}/datasets}"
PROJECT_NAMESPACE="${PROJECT_NAMESPACE:-wellspace_v2/shadowmap}"
SHADOWMAP_DATA_ROOT="${SHADOWMAP_DATA_ROOT:-${DATASETS_HOME}/${PROJECT_NAMESPACE}}"
LEGACY_DATASET_ROOT="${LEGACY_DATASET_ROOT:-${HOME}/DATASET}"
LEGACY_DATA_ROOT="${LEGACY_DATA_ROOT:-${HOME}/data}"

link_path_if_exists() {
  local src="$1"
  local dst="$2"

  if [ -e "${dst}" ] || [ -L "${dst}" ]; then
    return 0
  fi

  if [ -e "${src}" ] || [ -L "${src}" ]; then
    mkdir -p "$(dirname "${dst}")"
    ln -s "${src}" "${dst}"
  fi
}

mkdir -p \
  "${DATASETS_HOME}" \
  "${SHADOWMAP_DATA_ROOT}/raw" \
  "${SHADOWMAP_DATA_ROOT}/derived" \
  "${SHADOWMAP_DATA_ROOT}/infra/buildings" \
  "${SHADOWMAP_DATA_ROOT}/infra/canopy" \
  "${SHADOWMAP_DATA_ROOT}/infra/canopy/meta_wri_chm/index" \
  "${SHADOWMAP_DATA_ROOT}/infra/canopy/meta_wri_chm/raw_tiles" \
  "${SHADOWMAP_DATA_ROOT}/infra/canopy/meta_wri_chm/manifests" \
  "${SHADOWMAP_DATA_ROOT}/infra/canopy/meta_wri_chm/derived" \
  "${SHADOWMAP_DATA_ROOT}/infra/weather"

link_path_if_exists "${LEGACY_DATASET_ROOT}/GLAN" "${SHADOWMAP_DATA_ROOT}/raw/glan"
if [ ! -e "${SHADOWMAP_DATA_ROOT}/raw/glan" ] && [ ! -L "${SHADOWMAP_DATA_ROOT}/raw/glan" ]; then
  mkdir -p "${SHADOWMAP_DATA_ROOT}/raw/glan"
fi

link_path_if_exists "${LEGACY_DATASET_ROOT}/GLAN_processed_recalc_migrated_part1" "${SHADOWMAP_DATA_ROOT}/derived/GLAN_processed_recalc_migrated_part1"
link_path_if_exists "${LEGACY_DATA_ROOT}/GLAN_processed_recalc_migrated_part1" "${SHADOWMAP_DATA_ROOT}/derived/GLAN_processed_recalc_migrated_part1"
if [ ! -e "${SHADOWMAP_DATA_ROOT}/derived/GLAN_processed_recalc_migrated_part1" ] && [ ! -L "${SHADOWMAP_DATA_ROOT}/derived/GLAN_processed_recalc_migrated_part1" ]; then
  mkdir -p "${SHADOWMAP_DATA_ROOT}/derived/GLAN_processed_recalc_migrated_part1"
fi

link_path_if_exists "${LEGACY_DATASET_ROOT}/Height/hong_kong_cleaned.gpkg" "${SHADOWMAP_DATA_ROOT}/infra/buildings/hong_kong_cleaned.gpkg"
link_path_if_exists "${LEGACY_DATASET_ROOT}/Height/hong_kong_cleaned.geojson" "${SHADOWMAP_DATA_ROOT}/infra/buildings/hong_kong_cleaned.geojson"
link_path_if_exists "${LEGACY_DATASET_ROOT}/HKtree_small.tif" "${SHADOWMAP_DATA_ROOT}/infra/canopy/HKtree_small.tif"
link_path_if_exists "${LEGACY_DATASET_ROOT}/HKtree_cog.tif" "${SHADOWMAP_DATA_ROOT}/infra/canopy/HKtree_cog.tif"
link_path_if_exists "${LEGACY_DATASET_ROOT}/HKtree_reprojected4326.tif" "${SHADOWMAP_DATA_ROOT}/infra/canopy/HKtree_reprojected4326.tif"
link_path_if_exists "${LEGACY_DATASET_ROOT}/era5" "${SHADOWMAP_DATA_ROOT}/infra/weather/era5"
if [ ! -e "${SHADOWMAP_DATA_ROOT}/infra/weather/era5" ] && [ ! -L "${SHADOWMAP_DATA_ROOT}/infra/weather/era5" ]; then
  mkdir -p "${SHADOWMAP_DATA_ROOT}/infra/weather/era5"
fi
mkdir -p "${SHADOWMAP_DATA_ROOT}/infra/weather/era5/global"

link_path_if_exists "${LEGACY_DATA_ROOT}/Greenspace_Seasonality_Data_Cube" "${DATASETS_HOME}/greenspace_seasonality"
link_path_if_exists "${LEGACY_DATA_ROOT}/Facebook_Disaster" "${DATASETS_HOME}/facebook_disaster"

cat > "${DATASETS_HOME}/REGISTRY.md" <<EOF
# Dataset Registry

## Canonical roots

- \`${SHADOWMAP_DATA_ROOT}\`: active ShadowMap and mobility analysis datasets for \`${PROJECT_NAMESPACE}\`
- \`${DATASETS_HOME}/greenspace_seasonality\`: compatibility link to Greenspace cube data
- \`${DATASETS_HOME}/facebook_disaster\`: compatibility link to Facebook disaster data

## Layout

- \`raw/\`: immutable or externally sourced inputs
- \`derived/\`: generated outputs, task buckets, and caches owned by a project
- \`infra/\`: shared project infrastructure assets such as buildings, canopy, and weather rasters
- \`infra/canopy/meta_wri_chm/\`: national canopy-height tiles, manifests, and derived VRT/COG mosaics
- \`infra/canopy/meta_wri_chm/index/\`: cached copies of the public tiles index (\`tiles.geojson\`)
- \`infra/weather/era5/\`: local ERA5 monthly NetCDF files for offline weather/cloud lookups

## Migration policy

- \`${LEGACY_DATASET_ROOT}\` and \`${LEGACY_DATA_ROOT}\` remain legacy compatibility roots.
- New configs should point to \`${DATASETS_HOME}\`.
- Use symlinks during migration instead of duplicating large files.
EOF

echo "Canonical data root: ${SHADOWMAP_DATA_ROOT}"
echo "Registry file: ${DATASETS_HOME}/REGISTRY.md"
