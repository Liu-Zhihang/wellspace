# National Compute Framework

## Goal

Replace the current nationwide `minute-level exact runtime` as the main
orchestration path. Keep exact final point classification, but move national
scale preprocessing into a stable task-graph and partitioned data pipeline.

This document defines the next framework layer. It does not replace the
existing shadow engine immediately. It replaces the current ad hoc
`CSV -> runtime grouping -> online obstacle lookup` orchestration.

## Exactness Boundary

The following rules are mandatory for the national pipeline:

- Do not replace real point coordinates with cell centroids for final labeling.
- Do not assign one cell-level label to every point inside the cell.
- Use cells only for routing, batching, obstacle reuse, and task graph keys.
- Final point-level sunlight / shade classification must still evaluate the
  real point location against the generated shadow geometry.

This means `H3` or square cells are orchestration keys, not output resolution.

## Target Stack

### 1. Task Key Layer: H3

Use `cell_id + minute` as the stable nationwide task key.

Why:

- stable, portable task routing
- easier spatial partitioning than the current ad hoc `12 km` square key
- cleaner join key for downstream tables

Exactness note:

- H3 is not used for centroid substitution
- H3 is not the final output geometry
- real point coordinates stay in the membership table

### 2. Data Representation Layer: GeoParquet / Parquet

The national pipeline should stop depending on `GeoJSON/GPKG + runtime
polygonize + loose caches` as the main data representation.

Use:

- `Parquet` for mobility membership / task graph tables
- `GeoParquet` for buildings and canopy obstacle layers

Why:

- columnar scans
- bbox metadata
- partition pruning
- easier integration with DuckDB and later distributed engines

Planned datasets:

- `buildings_us` as partitioned GeoParquet
- `canopy_obstacles_us` as partitioned GeoParquet
- `mobility_minute_rows` or interval-derived point rows as Parquet
- `task_graph` as Parquet/CSV
- `task_membership` as Parquet/CSV

### 3. Preprocessing Engine: DuckDB Spatial

DuckDB Spatial is the first national preprocessing engine to adopt.

Use it for:

- mobility point -> cell assignment
- task table generation
- candidate obstacle filtering by cell/bbox
- membership and obstacle edge-table generation

Do not use it as the final shadow solver. Its role is to reduce and organize
the work before the exact shadow engine runs.

### 4. Weather Layer: Dask + Xarray

ERA5 / cloud data should not be point-queried repeatedly by each worker.

Use:

- Dask-backed Xarray for chunked weather access
- precomputed lookup tables keyed by time block and spatial block

Goal:

- one weather preprocessing pass
- broadcast weather results to many shadow tasks

### 5. Solar Layer: pvlib

Solar position should be precomputed into tables, not recomputed in scattered
runtime calls.

Use:

- `pvlib` for solar position tables
- minute-indexed or bin-indexed solar lookup

This is exact if the table is still minute-indexed.

## Immediate Migration Path

### Phase 1: Task Graph Prototype

Create a stable nationwide task graph from the existing minute CSV corpus.

Current entry:

- [scripts/ops/build_national_task_graph.py](/mnt/e/newdesktop/archive/app_dev/shadowmap/scripts/ops/build_national_task_graph.py)

Prototype outputs:

- `tasks.csv`
- `task_membership_counts.csv` or `task_membership_rows.csv`
- `summary.json`

Purpose:

- quantify compression ratio
- measure fanout
- compare square vs H3 routing

### Phase 2: GeoParquet Data Layer

Convert the serving-side obstacle datasets into partitioned analysis datasets.

Targets:

- buildings service table -> partitioned GeoParquet
- canopy obstacle source -> partitioned GeoParquet

Current helpers:

- [scripts/ops/generate_building_partition_catalog.py](/mnt/e/newdesktop/archive/app_dev/shadowmap/scripts/ops/generate_building_partition_catalog.py)
- [scripts/ops/postgis/export_building_partitions_geoparquet.py](/mnt/e/newdesktop/archive/app_dev/shadowmap/scripts/ops/postgis/export_building_partitions_geoparquet.py)

The runtime should query these prepared datasets, not reconstruct them online.

### Phase 3: DuckDB Candidate Pipeline

Build a preprocessing stage that emits:

- `cell-minute task table`
- `task -> point membership`
- `task -> candidate tile set`
- `task -> candidate obstacle set`

This becomes the new handoff boundary into the exact shadow engine.

Current helper:

- [scripts/ops/materialize_task_tile_edges_duckdb.py](/mnt/e/newdesktop/archive/app_dev/shadowmap/scripts/ops/materialize_task_tile_edges_duckdb.py)
- [scripts/ops/materialize_task_partition_edges_duckdb.py](/mnt/e/newdesktop/archive/app_dev/shadowmap/scripts/ops/materialize_task_partition_edges_duckdb.py)

This stage should first materialize `task -> tile` edge tables from the task
graph and the backend tile catalog. Exact shadow runs can then load only the
relevant building/canopy partitions for each task instead of discovering
candidate tiles online.

### Phase 4: Exact Solver Integration

Keep the existing exact point classification engine, but change the input
contract:

- old: per-user CSVs grouped online inside runtime
- new: prepared `task graph + membership + candidate obstacles`

## Current Decisions

- Keep current `1 minute` time precision for now.
- Do not use centroid substitution.
- Do not use `5/10/15 minute` bins in the first migration step.
- The current `12 km` square grouping can remain as the initial baseline for
  comparison, but it should no longer be treated as the final orchestration
  model.

## Deferred Items

- Sedona / Spark scale-out
- GPU acceleration
- approximate time binning

These are later-stage options. They are not the first step.
