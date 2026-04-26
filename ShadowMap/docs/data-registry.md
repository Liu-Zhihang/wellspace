# ShadowMap Data Registry

This project should treat large files as registered assets, not as hidden machine paths.

## Recommended root

Use one centralized datasets home per machine, then keep one project-level data root inside it:

```text
~/datasets/
  REGISTRY.md
  wellspace_v2/
    shadowmap/
      raw/
        glan/PHASE1/spatial_temporal_merge
      derived/
        GLAN_processed_recalc_migrated_part1
      infra/
        buildings/hong_kong_cleaned.geojson
        canopy/HKtree_small.tif
        canopy/meta_wri_chm/index/tiles.geojson
        canopy/meta_wri_chm/raw_tiles/us_subset/*.tif
        canopy/meta_wri_chm/manifests/us_lower48_tiles.txt
        canopy/meta_wri_chm/derived/us_canopy_height.vrt
        weather/era5/era5_%Y%m_hk.nc
        weather/era5/global/era5_%Y%m.nc
  greenspace_seasonality -> ~/data/Greenspace_Seasonality_Data_Cube
  facebook_disaster -> ~/data/Facebook_Disaster
```

Set `SHADOWMAP_DATA_ROOT` in `.shadowmap.env`, then derive the rest from it.

## Required assets

| Name | Role | Example path under `SHADOWMAP_DATA_ROOT` | Notes |
| --- | --- | --- | --- |
| GLAN mobility input | Raw input | `raw/glan/PHASE1/spatial_temporal_merge` | Source trajectories for mobility sunlight batch runs |
| Batch output root | Derived output | `derived/GLAN_processed_recalc_migrated_part1` | Should remain persistent, not `/tmp` |
| Hong Kong building dataset | Infrastructure | `infra/buildings/hong_kong_cleaned.geojson` | Use this for offline/local workflows. If the GeoJSON becomes multi-GB, switch the Node backend to `BUILDING_SOURCE=wfs` and keep the sibling `.gpkg` only for preprocessing or Python workflows that need it |
| Canopy raster | Infrastructure | `infra/canopy/HKtree_small.tif` | Optional; can disable with `MOBILITY_INCLUDE_CANOPY=false` |
| Canopy tiles index | Infrastructure | `infra/canopy/meta_wri_chm/index/tiles.geojson` | Cached local copy of the public Meta/WRI `tiles.geojson`; keep this local so shard prep does not refetch it every run |
| ERA5 monthly files | Infrastructure | `infra/weather/era5/era5_%Y%m_hk.nc` | Used by weather/night fast-path |
| Meta/WRI canopy-height tiles | Infrastructure | `infra/canopy/meta_wri_chm/raw_tiles/us_subset/*.tif` | Public AWS dataset; keep raw tiles immutable and build a VRT/COG for compute |
| National canopy mosaic | Infrastructure | `infra/canopy/meta_wri_chm/derived/us_canopy_height.vrt` | Recommended `SHADOW_ENGINE_CANOPY_RASTER_PATH` for US-scale offline runs |
| National ERA5 monthly files | Infrastructure | `infra/weather/era5/global/era5_%Y%m.nc` | Local weather/cloud source for offline US-scale runs |
| GeoServer WFS | Service dependency | `SHADOWMAP_GEOSERVER_ORIGIN` | External service, not a repo asset |
| Shadow engine service | Service dependency | `SHADOWMAP_ENGINE_ORIGIN` | Python engine microservice |
| Backend service | Service dependency | `SHADOWMAP_BACKEND_ORIGIN` | Node API used by frontend and scripts |

## Registry rules

- Distinguish `raw`, `derived`, and `infra`.
- Prefer one canonical root per project deployment under `~/datasets/<project>/...`.
- If legacy paths still exist, keep them as symlinks during migration instead of copying data twice.
- Treat `~/data` and `~/DATASET` as legacy compatibility roots only.
- Store machine-specific paths only in `.shadowmap.env`, not in tracked source files.
- When adding a new large asset, register its role before wiring it into a script.

## Helper script

Use `./scripts/ops/setup_dataset_root.sh` to create the canonical ShadowMap layout and compatibility links on a host.

