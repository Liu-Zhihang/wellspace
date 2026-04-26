#!/usr/bin/env python3
"""Prototype exact executor backed by task->partition edges and GeoParquet partitions."""

from __future__ import annotations

import argparse
import csv
import gc
import hashlib
import json
import math
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.batch_mobility_shadow import (  # noqa: E402
    ENGINE_PATH,
    BucketJob,
    BucketPoint,
    WorkerConfig,
    _build_shadow_cache_entry_for_job,
    _evaluate_bucket_weather,
    _night_bucket_result,
    _row_updates_from_shadow_cache,
    _mercator_cell_id,
    build_bucket_payload,
    floor_to_minute_iso,
    pick_lon_lat,
)
from scripts.ops.build_national_task_graph import _safe_int  # noqa: E402
from scripts.ops.build_national_task_graph_raw_stays import (  # noqa: E402
    _raw_row_coords,
    iter_daylight_timestamps,
)


@dataclass(frozen=True)
class SelectedTask:
    task_id: str
    minute_iso: str
    cell_key: str
    cell_provider: str
    cell_resolution: int
    point_count: int
    west: float
    south: float
    east: float
    north: float
    partition_ids: Tuple[str, ...]


@dataclass(frozen=True)
class PointMeta:
    task_id: str
    file_relpath: str
    row_index: int
    timestamp: str
    lon: float
    lat: float


@dataclass(frozen=True)
class ManifestEntry:
    partition_id: str
    output_path: str
    min_lon: Optional[float] = None
    min_lat: Optional[float] = None
    max_lon: Optional[float] = None
    max_lat: Optional[float] = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-graph-db", required=True, help="DuckDB with tasks/memberships/edge tables.")
    parser.add_argument("--partition-manifest-csv", required=True, help="Export manifest CSV for available partition parquet files.")
    parser.add_argument("--input-root", required=True, help="Root directory for mobility CSV files.")
    parser.add_argument("--edge-table-name", default="task_partition_edges_deg05_ctx400", help="Task->partition edge table inside DuckDB.")
    parser.add_argument("--output-dir", required=True, help="Directory for executor artifacts.")
    parser.add_argument(
        "--resume",
        choices=("true", "false"),
        default="true",
        help="When true, trust completed checkpoint chunks and skip them on restart.",
    )
    parser.add_argument(
        "--checkpoint-task-count",
        type=int,
        default=0,
        help=(
            "When >0, execute tasks in deterministic checkpoint chunks of this size. Completed "
            "chunks get their own _SUCCESS marker, so interrupted shards resume without redoing "
            "finished chunks."
        ),
    )
    parser.add_argument(
        "--checkpoint-max-point-count",
        type=int,
        default=int(os.getenv("MOBILITY_CHECKPOINT_MAX_POINT_COUNT", "0") or "0"),
        help=(
            "When >0, checkpoint chunks are also bounded by the sum of task point_count. "
            "This is the production guardrail for mobility workloads where a small number "
            "of hotspot tasks can dominate memory."
        ),
    )
    parser.add_argument(
        "--max-checkpoint-chunks-per-run",
        type=int,
        default=int(os.getenv("MOBILITY_MAX_CHECKPOINT_CHUNKS_PER_RUN", "0") or "0"),
        help=(
            "When >0, process at most this many new checkpoint chunks, write partial "
            "summary metadata, then exit 0 without top-level _SUCCESS. The outer "
            "runner can restart the process to release Python/GeoPandas memory while "
            "preserving checkpoint resume semantics."
        ),
    )
    parser.add_argument(
        "--final-output-mode",
        choices=("merged-csv", "checkpoint-manifest"),
        default="merged-csv",
        help=(
            "merged-csv writes one top-level task_point_results.csv. checkpoint-manifest keeps "
            "checkpoint CSVs as the final artifact and writes result_manifest.json, avoiding a "
            "second full-size CSV for large production runs."
        ),
    )
    parser.add_argument("--max-tasks", type=int, default=25, help="Max eligible tasks to execute in this prototype run.")
    parser.add_argument("--task-id-file", default="", help="Optional newline-delimited task ID allowlist.")
    parser.add_argument(
        "--point-cache-csv",
        default="",
        help="Optional materialized task-point CSV. When provided, skip rescanning input files.",
    )
    parser.add_argument(
        "--source-spans-table",
        default="",
        help="Optional DuckDB source-span table name. When provided, load task points by joining selected tasks against source spans.",
    )
    parser.add_argument(
        "--input-mode",
        choices=("minute-rows", "raw-stays"),
        default="minute-rows",
        help="Interpret input-root CSVs as expanded minute rows or raw stay intervals.",
    )
    parser.add_argument("--context-m", type=float, default=400.0, help="Exact obstacle clip margin in meters.")
    parser.add_argument(
        "--adaptive-context",
        choices=("true", "false"),
        default="false",
        help=(
            "When true, use --context-m as the conservative candidate window, then shrink the exact "
            "solve window from local building height and solar elevation."
        ),
    )
    parser.add_argument(
        "--adaptive-context-min-m",
        type=float,
        default=50.0,
        help="Minimum exact solve context when --adaptive-context=true.",
    )
    parser.add_argument(
        "--adaptive-context-margin-m",
        type=float,
        default=30.0,
        help="Safety margin added to height/tan(solar_elevation) when --adaptive-context=true.",
    )
    parser.add_argument(
        "--adaptive-context-height-column",
        default="height",
        help="Building height column used by --adaptive-context.",
    )
    parser.add_argument(
        "--max-points-per-execution-unit",
        type=int,
        default=0,
        help=(
            "Adaptive exact split threshold. When >0, split a task spatially until each execution "
            "unit has at most this many points, subject to --max-execution-split-depth."
        ),
    )
    parser.add_argument(
        "--max-obstacles-per-execution-unit",
        type=int,
        default=0,
        help=(
            "Adaptive exact split threshold. When >0, split a task spatially until each execution "
            "unit's bbox-filtered obstacle row count is at most this value, subject to split depth."
        ),
    )
    parser.add_argument(
        "--max-execution-split-depth",
        type=int,
        default=8,
        help="Maximum recursive depth for adaptive exact execution-unit splitting.",
    )
    parser.add_argument(
        "--min-points-per-execution-unit",
        type=int,
        default=128,
        help="Do not split a node if either child would have fewer than this many points.",
    )
    parser.add_argument(
        "--max-obstacles-per-shadow-batch",
        type=int,
        default=0,
        help=(
            "Experimental. When >0, generate shadows for a large leaf obstacle set in deterministic "
            "row batches and merge the resulting shadow geometries before point classification. Keep "
            "0 for parity; pybdshadow's projection center is batch-size sensitive."
        ),
    )
    parser.add_argument(
        "--shadow-kernel",
        choices=("pybdshadow", "fast-ground"),
        default="pybdshadow",
        help=(
            "Shadow generation kernel. pybdshadow preserves the library path; fast-ground uses the "
            "same ground-shadow projection formula but bypasses pybdshadow's pandas/groupby path."
        ),
    )
    parser.add_argument(
        "--obstacle-reach-filter",
        choices=("true", "false"),
        default="false",
        help=(
            "When true, remove buildings whose height-limited maximum shadow reach cannot touch "
            "the exact point bbox. This is a conservative physical prefilter; validate with parity "
            "benchmarks before enabling for production."
        ),
    )
    parser.add_argument(
        "--obstacle-reach-filter-margin-m",
        type=float,
        default=30.0,
        help="Safety margin added to each building's height/tan(solar_elevation) reach.",
    )
    parser.add_argument(
        "--obstacle-reach-filter-min-elevation-deg",
        type=float,
        default=0.1,
        help="Disable reach filtering when solar elevation is at or below this value.",
    )
    parser.add_argument(
        "--execution-unit-bbox-mode",
        choices=("child", "parent"),
        default="child",
        help=(
            "child: each split unit uses its own point bbox plus context. parent: split points but keep "
            "the original parent task bbox for conservative output parity checks."
        ),
    )
    parser.add_argument("--timezone", default=os.getenv("SHADOW_ENGINE_TIMEZONE", "Asia/Hong_Kong"))
    parser.add_argument("--era5-file-template", default=os.getenv("ERA5_FILE_TEMPLATE", ""))
    parser.add_argument("--era5-file-path", default=os.getenv("ERA5_FILE_PATH", ""))
    parser.add_argument("--step-seconds", type=int, default=60, help="Step seconds used when expanding raw stays.")
    parser.add_argument("--solar-elevation-threshold-deg", type=float, default=0.0)
    return parser


def sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def parse_task_allowlist(path: str) -> Optional[set[str]]:
    if not path:
        return None
    values = {
        line.strip()
        for line in Path(path).expanduser().resolve().read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    return values or None


def _optional_float(value: Any) -> Optional[float]:
    if value in ("", None):
        return None
    try:
        parsed = float(value)
    except Exception:
        return None
    return parsed if math.isfinite(parsed) else None


def read_manifest(path: Path) -> Dict[str, ManifestEntry]:
    mapping: Dict[str, ManifestEntry] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            partition_id = str(row.get("partitionId") or "").strip()
            output_path = str(row.get("outputParquet") or "").strip()
            if partition_id and output_path and Path(output_path).exists():
                mapping[partition_id] = ManifestEntry(
                    partition_id=partition_id,
                    output_path=output_path,
                    min_lon=_optional_float(row.get("minLon")),
                    min_lat=_optional_float(row.get("minLat")),
                    max_lon=_optional_float(row.get("maxLon")),
                    max_lat=_optional_float(row.get("maxLat")),
                )
    if not mapping:
        raise RuntimeError(f"No readable partition parquet entries found in manifest: {path}")
    return mapping


def load_selected_tasks(
    db_path: Path,
    manifest_path: Path,
    edge_table_name: str,
    max_tasks: int,
    allowlist: Optional[set[str]],
) -> Tuple[List[SelectedTask], List[str]]:
    try:
        import duckdb
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("This script requires the `duckdb` Python package.") from exc

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        base_sql = f"""
WITH available_manifest AS (
  SELECT
    partitionId AS partition_id,
    outputParquet AS output_parquet
  FROM read_csv_auto({sql_quote(str(manifest_path))}, header = true, sample_size = -1)
),
eligible AS (
  SELECT
    e.task_id,
    count(*)::BIGINT AS edge_count,
    sum(CASE WHEN am.partition_id IS NOT NULL THEN 1 ELSE 0 END)::BIGINT AS available_edge_count
  FROM {edge_table_name} e
  LEFT JOIN available_manifest am
    ON e.partition_id = am.partition_id
  GROUP BY 1
  HAVING count(*) = sum(CASE WHEN am.partition_id IS NOT NULL THEN 1 ELSE 0 END)
)
SELECT
  t.task_id,
  t.minute_iso,
  t.cell_key,
  t.cell_provider,
  t.cell_resolution,
  t.point_count,
  t.west,
  t.south,
  t.east,
  t.north
FROM tasks t
JOIN eligible e
  ON t.task_id = e.task_id
ORDER BY t.point_count DESC, t.task_id
"""
        if allowlist:
            quoted = ", ".join(sql_quote(task_id) for task_id in sorted(allowlist))
            base_sql = f"SELECT * FROM ({base_sql}) base WHERE task_id IN ({quoted})"
        if max_tasks > 0:
            base_sql += f"\nLIMIT {int(max_tasks)}"

        task_rows = con.execute(base_sql).fetchall()
        if not task_rows:
            raise RuntimeError("No eligible tasks found for the requested manifest/filters.")

        task_ids = [str(row[0]) for row in task_rows]
        quoted_ids = ", ".join(sql_quote(task_id) for task_id in task_ids)
        edge_rows = con.execute(
            f"""
            SELECT task_id, partition_id
            FROM {edge_table_name}
            WHERE task_id IN ({quoted_ids})
            ORDER BY task_id, partition_id
            """
        ).fetchall()
        files = con.execute(
            f"""
            SELECT DISTINCT file_relpath
            FROM memberships
            WHERE task_id IN ({quoted_ids})
            ORDER BY file_relpath
            """
        ).fetchall()
    finally:
        con.close()

    task_partitions: Dict[str, List[str]] = defaultdict(list)
    for task_id, partition_id in edge_rows:
        task_partitions[str(task_id)].append(str(partition_id))

    tasks: List[SelectedTask] = []
    for row in task_rows:
        task_id = str(row[0])
        tasks.append(
            SelectedTask(
                task_id=task_id,
                minute_iso=str(row[1]),
                cell_key=str(row[2]),
                cell_provider=str(row[3]),
                cell_resolution=int(row[4]),
                point_count=int(row[5]),
                west=float(row[6]),
                south=float(row[7]),
                east=float(row[8]),
                north=float(row[9]),
                partition_ids=tuple(task_partitions.get(task_id, [])),
            )
        )
    file_relpaths = [str(row[0]) for row in files]
    return tasks, file_relpaths


def build_cell_key(provider: str, resolution: int, lon: float, lat: float) -> str:
    if provider == "h3":
        import h3  # type: ignore

        return f"h3:{int(resolution)}:{h3.latlng_to_cell(lat, lon, int(resolution))}"
    cell_x, cell_y = _mercator_cell_id(lat, lon, float(resolution))
    return f"square:{int(resolution)}:{cell_x}:{cell_y}"


PointMetaKey = Tuple[str, int, int]


def scan_points_for_tasks(
    input_root: Path,
    file_relpaths: Sequence[str],
    tasks: Sequence[SelectedTask],
) -> Tuple[Dict[str, List[BucketPoint]], Dict[PointMetaKey, PointMeta], Dict[str, int]]:
    if not tasks:
        return {}, {}, {}

    provider_set = {task.cell_provider for task in tasks}
    resolution_set = {task.cell_resolution for task in tasks}
    if len(provider_set) != 1 or len(resolution_set) != 1:
        raise RuntimeError("Prototype executor expects a single cell provider/resolution in the selected task set.")
    provider = next(iter(provider_set))
    resolution = next(iter(resolution_set))

    task_lookup = {task.task_id: task for task in tasks}
    task_points: Dict[str, List[BucketPoint]] = defaultdict(list)
    point_meta: Dict[PointMetaKey, PointMeta] = {}
    file_index_by_relpath = {file_relpath: idx for idx, file_relpath in enumerate(file_relpaths)}
    scanned: Dict[str, int] = {}

    for file_relpath in file_relpaths:
        file_index = file_index_by_relpath[file_relpath]
        file_path = input_root / file_relpath
        scanned_rows = 0
        with file_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row_index, row in enumerate(reader):
                scanned_rows += 1
                minute_iso = floor_to_minute_iso(row.get("timestamp"))
                lon_raw, lat_raw = pick_lon_lat(row)
                if not minute_iso or not lon_raw or not lat_raw:
                    continue
                try:
                    lon = float(lon_raw)
                    lat = float(lat_raw)
                except Exception:
                    continue
                if not (math.isfinite(lon) and math.isfinite(lat)):
                    continue
                cell_key = build_cell_key(provider, resolution, lon, lat)
                task_id = f"{minute_iso}|{cell_key}"
                task = task_lookup.get(task_id)
                if task is None:
                    continue
                point = BucketPoint(index=row_index, lon=lon, lat=lat, file_index=file_index)
                task_points[task_id].append(point)
                point_meta[(task_id, file_index, row_index)] = PointMeta(
                    task_id=task_id,
                    file_relpath=file_relpath,
                    row_index=row_index,
                    timestamp=str(row.get("timestamp") or ""),
                    lon=lon,
                    lat=lat,
                )
        scanned[file_relpath] = scanned_rows
    return task_points, point_meta, scanned


def scan_raw_stay_points_for_tasks(
    input_root: Path,
    file_relpaths: Sequence[str],
    tasks: Sequence[SelectedTask],
    *,
    step_seconds: int,
    solar_elevation_threshold_deg: float,
) -> Tuple[Dict[str, List[BucketPoint]], Dict[Tuple[int, int], PointMeta], Dict[str, int]]:
    if not tasks:
        return {}, {}, {}

    provider_set = {task.cell_provider for task in tasks}
    resolution_set = {task.cell_resolution for task in tasks}
    if len(provider_set) != 1 or len(resolution_set) != 1:
        raise RuntimeError("Prototype executor expects a single cell provider/resolution in the selected task set.")
    provider = next(iter(provider_set))
    resolution = next(iter(resolution_set))

    task_lookup = {task.task_id: task for task in tasks}
    task_points: Dict[str, List[BucketPoint]] = defaultdict(list)
    point_meta: Dict[PointMetaKey, PointMeta] = {}
    file_index_by_relpath = {file_relpath: idx for idx, file_relpath in enumerate(file_relpaths)}
    scanned: Dict[str, int] = {}
    solar_cache: Dict[Tuple[float, float, str], Any] = {}

    for file_relpath in file_relpaths:
        file_index = file_index_by_relpath[file_relpath]
        file_path = input_root / file_relpath
        scanned_rows = 0
        with file_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row_index, row in enumerate(reader):
                scanned_rows += 1
                lon, lat = _raw_row_coords(row)
                start_ts = _safe_int(row.get("start_time"))
                end_ts = _safe_int(row.get("end_time"))
                if lon is None or lat is None or start_ts is None:
                    continue
                if end_ts is None or end_ts < start_ts:
                    end_ts = start_ts
                cell_key = build_cell_key(provider, resolution, lon, lat)
                for ts_value in iter_daylight_timestamps(
                    start_ts=start_ts,
                    end_ts=end_ts,
                    lat=lat,
                    lon=lon,
                    step_seconds=int(step_seconds),
                    threshold_deg=float(solar_elevation_threshold_deg),
                    solar_cache=solar_cache,
                ):
                    minute_iso = floor_to_minute_iso(ts_value)
                    if not minute_iso:
                        continue
                    task_id = f"{minute_iso}|{cell_key}"
                    task = task_lookup.get(task_id)
                    if task is None:
                        continue
                    point = BucketPoint(index=row_index, lon=lon, lat=lat, file_index=file_index)
                    task_points[task_id].append(point)
                    point_meta[(task_id, file_index, row_index)] = PointMeta(
                        task_id=task_id,
                        file_relpath=file_relpath,
                        row_index=row_index,
                        timestamp=minute_iso,
                        lon=lon,
                        lat=lat,
                    )
        scanned[file_relpath] = scanned_rows
    return task_points, point_meta, scanned


def load_task_points_from_cache(
    cache_csv: Path,
) -> Tuple[Dict[str, List[BucketPoint]], Dict[PointMetaKey, PointMeta], Dict[str, int]]:
    task_points: Dict[str, List[BucketPoint]] = defaultdict(list)
    point_meta: Dict[PointMetaKey, PointMeta] = {}
    file_index_by_relpath: Dict[str, int] = {}
    scanned: Dict[str, int] = {}
    with cache_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            task_id = str(row.get("task_id") or "").strip()
            file_relpath = str(row.get("file_relpath") or "").strip()
            if not task_id or not file_relpath:
                continue
            row_index = int(row["row_index"])
            lon = float(row["lon"])
            lat = float(row["lat"])
            timestamp = str(row.get("timestamp") or "")
            file_index = file_index_by_relpath.setdefault(file_relpath, len(file_index_by_relpath))
            point = BucketPoint(index=row_index, lon=lon, lat=lat, file_index=file_index)
            task_points[task_id].append(point)
            point_meta[(task_id, file_index, row_index)] = PointMeta(
                task_id=task_id,
                file_relpath=file_relpath,
                row_index=row_index,
                timestamp=timestamp,
                lon=lon,
                lat=lat,
            )
    for file_relpath in file_index_by_relpath:
        scanned[file_relpath] = 0
    return task_points, point_meta, scanned


def load_task_points_from_source_spans(
    db_path: Path,
    tasks: Sequence[SelectedTask],
    source_spans_table: str,
) -> Tuple[Dict[str, List[BucketPoint]], Dict[PointMetaKey, PointMeta], Dict[str, int]]:
    if not tasks:
        return {}, {}, {}

    try:
        import duckdb
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("This script requires the `duckdb` Python package.") from exc

    quoted_ids = ", ".join(sql_quote(task.task_id) for task in tasks)
    query = f"""
    SELECT
      t.task_id,
      s.file_relpath,
      s.row_index,
      t.minute_iso AS timestamp,
      s.lon,
      s.lat
    FROM tasks t
    JOIN {source_spans_table} s
      ON t.cell_key = s.cell_key
     AND t.minute_ts >= s.start_minute_ts
     AND t.minute_ts <= s.end_minute_ts
    WHERE t.task_id IN ({quoted_ids})
    ORDER BY t.task_id, s.file_relpath, s.row_index
    """
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        rows = con.execute(query).fetchall()
    finally:
        con.close()

    task_points: Dict[str, List[BucketPoint]] = defaultdict(list)
    point_meta: Dict[PointMetaKey, PointMeta] = {}
    file_index_by_relpath: Dict[str, int] = {}
    scanned: Dict[str, int] = {}
    for task_id, file_relpath, row_index, timestamp, lon, lat in rows:
        task_id_str = str(task_id)
        file_relpath_str = str(file_relpath)
        file_index = file_index_by_relpath.setdefault(file_relpath_str, len(file_index_by_relpath))
        point = BucketPoint(index=int(row_index), lon=float(lon), lat=float(lat), file_index=file_index)
        task_points[task_id_str].append(point)
        point_meta[(task_id_str, file_index, int(row_index))] = PointMeta(
            task_id=task_id_str,
            file_relpath=file_relpath_str,
            row_index=int(row_index),
            timestamp=str(timestamp),
            lon=float(lon),
            lat=float(lat),
        )
    for file_relpath in file_index_by_relpath:
        scanned[file_relpath] = 0
    return task_points, point_meta, scanned


def filter_geodataframe_to_bounds(gdf, bounds: Mapping[str, float]):
    west = float(bounds["west"])
    south = float(bounds["south"])
    east = float(bounds["east"])
    north = float(bounds["north"])
    try:
        subset = gdf.cx[west:east, south:north]
        return subset.copy()
    except Exception:
        return gdf.copy()


def _manifest_output_path(entry: ManifestEntry | str) -> str:
    return entry.output_path if isinstance(entry, ManifestEntry) else str(entry)


def load_partition_union(
    manifest_map: Mapping[str, ManifestEntry],
    partition_ids: Sequence[str],
    cache: Dict[Tuple[str, ...], Any],
):
    key = tuple(sorted(partition_ids))
    cached = cache.get(key)
    if cached is not None:
        return cached

    import geopandas as gpd
    import pandas as pd

    parts = []
    for partition_id in key:
        entry = manifest_map.get(partition_id)
        if not entry:
            raise RuntimeError(f"Missing partition parquet for {partition_id}")
        parts.append(gpd.read_parquet(_manifest_output_path(entry)))
    if not parts:
        union = gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    else:
        geometry_name = parts[0].geometry.name
        union = gpd.GeoDataFrame(
            pd.concat(parts, ignore_index=True),
            geometry=geometry_name,
            crs=getattr(parts[0], "crs", None) or "EPSG:4326",
        )
    cache[key] = union
    return union


def load_partition_union_for_bbox(
    manifest_map: Mapping[str, ManifestEntry],
    partition_ids: Sequence[str],
    bounds: Mapping[str, float],
    cache: Dict[Tuple[Tuple[str, ...], Tuple[float, float, float, float]], Any],
    *,
    use_cache: bool = True,
):
    key_ids = tuple(sorted(partition_ids))
    bbox_tuple = (
        round(float(bounds["west"]), 6),
        round(float(bounds["south"]), 6),
        round(float(bounds["east"]), 6),
        round(float(bounds["north"]), 6),
    )
    cache_key = (key_ids, bbox_tuple)
    if use_cache:
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

    import geopandas as gpd
    import pandas as pd

    bbox = (bbox_tuple[0], bbox_tuple[1], bbox_tuple[2], bbox_tuple[3])
    parts = []
    for partition_id in key_ids:
        entry = manifest_map.get(partition_id)
        if not entry:
            raise RuntimeError(f"Missing partition parquet for {partition_id}")
        try:
            part = gpd.read_parquet(_manifest_output_path(entry), bbox=bbox)
        except Exception:
            part = gpd.read_parquet(_manifest_output_path(entry))
        parts.append(part)
    if not parts:
        union = gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    else:
        geometry_name = parts[0].geometry.name
        union = gpd.GeoDataFrame(
            pd.concat(parts, ignore_index=True),
            geometry=geometry_name,
            crs=getattr(parts[0], "crs", None) or "EPSG:4326",
        )
    if use_cache:
        cache[cache_key] = union
    return union


def build_worker_config(args: argparse.Namespace) -> WorkerConfig:
    return WorkerConfig(
        buildings_source="partition-parquet",
        buildings_path="",
        buildings_layer=None,
        buildings_mode="bbox",
        buildings_point_buffer_m=0.0,
        buildings_point_buffer_threshold_m=0.0,
        postgis_dsn=None,
        postgis_host=None,
        postgis_port=None,
        postgis_database=None,
        postgis_user=None,
        postgis_password=None,
        postgis_table=None,
        postgis_geom_column="geom",
        postgis_height_column="height",
        postgis_where=None,
        canopy_raster_path=None,
        include_canopy=False,
        timezone=str(args.timezone),
        max_features=0,
        era5_file_template=str(args.era5_file_template or "") or None,
        era5_file_path=str(args.era5_file_path or "") or None,
        shadow_cache_cell_size_m=0.0,
        shadow_cache_max_entries=0,
    )


def task_bbox(task: SelectedTask, context_m: float) -> Dict[str, float]:
    return build_bucket_payload(
        task.minute_iso,
        [
            BucketPoint(index=0, lon=task.west, lat=task.south),
            BucketPoint(index=1, lon=task.east, lat=task.north),
        ],
        context_margin_m=context_m,
    )["bbox"]


def points_bbox(minute_iso: str, points: Sequence[BucketPoint], context_m: float) -> Dict[str, float]:
    return build_bucket_payload(minute_iso, points, context_margin_m=context_m)["bbox"]


def points_tight_bounds(points: Sequence[BucketPoint]) -> Dict[str, float]:
    lon_values = [float(point.lon) for point in points]
    lat_values = [float(point.lat) for point in points]
    return {
        "west": min(lon_values),
        "south": min(lat_values),
        "east": max(lon_values),
        "north": max(lat_values),
    }


def parse_bool_string(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def task_ids_digest(tasks: Sequence[SelectedTask]) -> str:
    digest = hashlib.sha256()
    for task in tasks:
        digest.update(task.task_id.encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def output_success_marker(output_dir: Path) -> Path:
    return output_dir / "_SUCCESS"


def mark_output_success(output_dir: Path, summary: Mapping[str, Any]) -> None:
    marker = output_success_marker(output_dir)
    payload = {
        "status": "ok",
        "summaryJson": str(output_dir / "summary.json"),
        "resultRowsPath": summary.get("resultRowsPath", ""),
        "resultManifestPath": summary.get("resultManifestPath", ""),
        "processedTaskCount": int(summary.get("processedTaskCount", 0)),
        "resultRowCount": int(summary.get("resultRowCount", 0)),
        "taskIdsDigest": summary.get("taskIdsDigest", ""),
        "writtenEpochSeconds": time.time(),
    }
    marker.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def successful_output_summary(output_dir: Path, expected_digest: Optional[str] = None) -> Optional[Dict[str, Any]]:
    summary_path = output_dir / "summary.json"
    rows_path = output_dir / "task_point_results.csv"
    manifest_path = output_dir / "result_manifest.json"
    marker_path = output_success_marker(output_dir)
    if not (summary_path.exists() and marker_path.exists() and (rows_path.exists() or manifest_path.exists())):
        return None
    try:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if summary.get("status") != "ok":
        return None
    if expected_digest and summary.get("taskIdsDigest") != expected_digest:
        return None
    return summary


def update_summary_metadata(
    summary: Dict[str, Any],
    *,
    db_path: Path,
    manifest_path: Path,
    input_root: Path,
    output_dir: Path,
    args: argparse.Namespace,
    selected_task_count: int,
    selected_file_count: int,
    scanned: Mapping[str, int],
    tasks: Sequence[SelectedTask],
) -> Dict[str, Any]:
    summary.update(
        {
            "status": summary.get("status", "ok"),
            "taskGraphDb": str(db_path),
            "partitionManifestCsv": str(manifest_path),
            "inputRoot": str(input_root),
            "outputDir": str(output_dir),
            "shadowKernel": str(args.shadow_kernel),
            "obstacleReachFilter": str(args.obstacle_reach_filter),
            "checkpointTaskCount": int(args.checkpoint_task_count),
            "checkpointMaxPointCount": int(args.checkpoint_max_point_count),
            "finalOutputMode": str(args.final_output_mode),
            "resume": parse_bool_string(str(args.resume)),
            "selectedTaskCount": selected_task_count,
            "selectedFileCount": selected_file_count,
            "scannedFileCount": len(scanned),
            "scannedRowCount": sum(scanned.values()),
            "taskIdsDigest": task_ids_digest(tasks),
        }
    )
    return summary


def write_summary_and_success(output_dir: Path, summary: Dict[str, Any]) -> None:
    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    mark_output_success(output_dir, summary)


def bbox_center(bounds: Mapping[str, float]) -> Tuple[float, float]:
    lon = (float(bounds["west"]) + float(bounds["east"])) / 2.0
    lat = (float(bounds["south"]) + float(bounds["north"])) / 2.0
    return lon, lat


def solar_elevation_deg(timestamp_iso: str, lon: float, lat: float) -> Optional[float]:
    try:
        import pandas as pd
        import pvlib

        dt_index = pd.DatetimeIndex([pd.Timestamp(timestamp_iso, tz="UTC")])
        solar = pvlib.solarposition.get_solarposition(dt_index, latitude=float(lat), longitude=float(lon))
        elevation = float(solar["apparent_elevation"].iloc[0])
    except Exception:
        return None
    return elevation if math.isfinite(elevation) else None


def max_obstacle_height_m(gdf, height_column: str) -> Optional[float]:
    if gdf is None or getattr(gdf, "empty", True) or height_column not in gdf.columns:
        return None
    try:
        values = gdf[height_column].astype(float)
        values = values[values.map(math.isfinite)]
        if values.empty:
            return None
        height = float(values.max())
    except Exception:
        return None
    return max(0.0, height) if math.isfinite(height) else None


def obstacle_height_series_m(gdf, preferred_column: str, default_height_m: float = 12.0):
    import pandas as pd

    candidates = [
        preferred_column,
        "height",
        "height_m",
        "HEIGHT",
        "height_mean",
    ]
    for column in candidates:
        if column and column in gdf.columns:
            values = pd.to_numeric(gdf[column], errors="coerce")
            values = values.replace([float("inf"), float("-inf")], math.nan)
            return values.fillna(default_height_m).clip(lower=0.0)

    if "levels" in gdf.columns:
        values = pd.to_numeric(gdf["levels"], errors="coerce") * 3.5
        values = values.replace([float("inf"), float("-inf")], math.nan)
        return values.fillna(default_height_m).clip(lower=0.0)

    return pd.Series(default_height_m, index=gdf.index, dtype="float64")


def local_aeqd_crs(bounds: Mapping[str, float]) -> str:
    lon, lat = bbox_center(bounds)
    return f"+proj=aeqd +lat_0={lat:.10f} +lon_0={lon:.10f} +datum=WGS84 +units=m +no_defs +type=crs"


def filter_obstacles_by_shadow_reach(
    *,
    obstacles,
    target_bounds: Mapping[str, float],
    timestamp_iso: str,
    height_column: str,
    margin_m: float,
    min_elevation_deg: float,
) -> Tuple[Any, Dict[str, Any]]:
    input_count = int(len(obstacles))
    meta: Dict[str, Any] = {
        "enabled": True,
        "inputRows": input_count,
        "outputRows": input_count,
        "removedRows": 0,
        "solarElevationDeg": None,
        "maxReachM": None,
        "reason": "fallback",
    }
    if input_count == 0:
        meta["reason"] = "empty"
        return obstacles, meta

    lon, lat = bbox_center(target_bounds)
    elevation = solar_elevation_deg(timestamp_iso, lon, lat)
    meta["solarElevationDeg"] = elevation
    if elevation is None or elevation <= float(min_elevation_deg):
        meta["reason"] = "low_sun_or_unknown"
        return obstacles, meta

    try:
        import geopandas as gpd
        from shapely.geometry import box

        work = obstacles
        if getattr(work, "crs", None) is None:
            work = work.set_crs("EPSG:4326")
        elif work.crs.to_string() != "EPSG:4326":
            work = work.to_crs("EPSG:4326")

        target_geom = box(
            float(target_bounds["west"]),
            float(target_bounds["south"]),
            float(target_bounds["east"]),
            float(target_bounds["north"]),
        )
        metric_crs = local_aeqd_crs(target_bounds)
        target_metric = gpd.GeoSeries([target_geom], crs="EPSG:4326").to_crs(metric_crs).iloc[0]
        projected = work.to_crs(metric_crs)

        heights = obstacle_height_series_m(work, height_column)
        reaches = heights / math.tan(math.radians(max(float(elevation), 0.01))) + max(0.0, float(margin_m))
        reaches = reaches.reindex(projected.index)
        distances = projected.geometry.distance(target_metric)
        keep = distances <= reaches
        keep = keep.fillna(True)
        filtered = obstacles.loc[keep].copy()
    except Exception as exc:
        meta["reason"] = f"error:{type(exc).__name__}"
        return obstacles, meta

    output_count = int(len(filtered))
    meta.update(
        {
            "outputRows": output_count,
            "removedRows": input_count - output_count,
            "maxReachM": float(reaches.max()) if len(reaches) else None,
            "reason": "height_distance",
        }
    )
    return filtered, meta


def build_fast_ground_shadow_cache_entry_for_job(job: BucketJob, buildings_preprocessed) -> Dict[str, Any]:
    """Generate pybdshadow-compatible ground shadows without its pandas/groupby path."""
    from zoneinfo import ZoneInfo

    import numpy as np
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree
    from suncalc import get_position

    from engine_core import parse_timestamp
    from pybdshadow.pybdshadow import calSunShadow_vector

    buildings = buildings_preprocessed.copy(deep=False)
    if "height" not in buildings.columns:
        raise RuntimeError("fast-ground shadow kernel requires preprocessed buildings with a height column")
    buildings = buildings[buildings["height"] > 0]
    if getattr(buildings, "empty", False):
        return {"mode": "empty", "geoms": [], "tree": None}

    bounds_mean = list(buildings.bounds.mean())
    lon = (float(bounds_mean[0]) + float(bounds_mean[2])) / 2.0
    lat = (float(bounds_mean[1]) + float(bounds_mean[3])) / 2.0

    tzinfo = ZoneInfo(job.worker.timezone)
    parsed_dt = parse_timestamp(job.bucket_key)
    if parsed_dt.tzinfo is None:
        aware_dt = parsed_dt.replace(tzinfo=tzinfo)
    else:
        aware_dt = parsed_dt.astimezone(tzinfo)
    utc_dt = aware_dt.astimezone(ZoneInfo("UTC"))

    sun_position = get_position(utc_dt, lon, lat)
    if sun_position["altitude"] < 0:
        return {"mode": "night", "geoms": [], "tree": None}

    wall_segments: List[Tuple[Tuple[float, float], Tuple[float, float]]] = []
    wall_heights: List[float] = []
    footprint_geoms: List[Any] = []
    for geom, height_raw in zip(buildings.geometry, buildings["height"]):
        if geom is None or geom.is_empty:
            continue
        try:
            height = float(height_raw)
        except Exception:
            continue
        if not math.isfinite(height) or height <= 0:
            continue

        polygons = list(getattr(geom, "geoms", [])) if geom.geom_type == "MultiPolygon" else [geom]
        for polygon in polygons:
            if polygon is None or polygon.is_empty or polygon.geom_type != "Polygon":
                continue
            coords = list(polygon.exterior.coords)
            if len(coords) < 2:
                continue
            footprint_geoms.append(polygon)
            for idx in range(len(coords) - 1):
                wall_segments.append((coords[idx], coords[idx + 1]))
                wall_heights.append(height)

    if not wall_segments and not footprint_geoms:
        return {"mode": "empty", "geoms": [], "tree": None}

    geoms: List[Any] = []
    if wall_segments:
        walls_shape = np.asarray(wall_segments, dtype="float64")
        heights = np.asarray(wall_heights, dtype="float64")
        shadow_shape = calSunShadow_vector(walls_shape, heights, sun_position)
        for coords in shadow_shape:
            try:
                polygon = Polygon(coords)
            except Exception:
                continue
            if polygon is not None and not polygon.is_empty:
                geoms.append(polygon)
    geoms.extend(footprint_geoms)

    if not geoms:
        return {"mode": "shadow", "geoms": [], "tree": None}
    return {"mode": "shadow", "geoms": geoms, "tree": STRtree(geoms)}


def adaptive_context_m(
    *,
    timestamp_iso: str,
    candidate_bounds: Mapping[str, float],
    candidate_obstacles,
    max_context_m: float,
    min_context_m: float,
    margin_m: float,
    height_column: str,
) -> Tuple[float, Dict[str, Any]]:
    max_context = max(0.0, float(max_context_m))
    min_context = max(0.0, min(float(min_context_m), max_context))
    margin = max(0.0, float(margin_m))
    lon, lat = bbox_center(candidate_bounds)
    elevation = solar_elevation_deg(timestamp_iso, lon, lat)
    height = max_obstacle_height_m(candidate_obstacles, height_column)

    if elevation is None or elevation <= 0.0 or height is None:
        return max_context, {
            "enabled": True,
            "contextM": max_context,
            "solarElevationDeg": elevation,
            "heightM": height,
            "reason": "fallback",
        }

    reach = height / math.tan(math.radians(max(elevation, 0.01)))
    context = min(max_context, max(min_context, reach + margin))
    return context, {
        "enabled": True,
        "contextM": context,
        "solarElevationDeg": elevation,
        "heightM": height,
        "shadowReachM": reach,
        "reason": "height_solar",
    }


def split_points_spatially(
    points: Sequence[BucketPoint],
    *,
    min_points_per_child: int,
) -> List[List[BucketPoint]]:
    if len(points) < 2:
        return []
    min_points = max(1, int(min_points_per_child))
    if len(points) < min_points * 2:
        return []
    lon_values = [float(point.lon) for point in points]
    lat_values = [float(point.lat) for point in points]
    lon_span = max(lon_values) - min(lon_values)
    lat_span = max(lat_values) - min(lat_values)
    if lon_span >= lat_span:
        ordered = sorted(points, key=lambda point: (float(point.lon), float(point.lat), point.file_index, point.index))
    else:
        ordered = sorted(points, key=lambda point: (float(point.lat), float(point.lon), point.file_index, point.index))
    mid = len(ordered) // 2
    left = list(ordered[:mid])
    right = list(ordered[mid:])
    if len(left) < min_points or len(right) < min_points:
        return []
    return [left, right]


def should_split_execution_unit(
    *,
    point_count: int,
    obstacle_count: int,
    depth: int,
    args: argparse.Namespace,
) -> bool:
    if depth >= max(0, int(args.max_execution_split_depth)):
        return False
    by_points = int(args.max_points_per_execution_unit) > 0 and point_count > int(args.max_points_per_execution_unit)
    by_obstacles = (
        int(args.max_obstacles_per_execution_unit) > 0
        and obstacle_count > int(args.max_obstacles_per_execution_unit)
    )
    return bool(by_points or by_obstacles)


def build_shadow_cache_entry_for_obstacles(
    job: BucketJob,
    clipped,
    preprocess_buildings,
    *,
    max_obstacles_per_shadow_batch: int,
    shadow_kernel: str,
) -> Tuple[Dict[str, Any], int]:
    def build_entry(preprocessed):
        if shadow_kernel == "fast-ground":
            return build_fast_ground_shadow_cache_entry_for_job(job, preprocessed)
        return _build_shadow_cache_entry_for_job(job, preprocessed)

    obstacle_count = int(len(clipped))
    batch_size = int(max_obstacles_per_shadow_batch)
    if batch_size <= 0 or obstacle_count <= batch_size:
        preprocessed = preprocess_buildings(clipped)
        if getattr(preprocessed, "empty", False):
            return {"mode": "empty", "geoms": [], "tree": None}, 0
        return build_entry(preprocessed), 1

    from shapely.strtree import STRtree

    geoms: List[Any] = []
    batch_count = 0
    for start_idx in range(0, obstacle_count, batch_size):
        part = clipped.iloc[start_idx : start_idx + batch_size]
        if part.empty:
            continue
        preprocessed = preprocess_buildings(part)
        if getattr(preprocessed, "empty", False):
            continue
        entry = build_entry(preprocessed)
        batch_count += 1
        if entry.get("mode") == "night":
            return entry, batch_count
        geoms.extend(entry.get("geoms") or [])

    if not geoms:
        return {"mode": "shadow", "geoms": [], "tree": None}, batch_count
    return {"mode": "shadow", "geoms": geoms, "tree": STRtree(geoms)}, batch_count


def append_result_rows(
    *,
    result_rows: List[Dict[str, Any]],
    summary: Dict[str, Any],
    used_files: set[str],
    task: SelectedTask,
    point_meta: Mapping[PointMetaKey, PointMeta],
    result: Any,
    partition_count: int,
) -> None:
    for update in result.row_updates:
        meta = point_meta[(task.task_id, update.file_index, update.index)]
        used_files.add(meta.file_relpath)
        values = update.values
        if values.get("source") == "fallback_error":
            summary["fallbackRowCount"] += 1
        result_rows.append(
            {
                "task_id": task.task_id,
                "minute_iso": task.minute_iso,
                "file_relpath": meta.file_relpath,
                "row_index": meta.row_index,
                "timestamp": meta.timestamp,
                "lon": meta.lon,
                "lat": meta.lat,
                "partition_count": partition_count,
                "sunlit": values.get("sunlit", ""),
                "shadowPercent": values.get("shadowPercent", ""),
                "source": values.get("source", ""),
                "errorDetail": values.get("errorDetail", ""),
                "cloudCover": values.get("cloudCover", ""),
                "sunlightFactor": values.get("sunlightFactor", ""),
                "solarIrradianceWm2": values.get("solarIrradianceWm2", ""),
                "sunlitEffective": values.get("sunlitEffective", ""),
                "shadowPercentEffective": values.get("shadowPercentEffective", ""),
                "irradianceEffective": values.get("irradianceEffective", ""),
            }
        )


def execute_tasks(
    tasks: Sequence[SelectedTask],
    task_points: Mapping[str, Sequence[BucketPoint]],
    point_meta: Mapping[PointMetaKey, PointMeta],
    manifest_map: Mapping[str, ManifestEntry],
    args: argparse.Namespace,
    output_dir: Path,
) -> Dict[str, Any]:
    if str(ENGINE_PATH) not in sys.path:
        sys.path.append(str(ENGINE_PATH))
    from engine_core import preprocess_buildings

    worker = build_worker_config(args)
    partition_union_cache: Dict[Tuple[Tuple[str, ...], Tuple[float, float, float, float]], Any] = {}
    result_rows: List[Dict[str, Any]] = []
    summary: Dict[str, Any] = {
        "processedTaskCount": 0,
        "nightTaskCount": 0,
        "engineTaskCount": 0,
        "emptyTaskCount": 0,
        "engineExecutionUnitCount": 0,
        "emptyExecutionUnitCount": 0,
        "fallbackRowCount": 0,
        "splitTaskCount": 0,
        "executionUnitCount": 0,
        "splitNodeCount": 0,
        "shadowBatchCount": 0,
        "maxExecutionDepth": 0,
        "maxExecutionUnitPointCount": 0,
        "maxExecutionUnitObstacleRows": 0,
        "maxCandidateObstacleRows": 0,
        "adaptiveContextTaskCount": 0,
        "minAdaptiveContextM": "",
        "maxAdaptiveContextM": 0.0,
        "reachFilterTaskCount": 0,
        "reachFilterRemovedObstacleRows": 0,
        "maxReachFilterInputObstacleRows": 0,
        "maxReachFilterOutputObstacleRows": 0,
        "resultRowCount": 0,
        "distinctPartitionCount": 0,
        "distinctFileCount": 0,
    }
    used_partitions: set[str] = set()
    used_files: set[str] = set()

    started = time.time()
    for task in tasks:
        task_started = time.time()
        points = list(task_points.get(task.task_id, []))
        if not points:
            continue

        root_bbox = task_bbox(task, float(args.context_m))
        root_job = BucketJob(
            bucket_key=task.minute_iso,
            bbox=root_bbox,
            points=points,
            worker=worker,
            file_label=f"partition-exact[{task.task_id}]",
            shadow_cache_key=None,
            shadow_cache_bbox=None,
            obstacle_cache_key=None,
            obstacle_cache_bbox=None,
        )

        weather = _evaluate_bucket_weather(root_job)
        task_metrics: Dict[str, Any] = {
            "rootObstacleRows": 0,
            "executionUnitCount": 0,
            "splitNodeCount": 0,
            "shadowBatchCount": 0,
            "maxExecutionDepth": 0,
            "maxUnitPointCount": 0,
            "maxUnitObstacleRows": 0,
            "maxCandidateObstacleRows": 0,
            "totalLeafObstacleRows": 0,
            "engineLeafCount": 0,
            "emptyLeafCount": 0,
            "adaptiveContextUsed": False,
            "minContextM": None,
            "maxContextM": 0.0,
            "reachFilterUsed": False,
            "reachFilterInputRows": 0,
            "reachFilterOutputRows": 0,
            "reachFilterRemovedRows": 0,
        }

        if weather.is_night:
            result = _night_bucket_result(root_job, weather)
            summary["nightTaskCount"] += 1
            append_result_rows(
                result_rows=result_rows,
                summary=summary,
                used_files=used_files,
                task=task,
                point_meta=point_meta,
                result=result,
                partition_count=len(task.partition_ids),
            )
        else:
            def execute_unit(unit_points: List[BucketPoint], depth: int, unit_path: str) -> None:
                candidate_bbox = root_bbox if depth == 0 or args.execution_unit_bbox_mode == "parent" else points_bbox(
                    task.minute_iso,
                    unit_points,
                    float(args.context_m),
                )
                union = load_partition_union_for_bbox(
                    manifest_map=manifest_map,
                    partition_ids=task.partition_ids,
                    bounds=candidate_bbox,
                    cache=partition_union_cache,
                    use_cache=False,
                )
                candidate_clipped = filter_geodataframe_to_bounds(union, candidate_bbox)
                candidate_obstacle_count = int(len(candidate_clipped))
                unit_bbox = candidate_bbox
                context_used_m = float(args.context_m)
                adaptive_meta: Dict[str, Any] = {"enabled": False, "contextM": context_used_m}
                if parse_bool_string(str(args.adaptive_context)) and not candidate_clipped.empty:
                    context_used_m, adaptive_meta = adaptive_context_m(
                        timestamp_iso=task.minute_iso,
                        candidate_bounds=candidate_bbox,
                        candidate_obstacles=candidate_clipped,
                        max_context_m=float(args.context_m),
                        min_context_m=float(args.adaptive_context_min_m),
                        margin_m=float(args.adaptive_context_margin_m),
                        height_column=str(args.adaptive_context_height_column),
                    )
                    if context_used_m < float(args.context_m) - 1e-6:
                        if args.execution_unit_bbox_mode == "parent" and depth > 0:
                            unit_bbox = root_bbox
                        else:
                            unit_bbox = points_bbox(
                                task.minute_iso,
                                unit_points,
                                context_used_m,
                            )
                    task_metrics["adaptiveContextUsed"] = True
                    current_min = task_metrics["minContextM"]
                    task_metrics["minContextM"] = (
                        context_used_m
                        if current_min is None
                        else min(float(current_min), context_used_m)
                    )
                    task_metrics["maxContextM"] = max(float(task_metrics["maxContextM"]), context_used_m)

                clipped = filter_geodataframe_to_bounds(candidate_clipped, unit_bbox)
                obstacle_count = int(len(clipped))
                if parse_bool_string(str(args.obstacle_reach_filter)) and not clipped.empty:
                    clipped, reach_meta = filter_obstacles_by_shadow_reach(
                        obstacles=clipped,
                        target_bounds=points_tight_bounds(unit_points),
                        timestamp_iso=task.minute_iso,
                        height_column=str(args.adaptive_context_height_column),
                        margin_m=float(args.obstacle_reach_filter_margin_m),
                        min_elevation_deg=float(args.obstacle_reach_filter_min_elevation_deg),
                    )
                    obstacle_count = int(len(clipped))
                    task_metrics["reachFilterUsed"] = True
                    task_metrics["reachFilterInputRows"] += int(reach_meta.get("inputRows") or 0)
                    task_metrics["reachFilterOutputRows"] += int(reach_meta.get("outputRows") or 0)
                    task_metrics["reachFilterRemovedRows"] += int(reach_meta.get("removedRows") or 0)
                if depth == 0:
                    task_metrics["rootObstacleRows"] = obstacle_count
                    task_metrics["maxCandidateObstacleRows"] = candidate_obstacle_count

                if should_split_execution_unit(
                    point_count=len(unit_points),
                    obstacle_count=obstacle_count,
                    depth=depth,
                    args=args,
                ):
                    children = split_points_spatially(
                        unit_points,
                        min_points_per_child=int(args.min_points_per_execution_unit),
                    )
                    if children:
                        task_metrics["splitNodeCount"] += 1
                        for child_idx, child_points in enumerate(children):
                            execute_unit(child_points, depth + 1, f"{unit_path}.{child_idx}")
                        return

                job = BucketJob(
                    bucket_key=task.minute_iso,
                    bbox=unit_bbox,
                    points=unit_points,
                    worker=worker,
                    file_label=f"partition-exact[{task.task_id}#{unit_path}]",
                    shadow_cache_key=None,
                    shadow_cache_bbox=None,
                    obstacle_cache_key=None,
                    obstacle_cache_bbox=None,
                )
                if clipped.empty:
                    cache_entry = {"mode": "empty", "geoms": [], "tree": None}
                    batch_count = 0
                    task_metrics["emptyLeafCount"] += 1
                    summary["emptyExecutionUnitCount"] += 1
                else:
                    cache_entry, batch_count = build_shadow_cache_entry_for_obstacles(
                        job,
                        clipped,
                        preprocess_buildings,
                        max_obstacles_per_shadow_batch=int(args.max_obstacles_per_shadow_batch),
                        shadow_kernel=str(args.shadow_kernel),
                    )
                    task_metrics["engineLeafCount"] += 1
                    summary["engineExecutionUnitCount"] += 1

                task_metrics["executionUnitCount"] += 1
                task_metrics["shadowBatchCount"] += int(batch_count)
                task_metrics["maxExecutionDepth"] = max(int(task_metrics["maxExecutionDepth"]), depth)
                task_metrics["maxUnitPointCount"] = max(int(task_metrics["maxUnitPointCount"]), len(unit_points))
                task_metrics["maxUnitObstacleRows"] = max(int(task_metrics["maxUnitObstacleRows"]), obstacle_count)
                task_metrics["maxCandidateObstacleRows"] = max(
                    int(task_metrics["maxCandidateObstacleRows"]),
                    candidate_obstacle_count,
                )
                task_metrics["totalLeafObstacleRows"] += obstacle_count

                result = _row_updates_from_shadow_cache(
                    job,
                    cache_entry,
                    cloud_cover_out=weather.cloud_cover_out,
                    sunlight_factor_out=weather.sunlight_factor_out,
                    solar_irradiance_out=weather.solar_irradiance_out,
                )
                append_result_rows(
                    result_rows=result_rows,
                    summary=summary,
                    used_files=used_files,
                    task=task,
                    point_meta=point_meta,
                    result=result,
                    partition_count=len(task.partition_ids),
                )

            execute_unit(points, 0, "0")

        summary["processedTaskCount"] += 1
        used_partitions.update(task.partition_ids)
        summary["executionUnitCount"] += int(task_metrics["executionUnitCount"])
        summary["splitNodeCount"] += int(task_metrics["splitNodeCount"])
        summary["shadowBatchCount"] += int(task_metrics["shadowBatchCount"])
        summary["maxExecutionDepth"] = max(int(summary["maxExecutionDepth"]), int(task_metrics["maxExecutionDepth"]))
        summary["maxExecutionUnitPointCount"] = max(
            int(summary["maxExecutionUnitPointCount"]),
            int(task_metrics["maxUnitPointCount"]),
        )
        summary["maxExecutionUnitObstacleRows"] = max(
            int(summary["maxExecutionUnitObstacleRows"]),
            int(task_metrics["maxUnitObstacleRows"]),
        )
        summary["maxCandidateObstacleRows"] = max(
            int(summary["maxCandidateObstacleRows"]),
            int(task_metrics["maxCandidateObstacleRows"]),
        )
        if bool(task_metrics["adaptiveContextUsed"]):
            summary["adaptiveContextTaskCount"] += 1
            if task_metrics["minContextM"] is not None:
                if summary["minAdaptiveContextM"] == "":
                    summary["minAdaptiveContextM"] = float(task_metrics["minContextM"])
                else:
                    summary["minAdaptiveContextM"] = min(
                        float(summary["minAdaptiveContextM"]),
                        float(task_metrics["minContextM"]),
                    )
            summary["maxAdaptiveContextM"] = max(
                float(summary["maxAdaptiveContextM"]),
                float(task_metrics["maxContextM"]),
            )
        if bool(task_metrics["reachFilterUsed"]):
            summary["reachFilterTaskCount"] += 1
            summary["reachFilterRemovedObstacleRows"] += int(task_metrics["reachFilterRemovedRows"])
            summary["maxReachFilterInputObstacleRows"] = max(
                int(summary["maxReachFilterInputObstacleRows"]),
                int(task_metrics["reachFilterInputRows"]),
            )
            summary["maxReachFilterOutputObstacleRows"] = max(
                int(summary["maxReachFilterOutputObstacleRows"]),
                int(task_metrics["reachFilterOutputRows"]),
            )
        if int(task_metrics["executionUnitCount"]) > 1:
            summary["splitTaskCount"] += 1
        if int(task_metrics["engineLeafCount"]) > 0:
            summary["engineTaskCount"] += 1
        elif int(task_metrics["emptyLeafCount"]) > 0:
            summary["emptyTaskCount"] += 1

        print(
            json.dumps(
                {
                    "taskId": task.task_id,
                    "processedTaskCount": summary["processedTaskCount"],
                    "totalSelectedTasks": len(tasks),
                    "pointCount": len(points),
                    "partitionCount": len(task.partition_ids),
                    "bboxFilteredObstacleRows": int(task_metrics["rootObstacleRows"]),
                    "candidateObstacleRows": int(task_metrics["maxCandidateObstacleRows"]),
                    "executionUnitCount": int(task_metrics["executionUnitCount"]),
                    "splitNodeCount": int(task_metrics["splitNodeCount"]),
                    "shadowBatchCount": int(task_metrics["shadowBatchCount"]),
                    "maxExecutionDepth": int(task_metrics["maxExecutionDepth"]),
                    "maxUnitPointCount": int(task_metrics["maxUnitPointCount"]),
                    "maxUnitObstacleRows": int(task_metrics["maxUnitObstacleRows"]),
                    "totalLeafObstacleRows": int(task_metrics["totalLeafObstacleRows"]),
                    "adaptiveContextUsed": bool(task_metrics["adaptiveContextUsed"]),
                    "minContextM": task_metrics["minContextM"],
                    "maxContextM": task_metrics["maxContextM"],
                    "reachFilterUsed": bool(task_metrics["reachFilterUsed"]),
                    "reachFilterInputRows": int(task_metrics["reachFilterInputRows"]),
                    "reachFilterOutputRows": int(task_metrics["reachFilterOutputRows"]),
                    "reachFilterRemovedRows": int(task_metrics["reachFilterRemovedRows"]),
                    "elapsedSeconds": round(time.time() - task_started, 3),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    summary["resultRowCount"] = len(result_rows)
    summary["distinctPartitionCount"] = len(used_partitions)
    summary["distinctFileCount"] = len(used_files)
    summary["elapsedSeconds"] = time.time() - started

    output_rows_path = output_dir / "task_point_results.csv"
    with output_rows_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "task_id",
                "minute_iso",
                "file_relpath",
                "row_index",
                "timestamp",
                "lon",
                "lat",
                "partition_count",
                "sunlit",
                "shadowPercent",
                "source",
                "errorDetail",
                "cloudCover",
                "sunlightFactor",
                "solarIrradianceWm2",
                "sunlitEffective",
                "shadowPercentEffective",
                "irradianceEffective",
            ],
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(result_rows)
    summary["resultRowsPath"] = str(output_rows_path)
    return summary


SUMMARY_SUM_KEYS = (
    "processedTaskCount",
    "nightTaskCount",
    "engineTaskCount",
    "emptyTaskCount",
    "engineExecutionUnitCount",
    "emptyExecutionUnitCount",
    "fallbackRowCount",
    "splitTaskCount",
    "executionUnitCount",
    "splitNodeCount",
    "shadowBatchCount",
    "adaptiveContextTaskCount",
    "reachFilterTaskCount",
    "reachFilterRemovedObstacleRows",
    "resultRowCount",
)

SUMMARY_MAX_KEYS = (
    "maxExecutionDepth",
    "maxExecutionUnitPointCount",
    "maxExecutionUnitObstacleRows",
    "maxCandidateObstacleRows",
    "maxAdaptiveContextM",
    "maxReachFilterInputObstacleRows",
    "maxReachFilterOutputObstacleRows",
)


def merge_checkpoint_summaries(
    *,
    tasks: Sequence[SelectedTask],
    point_meta: Mapping[PointMetaKey, PointMeta],
    chunk_summaries: Sequence[Mapping[str, Any]],
    output_dir: Path,
    started: float,
) -> Dict[str, Any]:
    summary: Dict[str, Any] = {key: 0 for key in SUMMARY_SUM_KEYS}
    summary.update({key: 0 for key in SUMMARY_MAX_KEYS})
    summary["minAdaptiveContextM"] = ""

    for chunk_summary in chunk_summaries:
        for key in SUMMARY_SUM_KEYS:
            summary[key] = int(summary.get(key, 0)) + int(chunk_summary.get(key, 0) or 0)
        for key in SUMMARY_MAX_KEYS:
            summary[key] = max(float(summary.get(key, 0) or 0), float(chunk_summary.get(key, 0) or 0))
        chunk_min = chunk_summary.get("minAdaptiveContextM", "")
        if chunk_min != "":
            if summary["minAdaptiveContextM"] == "":
                summary["minAdaptiveContextM"] = float(chunk_min)
            else:
                summary["minAdaptiveContextM"] = min(float(summary["minAdaptiveContextM"]), float(chunk_min))

    summary["distinctPartitionCount"] = len({partition_id for task in tasks for partition_id in task.partition_ids})
    selected_task_ids = {task.task_id for task in tasks}
    summary["distinctFileCount"] = len(
        {meta.file_relpath for key, meta in point_meta.items() if key[0] in selected_task_ids}
    )
    summary["elapsedSeconds"] = time.time() - started
    summary["resultRowsPath"] = str(output_dir / "task_point_results.csv")
    return summary


def merge_checkpoint_summaries_without_point_meta(
    *,
    tasks: Sequence[SelectedTask],
    chunk_summaries: Sequence[Mapping[str, Any]],
    output_dir: Path,
    started: float,
) -> Dict[str, Any]:
    """Merge checkpoint summaries when task points are loaded chunk-by-chunk.

    The source-spans production path intentionally avoids holding all point
    metadata for a shard in memory. That means exact distinct file counting is
    not available at shard-finalization time without re-reading all checkpoint
    CSVs, so we report a conservative chunk-sum upper bound instead.
    """

    summary: Dict[str, Any] = {key: 0 for key in SUMMARY_SUM_KEYS}
    summary.update({key: 0 for key in SUMMARY_MAX_KEYS})
    summary["minAdaptiveContextM"] = ""

    distinct_file_count_upper_bound = 0
    for chunk_summary in chunk_summaries:
        for key in SUMMARY_SUM_KEYS:
            summary[key] = int(summary.get(key, 0)) + int(chunk_summary.get(key, 0) or 0)
        for key in SUMMARY_MAX_KEYS:
            summary[key] = max(float(summary.get(key, 0) or 0), float(chunk_summary.get(key, 0) or 0))
        chunk_min = chunk_summary.get("minAdaptiveContextM", "")
        if chunk_min != "":
            if summary["minAdaptiveContextM"] == "":
                summary["minAdaptiveContextM"] = float(chunk_min)
            else:
                summary["minAdaptiveContextM"] = min(float(summary["minAdaptiveContextM"]), float(chunk_min))
        distinct_file_count_upper_bound += int(chunk_summary.get("distinctFileCount", 0) or 0)

    summary["distinctPartitionCount"] = len({partition_id for task in tasks for partition_id in task.partition_ids})
    summary["distinctFileCount"] = distinct_file_count_upper_bound
    summary["distinctFileCountMode"] = "chunk_sum_upper_bound"
    summary["elapsedSeconds"] = time.time() - started
    summary["resultRowsPath"] = str(output_dir / "task_point_results.csv")
    return summary


def build_checkpoint_plan(
    tasks: Sequence[SelectedTask],
    *,
    task_chunk_size: int,
    max_point_count: int,
) -> List[Tuple[int, int, List[SelectedTask]]]:
    task_limit = max(1, int(task_chunk_size))
    point_limit = max(0, int(max_point_count))
    if point_limit <= 0:
        return [
            (chunk_index, start, list(tasks[start : start + task_limit]))
            for chunk_index, start in enumerate(range(0, len(tasks), task_limit))
        ]

    chunks: List[Tuple[int, int, List[SelectedTask]]] = []
    current: List[SelectedTask] = []
    current_start = 0
    current_points = 0
    for task_index, task in enumerate(tasks):
        task_points = max(0, int(task.point_count))
        would_exceed_points = bool(current) and current_points + task_points > point_limit
        would_exceed_tasks = bool(current) and len(current) >= task_limit
        if would_exceed_points or would_exceed_tasks:
            chunks.append((len(chunks), current_start, current))
            current = []
            current_start = task_index
            current_points = 0
        if not current:
            current_start = task_index
        current.append(task)
        current_points += task_points
    if current:
        chunks.append((len(chunks), current_start, current))
    return chunks


def merge_checkpoint_csvs(chunk_dirs: Sequence[Path], output_path: Path) -> None:
    wrote_header = False
    with output_path.open("w", encoding="utf-8", newline="") as out_handle:
        for chunk_dir in chunk_dirs:
            chunk_csv = chunk_dir / "task_point_results.csv"
            with chunk_csv.open("r", encoding="utf-8", newline="") as in_handle:
                header = in_handle.readline()
                if not header:
                    continue
                if not wrote_header:
                    out_handle.write(header)
                    wrote_header = True
                for line in in_handle:
                    out_handle.write(line)


def write_checkpoint_result_manifest(
    *,
    chunk_dirs: Sequence[Path],
    output_path: Path,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for chunk_dir in chunk_dirs:
        summary_path = chunk_dir / "summary.json"
        csv_path = chunk_dir / "task_point_results.csv"
        if not summary_path.exists() or not csv_path.exists():
            continue
        try:
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
        except Exception:
            summary = {}
        rows.append(
            {
                "checkpointChunk": summary.get("checkpointChunk", chunk_dir.name),
                "checkpointTaskStartIndex": summary.get("checkpointTaskStartIndex", ""),
                "checkpointTaskEndIndex": summary.get("checkpointTaskEndIndex", ""),
                "processedTaskCount": int(summary.get("processedTaskCount", 0) or 0),
                "resultRowCount": int(summary.get("resultRowCount", 0) or 0),
                "taskIdsDigest": summary.get("taskIdsDigest", ""),
                "resultRowsPath": str(csv_path),
                "summaryPath": str(summary_path),
            }
        )
    payload = {
        "format": "checkpoint-csv-manifest-v1",
        "chunkCount": len(rows),
        "resultRowCount": sum(int(row["resultRowCount"]) for row in rows),
        "chunks": rows,
    }
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return rows


def execute_tasks_with_checkpoints(
    *,
    tasks: Sequence[SelectedTask],
    task_points: Mapping[str, Sequence[BucketPoint]],
    point_meta: Mapping[PointMetaKey, PointMeta],
    manifest_map: Mapping[str, ManifestEntry],
    args: argparse.Namespace,
    output_dir: Path,
) -> Dict[str, Any]:
    chunk_size = max(1, int(args.checkpoint_task_count))
    checkpoints_dir = output_dir / "checkpoints"
    checkpoints_dir.mkdir(parents=True, exist_ok=True)

    started = time.time()
    chunk_dirs: List[Path] = []
    chunk_summaries: List[Mapping[str, Any]] = []
    resume = parse_bool_string(str(args.resume))

    chunk_plan = build_checkpoint_plan(
        tasks,
        task_chunk_size=chunk_size,
        max_point_count=int(args.checkpoint_max_point_count),
    )
    for chunk_index, start, chunk_tasks in chunk_plan:
        chunk_dir = checkpoints_dir / f"chunk_{chunk_index:06d}"
        chunk_dir.mkdir(parents=True, exist_ok=True)
        digest = task_ids_digest(chunk_tasks)
        existing = successful_output_summary(chunk_dir, expected_digest=digest) if resume else None
        if existing is not None:
            print(
                json.dumps(
                    {
                        "checkpointChunk": chunk_index,
                        "status": "skipped",
                        "taskCount": len(chunk_tasks),
                        "resultRowCount": int(existing.get("resultRowCount", 0)),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            chunk_summary = existing
        else:
            marker = output_success_marker(chunk_dir)
            if marker.exists():
                marker.unlink()
            chunk_summary = execute_tasks(chunk_tasks, task_points, point_meta, manifest_map, args, chunk_dir)
            chunk_summary.update(
                {
                    "status": "ok",
                    "checkpointChunk": chunk_index,
                    "checkpointTaskStartIndex": start,
                    "checkpointTaskEndIndex": start + len(chunk_tasks),
                    "checkpointTaskCount": len(chunk_tasks),
                    "taskIdsDigest": digest,
                }
            )
            write_summary_and_success(chunk_dir, dict(chunk_summary))

        chunk_dirs.append(chunk_dir)
        chunk_summaries.append(chunk_summary)

    result_manifest_path = output_dir / "result_manifest.json"
    write_checkpoint_result_manifest(chunk_dirs=chunk_dirs, output_path=result_manifest_path)
    if str(args.final_output_mode) == "merged-csv":
        merge_checkpoint_csvs(chunk_dirs, output_dir / "task_point_results.csv")
    summary = merge_checkpoint_summaries(
        tasks=tasks,
        point_meta=point_meta,
        chunk_summaries=chunk_summaries,
        output_dir=output_dir,
        started=started,
    )
    summary.update(
        {
            "checkpointed": True,
            "checkpointChunkCount": len(chunk_dirs),
            "checkpointCompletedChunkCount": len(chunk_dirs),
            "checkpointDir": str(checkpoints_dir),
            "checkpointTaskCount": chunk_size,
            "checkpointMaxPointCount": int(args.checkpoint_max_point_count),
            "resultManifestPath": str(result_manifest_path),
        }
    )
    if str(args.final_output_mode) == "checkpoint-manifest":
        summary["resultRowsPath"] = ""
    return summary


def execute_source_spans_tasks_with_checkpoints(
    *,
    db_path: Path,
    tasks: Sequence[SelectedTask],
    manifest_map: Mapping[str, ManifestEntry],
    args: argparse.Namespace,
    output_dir: Path,
) -> Dict[str, Any]:
    """Checkpoint executor path that loads source-spans points per chunk.

    The full-US source_spans shards can contain tens of millions of expanded
    point rows. Loading all points for the shard before checkpointing makes the
    checkpoint mechanism resumable but not memory-bounded. This path keeps the
    same deterministic chunk layout while loading and releasing points one
    checkpoint chunk at a time.
    """

    chunk_size = max(1, int(args.checkpoint_task_count))
    max_point_count = max(0, int(args.checkpoint_max_point_count))
    max_new_chunks = max(0, int(args.max_checkpoint_chunks_per_run))
    checkpoints_dir = output_dir / "checkpoints"
    checkpoints_dir.mkdir(parents=True, exist_ok=True)

    started = time.time()
    chunk_plan: List[Tuple[int, int, List[SelectedTask], Path, str]] = []
    for chunk_index, start, chunk_tasks in build_checkpoint_plan(
        tasks,
        task_chunk_size=chunk_size,
        max_point_count=max_point_count,
    ):
        chunk_dir = checkpoints_dir / f"chunk_{chunk_index:06d}"
        chunk_dir.mkdir(parents=True, exist_ok=True)
        chunk_plan.append((chunk_index, start, chunk_tasks, chunk_dir, task_ids_digest(chunk_tasks)))

    new_chunks_processed = 0
    stopped_after_limit = False

    for chunk_index, start, chunk_tasks, chunk_dir, digest in chunk_plan:
        existing = successful_output_summary(chunk_dir, expected_digest=digest) if parse_bool_string(str(args.resume)) else None
        if existing is not None:
            print(
                json.dumps(
                    {
                        "checkpointChunk": chunk_index,
                        "status": "skipped",
                        "taskCount": len(chunk_tasks),
                        "resultRowCount": int(existing.get("resultRowCount", 0)),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            continue

        if max_new_chunks > 0 and new_chunks_processed >= max_new_chunks:
            stopped_after_limit = True
            break

        marker = output_success_marker(chunk_dir)
        if marker.exists():
            marker.unlink()
        task_points, point_meta, _scanned = load_task_points_from_source_spans(
            db_path=db_path,
            tasks=chunk_tasks,
            source_spans_table=str(args.source_spans_table),
        )
        chunk_summary = execute_tasks(chunk_tasks, task_points, point_meta, manifest_map, args, chunk_dir)
        chunk_summary.update(
            {
                "status": "ok",
                "checkpointChunk": chunk_index,
                "checkpointTaskStartIndex": start,
                "checkpointTaskEndIndex": start + len(chunk_tasks),
                "checkpointTaskCount": len(chunk_tasks),
                "taskIdsDigest": digest,
            }
        )
        write_summary_and_success(chunk_dir, dict(chunk_summary))
        new_chunks_processed += 1
        del task_points
        del point_meta
        del chunk_summary
        gc.collect()

    completed_chunk_dirs: List[Path] = []
    completed_chunk_summaries: List[Mapping[str, Any]] = []
    for _chunk_index, _start, _chunk_tasks, chunk_dir, digest in chunk_plan:
        existing = successful_output_summary(chunk_dir, expected_digest=digest)
        if existing is None:
            continue
        completed_chunk_dirs.append(chunk_dir)
        completed_chunk_summaries.append(existing)

    all_complete = len(completed_chunk_dirs) == len(chunk_plan)
    if all_complete:
        result_manifest_path = output_dir / "result_manifest.json"
        write_checkpoint_result_manifest(chunk_dirs=completed_chunk_dirs, output_path=result_manifest_path)
        if str(args.final_output_mode) == "merged-csv":
            merge_checkpoint_csvs(completed_chunk_dirs, output_dir / "task_point_results.csv")
        summary = merge_checkpoint_summaries_without_point_meta(
            tasks=tasks,
            chunk_summaries=completed_chunk_summaries,
            output_dir=output_dir,
            started=started,
        )
        summary.update(
            {
                "status": "ok",
                "checkpointed": True,
                "checkpointChunkCount": len(chunk_plan),
                "checkpointCompletedChunkCount": len(completed_chunk_dirs),
                "checkpointDir": str(checkpoints_dir),
                "checkpointTaskCount": chunk_size,
                "checkpointMaxPointCount": max_point_count,
                "resultManifestPath": str(result_manifest_path),
                "maxCheckpointChunksPerRun": max_new_chunks,
                "newCheckpointChunksProcessedThisRun": new_chunks_processed,
            }
        )
        if str(args.final_output_mode) == "checkpoint-manifest":
            summary["resultRowsPath"] = ""
        return summary

    partial_summary: Dict[str, Any] = {
        "status": "partial",
        "checkpointed": True,
        "checkpointChunkCount": len(chunk_plan),
        "checkpointCompletedChunkCount": len(completed_chunk_dirs),
        "checkpointPendingChunkCount": len(chunk_plan) - len(completed_chunk_dirs),
        "checkpointDir": str(checkpoints_dir),
        "checkpointTaskCount": chunk_size,
        "checkpointMaxPointCount": max_point_count,
        "maxCheckpointChunksPerRun": max_new_chunks,
        "newCheckpointChunksProcessedThisRun": new_chunks_processed,
        "stoppedAfterCheckpointLimit": stopped_after_limit,
        "processedTaskCount": sum(int(row.get("processedTaskCount", 0) or 0) for row in completed_chunk_summaries),
        "resultRowCount": sum(int(row.get("resultRowCount", 0) or 0) for row in completed_chunk_summaries),
        "resultRowsPath": "",
        "resultManifestPath": "",
        "elapsedSeconds": time.time() - started,
    }
    return partial_summary


def main() -> int:
    args = build_parser().parse_args()
    db_path = Path(args.task_graph_db).expanduser().resolve()
    manifest_path = Path(args.partition_manifest_csv).expanduser().resolve()
    input_root = Path(args.input_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest_map = read_manifest(manifest_path)
    allowlist = parse_task_allowlist(args.task_id_file)
    tasks, file_relpaths = load_selected_tasks(
        db_path=db_path,
        manifest_path=manifest_path,
        edge_table_name=str(args.edge_table_name),
        max_tasks=int(args.max_tasks),
        allowlist=allowlist,
    )
    lazy_source_spans_checkpoints = bool(args.source_spans_table) and int(args.checkpoint_task_count) > 0
    if lazy_source_spans_checkpoints:
        task_points, point_meta, scanned = {}, {}, {}
    elif args.point_cache_csv:
        task_points, point_meta, scanned = load_task_points_from_cache(
            Path(args.point_cache_csv).expanduser().resolve()
        )
    elif args.source_spans_table:
        task_points, point_meta, scanned = load_task_points_from_source_spans(
            db_path=db_path,
            tasks=tasks,
            source_spans_table=str(args.source_spans_table),
        )
    elif args.input_mode == "raw-stays":
        task_points, point_meta, scanned = scan_raw_stay_points_for_tasks(
            input_root,
            file_relpaths,
            tasks,
            step_seconds=int(args.step_seconds),
            solar_elevation_threshold_deg=float(args.solar_elevation_threshold_deg),
        )
    else:
        task_points, point_meta, scanned = scan_points_for_tasks(input_root, file_relpaths, tasks)

    digest = task_ids_digest(tasks)
    existing = successful_output_summary(output_dir, expected_digest=digest) if parse_bool_string(str(args.resume)) else None
    if existing is not None:
        print(json.dumps(existing, indent=2, ensure_ascii=False))
        return 0

    marker = output_success_marker(output_dir)
    if marker.exists():
        marker.unlink()

    if int(args.checkpoint_task_count) > 0:
        if lazy_source_spans_checkpoints:
            summary = execute_source_spans_tasks_with_checkpoints(
                db_path=db_path,
                tasks=tasks,
                manifest_map=manifest_map,
                args=args,
                output_dir=output_dir,
            )
        else:
            summary = execute_tasks_with_checkpoints(
                tasks=tasks,
                task_points=task_points,
                point_meta=point_meta,
                manifest_map=manifest_map,
                args=args,
                output_dir=output_dir,
            )
    else:
        summary = execute_tasks(tasks, task_points, point_meta, manifest_map, args, output_dir)

    update_summary_metadata(
        summary,
        db_path=db_path,
        manifest_path=manifest_path,
        input_root=input_root,
        output_dir=output_dir,
        args=args,
        selected_task_count=len(tasks),
        selected_file_count=len(file_relpaths),
        scanned=scanned,
        tasks=tasks,
    )
    if summary.get("status") == "ok":
        write_summary_and_success(output_dir, summary)
    else:
        summary_path = output_dir / "summary.json"
        summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
