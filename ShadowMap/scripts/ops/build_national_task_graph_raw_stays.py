#!/usr/bin/env python3
"""Build a minute-level task graph directly from raw stay-point CSV shards."""

from __future__ import annotations

import argparse
import csv
import collections
import json
import math
import numbers
import os
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import DefaultDict, Dict, Iterable, Iterator, List, Optional, Sequence, Set, Tuple

import pandas as pd
from shapely.geometry import Point

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.batch_mobility_shadow import floor_to_minute_iso  # noqa: E402
from scripts.ops.build_national_task_graph import (  # noqa: E402
    CellIndexer,
    TaskStats,
    _safe_int,
    write_csv,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-csv", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--cell-provider", choices=("square", "h3"), default="h3")
    parser.add_argument("--cell-size-m", type=float, default=12000.0)
    parser.add_argument("--h3-resolution", type=int, default=5)
    parser.add_argument("--step-seconds", type=int, default=60)
    parser.add_argument("--progress-every", type=int, default=100_000)
    parser.add_argument("--max-raw-rows", type=int, default=0)
    parser.add_argument(
        "--flush-every-raw-rows",
        type=int,
        default=25_000,
        help="Flush per-batch task graph checkpoints every N raw rows. 0 disables batching.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Reuse completed batch checkpoints in output-dir and only compute missing batches.",
    )
    parser.add_argument("--solar-elevation-threshold-deg", type=float, default=0.0)
    parser.add_argument("--indoor-mode", choices=("none", "drop"), default="drop")
    parser.add_argument(
        "--indoor-backend",
        choices=("geoparquet", "postgis"),
        default=os.getenv("MOBILITY_INDOOR_BACKEND", "geoparquet"),
    )
    parser.add_argument("--indoor-partition-manifest-csv", default="")
    parser.add_argument("--indoor-buildings-buffer-m", type=float, default=0.0)
    parser.add_argument("--postgis-dsn", default=os.getenv("MOBILITY_POSTGIS_DSN", "") or os.getenv("POSTGIS_DSN", ""))
    parser.add_argument("--postgis-host", default=os.getenv("MOBILITY_POSTGIS_HOST", "") or os.getenv("POSTGIS_HOST", "") or os.getenv("PGHOST", ""))
    parser.add_argument("--postgis-port", default=os.getenv("MOBILITY_POSTGIS_PORT", "") or os.getenv("POSTGIS_PORT", "") or os.getenv("PGPORT", "5432"))
    parser.add_argument("--postgis-database", default=os.getenv("MOBILITY_POSTGIS_DATABASE", "") or os.getenv("POSTGIS_DATABASE", "") or os.getenv("PGDATABASE", ""))
    parser.add_argument("--postgis-user", default=os.getenv("MOBILITY_POSTGIS_USER", "") or os.getenv("POSTGIS_USER", "") or os.getenv("PGUSER", ""))
    parser.add_argument("--postgis-password", default=os.getenv("MOBILITY_POSTGIS_PASSWORD", "") or os.getenv("POSTGIS_PASSWORD", "") or os.getenv("PGPASSWORD", ""))
    parser.add_argument("--postgis-table", default=os.getenv("MOBILITY_POSTGIS_TABLE", "") or os.getenv("POSTGIS_TABLE", "public.buildings_us_lod1"))
    parser.add_argument("--postgis-geom-column", default=os.getenv("MOBILITY_POSTGIS_GEOM_COLUMN", "") or os.getenv("POSTGIS_GEOM_COLUMN", "geom"))
    return parser


def _iter_raw_rows(input_csv: Path) -> Iterator[Tuple[int, Dict[str, str]]]:
    with input_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for idx, row in enumerate(reader):
            if not row:
                continue
            yield idx, row