## National canopy and weather sources

For US-scale mobility shadow runs, keep weather/cloud and canopy inputs local instead of pulling them through the demo service path.

- Weather/cloud:
  store local ERA5 single-level monthly NetCDF files with at least `tcc` and `ssrd` under `infra/weather/era5/...`.
- Recommended offline path:
  set `ERA5_FILE_TEMPLATE` and let `batch_mobility_shadow.py` read ERA5 directly.
- Repo helper:
  `./scripts/ops/weather/download_era5_single_levels_month.py` can fetch monthly ERA5 single-level files to the canonical local directory.
- Demo path:
  `/api/weather/current` can remain available for frontend display, but do not make national offline compute depend on it.

- Canopy:
  use the public AWS "High Resolution Canopy Height Maps by WRI and Meta" dataset:
  https://registry.opendata.aws/dataforgood-fb-forests/
- Public global CHM bucket:
  `s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/`
- Public California CHM bucket:
  `s3://dataforgood-fb-data/forests/v1/California/alsgedi_ca_v5_float/chm/`
- Model/documentation repo:
  https://github.com/facebookresearch/HighResCanopyHeight

Important interpretation rule:

- This AWS dataset is canopy height, not precomputed tree shade.
- Use it as a height raster obstruction layer.
- Time-varying tree shade still has to be computed by the engine from sun angle, timestamp, and geometry.

Recommended workflow:

1. Cache `tiles.geojson` locally under `infra/canopy/meta_wri_chm/index/tiles.geojson` using `./scripts/ops/canopy/sync_tiles_index.sh`.
2. Download only the required regional CHM tiles into `infra/canopy/meta_wri_chm/raw_tiles/...`.
3. Keep a tile manifest under `infra/canopy/meta_wri_chm/manifests/...` so the selected subset is reproducible.
4. Build one VRT or COG mosaic under `infra/canopy/meta_wri_chm/derived/...`.
5. Point `SHADOW_ENGINE_CANOPY_RASTER_PATH` at that derived single entry point.

For nationwide sharded mobility runs, prefer a persistent raw-tile cache plus shard-local VRTs instead of a single full-US mirror:

- `scripts/ops/run_mobility_shadow_sharded.sh` now supports `MOBILITY_CANOPY_AUTO_PREP=true`.
- For sparse nationwide runs, pair canopy auto-prep with `MOBILITY_SHARD_STRATEGY=spatial` so each shard groups geographically nearby files instead of mixing the whole US into one shard bbox.
- For large first-run canopy jobs, set `MOBILITY_CANOPY_PREFETCH_MODE=union` so the runner unions all shard manifests and downloads missing tiles once in parallel before shard compute starts.
- In that mode, each shard:
  1. computes its own trajectory bbox,
  2. generates a canopy manifest from the Meta/WRI tile index,
  3. downloads only missing tiles into `MOBILITY_CANOPY_CACHE_DIR`,
  4. builds a shard-local VRT under the run directory,
  5. passes that VRT to the Python shadow runner.
- This is the preferred production path when the host cannot afford a `lower48`-wide canopy mirror.
- The raw-tile cache should be treated as infrastructure cache, not as a run artifact. Keep run-local manifests, bbox summaries, and VRTs under the run directory so the exact subset remains auditable.

## Continental-scale building catalogs

For North America or US-wide building coverage, do not mix the continental catalog into the same service table used by a city-scale deployment.

Recommended split:

```text
~/datasets/
  shared/
    buildings/
      na_lod1/
        raw_tiles/                 # original 5x5 degree GeoJSON tiles
        import_logs/
        manifests/
      us_lod1/
        derived_tiles/             # optional clipped US-only subset
```

Recommended serving strategy:

