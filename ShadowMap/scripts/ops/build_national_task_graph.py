#!/usr/bin/env python3
"""Build a nationwide mobility task graph from per-user minute CSV files.

This is the first-stage entry for the new national-scale compute framework.
It does not run the shadow engine. Instead it converts the existing mobility
CSV corpus into a stable `cell-time` task graph plus membership tables.

Design goals:
- keep exact point locations for final classification
- move nationwide orchestration out of the legacy runtime
- make H3 / GeoParquet / DuckDB integration possible in later stages
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import statistics
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.batch_mobility_shadow import (  # noqa: E402
    _get_weather_cached,
    _cleanup_weather_caches,
    _mercator_cell_id,
    floor_to_minute_iso,
    pick_lon_lat,
    read_targets_from_file,
)


@dataclass
class TaskStats:
    minute_iso: str
    cell_key: str
    point_count: int = 0
    min_lon: float = math.inf
    min_lat: float = math.inf
    max_lon: float = -math.inf
    max_lat: float = -math.inf
    file_ids: Optional[set[int]] = None

    def update(self, lon: float, lat: float, file_id: int) -> None:
        self.point_count += 1
        self.min_lon = min(self.min_lon, lon)
        self.min_lat = min(self.min_lat, lat)
        self.max_lon = max(self.max_lon, lon)
        self.max_lat = max(self.max_lat, lat)
        if self.file_ids is not None:
            self.file_ids.add(file_id)

    def as_row(self, task_id: str, weather: Optional[Dict[str, object]] = None) -> Dict[str, object]:
        row = {
            "task_id": task_id,
            "minute_iso": self.minute_iso,
            "cell_key": self.cell_key,
            "point_count": self.point_count,
            "file_count": len(self.file_ids or ()),
            "west": self.min_lon,
            "south": self.min_lat,
            "east": self.max_lon,
            "north": self.max_lat,
        }
        if weather:
            row.update(weather)
        return row


class CellIndexer:
    def __init__(
        self,
        provider: str,
        *,
        cell_size_m: float,
        h3_resolution: Optional[int],
    ) -> None:
        self.provider = provider
        self.cell_size_m = float(cell_size_m)
        self.h3_resolution = h3_resolution
        self._h3 = None
        if provider == "h3":
            try:
                import h3  # type: ignore
            except Exception as exc:  # pragma: no cover - runtime dependency
                raise RuntimeError(
                    "H3 cell provider requires the `h3` Python package. "
                    "Install it first, then rerun with --cell-provider h3."
                ) from exc
            if h3_resolution is None:
                raise RuntimeError("--h3-resolution is required for --cell-provider h3")
            self._h3 = h3

    def key_for_point(self, lat: float, lon: float) -> str:
        if self.provider == "square":
            cell_x, cell_y = _mercator_cell_id(lat, lon, self.cell_size_m)
            return f"square:{int(round(self.cell_size_m))}:{cell_x}:{cell_y}"
        assert self._h3 is not None
        cell = self._h3.latlng_to_cell(lat, lon, int(self.h3_resolution))
        return f"h3:{int(self.h3_resolution)}:{cell}"


@dataclass
class StayGroup:
    rows: List[Tuple[int, Dict[str, str]]]
    start_time: Optional[int]
    end_time: Optional[int]
    group_key: str


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", required=True, help="Root directory for mobility CSV files.")
    parser.add_argument("--targets-file", required=True, help="Manifest of target CSV files.")
    parser.add_argument("--output-dir", required=True, help="Directory for task graph artifacts.")
    parser.add_argument(
        "--cell-provider",
        choices=("square", "h3"),
        default="square",
        help="Cell indexing scheme for task routing.",
    )
    parser.add_argument(
        "--cell-size-m",
        type=float,
        default=12000.0,
        help="Square-grid cell size in meters when --cell-provider square.",
    )
    parser.add_argument(
        "--h3-resolution",
        type=int,
        default=None,
        help="H3 resolution when --cell-provider h3.",
    )
    parser.add_argument(
        "--membership-mode",
        choices=("count", "row"),
        default="count",
        help="count: aggregate per task/file. row: emit one membership row per input point.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=0,
        help="Optional cap for quick experiments. 0 means no cap.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=200000,
        help="Print progress every N scanned rows.",
    )
    parser.add_argument(
        "--weather-night-mode",
        choices=("none", "annotate", "drop"),
        default="none",
        help="none: no weather/night classification. annotate: keep tasks but add night fields. drop: remove night tasks.",
    )
    parser.add_argument(
        "--era5-file-template",
        default=os.getenv("ERA5_FILE_TEMPLATE", ""),
        help="ERA5 file template for weather/night classification.",
    )
    parser.add_argument(
        "--era5-file-path",
        default=os.getenv("ERA5_FILE_PATH", ""),
        help="Fallback ERA5 file path for weather/night classification.",
    )
    parser.add_argument(
        "--indoor-mode",
        choices=("none", "drop"),
        default="none",
        help="none: keep all valid rows. drop: remove rows classified as indoor before task graph construction.",
    )
    parser.add_argument(
        "--indoor-partition-manifest-csv",
        default="",
        help="GeoParquet partition manifest used for indoor preclassification.",
    )
    parser.add_argument(
        "--indoor-buildings-buffer-m",
        type=float,
        default=float(os.getenv("MOBILITY_INDOOR_BUILDINGS_BUFFER_M", "0") or "0"),
        help="Optional building footprint buffer in meters for indoor preclassification.",
    )
    parser.add_argument(
        "--preprocess-mode",
        choices=("row", "stay"),
        default="row",
        help="row: process each minute row independently. stay: reconstruct contiguous stay intervals first.",
    )
    parser.add_argument(
        "--stay-daylight-mode",
        choices=("none", "solar"),
        default="none",
        help="none: do not prefilter night rows inside stay groups. solar: use solar elevation to remove night rows before task graph construction.",
    )
    parser.add_argument(
        "--solar-elevation-threshold-deg",
        type=float,
        default=0.0,
        help="Rows with apparent solar elevation <= this threshold are treated as night in --stay-daylight-mode solar.",
    )
    return parser


def iter_csv_rows(file_path: Path) -> Iterator[Tuple[int, Dict[str, str]]]:
    with file_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for idx, row in enumerate(reader):
            if not row:
                continue
            yield idx, row


def write_csv(path: Path, headers: List[str], rows: Iterable[Dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _is_stay_point(row: Dict[str, str]) -> bool:
    raw = (row.get("stay_status") or "").strip()
    if not raw:
        return False
    try:
        return float(raw) >= 1.0
    except Exception:
        return raw.lower() in {"1", "true", "yes", "y"}


def pick_indoor_lon_lat(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    raw = (os.getenv("MOBILITY_INDOOR_COORD_PRIORITY") or "stay_point,fnl,gps,gpx,air,lnglat").strip()
    priority = [p.strip().lower() for p in raw.replace(";", ",").split(",") if p.strip()]
    is_stay = _is_stay_point(row)
    sources = {
        "stay_point": ("stay_point_x", "stay_point_y"),
        "gps": ("gps_lon", "gps_lat"),
        "fnl": ("fnl_lon", "fnl_lat"),
        "gpx": ("gpx_lon", "gpx_lat"),
        "air": ("air_lon", "air_lat"),
        "lnglat": ("lng", "lat"),
        "lonlat": ("lon", "lat"),
    }
    for src in priority:
        pair = sources.get(src)
        if not pair:
            continue
        lon_key, lat_key = pair
        if src == "stay_point" and not is_stay:
            continue
        lon = (row.get(lon_key) or "").strip()
        lat = (row.get(lat_key) or "").strip()
        if lon and lat:
            return lon, lat
    return None, None


def _safe_int(value: object) -> Optional[int]:
    try:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        return int(float(text))
    except Exception:
        return None


def _canonical_stay_key(row: Dict[str, str], row_index: int) -> str:
    start_time = (row.get("start_time") or "").strip()
    end_time = (row.get("end_time") or "").strip()
    if start_time and end_time:
        ad_id = (row.get("ad_id") or "").strip()
        stay_x = (row.get("stay_point_x") or "").strip()
        stay_y = (row.get("stay_point_y") or "").strip()
        lat = (row.get("latitude") or row.get("lat") or "").strip()
        lon = (row.get("longitude") or row.get("lon") or "").strip()
        cluster_id = (row.get("cluster_id") or "").strip()
        return "|".join(
            [
                ad_id,
                start_time,
                end_time,
                cluster_id,
                stay_x,
                stay_y,
                lon,
                lat,
            ]
        )
    return f"row:{row_index}"


def iter_stay_groups(file_path: Path) -> Iterator[StayGroup]:
    current_key: Optional[str] = None
    current_rows: List[Tuple[int, Dict[str, str]]] = []
    current_start: Optional[int] = None
    current_end: Optional[int] = None

    for row_index, row in iter_csv_rows(file_path):
        key = _canonical_stay_key(row, row_index)
        if current_key is None:
            current_key = key
        if key != current_key:
            yield StayGroup(
                rows=current_rows,
                start_time=current_start,
                end_time=current_end,
                group_key=current_key,
            )
            current_rows = []
            current_key = key
            current_start = None
            current_end = None

        current_rows.append((row_index, row))
        start_time = _safe_int(row.get("start_time"))
        end_time = _safe_int(row.get("end_time"))
        if start_time is not None:
            current_start = start_time if current_start is None else min(current_start, start_time)
        if end_time is not None:
            current_end = end_time if current_end is None else max(current_end, end_time)

    if current_rows:
        yield StayGroup(
            rows=current_rows,
            start_time=current_start,
            end_time=current_end,
            group_key=current_key or "",
        )


def _pick_stay_task_coords(stay_rows: Sequence[Tuple[int, Dict[str, str]]]) -> Tuple[Optional[float], Optional[float]]:
    for _row_index, row in stay_rows:
        lon_raw, lat_raw = pick_lon_lat(row)
        if not lon_raw or not lat_raw:
            continue
        try:
            lon = float(lon_raw)
            lat = float(lat_raw)
        except Exception:
            continue
        if math.isfinite(lon) and math.isfinite(lat):
            return lon, lat
    return None, None


def _pick_stay_indoor_coords(stay_rows: Sequence[Tuple[int, Dict[str, str]]]) -> Tuple[Optional[float], Optional[float]]:
    for _row_index, row in stay_rows:
        lon_raw, lat_raw = pick_indoor_lon_lat(row)
        if not lon_raw or not lat_raw:
            continue
        try:
            lon = float(lon_raw)
            lat = float(lat_raw)
        except Exception:
            continue
        if math.isfinite(lon) and math.isfinite(lat):
            return lon, lat
    return None, None


def _filter_stay_rows_by_solar_daylight(
    stay_rows: Sequence[Tuple[int, Dict[str, str]]],
    *,
    lat: float,
    lon: float,
    elevation_threshold_deg: float,
) -> Tuple[List[Tuple[int, Dict[str, str]]], int]:
    try:
        import pandas as pd
        import pvlib
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "stay daylight prefilter requires pandas and pvlib; rerun with --stay-daylight-mode none "
            "or install pvlib in the active Python environment."
        ) from exc

    timed_rows: List[Tuple[int, Dict[str, str], str]] = []
    timestamps: List[str] = []
    for row_index, row in stay_rows:
        minute_iso = floor_to_minute_iso(row.get("timestamp"))
        if not minute_iso:
            continue
        timed_rows.append((row_index, row, minute_iso))
        timestamps.append(minute_iso.replace("Z", "+00:00"))
    if not timed_rows:
        return [], 0

    dt_index = pd.DatetimeIndex(timestamps, tz="UTC")
    solar = pvlib.solarposition.get_solarposition(dt_index, latitude=lat, longitude=lon)
    elevations = solar["apparent_elevation"].to_numpy()

    kept: List[Tuple[int, Dict[str, str]]] = []
    dropped = 0
    threshold = float(elevation_threshold_deg)
    for (row_index, row, _minute_iso), elevation in zip(timed_rows, elevations):
        if float(elevation) <= threshold:
            dropped += 1
            continue
        kept.append((row_index, row))
    return kept, dropped


def compute_bounds_for_file(file_path: Path, *, use_indoor_coords: bool) -> Optional[Tuple[float, float, float, float]]:
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    found = 0
    for _row_index, row in iter_csv_rows(file_path):
        if use_indoor_coords:
            lon_raw, lat_raw = pick_indoor_lon_lat(row)
        else:
            lon_raw, lat_raw = pick_lon_lat(row)
        if not lon_raw or not lat_raw:
            continue
        try:
            lon = float(lon_raw)
            lat = float(lat_raw)
        except Exception:
            continue
        if not (math.isfinite(lon) and math.isfinite(lat)):
            continue
        minx = min(minx, lon)
        maxx = max(maxx, lon)
        miny = min(miny, lat)
        maxy = max(maxy, lat)
        found += 1
    if found == 0:
        return None
    return (minx, miny, maxx, maxy)


def _meters_to_degrees(buffer_m: float, *, mean_lat: float) -> float:
    meters = abs(float(buffer_m))
    if meters <= 0:
        return 0.0
    cos_lat = max(0.1, abs(math.cos(math.radians(float(mean_lat)))))
    deg_lat = meters / 111_000.0
    deg_lon = meters / (111_000.0 * cos_lat)
    return max(deg_lat, deg_lon)


def _expand_bounds(bounds: Tuple[float, float, float, float], *, expand: float) -> Tuple[float, float, float, float]:
    minx, miny, maxx, maxy = bounds
    pad = abs(float(expand))
    return (minx - pad, miny - pad, maxx + pad, maxy + pad)


def _maybe_buffer_buildings(buildings_gdf, *, buffer_m: float, mean_lat: float):
    if not buffer_m:
        return buildings_gdf
    dist_deg = _meters_to_degrees(buffer_m, mean_lat=mean_lat)
    if buffer_m < 0:
        dist_deg = -dist_deg
    buildings_gdf = buildings_gdf.copy()
    buildings_gdf["geometry"] = buildings_gdf.geometry.buffer(dist_deg)
    return buildings_gdf


def _build_tree(buildings_gdf):
    from shapely.strtree import STRtree

    geoms = [g for g in buildings_gdf.geometry if g is not None and not g.is_empty]
    tree = STRtree(geoms) if geoms else None
    return tree, geoms


def _is_indoor(tree, geoms, pt) -> bool:
    if tree is None:
        return False
    candidates = tree.query(pt)
    for cand in candidates:
        geom = cand if hasattr(cand, "covers") else geoms[int(cand)]
        if geom.covers(pt):
            return True
    return False


class IndoorPartitionClassifier:
    def __init__(self, manifest_csv: Path, *, buildings_buffer_m: float) -> None:
        self.manifest_csv = manifest_csv
        self.buildings_buffer_m = float(buildings_buffer_m)
        self._manifest_rows = self._load_manifest(manifest_csv)

    @staticmethod
    def _load_manifest(path: Path) -> List[Dict[str, object]]:
        rows: List[Dict[str, object]] = []
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                output_path = str(row.get("outputParquet") or "").strip()
                if not output_path or not Path(output_path).exists():
                    continue
                rows.append(
                    {
                        "partition_id": str(row.get("partitionId") or "").strip(),
                        "output_path": output_path,
                        "min_lon": float(row["minLon"]),
                        "min_lat": float(row["minLat"]),
                        "max_lon": float(row["maxLon"]),
                        "max_lat": float(row["maxLat"]),
                    }
                )
        if not rows:
            raise RuntimeError(f"No readable partition parquet entries found in manifest: {path}")
        return rows

    def _select_partitions(self, bounds: Tuple[float, float, float, float]) -> List[Dict[str, object]]:
        west, south, east, north = bounds
        selected = []
        for row in self._manifest_rows:
            if float(row["min_lon"]) <= east and float(row["max_lon"]) >= west and float(row["min_lat"]) <= north and float(row["max_lat"]) >= south:
                selected.append(row)
        return selected

    def build_for_file(self, file_path: Path) -> Tuple[object, List[object], Dict[str, int]]:
        bounds = compute_bounds_for_file(file_path, use_indoor_coords=True)
        if bounds is None:
            return None, [], {"selected_partitions": 0, "loaded_rows": 0}

        mean_lat = (bounds[1] + bounds[3]) / 2.0
        expand = _meters_to_degrees(self.buildings_buffer_m, mean_lat=mean_lat)
        expanded_bounds = _expand_bounds(bounds, expand=expand)
        selected = self._select_partitions(expanded_bounds)
        if not selected:
            return None, [], {"selected_partitions": 0, "loaded_rows": 0}

        import geopandas as gpd
        import pandas as pd

        parts = []
        bbox = expanded_bounds
        for row in selected:
            part = gpd.read_parquet(str(row["output_path"]), bbox=bbox)
            if len(part) > 0:
                parts.append(part)
        if not parts:
            return None, [], {"selected_partitions": len(selected), "loaded_rows": 0}

        geometry_name = parts[0].geometry.name
        buildings_gdf = gpd.GeoDataFrame(
            pd.concat(parts, ignore_index=True),
            geometry=geometry_name,
            crs=getattr(parts[0], "crs", None) or "EPSG:4326",
        )
        buildings_gdf = _maybe_buffer_buildings(
            buildings_gdf,
            buffer_m=self.buildings_buffer_m,
            mean_lat=mean_lat,
        )
        tree, geoms = _build_tree(buildings_gdf)
        return tree, geoms, {"selected_partitions": len(selected), "loaded_rows": int(len(buildings_gdf))}


def percentile(sorted_values: List[int], q: float) -> float:
    if not sorted_values:
        return 0.0
    if q <= 0:
        return float(sorted_values[0])
    if q >= 1:
        return float(sorted_values[-1])
    pos = (len(sorted_values) - 1) * q
    lower = int(math.floor(pos))
    upper = int(math.ceil(pos))
    if lower == upper:
        return float(sorted_values[lower])
    weight = pos - lower
    return float(sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight)


def annotate_task_weather(
    task_stats: Dict[str, TaskStats],
    *,
    era5_file_template: Optional[str],
    era5_file_path: Optional[str],
    progress_every: int,
) -> Dict[str, Dict[str, object]]:
    threshold = float(os.getenv("MOBILITY_NIGHT_IRRADIANCE_THRESHOLD", "1e-6"))
    annotations: Dict[str, Dict[str, object]] = {}
    night_tasks = 0
    try:
        for idx, (task_id, stats) in enumerate(task_stats.items(), start=1):
            center_lat = (stats.min_lat + stats.max_lat) / 2.0
            center_lon = (stats.min_lon + stats.max_lon) / 2.0
            cloud_cover, irradiance = _get_weather_cached(
                center_lat,
                center_lon,
                stats.minute_iso,
                era5_file_template or None,
                era5_file_path or None,
            )
            is_night = bool(irradiance is not None and irradiance <= threshold)
            if is_night:
                night_tasks += 1
            annotations[task_id] = {
                "is_night": int(is_night),
                "cloud_cover": "" if cloud_cover is None else cloud_cover,
                "solar_irradiance_wm2": "" if irradiance is None else irradiance,
            }
            if progress_every > 0 and idx % int(progress_every) == 0:
                print(
                    f"[TaskGraphWeather] annotated_tasks={idx} night_tasks={night_tasks}",
                    file=sys.stderr,
                    flush=True,
                )
    finally:
        _cleanup_weather_caches()
    return annotations


def _record_task_row(
    *,
    row: Dict[str, str],
    row_index: int,
    file_id: int,
    file_relpath: str,
    indexer: CellIndexer,
    task_stats: Dict[str, TaskStats],
    membership_mode: str,
    membership_counts: Dict[Tuple[str, str], int],
    membership_rows_writer,
) -> bool:
    lon_raw, lat_raw = pick_lon_lat(row)
    minute_iso = floor_to_minute_iso(row.get("timestamp"))
    if not lon_raw or not lat_raw or not minute_iso:
        return False
    try:
        lon = float(lon_raw)
        lat = float(lat_raw)
    except Exception:
        return False
    if not (math.isfinite(lon) and math.isfinite(lat)):
        return False

    cell_key = indexer.key_for_point(lat, lon)
    task_id = f"{minute_iso}|{cell_key}"

    stats = task_stats.get(task_id)
    if stats is None:
        stats = TaskStats(minute_iso=minute_iso, cell_key=cell_key, file_ids=set())
        task_stats[task_id] = stats
    stats.update(lon, lat, file_id)

    if membership_mode == "row":
        assert membership_rows_writer is not None
        membership_rows_writer.writerow(
            {
                "task_id": task_id,
                "minute_iso": minute_iso,
                "cell_key": cell_key,
                "file_relpath": file_relpath,
                "row_index": row_index,
                "timestamp": row.get("timestamp", ""),
                "lon": lon,
                "lat": lat,
            }
        )
    else:
        membership_counts[(task_id, file_relpath)] += 1
    return True


def main(argv: List[str]) -> int:
    args = build_parser().parse_args(argv)
    started_at = time.monotonic()

    input_root = Path(args.input_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    targets = read_targets_from_file(args.targets_file, input_root)
    indexer = CellIndexer(
        args.cell_provider,
        cell_size_m=float(args.cell_size_m),
        h3_resolution=args.h3_resolution,
    )
    indoor_classifier = None
    if args.indoor_mode != "none":
        manifest_csv = str(args.indoor_partition_manifest_csv or "").strip()
        if not manifest_csv:
            raise RuntimeError("--indoor-partition-manifest-csv is required when --indoor-mode drop")
        indoor_classifier = IndoorPartitionClassifier(
            Path(manifest_csv).expanduser().resolve(),
            buildings_buffer_m=float(args.indoor_buildings_buffer_m),
        )

    task_stats: Dict[str, TaskStats] = {}
    membership_counts: Dict[Tuple[str, str], int] = defaultdict(int)
    membership_rows_path = output_dir / "task_membership_rows.csv"
    membership_rows_handle = None
    membership_rows_writer = None
    if args.membership_mode == "row":
        membership_rows_handle = membership_rows_path.open("w", encoding="utf-8", newline="")
        membership_rows_writer = csv.DictWriter(
            membership_rows_handle,
            fieldnames=[
                "task_id",
                "minute_iso",
                "cell_key",
                "file_relpath",
                "row_index",
                "timestamp",
                "lon",
                "lat",
            ],
            lineterminator="\n",
        )
        membership_rows_writer.writeheader()

    scanned_rows = 0
    valid_rows = 0
    invalid_rows = 0
    indoor_rows = 0
    indoor_selected_partition_total = 0
    indoor_loaded_building_rows_total = 0
    indoor_files_processed = 0
    stay_group_count = 0
    stay_all_night_count = 0
    stay_indoor_drop_count = 0
    solar_prefilter_night_rows = 0

    try:
        for file_id, target in enumerate(targets):
            file_relpath = target.relative_to(input_root).as_posix()
            indoor_tree = None
            indoor_geoms: Sequence[object] = ()
            indoor_coord_cache: Dict[Tuple[int, int], bool] = {}
            indoor_loaded_for_file = False

            def ensure_indoor_classifier_loaded() -> None:
                nonlocal indoor_tree, indoor_geoms, indoor_loaded_for_file
                nonlocal indoor_selected_partition_total, indoor_loaded_building_rows_total, indoor_files_processed
                if indoor_classifier is None or indoor_loaded_for_file:
                    return
                indoor_tree, indoor_geoms, indoor_meta = indoor_classifier.build_for_file(target)
                indoor_selected_partition_total += int(indoor_meta["selected_partitions"])
                indoor_loaded_building_rows_total += int(indoor_meta["loaded_rows"])
                indoor_files_processed += 1
                indoor_loaded_for_file = True

            if args.preprocess_mode == "stay":
                for stay in iter_stay_groups(target):
                    if args.max_rows > 0 and scanned_rows >= args.max_rows:
                        break
                    stay_group_count += 1
                    stay_rows = stay.rows
                    if args.max_rows > 0 and scanned_rows + len(stay_rows) > args.max_rows:
                        stay_rows = stay_rows[: max(0, args.max_rows - scanned_rows)]
                    scanned_rows += len(stay_rows)
                    if not stay_rows:
                        continue

                    candidate_rows = stay_rows
                    if args.stay_daylight_mode == "solar":
                        stay_lon, stay_lat = _pick_stay_task_coords(stay_rows)
                        if stay_lon is not None and stay_lat is not None:
                            candidate_rows, dropped_rows = _filter_stay_rows_by_solar_daylight(
                                stay_rows,
                                lat=stay_lat,
                                lon=stay_lon,
                                elevation_threshold_deg=float(args.solar_elevation_threshold_deg),
                            )
                            solar_prefilter_night_rows += dropped_rows
                        if not candidate_rows:
                            stay_all_night_count += 1
                            if args.progress_every > 0 and scanned_rows % int(args.progress_every) == 0:
                                print(
                                    f"[TaskGraph] scanned_rows={scanned_rows} valid_rows={valid_rows} "
                                    f"tasks={len(task_stats)}",
                                    file=sys.stderr,
                                    flush=True,
                                )
                            continue

                    if indoor_classifier is not None:
                        indoor_lon, indoor_lat = _pick_stay_indoor_coords(candidate_rows)
                        if indoor_lon is not None and indoor_lat is not None:
                            from shapely.geometry import Point

                            ensure_indoor_classifier_loaded()
                            key = (int(round(indoor_lon * 1e5)), int(round(indoor_lat * 1e5)))
                            indoor_value = indoor_coord_cache.get(key)
                            if indoor_value is None:
                                indoor_value = _is_indoor(indoor_tree, indoor_geoms, Point(indoor_lon, indoor_lat))
                                indoor_coord_cache[key] = indoor_value
                            if indoor_value:
                                indoor_rows += len(candidate_rows)
                                stay_indoor_drop_count += 1
                                if args.progress_every > 0 and scanned_rows % int(args.progress_every) == 0:
                                    print(
                                        f"[TaskGraph] scanned_rows={scanned_rows} valid_rows={valid_rows} "
                                        f"tasks={len(task_stats)}",
                                        file=sys.stderr,
                                        flush=True,
                                    )
                                continue

                    for row_index, row in candidate_rows:
                        if _record_task_row(
                            row=row,
                            row_index=row_index,
                            file_id=file_id,
                            file_relpath=file_relpath,
                            indexer=indexer,
                            task_stats=task_stats,
                            membership_mode=args.membership_mode,
                            membership_counts=membership_counts,
                            membership_rows_writer=membership_rows_writer,
                        ):
                            valid_rows += 1
                        else:
                            invalid_rows += 1

                    if args.progress_every > 0 and scanned_rows % int(args.progress_every) == 0:
                        print(
                            f"[TaskGraph] scanned_rows={scanned_rows} valid_rows={valid_rows} "
                            f"tasks={len(task_stats)}",
                            file=sys.stderr,
                            flush=True,
                        )
                if args.max_rows > 0 and scanned_rows >= args.max_rows:
                    break
            else:
                if indoor_classifier is not None:
                    ensure_indoor_classifier_loaded()
                for row_index, row in iter_csv_rows(target):
                    scanned_rows += 1
                    if args.max_rows > 0 and scanned_rows > args.max_rows:
                        break

                    if indoor_classifier is not None:
                        indoor_lon_raw, indoor_lat_raw = pick_indoor_lon_lat(row)
                        if indoor_lon_raw and indoor_lat_raw:
                            try:
                                indoor_lon = float(indoor_lon_raw)
                                indoor_lat = float(indoor_lat_raw)
                            except Exception:
                                indoor_lon = None
                                indoor_lat = None
                            if indoor_lon is not None and indoor_lat is not None:
                                from shapely.geometry import Point

                                key = (int(round(indoor_lon * 1e5)), int(round(indoor_lat * 1e5)))
                                indoor_value = indoor_coord_cache.get(key)
                                if indoor_value is None:
                                    indoor_value = _is_indoor(indoor_tree, indoor_geoms, Point(indoor_lon, indoor_lat))
                                    indoor_coord_cache[key] = indoor_value
                                if indoor_value:
                                    indoor_rows += 1
                                    continue

                    if _record_task_row(
                        row=row,
                        row_index=row_index,
                        file_id=file_id,
                        file_relpath=file_relpath,
                        indexer=indexer,
                        task_stats=task_stats,
                        membership_mode=args.membership_mode,
                        membership_counts=membership_counts,
                        membership_rows_writer=membership_rows_writer,
                    ):
                        valid_rows += 1
                    else:
                        invalid_rows += 1

                    if args.progress_every > 0 and scanned_rows % int(args.progress_every) == 0:
                        print(
                            f"[TaskGraph] scanned_rows={scanned_rows} valid_rows={valid_rows} "
                            f"tasks={len(task_stats)}",
                            file=sys.stderr,
                            flush=True,
                        )
                if args.max_rows > 0 and scanned_rows >= args.max_rows:
                    break
    finally:
        if membership_rows_handle is not None:
            membership_rows_handle.close()

    raw_task_count = len(task_stats)
    weather_annotations: Dict[str, Dict[str, object]] = {}
    if args.weather_night_mode != "none":
        weather_annotations = annotate_task_weather(
            task_stats,
            era5_file_template=str(args.era5_file_template or ""),
            era5_file_path=str(args.era5_file_path or ""),
            progress_every=max(1, int(args.progress_every)),
        )

    retained_task_ids = list(task_stats.keys())
    if args.weather_night_mode == "drop":
        retained_task_ids = [
            task_id
            for task_id in retained_task_ids
            if weather_annotations.get(task_id, {}).get("is_night", 0) != 1
        ]
    retained_task_set = set(retained_task_ids)

    tasks_path = output_dir / "tasks.csv"
    task_headers = [
        "task_id",
        "minute_iso",
        "cell_key",
        "point_count",
        "file_count",
        "west",
        "south",
        "east",
        "north",
    ]
    if args.weather_night_mode != "none":
        task_headers.extend(["is_night", "cloud_cover", "solar_irradiance_wm2"])
    write_csv(
        tasks_path,
        task_headers,
        (
            task_stats[task_id].as_row(task_id, weather_annotations.get(task_id))
            for task_id in sorted(retained_task_ids)
        ),
    )

    memberships_path = None
    if args.membership_mode == "count":
        memberships_path = output_dir / "task_membership_counts.csv"
        write_csv(
            memberships_path,
            ["task_id", "file_relpath", "point_count"],
            (
                {
                    "task_id": task_id,
                    "file_relpath": file_relpath,
                    "point_count": count,
                }
                for (task_id, file_relpath), count in sorted(membership_counts.items())
                if task_id in retained_task_set
            ),
        )
    else:
        memberships_path = membership_rows_path

    retained_task_stats = [task_stats[task_id] for task_id in retained_task_ids]
    task_point_counts = sorted(stats.point_count for stats in retained_task_stats)
    task_file_counts = sorted(len(stats.file_ids or ()) for stats in retained_task_stats)
    minute_count = len({stats.minute_iso for stats in retained_task_stats})
    cell_count = len({stats.cell_key for stats in retained_task_stats})
    membership_edge_count = (
        sum(1 for (task_id, _file_relpath) in membership_counts.keys() if task_id in retained_task_set)
        if args.membership_mode == "count"
        else retained_point_count
    )
    night_task_count = sum(1 for value in weather_annotations.values() if value.get("is_night", 0) == 1)
    retained_point_count = sum(stats.point_count for stats in retained_task_stats)
    night_point_count = (
        sum(task_stats[task_id].point_count for task_id, value in weather_annotations.items() if value.get("is_night", 0) == 1)
        if weather_annotations
        else 0
    )
    rows_per_task_avg = (
        float(statistics.fmean(task_point_counts)) if task_point_counts else 0.0
    )
    files_per_task_avg = (
        float(statistics.fmean(task_file_counts)) if task_file_counts else 0.0
    )
    row_compression_ratio = (
        float(retained_point_count) / float(len(retained_task_stats)) if retained_task_stats else 0.0
    )

    summary = {
        "input_root": str(input_root),
        "targets_file": str(Path(args.targets_file).expanduser().resolve()),
        "target_count": len(targets),
        "cell_provider": args.cell_provider,
        "cell_size_m": float(args.cell_size_m),
        "h3_resolution": args.h3_resolution,
        "membership_mode": args.membership_mode,
        "weather_night_mode": args.weather_night_mode,
        "era5_file_template": str(args.era5_file_template or ""),
        "era5_file_path": str(args.era5_file_path or ""),
        "indoor_mode": args.indoor_mode,
        "indoor_partition_manifest_csv": str(args.indoor_partition_manifest_csv or ""),
        "indoor_buildings_buffer_m": float(args.indoor_buildings_buffer_m),
        "preprocess_mode": args.preprocess_mode,
        "stay_daylight_mode": args.stay_daylight_mode,
        "solar_elevation_threshold_deg": float(args.solar_elevation_threshold_deg),
        "scanned_rows": scanned_rows,
        "valid_rows": valid_rows,
        "invalid_rows": invalid_rows,
        "indoor_rows": indoor_rows,
        "indoor_files_processed": indoor_files_processed,
        "indoor_selected_partition_total": indoor_selected_partition_total,
        "indoor_loaded_building_rows_total": indoor_loaded_building_rows_total,
        "stay_group_count": stay_group_count,
        "stay_all_night_count": stay_all_night_count,
        "stay_indoor_drop_count": stay_indoor_drop_count,
        "solar_prefilter_night_rows": solar_prefilter_night_rows,
        "raw_task_count": raw_task_count,
        "task_count": len(retained_task_stats),
        "minute_count": minute_count,
        "cell_count": cell_count,
        "membership_edge_count": membership_edge_count,
        "night_task_count": night_task_count,
        "night_point_count": night_point_count,
        "retained_point_count": retained_point_count,
        "row_compression_ratio": row_compression_ratio,
        "rows_per_task": {
            "avg": rows_per_task_avg,
            "min": task_point_counts[0] if task_point_counts else 0,
            "p50": percentile(task_point_counts, 0.50),
            "p90": percentile(task_point_counts, 0.90),
            "p95": percentile(task_point_counts, 0.95),
            "max": task_point_counts[-1] if task_point_counts else 0,
        },
        "files_per_task": {
            "avg": files_per_task_avg,
            "min": task_file_counts[0] if task_file_counts else 0,
            "p50": percentile(task_file_counts, 0.50),
            "p90": percentile(task_file_counts, 0.90),
            "p95": percentile(task_file_counts, 0.95),
            "max": task_file_counts[-1] if task_file_counts else 0,
        },
        "tasks_path": str(tasks_path),
        "memberships_path": str(memberships_path),
        "elapsed_seconds": time.monotonic() - started_at,
    }
    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