def _write_json_atomic(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temp_path.replace(path)


def _write_rows_atomic(path: Path, headers: List[str], rows: Iterable[Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    write_csv(temp_path, headers, rows)
    temp_path.replace(path)


def _expanded_points(start_ts: int, end_ts: int, step_seconds: int) -> int:
    if end_ts <= start_ts:
        return 1
    return max(1, int(math.ceil((end_ts - start_ts) / float(step_seconds))))


def _raw_row_coords(row: Dict[str, str]) -> Tuple[Optional[float], Optional[float]]:
    lon_raw = (row.get("longitude") or row.get("lon") or "").strip()
    lat_raw = (row.get("latitude") or row.get("lat") or "").strip()
    if not lon_raw or not lat_raw:
        return None, None
    try:
        lon = float(lon_raw)
        lat = float(lat_raw)
    except Exception:
        return None, None
    if not (math.isfinite(lon) and math.isfinite(lat)):
        return None, None
    return lon, lat


def _sunrise_sunset_utc(lat: float, lon: float, date_utc: pd.Timestamp):
    import pvlib

    idx = pd.DatetimeIndex([date_utc.normalize()], tz="UTC")
    result = pvlib.solarposition.sun_rise_set_transit_spa(idx, lat, lon)
    row = result.iloc[0]
    return pd.Timestamp(row["sunrise"]).tz_convert("UTC"), pd.Timestamp(row["sunset"]).tz_convert("UTC")


def _meters_to_degrees(buffer_m: float, *, mean_lat: float) -> float:
    meters = abs(float(buffer_m))
    if meters <= 0:
        return 0.0
    cos_lat = max(0.1, abs(math.cos(math.radians(float(mean_lat)))))
    deg_lat = meters / 111_000.0
    deg_lon = meters / (111_000.0 * cos_lat)
    return max(deg_lat, deg_lon)


@dataclass
class ManifestPartition:
    partition_id: str
    output_path: str
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float


class IndoorPointClassifier:
    def __init__(self, manifest_csv: Path, *, buildings_buffer_m: float) -> None:
        self.manifest_csv = manifest_csv
        self.buildings_buffer_m = float(buildings_buffer_m)
        self._grid = self._load_manifest(manifest_csv)
        self.query_count = 0
        self.selected_partition_total = 0
        self.loaded_building_rows_total = 0
        self.loaded_partition_count = 0

    @staticmethod
    def _grid_key(value: float) -> int:
        return int(math.floor(float(value) * 2.0))

    def _load_manifest(self, path: Path) -> Dict[Tuple[int, int], List[ManifestPartition]]:
        grid: Dict[Tuple[int, int], List[ManifestPartition]] = {}
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                output_path = str(row.get("outputParquet") or "").strip()
                if not output_path or not Path(output_path).exists():
                    continue
                part = ManifestPartition(
                    partition_id=str(row.get("partitionId") or "").strip(),
                    output_path=output_path,
                    min_lon=float(row["minLon"]),
                    min_lat=float(row["minLat"]),
                    max_lon=float(row["maxLon"]),
                    max_lat=float(row["maxLat"]),
                )
                west_key = self._grid_key(part.min_lon)
                south_key = self._grid_key(part.min_lat)
                grid.setdefault((west_key, south_key), []).append(part)
        if not grid:
            raise RuntimeError(f"No readable partition parquet entries found in manifest: {path}")
        return grid

    def _candidate_partitions(self, lon: float, lat: float) -> List[ManifestPartition]:
        mean_lat = lat
        expand_deg = _meters_to_degrees(self.buildings_buffer_m, mean_lat=mean_lat)
        west = lon - expand_deg
        east = lon + expand_deg
        south = lat - expand_deg
        north = lat + expand_deg
        x0 = self._grid_key(west)
        x1 = self._grid_key(east)
        y0 = self._grid_key(south)
        y1 = self._grid_key(north)
        parts: List[ManifestPartition] = []
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                for part in self._grid.get((x, y), []):
                    if part.min_lon <= east and part.max_lon >= west and part.min_lat <= north and part.max_lat >= south:
                        parts.append(part)
        return parts

    def is_indoor(self, lon: float, lat: float) -> bool:
        import geopandas as gpd

        self.query_count += 1
        parts = self._candidate_partitions(lon, lat)
        self.selected_partition_total += len(parts)
        if not parts:
            return False
        point = Point(lon, lat)
        bbox = (lon, lat, lon, lat)
        for part in parts:
            gdf = gpd.read_parquet(part.output_path, bbox=bbox)
            self.loaded_building_rows_total += int(len(gdf))
            for geom in gdf.geometry:
                if geom is not None and not geom.is_empty and geom.covers(point):
                    return True
        return False

    def classify_points(
        self,
        coords: Sequence[Tuple[float, float]],
    ) -> Dict[Tuple[int, int], bool]:
        import geopandas as gpd
        from shapely.strtree import STRtree

        if not coords:
            return {}
        unique_coords: Dict[Tuple[int, int], Tuple[float, float]] = {}
        for lon, lat in coords:
            key = (int(round(lon * 1e5)), int(round(lat * 1e5)))
            unique_coords.setdefault(key, (lon, lat))
        self.query_count += len(unique_coords)

        coord_parts: DefaultDict[str, List[Tuple[int, int, float, float]]] = collections.defaultdict(list)
        for key, (lon, lat) in unique_coords.items():
            parts = self._candidate_partitions(lon, lat)
            self.selected_partition_total += len(parts)
            for part in parts:
                coord_parts[part.output_path].append((key[0], key[1], lon, lat))

        indoor_map: Dict[Tuple[int, int], bool] = {key: False for key in unique_coords}
        for output_path, entries in coord_parts.items():
            if not entries:
                continue
            lons = [entry[2] for entry in entries]
            lats = [entry[3] for entry in entries]
            bbox = (min(lons), min(lats), max(lons), max(lats))
            gdf = gpd.read_parquet(output_path, bbox=bbox)
            self.loaded_building_rows_total += int(len(gdf))
            self.loaded_partition_count += 1
            if gdf.empty:
                continue
            geometries = [geom for geom in gdf.geometry if geom is not None and not geom.is_empty]
            if not geometries:
                continue
            tree = STRtree(geometries)
            for lon_key, lat_key, lon, lat in entries:
                cache_key = (lon_key, lat_key)
                if indoor_map.get(cache_key):
                    continue
                point = Point(lon, lat)
                candidates = tree.query(point)
                for candidate in candidates:
                    geom = geometries[int(candidate)] if isinstance(candidate, numbers.Integral) else candidate
                    if geom.covers(point):
                        indoor_map[cache_key] = True
                        break
        return indoor_map


class IndoorPostGISClassifier:
    def __init__(
        self,
        *,
        dsn: str,
        host: str,
        port: str,
        database: str,
        user: str,
        password: str,
        table: str,
        geom_column: str,
    ) -> None:
        import psycopg2

        self.query_count = 0
        self.selected_partition_total = 0
        self.loaded_building_rows_total = 0
        self.loaded_partition_count = 0
        self.table = table
        self.geom_column = geom_column or "geom"

        if dsn:
            self.conn = psycopg2.connect(dsn)
        else:
            connect_kwargs: Dict[str, object] = {}
            if host:
                connect_kwargs["host"] = host
            if port:
                connect_kwargs["port"] = int(port)
            if database:
                connect_kwargs["dbname"] = database
            if user:
                connect_kwargs["user"] = user
            if password:
                connect_kwargs["password"] = password
            self.conn = psycopg2.connect(**connect_kwargs)
        self.conn.autocommit = False
        self.cur = self.conn.cursor()
        self.cur.execute(
            """
            CREATE TEMP TABLE IF NOT EXISTS temp_indoor_points (
              lon_key integer,
              lat_key integer,
              lon double precision,
              lat double precision,
              geom geometry(Point, 4326)
            ) ON COMMIT DELETE ROWS
            """
        )
        self.cur.execute(
            "CREATE INDEX IF NOT EXISTS temp_indoor_points_geom_idx ON temp_indoor_points USING GIST (geom)"
        )
        self.conn.commit()

    def classify_points(
        self,
        coords: Sequence[Tuple[float, float]],
    ) -> Dict[Tuple[int, int], bool]:
        from psycopg2.extras import execute_values

        if not coords:
            return {}
        unique_coords: Dict[Tuple[int, int], Tuple[float, float]] = {}
        for lon, lat in coords:
            key = (int(round(lon * 1e5)), int(round(lat * 1e5)))
            unique_coords.setdefault(key, (lon, lat))
        self.query_count += len(unique_coords)
        indoor_map: Dict[Tuple[int, int], bool] = {key: False for key in unique_coords}
        rows = [(lon_key, lat_key, lon, lat, f"SRID=4326;POINT({lon} {lat})") for (lon_key, lat_key), (lon, lat) in unique_coords.items()]
        min_lon = min(lon for lon, _ in unique_coords.values())
        min_lat = min(lat for _, lat in unique_coords.values())
        max_lon = max(lon for lon, _ in unique_coords.values())
        max_lat = max(lat for _, lat in unique_coords.values())

        self.cur.execute("TRUNCATE temp_indoor_points")
        execute_values(
            self.cur,
            "INSERT INTO temp_indoor_points (lon_key, lat_key, lon, lat, geom) VALUES %s",
            rows,
            template="(%s,%s,%s,%s,ST_GeomFromEWKT(%s))",
        )
        self.cur.execute("ANALYZE temp_indoor_points")
        self.cur.execute(
            f"""
            SELECT DISTINCT p.lon_key, p.lat_key
            FROM temp_indoor_points p
            JOIN {self.table} b
              ON b.{self.geom_column} && p.geom
             AND b.{self.geom_column} && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
             AND ST_Covers(b.{self.geom_column}, p.geom)
            """,
            (min_lon, min_lat, max_lon, max_lat),
        )
        matches = self.cur.fetchall()
        for lon_key, lat_key in matches:
            indoor_map[(int(lon_key), int(lat_key))] = True
        self.conn.commit()
        return indoor_map


@dataclass
class BatchStats:
    scanned_rows: int = 0
    valid_rows: int = 0
    invalid_rows: int = 0
    indoor_rows: int = 0
    solar_prefilter_night_rows: int = 0
    source_span_count: int = 0

    def as_dict(self) -> Dict[str, int]:
        return {
            "scanned_rows": int(self.scanned_rows),
            "valid_rows": int(self.valid_rows),
            "invalid_rows": int(self.invalid_rows),
            "indoor_rows": int(self.indoor_rows),
            "solar_prefilter_night_rows": int(self.solar_prefilter_night_rows),
            "source_span_count": int(self.source_span_count),
        }

    def add_summary(self, payload: Dict[str, object]) -> None:
        self.scanned_rows += int(payload.get("scanned_rows", 0) or 0)
        self.valid_rows += int(payload.get("valid_rows", 0) or 0)
        self.invalid_rows += int(payload.get("invalid_rows", 0) or 0)
        self.indoor_rows += int(payload.get("indoor_rows", 0) or 0)
        self.solar_prefilter_night_rows += int(payload.get("solar_prefilter_night_rows", 0) or 0)
        self.source_span_count += int(payload.get("source_span_count", 0) or 0)


def _batch_id_for_row(row_index: int, flush_every_raw_rows: int) -> int:
    if flush_every_raw_rows <= 0:
        return 0
    return int(row_index) // int(flush_every_raw_rows)


def _batch_task_path(checkpoint_dir: Path, batch_id: int) -> Path:
    return checkpoint_dir / f"tasks_batch_{batch_id:06d}.csv"


def _batch_summary_path(checkpoint_dir: Path, batch_id: int) -> Path:
    return checkpoint_dir / f"summary_batch_{batch_id:06d}.json"


def _batch_membership_path(checkpoint_dir: Path, batch_id: int) -> Path:
    return checkpoint_dir / f"memberships_batch_{batch_id:06d}.csv"


def _batch_source_span_path(checkpoint_dir: Path, batch_id: int) -> Path:
    return checkpoint_dir / f"source_spans_batch_{batch_id:06d}.csv"


def _load_completed_batches(checkpoint_dir: Path) -> Tuple[Set[int], BatchStats]:
    completed: Set[int] = set()
    totals = BatchStats()
    for summary_path in sorted(checkpoint_dir.glob("summary_batch_*.json")):
        stem = summary_path.stem
        try:
            batch_id = int(stem.rsplit("_", 1)[-1])
        except Exception:
            continue
        task_path = _batch_task_path(checkpoint_dir, batch_id)
        if not task_path.exists():
            continue
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
        completed.add(batch_id)
        totals.add_summary(payload)
    return completed, totals


def _flush_batch(
    *,
    checkpoint_dir: Path,
    batch_id: int,
    batch_start_row: int,
    batch_end_row: int,
    task_stats: Dict[str, TaskStats],
    membership_counts: Dict[Tuple[str, str], int],
    source_span_rows: List[Dict[str, object]],
    batch_stats: BatchStats,
    started_at: float,
) -> Dict[str, object]:
    task_path = _batch_task_path(checkpoint_dir, batch_id)
    membership_path = _batch_membership_path(checkpoint_dir, batch_id)
    source_span_path = _batch_source_span_path(checkpoint_dir, batch_id)
    summary_path = _batch_summary_path(checkpoint_dir, batch_id)
    _write_rows_atomic(
        task_path,
        ["task_id", "minute_iso", "cell_key", "point_count", "file_count", "west", "south", "east", "north"],
        (task_stats[task_id].as_row(task_id) for task_id in sorted(task_stats)),
    )
    _write_rows_atomic(
        membership_path,
        ["task_id", "file_relpath", "point_count"],
        (
            {
                "task_id": task_id,
                "file_relpath": file_relpath,
                "point_count": point_count,
            }
            for (task_id, file_relpath), point_count in sorted(membership_counts.items())
        ),
    )
    _write_rows_atomic(
        source_span_path,
        ["cell_key", "start_minute_iso", "end_minute_iso", "file_relpath", "row_index", "ad_id", "lon", "lat", "span_point_count"],
        source_span_rows,
    )
    retained_point_count = sum(stats.point_count for stats in task_stats.values())
    payload: Dict[str, object] = {
        "batch_id": int(batch_id),
        "batch_start_row": int(batch_start_row),
        "batch_end_row": int(batch_end_row),
        "task_csv": str(task_path),
        "memberships_csv": str(membership_path),
        "source_spans_csv": str(source_span_path),
        "task_count": int(len(task_stats)),
        "membership_edge_count": int(len(membership_counts)),
        "source_span_count": int(len(source_span_rows)),
        "retained_point_count": int(retained_point_count),
        "elapsed_seconds": time.monotonic() - started_at,
    }
    payload.update(batch_stats.as_dict())
    _write_json_atomic(summary_path, payload)
    return payload


def _merge_batches(output_dir: Path, checkpoint_dir: Path) -> Dict[str, object]:
    import duckdb

    task_files = sorted(checkpoint_dir.glob("tasks_batch_*.csv"))
    membership_files = sorted(checkpoint_dir.glob("memberships_batch_*.csv"))
    source_span_files = sorted(checkpoint_dir.glob("source_spans_batch_*.csv"))
    if not task_files:
        write_csv(
            output_dir / "tasks.csv",
            ["task_id", "minute_iso", "cell_key", "point_count", "file_count", "west", "south", "east", "north"],
            (),
        )
        write_csv(
            output_dir / "task_membership_counts.csv",
            ["task_id", "file_relpath", "point_count"],
            (),
        )
        write_csv(
            output_dir / "task_source_spans.csv",
            ["cell_key", "start_minute_iso", "end_minute_iso", "file_relpath", "row_index", "ad_id", "lon", "lat", "span_point_count"],
            (),
        )
        row = (0, 0, 0.0)
        membership_edge_count = 0
        source_span_count = 0
    else:
        con = duckdb.connect(str(output_dir / "task_graph.duckdb"))
        union_paths = ", ".join("'" + str(path).replace("'", "''") + "'" for path in task_files)
        con.execute(
            f"""
            CREATE OR REPLACE TABLE tasks_raw AS
            SELECT
              task_id,
              minute_iso,
              cell_key,
              SUM(CAST(point_count AS BIGINT)) AS point_count,
              SUM(CAST(file_count AS BIGINT)) AS file_count,
              MIN(CAST(west AS DOUBLE)) AS west,
              MIN(CAST(south AS DOUBLE)) AS south,
              MAX(CAST(east AS DOUBLE)) AS east,
              MAX(CAST(north AS DOUBLE)) AS north
            FROM read_csv_auto([{union_paths}], header=true)
            GROUP BY 1, 2, 3
            """
        )
        con.execute(
            """
            CREATE OR REPLACE TABLE tasks AS
            SELECT
              task_id,
              minute_iso,
              CAST(try_cast(CAST(minute_iso AS VARCHAR) AS TIMESTAMPTZ) AS TIMESTAMP) AS minute_ts,
              cell_key,
              point_count,
              file_count,
              west,
              south,
              east,
              north
            FROM tasks_raw
            """
        )
        tasks_csv = output_dir / "tasks.csv"
        con.execute(f"COPY tasks TO '{str(tasks_csv)}' (HEADER, DELIMITER ',')")
        if membership_files:
            membership_union = ", ".join("'" + str(path).replace("'", "''") + "'" for path in membership_files)
            con.execute(
                f"""
                CREATE OR REPLACE TABLE memberships AS
                SELECT
                  task_id,
                  CAST(file_relpath AS VARCHAR) AS file_relpath,
                  SUM(CAST(point_count AS BIGINT)) AS point_count
                FROM read_csv_auto([{membership_union}], header=true)
                GROUP BY 1, 2
                """
            )
            memberships_csv = output_dir / "task_membership_counts.csv"
            con.execute(f"COPY memberships TO '{str(memberships_csv)}' (HEADER, DELIMITER ',')")
            membership_edge_count = int(con.execute("SELECT count(*) FROM memberships").fetchone()[0] or 0)
        else:
            write_csv(
                output_dir / "task_membership_counts.csv",
                ["task_id", "file_relpath", "point_count"],
                (),
            )
            membership_edge_count = 0
        if source_span_files:
            source_span_union = ", ".join("'" + str(path).replace("'", "''") + "'" for path in source_span_files)
            con.execute(
                f"""
                CREATE OR REPLACE TABLE source_spans AS
                SELECT
                  CAST(cell_key AS VARCHAR) AS cell_key,
                  CAST(start_minute_iso AS VARCHAR) AS start_minute_iso,
                  CAST(end_minute_iso AS VARCHAR) AS end_minute_iso,
                  CAST(try_cast(CAST(start_minute_iso AS VARCHAR) AS TIMESTAMPTZ) AS TIMESTAMP) AS start_minute_ts,
                  CAST(try_cast(CAST(end_minute_iso AS VARCHAR) AS TIMESTAMPTZ) AS TIMESTAMP) AS end_minute_ts,
                  CAST(file_relpath AS VARCHAR) AS file_relpath,
                  CAST(row_index AS BIGINT) AS row_index,
                  CAST(ad_id AS VARCHAR) AS ad_id,
                  CAST(lon AS DOUBLE) AS lon,
                  CAST(lat AS DOUBLE) AS lat,
                  SUM(CAST(span_point_count AS BIGINT)) AS span_point_count
                FROM read_csv_auto([{source_span_union}], header=true)
                GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
                """
            )
            source_spans_csv = output_dir / "task_source_spans.csv"
            con.execute(f"COPY source_spans TO '{str(source_spans_csv)}' (HEADER, DELIMITER ',')")
            source_span_count = int(con.execute("SELECT count(*) FROM source_spans").fetchone()[0] or 0)
        else:
            write_csv(
                output_dir / "task_source_spans.csv",
                ["cell_key", "start_minute_iso", "end_minute_iso", "file_relpath", "row_index", "ad_id", "lon", "lat", "span_point_count"],
                (),
            )
            source_span_count = 0
        row = con.execute(
            """
            SELECT
              COUNT(*) AS task_count,
              COALESCE(SUM(point_count), 0) AS retained_point_count,
              COALESCE(AVG(point_count), 0) AS rows_per_task_avg
            FROM tasks
            """
        ).fetchone()
        con.close()

    totals = BatchStats()
    batch_count = 0
    for summary_path in sorted(checkpoint_dir.glob("summary_batch_*.json")):
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
        totals.add_summary(payload)
        batch_count += 1

    summary: Dict[str, object] = {
        "batch_count": int(batch_count),
        "task_count": int(row[0]),
        "retained_point_count": int(row[1]),
        "rows_per_task_avg": float(row[2] or 0.0),
        "membership_edge_count": int(membership_edge_count),
        "source_span_count": int(source_span_count),
        "night_task_count": 0,
    }
    summary.update(totals.as_dict())
    return summary


def iter_daylight_timestamps(
    *,
    start_ts: int,
    end_ts: int,
    lat: float,
    lon: float,
    step_seconds: int,
    threshold_deg: float,
    solar_cache: Dict[Tuple[int, int, str], Tuple[pd.Timestamp, pd.Timestamp]],
) -> Iterator[int]:
    if end_ts < start_ts:
        end_ts = start_ts
    point_count = _expanded_points(start_ts, end_ts, step_seconds)
    if point_count <= 0:
        return

    threshold = float(threshold_deg)
    lat_key = int(round(lat * 1000))
    lon_key = int(round(lon * 1000))
    current_ts = start_ts
    last_ts = start_ts + (point_count - 1) * step_seconds
    one_day = pd.Timedelta(days=1)
    current_day = pd.Timestamp(current_ts, unit="s", tz="UTC").normalize()
    last_day = pd.Timestamp(last_ts, unit="s", tz="UTC").normalize()
    daylight_spans: List[Tuple[int, int]] = []
    while current_day <= last_day:
        date_key = current_day.strftime("%Y-%m-%d")
        cache_key = (lat_key, lon_key, date_key)
        sunrise_ts, sunset_ts = solar_cache.get(cache_key, (None, None))  # type: ignore[assignment]
        if sunrise_ts is None or sunset_ts is None:
            sunrise_ts, sunset_ts = _sunrise_sunset_utc(lat, lon, current_day)
            solar_cache[cache_key] = (sunrise_ts, sunset_ts)
        if threshold <= 0:
            day_start = int(math.ceil(sunrise_ts.timestamp()))
            day_end = int(math.floor(sunset_ts.timestamp()))
            daylight_spans.append((day_start, day_end))
        else:
            import pvlib
            minute_index = pd.date_range(start=sunrise_ts.floor("min"), end=sunset_ts.ceil("min"), freq="1min", tz="UTC")
            if len(minute_index) > 0:
                solar = pvlib.solarposition.get_solarposition(minute_index, latitude=lat, longitude=lon)
                mask = solar["apparent_elevation"].to_numpy() > threshold
                if mask.any():
                    kept = minute_index[mask]
                    daylight_spans.append((int(kept[0].timestamp()), int(kept[-1].timestamp())))
        current_day += one_day

    if not daylight_spans:
        return

    for idx in range(point_count):
        ts_value = start_ts + idx * step_seconds
        for day_start, day_end in daylight_spans:
            if day_start <= ts_value <= day_end:
                yield ts_value
                break


def main(argv: List[str]) -> int:
    args = build_parser().parse_args(argv)
    started_at = time.monotonic()

    input_csv = Path(args.input_csv).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = output_dir / "checkpoints"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    indexer = CellIndexer(
        args.cell_provider,
        cell_size_m=float(args.cell_size_m),
        h3_resolution=int(args.h3_resolution) if args.h3_resolution is not None else None,
    )
    indoor_classifier = None
    if args.indoor_mode != "none":
        if args.indoor_backend == "geoparquet":
            manifest_csv = str(args.indoor_partition_manifest_csv or "").strip()
            if not manifest_csv:
                raise RuntimeError("--indoor-partition-manifest-csv is required when --indoor-backend geoparquet")
            indoor_classifier = IndoorPointClassifier(
                Path(manifest_csv).expanduser().resolve(),
                buildings_buffer_m=float(args.indoor_buildings_buffer_m),
            )
        else:
            indoor_classifier = IndoorPostGISClassifier(
                dsn=str(args.postgis_dsn or "").strip(),
                host=str(args.postgis_host or "").strip(),
                port=str(args.postgis_port or "").strip(),
                database=str(args.postgis_database or "").strip(),
                user=str(args.postgis_user or "").strip(),
                password=str(args.postgis_password or "").strip(),
                table=str(args.postgis_table or "").strip(),
                geom_column=str(args.postgis_geom_column or "").strip(),
            )

    completed_batches: Set[int] = set()
    completed_totals = BatchStats()
    if args.resume:
        completed_batches, completed_totals = _load_completed_batches(checkpoint_dir)

    flush_every_raw_rows = max(0, int(args.flush_every_raw_rows))
    task_stats: Dict[str, TaskStats] = {}
    current_batch_stats = BatchStats()
    current_batch_id: Optional[int] = None
    current_batch_start_row: Optional[int] = None
    solar_cache: Dict[Tuple[int, int, str], Tuple[pd.Timestamp, pd.Timestamp]] = {}
    indoor_coord_cache: Dict[Tuple[int, int], bool] = {}
    membership_counts: DefaultDict[Tuple[str, str], int] = collections.defaultdict(int)
    source_span_rows: List[Dict[str, object]] = []
    source_file_relpath = input_csv.name

    def reset_batch_state() -> None:
        nonlocal task_stats, membership_counts, source_span_rows, current_batch_stats, solar_cache, indoor_coord_cache, current_batch_id, current_batch_start_row
        task_stats = {}
        membership_counts = collections.defaultdict(int)
        source_span_rows = []
        current_batch_stats = BatchStats()
        solar_cache = {}
        indoor_coord_cache = {}
        current_batch_id = None
        current_batch_start_row = None

    def flush_current_batch(batch_end_row: int) -> None:
        nonlocal completed_totals, current_batch_id, current_batch_start_row
        if current_batch_id is None or current_batch_start_row is None:
            return
        payload = _flush_batch(
            checkpoint_dir=checkpoint_dir,
            batch_id=current_batch_id,
            batch_start_row=current_batch_start_row,
            batch_end_row=batch_end_row,
            task_stats=task_stats,
            membership_counts=membership_counts,
            source_span_rows=source_span_rows,
            batch_stats=current_batch_stats,
            started_at=started_at,
        )
        completed_totals.add_summary(payload)
        completed_batches.add(current_batch_id)
        reset_batch_state()

    current_batch_rows: List[Tuple[int, Dict[str, str]]] = []

    def process_batch_rows(batch_rows: List[Tuple[int, Dict[str, str]]]) -> None:
        nonlocal current_batch_stats, task_stats, membership_counts, source_span_rows, indoor_classifier, indoor_coord_cache
        if not batch_rows:
            return
        step_seconds = int(args.step_seconds)
        if indoor_classifier is not None:
            uncached_coords: List[Tuple[float, float]] = []
            for _, row in batch_rows:
                lon, lat = _raw_row_coords(row)
                if lon is None or lat is None:
                    continue
                key = (int(round(lon * 1e5)), int(round(lat * 1e5)))
                if key not in indoor_coord_cache:
                    uncached_coords.append((lon, lat))
            if uncached_coords:
                indoor_coord_cache.update(indoor_classifier.classify_points(uncached_coords))

        for row_index_inner, row in batch_rows:
            ad_id = (row.get("ad_id") or "").strip()
            lon, lat = _raw_row_coords(row)
            start_ts = _safe_int(row.get("start_time"))
            end_ts = _safe_int(row.get("end_time"))
            current_batch_stats.scanned_rows += 1
            if not ad_id or lon is None or lat is None or start_ts is None:
                current_batch_stats.invalid_rows += 1
                continue
            if end_ts is None or end_ts < start_ts:
                end_ts = start_ts

            point_count = _expanded_points(start_ts, end_ts, int(args.step_seconds))
            if indoor_classifier is not None:
                key = (int(round(lon * 1e5)), int(round(lat * 1e5)))
                indoor_value = indoor_coord_cache.get(key, False)
                if indoor_value:
                    current_batch_stats.indoor_rows += point_count
                    continue

            retained = 0
            span_start_iso: Optional[str] = None
            span_end_iso: Optional[str] = None
            span_prev_ts: Optional[int] = None
            span_point_count = 0
            for ts_value in iter_daylight_timestamps(
                start_ts=start_ts,
                end_ts=end_ts,
                lat=lat,
                lon=lon,
                step_seconds=step_seconds,
                threshold_deg=float(args.solar_elevation_threshold_deg),
                solar_cache=solar_cache,
            ):
                minute_iso = floor_to_minute_iso(ts_value)
                if not minute_iso:
                    continue
                cell_key = indexer.key_for_point(lat, lon)
                task_id = f"{minute_iso}|{cell_key}"
                stats = task_stats.get(task_id)
                if stats is None:
                    stats = TaskStats(minute_iso=minute_iso, cell_key=cell_key, file_ids=set())
                    task_stats[task_id] = stats
                stats.update(lon, lat, 0)
                membership_counts[(task_id, source_file_relpath)] += 1
                retained += 1
                current_batch_stats.valid_rows += 1
                ts_int = int(ts_value)
                if span_start_iso is None:
                    span_start_iso = minute_iso
                    span_end_iso = minute_iso
                    span_prev_ts = ts_int
                    span_point_count = 1
                elif span_prev_ts is not None and ts_int == span_prev_ts + step_seconds:
                    span_end_iso = minute_iso
                    span_prev_ts = ts_int
                    span_point_count += 1
                else:
                    source_span_rows.append(
                        {
                            "cell_key": cell_key,
                            "start_minute_iso": span_start_iso,
                            "end_minute_iso": span_end_iso,
                            "file_relpath": source_file_relpath,
                            "row_index": row_index_inner,
                            "ad_id": ad_id,
                            "lon": lon,
                            "lat": lat,
                            "span_point_count": span_point_count,
                        }
                    )
                    current_batch_stats.source_span_count += 1
                    span_start_iso = minute_iso
                    span_end_iso = minute_iso
                    span_prev_ts = ts_int
                    span_point_count = 1

            if span_start_iso is not None:
                source_span_rows.append(
                    {
                        "cell_key": cell_key,
                        "start_minute_iso": span_start_iso,
                        "end_minute_iso": span_end_iso,
                        "file_relpath": source_file_relpath,
                        "row_index": row_index_inner,
                        "ad_id": ad_id,
                        "lon": lon,
                        "lat": lat,
                        "span_point_count": span_point_count,
                    }
                )
                current_batch_stats.source_span_count += 1

            current_batch_stats.solar_prefilter_night_rows += max(0, point_count - retained)

    for row_index, row in _iter_raw_rows(input_csv):
        scanned_rows_total = row_index + 1
        if args.max_raw_rows > 0 and scanned_rows_total > int(args.max_raw_rows):
            break
        batch_id = _batch_id_for_row(row_index, flush_every_raw_rows)
        if batch_id in completed_batches:
            continue
        if current_batch_id is None:
            current_batch_id = batch_id
            current_batch_start_row = row_index
        elif batch_id != current_batch_id:
            process_batch_rows(current_batch_rows)
            flush_current_batch(row_index - 1)
            current_batch_id = batch_id
            current_batch_start_row = row_index
            current_batch_rows = []

        current_batch_rows.append((row_index, row))
        if args.progress_every > 0 and scanned_rows_total % int(args.progress_every) == 0:
            print(
                f"[RawTaskGraph] scanned_rows={scanned_rows_total} valid_rows={completed_totals.valid_rows + current_batch_stats.valid_rows} tasks={len(task_stats)} completed_batches={len(completed_batches)}",
                file=sys.stderr,
                flush=True,
            )

    if current_batch_id is not None and current_batch_start_row is not None:
        process_batch_rows(current_batch_rows)
        flush_current_batch((args.max_raw_rows - 1) if args.max_raw_rows > 0 else max(current_batch_start_row, scanned_rows_total - 1))

    merged = _merge_batches(output_dir, checkpoint_dir)
    summary = {
        "input_csv": str(input_csv),
        "output_dir": str(output_dir),
        "checkpoint_dir": str(checkpoint_dir),
        "cell_provider": args.cell_provider,
        "cell_size_m": float(args.cell_size_m),
        "h3_resolution": args.h3_resolution,
        "step_seconds": int(args.step_seconds),
        "flush_every_raw_rows": int(flush_every_raw_rows),
        "resume": bool(args.resume),
        "scanned_rows": int(merged["scanned_rows"]),
        "valid_rows": int(merged["valid_rows"]),
        "invalid_rows": int(merged["invalid_rows"]),
        "indoor_rows": int(merged["indoor_rows"]),
        "indoor_backend": str(args.indoor_backend),
        "solar_prefilter_night_rows": int(merged["solar_prefilter_night_rows"]),
        "raw_task_count": int(merged["task_count"]),
        "task_count": int(merged["task_count"]),
        "retained_point_count": int(merged["retained_point_count"]),
        "night_task_count": int(merged["night_task_count"]),
        "rows_per_task_avg": float(merged["rows_per_task_avg"]),
        "membership_edge_count": int(merged["membership_edge_count"]),
        "source_span_count": int(merged["source_span_count"]),
        "batch_count": int(merged["batch_count"]),
        "indoor_files_processed": int(indoor_classifier.query_count > 0) if indoor_classifier is not None else 0,
        "indoor_selected_partition_total": int(indoor_classifier.selected_partition_total) if indoor_classifier is not None else 0,
        "indoor_loaded_building_rows_total": int(indoor_classifier.loaded_building_rows_total) if indoor_classifier is not None else 0,
        "indoor_loaded_partition_count": int(indoor_classifier.loaded_partition_count) if indoor_classifier is not None else 0,
        "elapsed_seconds": time.monotonic() - started_at,
    }
    summary_path = output_dir / "summary.json"
    _write_json_atomic(summary_path, summary)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