- Keep the raw continental tiles as immutable files under `shared/buildings/...`.
- Import them into a dedicated PostGIS table such as `public.buildings_na_lod1` or a dedicated schema such as `gba_na.buildings`.
- Keep the active city/service table (`public.buildings` for ShadowMap) small and purpose-specific.
- If the production service only needs the US, build a derived US-only table instead of querying all North America rows every time.
- Preserve a stable `tile_id` column so batch compute and WFS filters can prune to a small tile set before spatial filtering.
- Publish large service tables under their own GeoServer layer name, for example `shadowmap:buildings_us_lod1`, instead of overloading the small `shadowmap:buildings` layer.
- Generate a matching backend tile catalogue from the published table, for example `./scripts/ops/postgis/export_tile_catalog_from_table.sh --table public.buildings_us_lod1 --output ./shadow-map-backend/config/buildingTiles.us_lod1.json --region "United States"`.
- For national-scale deployments, set `BUILDING_WFS_TILE_CATALOG_PATH` to that generated catalogue and use `BUILDING_WFS_TILE_STRATEGY=required` so WFS requests always prune by `tile_id` before spatial filtering.

Current host-specific reference on `wsA` (`2026-04-06`):

| Asset | Current location | Target canonical location | Notes |
| --- | --- | --- | --- |
| North America LoD1 raw tiles | `~/DATASET/LoD1/northamerica` | `~/datasets/shared/buildings/na_lod1/raw_tiles` | About `179` GeoJSON tiles, about `147G`; keep raw tiles immutable and migrate with symlinks first |
| Active GeoServer service table | `public.buildings` | `public.buildings` | Repaired service table containing only rows with valid `geom`; keep this table city or region specific |
| Dirty legacy backup | `public.buildings_dirty_20260406` | archive only | Backup of the mixed table where many North America rows were appended without geometry |
| Clean North America import table | `public.buildings_na_lod1` | `public.buildings_na_lod1` or `gba_na.buildings` | Use `scripts/ops/postgis/import_gba_lod1_tile.sh` or `import_gba_lod1_dir.sh`; do not append raw tiles directly into `public.buildings` |
| Derived US AOI staging table | `public.buildings_us_lod1` | `public.buildings_us_lod1` | Materialize from the clean North America table for nationwide US compute prep; this stage can still include cross-border rows in tiles that overlap the AOI |
| Published US service view | `public.buildings_us_service` | `public.buildings_us_service` | GeoServer/WFS-facing view filtered to `region IN ('USA','PRI','VIR')`; use this for backend WFS and tile-catalog generation |

Operational note:

- The legacy failure mode on `wsA` was caused by appending GeoJSON tiles into an existing table shaped like `public.buildings`; `ogr2ogr` ignores layer creation options on append, so `geom` can remain null even when attributes are imported.
- For any future continental or US-wide load, always import into a fresh staging table first, validate `geom IS NOT NULL`, then publish or swap.
- Production-scale mobility shadow runs should bypass WFS entirely: use the Python offline pipeline with `MOBILITY_BUILDINGS_SOURCE=postgis` against a compute-grade PostGIS table such as `public.buildings_us_lod1` or a future dedicated `public.buildings_us_compute`.
- For dense nationwide runs, prefer `MOBILITY_GROUPING_MODE=run-cell-minute` plus a larger `MOBILITY_SHADOW_CACHE_CELL_SIZE_M` so nearby minute-cells reuse one shadow solve while still classifying each person's true point.
- For sparse nationwide trajectories, the stronger win was a much larger compute cell, not worker-side shadow caching. On the `place20190206` sample benchmark on `wsA`, `MOBILITY_CELL_SIZE_M=12000` with `MOBILITY_SHADOW_CACHE_CELL_SIZE_M=0` outperformed the `250m` baseline while preserving identical per-row outputs on the sampled run.
- The sharded runner now exposes two convenience presets: `national-sparse` for wide-area sparse trajectories and `urban-dense` for compact city traces. Treat them as benchmark-backed starting points, not universal defaults.
- On the Hong Kong dense sample benchmark (`2001_500.csv`, replicated to 16 files on `wsA`) with the `urban-dense` preset and `hong_kong_cleaned.gpkg`, warm-cache canopy overhead was modest: about `1.024x` slower than the corresponding warm-cache buildings-only run.
- Keep GeoServer/WFS layers such as `public.buildings_us_service` for interactive display and API demos; do not make the offline compute pipeline depend on that service path.
