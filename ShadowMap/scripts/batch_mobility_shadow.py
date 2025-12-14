#!/usr/bin/env python3

"""Pure Python replacement for `batch-mobility-shadow.mjs`.

This script reads trajectory CSV files, buckets samples by UTC minute, computes
shadow/sunlight per point using local pybdshadow + local buildings/canopy data,
and writes `*-sunlight.csv` outputs with the same appended columns as the Node script.

It is designed to bypass the Node -> HTTP -> backend chain and run efficiently on
large multi-core machines.
"""

from __future__ import annotations

import argparse
import atexit
import csv
import json
import math
import os
import sys
import time
import warnings
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
ENGINE_PATH = SCRIPT_DIR / "shadow-engine-prototype"

warnings.filterwarnings(
    "ignore",
    message=r".*\\+init=<authority>:<code> syntax is deprecated.*",
    category=FutureWarning,
)


HEADERS_TO_APPEND: List[str] = [
    "sunlit",
    "shadowPercent",
    "bucketStart",
    "bucketEnd",
    "source",
    "errorDetail",
    "cloudCover",
    "sunlightFactor",
    "sunlitEffective",
    "shadowPercentEffective",
    "solarIrradianceWm2",
    "irradianceEffective",
    "durationSeconds",
    "sunlightSeconds",
    "shadowSeconds",
    "irradianceJ",
]


def parse_bool(value: object, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "y", "on"}:
            return True
        if lowered in {"0", "false", "no", "n", "off"}:
            return False
    return default


def parse_float(value: object, default: float) -> float:
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip()
        if raw == "":
            return default
        try:
            return float(raw)
        except Exception:
            return default
    try:
        return float(value)  # type: ignore[arg-type]
    except Exception:
        return default


def js_number(value: object) -> float:
    """Approximate JS `Number(value)` conversion for CSV string inputs."""

    if value is None:
        return math.nan
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip()
        if raw == "":
            return 0.0
        try:
            return float(raw)
        except ValueError:
            return math.nan
    return math.nan


def isoformat_z(dt: datetime) -> str:
    dt_utc = dt.astimezone(timezone.utc)
    return dt_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def floor_to_minute_iso(epoch_seconds: object) -> Optional[str]:
    try:
        ms = math.floor(float(epoch_seconds) * 1000.0)
    except (TypeError, ValueError):
        return None
    minute_ms = (ms // 60_000) * 60_000
    dt = datetime.fromtimestamp(minute_ms / 1000.0, tz=timezone.utc)
    dt = dt.replace(second=0, microsecond=0)
    return isoformat_z(dt)


def add_minutes_iso(bucket_start_iso: str, minutes: int) -> str:
    dt = datetime.fromisoformat(bucket_start_iso.replace("Z", "+00:00"))
    return isoformat_z(dt + timedelta(minutes=minutes))


def normalize_bucket_key(value: str) -> str:
    raw = value.strip()
    if raw.endswith("Z") and "." not in raw:
        return raw[:-1] + ".000Z"
    return raw


def clamp(value: float, min_value: float, max_value: float) -> float:
    return min(max(value, min_value), max_value)


def ensure_non_zero_bounds(bounds: Dict[str, float]) -> Dict[str, float]:
    epsilon = 1e-5
    west = bounds["west"]
    east = bounds["east"]
    south = bounds["south"]
    north = bounds["north"]
    if east - west <= 0:
        west -= epsilon
        east += epsilon
    if north - south <= 0:
        south -= epsilon
        north += epsilon
    return {"west": west, "east": east, "south": south, "north": north}


def list_csv_files(root: Path) -> List[Path]:
    files: List[Path] = []
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith(".csv"):
                files.append(Path(dirpath) / name)
    return sorted(files)


def read_buckets_from_file(file_path: Optional[str]) -> Optional[set[str]]:
    if not file_path:
        return None
    path = Path(file_path)
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        print(f"[Buckets] failed to read {file_path}: {exc}", file=sys.stderr)
        return None
    items = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        items.add(normalize_bucket_key(line))
    return items


def read_targets_from_file(file_path: str, input_root: Path) -> List[Path]:
    path = Path(file_path)
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        raise RuntimeError(f"targets_read_failed: {file_path}: {exc}") from exc

    targets: List[Path] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        candidate = Path(line)
        if not candidate.is_absolute():
            candidate = input_root / candidate
        try:
            resolved = candidate.resolve()
        except Exception:
            resolved = candidate
        if resolved.suffix.lower() != ".csv":
            continue
        try:
            resolved.relative_to(input_root)
        except Exception as exc:
            raise RuntimeError(f"target_outside_input_root: {resolved}") from exc
        targets.append(resolved)

    unique: List[Path] = []
    seen: set[Path] = set()
    for item in targets:
        if item in seen:
            continue
        seen.add(item)
        unique.append(item)
    missing = [str(p) for p in unique if not p.exists()]
    if missing:
        raise RuntimeError(f"targets_missing: {len(missing)} (first={missing[0]})")
    return unique


def read_csv_table(file_path: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    with file_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        all_rows = list(reader)
    if not all_rows:
        return [], []
    headers = all_rows[0]
    rows: List[Dict[str, str]] = []
    for raw in all_rows[1:]:
        if not raw or all((cell or "").strip() == "" for cell in raw):
            continue
        row = {headers[idx]: (raw[idx] if idx < len(raw) else "") for idx in range(len(headers))}
        rows.append(row)
    return headers, rows


def seed_existing_output(
    current_rows: List[Dict[str, str]],
    out_file: Path,
) -> Tuple[Optional[List[str]], Optional[List[Dict[str, str]]]]:
    try:
        headers, rows = read_csv_table(out_file)
        return headers, rows
    except Exception:
        return None, None


def write_csv_naive(out_file: Path, headers: Sequence[str], rows: Sequence[Dict[str, Any]]) -> None:
    def format_cell(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            if math.isfinite(value) and value.is_integer():
                return str(int(value))
            return str(value)
        return str(value)

    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(format_cell(row.get(h, "")) for h in headers))
    tmp_path = out_file.with_name(f"{out_file.name}.tmp.{os.getpid()}")
    try:
        tmp_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.replace(tmp_path, out_file)
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


def pick_lon_lat(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    lon = row.get("fnl_lon") or row.get("gps_lon") or row.get("gpx_lon") or row.get("air_lon")
    lat = row.get("fnl_lat") or row.get("gps_lat") or row.get("gpx_lat") or row.get("air_lat")
    return lon, lat


@dataclass(frozen=True)
class BucketPoint:
    index: int
    lon: float
    lat: float


def build_buckets(rows: List[Dict[str, str]]) -> Dict[str, List[BucketPoint]]:
    buckets: Dict[str, List[BucketPoint]] = {}
    for idx, row in enumerate(rows):
        ts = row.get("timestamp")
        lon_raw, lat_raw = pick_lon_lat(row)
        if not lon_raw or not lat_raw:
            row["__error"] = "missing_coords"
            continue
        try:
            lon = float(lon_raw)
            lat = float(lat_raw)
        except ValueError:
            row["__error"] = "invalid_coords"
            continue
        if not (math.isfinite(lon) and math.isfinite(lat)):
            row["__error"] = "invalid_coords"
            continue
        bucket_start = floor_to_minute_iso(ts)
        if not bucket_start:
            row["__error"] = "invalid_timestamp"
            continue
        buckets.setdefault(bucket_start, []).append(BucketPoint(index=idx, lon=lon, lat=lat))
    return buckets


def build_bucket_payload(bucket_key: str, points: Sequence[BucketPoint]) -> Dict[str, Any]:
    north = -math.inf
    south = math.inf
    east = -math.inf
    west = math.inf
    for p in points:
        north = max(north, p.lat)
        south = min(south, p.lat)
        east = max(east, p.lon)
        west = min(west, p.lon)
    bounds = ensure_non_zero_bounds({"west": west, "east": east, "south": south, "north": north})
    return {
        "bucketKey": bucket_key,
        "bbox": bounds,
        "timestamp": bucket_key,
        "points": [{"index": p.index, "lon": p.lon, "lat": p.lat} for p in points],
    }


@dataclass(frozen=True)
class WorkerConfig:
    buildings_path: str
    buildings_layer: Optional[str]
    buildings_mode: str
    canopy_raster_path: Optional[str]
    include_canopy: bool
    timezone: str
    max_features: int
    era5_file_template: Optional[str]
    era5_file_path: Optional[str]


@dataclass(frozen=True)
class BucketJob:
    bucket_key: str
    bbox: Dict[str, float]
    points: List[BucketPoint]
    worker: WorkerConfig
    file_label: str


@dataclass(frozen=True)
class RowUpdate:
    index: int
    values: Dict[str, Any]


@dataclass(frozen=True)
class BucketResult:
    bucket_key: str
    row_updates: List[RowUpdate]
    warnings: List[str]


_WEATHER_CACHE: Dict[str, Tuple[Optional[float], Optional[float]]] = {}
_ERA5_DATASET_CACHE: Dict[str, Tuple[Any, str]] = {}
_CANOPY_DATASET_CACHE: Dict[str, Any] = {}
_BUILDINGS_PRELOAD_CACHE: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}


def _cleanup_caches() -> None:
    for ds, _engine in list(_ERA5_DATASET_CACHE.values()):
        try:
            close = getattr(ds, "close", None)
            if callable(close):
                close()
        except Exception:
            pass
    _ERA5_DATASET_CACHE.clear()

    for ds in list(_CANOPY_DATASET_CACHE.values()):
        try:
            close = getattr(ds, "close", None)
            if callable(close):
                close()
        except Exception:
            pass
    _CANOPY_DATASET_CACHE.clear()


atexit.register(_cleanup_caches)


def _open_era5_dataset(file_path: str):
    import xarray as xr

    engines = ["netcdf4", "h5netcdf", "scipy"]
    last_err: Optional[Exception] = None
    for eng in engines:
        try:
            ds = xr.open_dataset(file_path, engine=eng)
            return ds, eng
        except Exception as exc:
            last_err = exc
            continue
    raise RuntimeError(f"open_failed: {last_err}")


def _resolve_era5_path(template: Optional[str], fallback: Optional[str], dt_utc: datetime) -> str:
    if template:
        y = str(dt_utc.year)
        m = f"{dt_utc.month:02d}"
        candidate = template.replace("%Y", y).replace("%m", m)
        if os.path.exists(candidate):
            return candidate
    if fallback and os.path.exists(fallback):
        return fallback
    raise FileNotFoundError(f"ERA5 file not found (template={template}, fallback={fallback})")


def _fetch_weather_era5(lat: float, lon: float, timestamp_iso: str, template: Optional[str], fallback: Optional[str]):
    import numpy as np

    target = datetime.fromisoformat(timestamp_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    target_naive = target.replace(tzinfo=None)
    file_path = _resolve_era5_path(template, fallback, target)

    cached = _ERA5_DATASET_CACHE.get(file_path)
    if cached is None:
        ds, engine_used = _open_era5_dataset(file_path)
        _ERA5_DATASET_CACHE[file_path] = (ds, engine_used)
    else:
        ds, engine_used = cached

    time_var = None
    for candidate in ("time", "valid_time"):
        if candidate in ds:
            time_var = candidate
            break
    if time_var is None:
        raise RuntimeError(f"missing_time_coord: no time/valid_time in {list(ds.variables)}")

    times = ds[time_var].values
    if len(times) < 2:
        raise RuntimeError("insufficient_time_steps")

    lon_values = ds["longitude"].values
    lon_norm = lon
    if lon_norm < 0 and float(lon_values.max()) > 180:
        lon_norm = (lon_norm + 360) % 360

    diffs = np.abs(
        np.array([(np.datetime64(target_naive) - t).astype("timedelta64[s]").astype(int) for t in times])
    )
    idx = int(np.argmin(diffs))
    if idx == 0:
        idx0, idx1 = 0, min(1, len(times) - 1)
    elif idx == len(times) - 1:
        idx0, idx1 = len(times) - 2, len(times) - 1
    else:
        idx0, idx1 = idx - 1, idx

    t0 = ds.isel({time_var: idx0})
    t1 = ds.isel({time_var: idx1})

    try:
        point_tcc = float(t1["tcc"].sel(latitude=lat, longitude=lon_norm, method="nearest").values)
        ssrd0 = float(t0["ssrd"].sel(latitude=lat, longitude=lon_norm, method="nearest").values)
        ssrd1 = float(t1["ssrd"].sel(latitude=lat, longitude=lon_norm, method="nearest").values)
    except Exception as exc:
        raise RuntimeError(f"variable_missing: {exc}") from exc

    time0 = int(np.datetime64(t0[time_var].values).astype("datetime64[s]").astype(int))
    time1 = int(np.datetime64(t1[time_var].values).astype("datetime64[s]").astype(int))
    dt_seconds = max(int(time1 - time0), 1)
    irradiance = max((ssrd1 - ssrd0) / dt_seconds, 0.0)

    cloud_cover = clamp(point_tcc, 0.0, 1.0)
    return cloud_cover, irradiance, {
        "file": file_path,
        "engine": engine_used,
        "idx0": idx0,
        "idx1": idx1,
        "dt_seconds": dt_seconds,
        "time_var": time_var,
    }


def _get_weather_cached(lat: float, lon: float, timestamp_iso: str, template: Optional[str], fallback: Optional[str]):
    t = datetime.fromisoformat(timestamp_iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    hour = t.replace(minute=0, second=0, microsecond=0)
    key = f"{isoformat_z(hour)}|{lat:.4f}|{lon:.4f}"
    if key in _WEATHER_CACHE:
        return _WEATHER_CACHE[key]

    cloud_cover, irradiance, _details = _fetch_weather_era5(lat, lon, timestamp_iso, template, fallback)
    _WEATHER_CACHE[key] = (cloud_cover, irradiance)
    return _WEATHER_CACHE[key]


def _open_canopy_dataset(path: str):
    import rasterio

    cached = _CANOPY_DATASET_CACHE.get(path)
    if cached is not None:
        return cached
    ds = rasterio.open(path)
    _CANOPY_DATASET_CACHE[path] = ds
    return ds


def _load_buildings(
    bounds: Dict[str, float],
    buildings_path: str,
    max_features: int,
    layer: Optional[str],
):
    import geopandas as gpd

    bbox = (bounds["west"], bounds["south"], bounds["east"], bounds["north"])
    gdf = gpd.read_file(buildings_path, bbox=bbox, layer=layer) if layer else gpd.read_file(buildings_path, bbox=bbox)
    if max_features > 0 and len(gdf) > max_features:
        gdf = gdf.iloc[:max_features].copy()
    return gdf


def _preload_buildings(buildings_path: str, layer: Optional[str]) -> None:
    key = (buildings_path, layer)
    if key in _BUILDINGS_PRELOAD_CACHE:
        return

    import geopandas as gpd
    import numpy as np

    gdf = gpd.read_file(buildings_path, layer=layer) if layer else gpd.read_file(buildings_path)
    geometry_col = gdf.geometry.name

    keep_columns = [geometry_col]
    for col in ("height", "HEIGHT", "height_mean", "levels", "height_m"):
        if col in gdf.columns and col not in keep_columns:
            keep_columns.append(col)
    gdf = gdf[keep_columns]

    bounds_df = gdf.geometry.bounds
    cache = {
        "gdf": gdf,
        "minx": bounds_df["minx"].to_numpy(dtype=np.float64, copy=True),
        "miny": bounds_df["miny"].to_numpy(dtype=np.float64, copy=True),
        "maxx": bounds_df["maxx"].to_numpy(dtype=np.float64, copy=True),
        "maxy": bounds_df["maxy"].to_numpy(dtype=np.float64, copy=True),
    }
    _BUILDINGS_PRELOAD_CACHE[key] = cache


def _load_buildings_preloaded(
    bounds: Dict[str, float],
    buildings_path: str,
    max_features: int,
    layer: Optional[str],
):
    import numpy as np

    key = (buildings_path, layer)
    if key not in _BUILDINGS_PRELOAD_CACHE:
        _preload_buildings(buildings_path, layer)
    cache = _BUILDINGS_PRELOAD_CACHE[key]
    gdf = cache["gdf"]

    west = bounds["west"]
    south = bounds["south"]
    east = bounds["east"]
    north = bounds["north"]

    minx = cache["minx"]
    miny = cache["miny"]
    maxx = cache["maxx"]
    maxy = cache["maxy"]

    mask = (minx <= east) & (maxx >= west) & (miny <= north) & (maxy >= south)
    idx = np.nonzero(mask)[0]
    subset = gdf.iloc[idx]
    if max_features > 0 and len(subset) > max_features:
        subset = subset.iloc[:max_features]
    return subset


def _get_buildings(bounds: Dict[str, float], worker: WorkerConfig):
    if worker.buildings_mode == "preload":
        return _load_buildings_preloaded(bounds, worker.buildings_path, worker.max_features, worker.buildings_layer)
    return _load_buildings(bounds, worker.buildings_path, worker.max_features, worker.buildings_layer)


def _process_bucket(job: BucketJob) -> BucketResult:
    warnings: List[str] = []
    bucket_end = job.bucket_key

    cloud_cover_value: Optional[float] = None
    solar_irradiance_value: Optional[float] = None
    sunlight_factor_value: Optional[float] = None
    night_irradiance_threshold = float(os.getenv("MOBILITY_NIGHT_IRRADIANCE_THRESHOLD", "1e-6"))

    center_lat = (job.bbox["north"] + job.bbox["south"]) / 2.0
    center_lon = (job.bbox["east"] + job.bbox["west"]) / 2.0

    try:
        cloud_cover_value, solar_irradiance_value = _get_weather_cached(
            center_lat,
            center_lon,
            job.bucket_key,
            job.worker.era5_file_template,
            job.worker.era5_file_path,
        )
        cf = clamp(cloud_cover_value, 0.0, 1.0)
        sunlight_factor_value = max(0.15, 1.0 - cf * 0.85)
    except Exception as exc:
        warnings.append(f"[Weather error][{job.file_label}][{job.bucket_key}] {exc}")
        cloud_cover_value = None
        solar_irradiance_value = None
        sunlight_factor_value = None

    cloud_cover_out: Any = cloud_cover_value if cloud_cover_value is not None else ""
    sunlight_factor_out: Any = sunlight_factor_value if sunlight_factor_value is not None else ""
    solar_irradiance_out: Any = solar_irradiance_value if solar_irradiance_value is not None else ""

    if solar_irradiance_value is not None and solar_irradiance_value <= night_irradiance_threshold:
        updates: List[RowUpdate] = []
        for point in job.points:
            updates.append(
                RowUpdate(
                    index=point.index,
                    values={
                        "sunlit": 0,
                        "shadowPercent": 0,
                        "bucketStart": job.bucket_key,
                        "bucketEnd": job.bucket_key,
                        "source": "night",
                        "errorDetail": "",
                        "cloudCover": cloud_cover_out,
                        "sunlightFactor": sunlight_factor_out,
                        "sunlitEffective": "",
                        "shadowPercentEffective": "",
                        "solarIrradianceWm2": solar_irradiance_out,
                        "irradianceEffective": "",
                    },
                )
            )
        return BucketResult(bucket_key=job.bucket_key, row_updates=updates, warnings=warnings)

    try:
        if str(ENGINE_PATH) not in sys.path:
            sys.path.append(str(ENGINE_PATH))

        import pandas as pd
        from shapely.geometry import Point
        from shapely.ops import unary_union
        from shapely.prepared import prep

        from engine_core import canopy_to_gdf, calculate_shadow_coverage, generate_shadows

        buildings = _get_buildings(job.bbox, job.worker)
        if buildings.empty:
            raise RuntimeError("No building features returned for the specified bounds/geometry")

        if job.worker.include_canopy and job.worker.canopy_raster_path:
            canopy_path = job.worker.canopy_raster_path
            if os.path.exists(canopy_path):
                canopy_ds = _open_canopy_dataset(canopy_path)
                canopy_gdf = canopy_to_gdf(canopy_ds, job.bbox)
                if canopy_gdf is not None and not canopy_gdf.empty:
                    buildings = pd.concat([buildings, canopy_gdf], ignore_index=True)
            else:
                warnings.append(f"[Canopy] raster not found: {canopy_path}")

        shadows = generate_shadows(buildings, job.bucket_key, job.worker.timezone)
        coverage = calculate_shadow_coverage(job.bbox, shadows)
        fallback_shadow_percent = clamp(float(coverage.get("coverage_percent") or 0.0), 0.0, 100.0)

        union_geom = unary_union(shadows.geometry) if not shadows.empty else None
        prepared = prep(union_geom) if union_geom is not None and not union_geom.is_empty else None

        updates: List[RowUpdate] = []
        for point in job.points:
            pt = Point(point.lon, point.lat)
            in_shadow = prepared.covers(pt) if prepared is not None else False
            shadow_percent = (100.0 if in_shadow else 0.0) if not shadows.empty else fallback_shadow_percent
            sunlit = 0 if in_shadow else 1
            sunlit_effective = (
                float(sunlit) if sunlight_factor_value is None else float(sunlit) * float(sunlight_factor_value)
            )
            shadow_percent_effective = 100.0 - sunlit_effective * 100.0
            irradiance_effective = (
                None
                if solar_irradiance_value is None
                else (0.0 if sunlit == 0 else float(solar_irradiance_value))
            )

            values: Dict[str, Any] = {
                "sunlit": sunlit,
                "shadowPercent": shadow_percent,
                "bucketStart": job.bucket_key,
                "bucketEnd": bucket_end,
                "source": "engine",
                "errorDetail": "",
                "cloudCover": cloud_cover_out,
                "sunlightFactor": sunlight_factor_out,
                "sunlitEffective": sunlit_effective,
                "shadowPercentEffective": shadow_percent_effective,
                "solarIrradianceWm2": solar_irradiance_out,
                "irradianceEffective": irradiance_effective if irradiance_effective is not None else "",
            }
            updates.append(RowUpdate(index=point.index, values=values))

        return BucketResult(bucket_key=job.bucket_key, row_updates=updates, warnings=warnings)
    except Exception as exc:
        err_msg = str(exc)
        expected = (
            "Given time before sunrise or after sunset" in err_msg
            or "outside daylight" in err_msg.lower()
            or "No building features returned" in err_msg
        )
        if not expected:
            warnings.append(f"[Bucket error][{job.file_label}][{job.bucket_key}] {err_msg}")

        detail = err_msg[:200]
        updates: List[RowUpdate] = []
        for point in job.points:
            updates.append(
                RowUpdate(
                    index=point.index,
                    values={
                        "sunlit": 0,
                        "shadowPercent": 0,
                        "bucketStart": job.bucket_key,
                        "bucketEnd": job.bucket_key,
                        "source": "fallback_error",
                        "errorDetail": detail,
                        "cloudCover": cloud_cover_out,
                        "sunlightFactor": sunlight_factor_out,
                        "sunlitEffective": "",
                        "shadowPercentEffective": "",
                        "solarIrradianceWm2": solar_irradiance_out,
                        "irradianceEffective": "",
                    },
                )
            )
        return BucketResult(bucket_key=job.bucket_key, row_updates=updates, warnings=warnings)


def _job_failure_result(job: BucketJob, error: BaseException) -> BucketResult:
    detail = str(error)[:200]
    updates: List[RowUpdate] = []
    for point in job.points:
        updates.append(
            RowUpdate(
                index=point.index,
                values={
                    "sunlit": 0,
                    "shadowPercent": 0,
                    "bucketStart": job.bucket_key,
                    "bucketEnd": job.bucket_key,
                    "source": "fallback_error",
                    "errorDetail": detail,
                    "cloudCover": "",
                    "sunlightFactor": "",
                    "sunlitEffective": "",
                    "shadowPercentEffective": "",
                    "solarIrradianceWm2": "",
                    "irradianceEffective": "",
                },
            )
        )
    warnings = [f"[Bucket crash][{job.file_label}][{job.bucket_key}] {detail}"]
    return BucketResult(bucket_key=job.bucket_key, row_updates=updates, warnings=warnings)


def run_bucket_jobs(
    jobs: Sequence[BucketJob],
    max_workers: int,
    executor: Optional[ProcessPoolExecutor] = None,
) -> Iterable[BucketResult]:
    if not jobs:
        return []
    max_workers = max(1, max_workers)

    iterator = iter(jobs)
    in_flight: set[Any] = set()
    future_to_job: Dict[Any, BucketJob] = {}

    def submit_next(target_executor: ProcessPoolExecutor) -> bool:
        try:
            next_job = next(iterator)
        except StopIteration:
            return False
        future = target_executor.submit(_process_bucket, next_job)
        in_flight.add(future)
        future_to_job[future] = next_job
        return True

    def run(target_executor: ProcessPoolExecutor) -> Iterable[BucketResult]:
        for _ in range(max_workers):
            if not submit_next(target_executor):
                break

        while in_flight:
            done, pending = wait(in_flight, return_when=FIRST_COMPLETED)
            in_flight.clear()
            in_flight.update(pending)
            for future in done:
                job = future_to_job.pop(future, None)
                try:
                    yield future.result()
                except Exception as exc:
                    if job is None:
                        yield BucketResult(
                            bucket_key="unknown",
                            row_updates=[],
                            warnings=[f"[Bucket crash][unknown] {str(exc)[:200]}"],
                        )
                    else:
                        yield _job_failure_result(job, exc)
                submit_next(target_executor)

    if executor is not None:
        yield from run(executor)
        return

    with ProcessPoolExecutor(max_workers=max_workers) as local_executor:
        yield from run(local_executor)


def compute_duration_fields(headers: Sequence[str], rows: List[Dict[str, Any]]) -> None:
    ts_field = "timestamp" if "timestamp" in headers else ("time" if "time" in headers else None)
    sorted_indices = list(range(len(rows)))

    if ts_field:
        def to_ms(value: object) -> float:
            n = js_number(value)
            if math.isfinite(n):
                return n * 1000.0
            try:
                return datetime.fromisoformat(str(value)).timestamp() * 1000.0
            except Exception:
                return 0.0

        sorted_indices = sorted(sorted_indices, key=lambda idx: to_ms(rows[idx].get(ts_field)))

    for pos, idx in enumerate(sorted_indices):
        next_idx = sorted_indices[pos + 1] if pos + 1 < len(sorted_indices) else None
        duration_seconds: float = 60.0
        if ts_field and next_idx is not None:
            cur_ms = js_number(rows[idx].get(ts_field)) * 1000.0
            nxt_ms = js_number(rows[next_idx].get(ts_field)) * 1000.0
            if math.isfinite(cur_ms) and math.isfinite(nxt_ms):
                diff = (nxt_ms - cur_ms) / 1000.0
                if math.isfinite(diff) and diff > 0:
                    duration_seconds = clamp(diff, 1.0, 300.0)

        current = rows[idx]
        sunlit_effective_raw = js_number(current.get("sunlitEffective"))
        sunlit_effective = sunlit_effective_raw if math.isfinite(sunlit_effective_raw) and sunlit_effective_raw != 0 else 0.0
        shadow_percent_effective_raw = js_number(current.get("shadowPercentEffective"))
        shadow_percent_effective = (
            shadow_percent_effective_raw
            if math.isfinite(shadow_percent_effective_raw) and shadow_percent_effective_raw != 0
            else 0.0
        )
        irradiance_effective = js_number(current.get("irradianceEffective"))

        current["durationSeconds"] = duration_seconds
        current["sunlightSeconds"] = sunlit_effective * duration_seconds
        current["shadowSeconds"] = (shadow_percent_effective / 100.0) * duration_seconds
        current["irradianceJ"] = (
            max(0.0, irradiance_effective) * duration_seconds if math.isfinite(irradiance_effective) else ""
        )


@dataclass
class Config:
    input_root: str
    output_root: str
    backend_url: str
    weather_url: str
    buildings_path: str
    buildings_layer: Optional[str]
    buildings_mode: str
    canopy_raster_path: Optional[str]
    include_canopy: bool
    era5_file_template: Optional[str]
    era5_file_path: Optional[str]
    timezone: str
    max_features: int
    concurrency: int
    progress_interval_s: float
    progress_style: str
    print_config: bool
    force: bool
    buckets_file: Optional[str]
    targets_file: Optional[str]
    target_file: Optional[str]


def parse_args(argv: Sequence[str]) -> Config:
    default_input = os.getenv("INPUT_ROOT")
    default_output = os.getenv("OUTPUT_ROOT")
    default_canopy = ""

    parser = argparse.ArgumentParser(description="Batch mobility shadow (pure Python)")
    parser.add_argument("--input", dest="input_root", default=default_input)
    parser.add_argument("--output", dest="output_root", default=default_output)
    parser.add_argument(
        "--backend",
        dest="backend_url",
        default=os.getenv("BACKEND_URL", "http://localhost:3001/api/analysis/shadow"),
        help="Accepted for compatibility; not used by the Python pipeline.",
    )
    parser.add_argument(
        "--weather",
        dest="weather_url",
        default=os.getenv("WEATHER_URL", "http://localhost:3001/api/weather/current"),
        help="Accepted for compatibility; not used by the Python pipeline.",
    )
    parser.add_argument(
        "--buildings",
        dest="buildings_path",
        default=os.getenv("BUILDING_LOCAL_GEOJSON", "") or os.getenv("ENGINE_BUILDING_LOCAL_GEOJSON", ""),
        help="Local buildings dataset (GPKG/GeoJSON). Defaults to $BUILDING_LOCAL_GEOJSON.",
    )
    parser.add_argument(
        "--buildings-layer",
        dest="buildings_layer",
        default=os.getenv("BUILDING_GPKG_LAYER", "") or os.getenv("BUILDINGS_LAYER", ""),
        help="Optional layer name for multi-layer GPKG (e.g. hk_buildings).",
    )
    parser.add_argument(
        "--buildings-mode",
        dest="buildings_mode",
        default=os.getenv("MOBILITY_BUILDINGS_MODE", "bbox"),
        choices=("bbox", "preload"),
        help="Building query strategy: bbox (read window) or preload (load once in memory).",
    )
    parser.add_argument(
        "--canopy",
        dest="canopy_raster_path",
        default=os.getenv("CANOPY_RASTER_PATH")
        or os.getenv("SHADOW_ENGINE_CANOPY_RASTER_PATH")
        or default_canopy,
        help="Canopy raster path (GeoTIFF).",
    )
    parser.add_argument("--include-canopy", dest="include_canopy", nargs="?", const="true", default="true")
    parser.add_argument(
        "--era5-template",
        dest="era5_file_template",
        default=os.getenv("ERA5_FILE_TEMPLATE", ""),
        help="ERA5 file template (supports %%Y %%m).",
    )
    parser.add_argument(
        "--era5-file",
        dest="era5_file_path",
        default=os.getenv("ERA5_FILE_PATH", ""),
        help="ERA5 fallback file path.",
    )
    parser.add_argument(
        "--timezone",
        dest="timezone",
        default=os.getenv("SHADOW_ENGINE_TIMEZONE", "Asia/Hong_Kong"),
    )
    parser.add_argument(
        "--max-features",
        dest="max_features",
        type=int,
        default=int(os.getenv("SHADOW_ENGINE_MAX_FEATURES", "8000")),
    )
    default_conc = os.getenv("CONC") or str(min(os.cpu_count() or 4, 64))
    parser.add_argument("--concurrency", dest="concurrency", default=default_conc)
    parser.add_argument("--workers", dest="workers", default=None)
    parser.add_argument(
        "--progress-interval",
        dest="progress_interval_s",
        default=os.getenv("MOBILITY_PROGRESS_INTERVAL", "10"),
        help="Progress log interval in seconds (0 disables).",
    )
    parser.add_argument(
        "--progress-style",
        dest="progress_style",
        default=os.getenv("MOBILITY_PROGRESS_STYLE", "log"),
        choices=("log", "single"),
        help="Progress output style: log (new lines) or single (overwrite line).",
    )
    parser.add_argument(
        "--print-config",
        dest="print_config",
        nargs="?",
        const="true",
        default=os.getenv("MOBILITY_PRINT_CONFIG", "false"),
        help="Print config JSON at startup.",
    )
    parser.add_argument("--force", dest="force", nargs="?", const="true", default="false")
    parser.add_argument("--buckets-file", "--bucketsFile", dest="buckets_file", default=None)
    parser.add_argument("--targets-file", dest="targets_file", default=None)
    parser.add_argument("--target-file", "--targetFile", dest="target_file", default=None)

    args = parser.parse_args(list(argv))
    if not args.input_root:
        parser.error("Missing --input (or set $INPUT_ROOT)")
    if not args.output_root:
        parser.error("Missing --output (or set $OUTPUT_ROOT)")
    concurrency_raw = args.workers if args.workers is not None else args.concurrency
    try:
        concurrency = int(concurrency_raw)
    except Exception:
        concurrency = 4
    progress_interval_s = max(0.0, parse_float(args.progress_interval_s, 10.0))
    canopy_path = str(args.canopy_raster_path).strip() if args.canopy_raster_path else None
    canopy_path = canopy_path or None

    return Config(
        input_root=str(Path(args.input_root).resolve()),
        output_root=str(Path(args.output_root).resolve()),
        backend_url=str(args.backend_url).rstrip("/"),
        weather_url=str(args.weather_url).rstrip("/"),
        buildings_path=str(args.buildings_path),
        buildings_layer=str(args.buildings_layer).strip() or None,
        buildings_mode=str(args.buildings_mode),
        canopy_raster_path=canopy_path,
        include_canopy=parse_bool(args.include_canopy, default=True),
        era5_file_template=str(args.era5_file_template).strip() or None,
        era5_file_path=str(args.era5_file_path).strip() or None,
        timezone=str(args.timezone),
        max_features=int(args.max_features),
        concurrency=max(1, concurrency),
        progress_interval_s=progress_interval_s,
        progress_style=str(args.progress_style),
        print_config=parse_bool(args.print_config, default=False),
        force=parse_bool(args.force, default=False),
        buckets_file=str(args.buckets_file) if args.buckets_file else None,
        targets_file=str(args.targets_file) if args.targets_file else None,
        target_file=str(args.target_file) if args.target_file else None,
    )


def process_file(
    file_path: Path,
    idx: int,
    total: int,
    config: Config,
    executor: Optional[ProcessPoolExecutor] = None,
) -> None:
    relative = os.path.relpath(file_path, config.input_root)
    out_dir = Path(config.output_root) / Path(relative).parent
    base = file_path.stem
    out_file = out_dir / f"{base}-sunlight.csv"
    started_at = time.time()

    filter_buckets = read_buckets_from_file(config.buckets_file)
    if not config.force and not filter_buckets and out_file.exists():
        print(f"[Skip existing][{idx + 1}/{total}] {relative}")
        return

    headers, rows = read_csv_table(file_path)
    if not rows:
        print(f"[Skip][{idx + 1}/{total}] {relative} empty file")
        return

    existing_headers = None
    existing_rows = None
    if filter_buckets:
        existing_headers, existing_rows = seed_existing_output(rows, out_file)
        if existing_headers and existing_rows and len(existing_rows) == len(rows):
            for i in range(len(rows)):
                target = rows[i]
                old = existing_rows[i]
                for h in existing_headers:
                    target[h] = old.get(h, target.get(h, ""))
            print(f"[Seed existing][{idx + 1}/{total}] {relative}")

    for row in rows:
        for key in HEADERS_TO_APPEND:
            if key not in row:
                row[key] = ""

    buckets = build_buckets(rows)
    jobs: List[BucketJob] = []

    if not config.buildings_path:
        raise SystemExit("Missing buildings path: set --buildings or $BUILDING_LOCAL_GEOJSON")

    worker_cfg = WorkerConfig(
        buildings_path=config.buildings_path,
        buildings_layer=config.buildings_layer,
        buildings_mode=config.buildings_mode,
        canopy_raster_path=config.canopy_raster_path,
        include_canopy=config.include_canopy,
        timezone=config.timezone,
        max_features=config.max_features,
        era5_file_template=config.era5_file_template,
        era5_file_path=config.era5_file_path,
    )

    for bucket_key, points in buckets.items():
        if not points:
            continue
        if filter_buckets and normalize_bucket_key(bucket_key) not in filter_buckets:
            continue
        payload = build_bucket_payload(bucket_key, points)
        jobs.append(
            BucketJob(
                bucket_key=bucket_key,
                bbox=payload["bbox"],
                points=list(points),
                worker=worker_cfg,
                file_label=relative,
            )
        )

    print(
        f"[Process][{idx + 1}/{total}] {relative} buckets={len(jobs)}"
        f"{' (filtered)' if filter_buckets else ''}"
    )

    total_buckets = len(jobs)
    total_points = sum(len(job.points) for job in jobs)
    completed_buckets = 0
    completed_points = 0
    last_progress = started_at
    progress_interval_s = max(0.0, float(config.progress_interval_s))
    progress_style = str(config.progress_style or "log")

    for result in run_bucket_jobs(jobs, config.concurrency, executor=executor):
        completed_buckets += 1
        completed_points += len(result.row_updates)
        for warn in result.warnings:
            print(warn, file=sys.stderr)
        for update in result.row_updates:
            rows[update.index].update(update.values)
        now = time.time()
        should_report = (
            progress_interval_s > 0
            and (now - last_progress >= progress_interval_s or completed_buckets >= total_buckets)
            and total_buckets > 0
        )
        if should_report:
            elapsed_s = max(0.001, now - started_at)
            rate = completed_buckets / elapsed_s
            remaining = max(0, total_buckets - completed_buckets)
            eta_s = int(round(remaining / rate)) if rate > 0 else -1
            pct = (completed_buckets / total_buckets) * 100.0
            line = (
                f"[Progress][{idx + 1}/{total}] {relative}"
                f" buckets={completed_buckets}/{total_buckets} ({pct:.1f}%)"
                f" points={completed_points}/{total_points}"
                f" elapsed={int(round(elapsed_s))}s eta={eta_s}s"
            )
            if progress_style == "single":
                print(f"\r{line}", end="", flush=True)
            else:
                print(line, flush=True)
            last_progress = now

    if progress_style == "single" and total_buckets > 0:
        print("", flush=True)

    for row in rows:
        if row.get("sunlit", "") not in ("", None):
            continue
        err = row.get("__error")
        if err:
            row["sunlit"] = 0
            row["shadowPercent"] = 0
            row["bucketStart"] = ""
            row["bucketEnd"] = ""
            row["source"] = err
            row["cloudCover"] = ""
            row["sunlightFactor"] = ""
            row["sunlitEffective"] = ""
            row["shadowPercentEffective"] = ""
            row["solarIrradianceWm2"] = ""
            row["irradianceEffective"] = ""

    out_dir.mkdir(parents=True, exist_ok=True)
    final_headers = list(headers) + list(HEADERS_TO_APPEND)
    compute_duration_fields(headers, rows)
    write_csv_naive(out_file, final_headers, rows)

    try:
        rel_out = str(out_file.relative_to(Path(config.output_root)))
    except Exception:
        rel_out = out_file.name

    elapsed_s = int(round(time.time() - started_at))
    print(
        f"[Done][{idx + 1}/{total}] {relative} -> {rel_out} ({elapsed_s}s) buckets={len(jobs)}"
        f"{' (filtered)' if filter_buckets else ''}"
    )


def main(argv: Sequence[str]) -> int:
    config = parse_args(argv)
    print("Batch mobility shadow")
    if config.print_config:
        print(json.dumps(asdict(config), indent=2))

    input_root = Path(config.input_root)
    if config.targets_file:
        if config.target_file:
            print("[Fatal] Use either --target-file or --targets-file (not both).", file=sys.stderr)
            return 2
        try:
            files = read_targets_from_file(config.targets_file, input_root)
        except Exception as exc:
            print(f"[Fatal] Failed to read targets file: {exc}", file=sys.stderr)
            return 2
    else:
        files = list_csv_files(input_root)
    if config.target_file:
        files = [f for f in files if f.name == config.target_file]
        if not files:
            print(f'[Warning] Target file "{config.target_file}" not found under {config.input_root}')
    if not files:
        print(f"No CSV files found under {config.input_root}", file=sys.stderr)
        return 1

    import multiprocessing as mp

    if config.buildings_mode == "preload":
        if sys.platform != "linux":
            print(
                f"[Warning] preload mode relies on forked processes for memory sharing; platform={sys.platform}",
                file=sys.stderr,
            )
        try:
            if "fork" not in mp.get_all_start_methods():
                print(
                    "[Warning] preload mode cannot use fork on this platform; each worker may reload the buildings file",
                    file=sys.stderr,
                )
        except Exception:
            pass

        if not config.buildings_path:
            print("Missing buildings path: set --buildings or $BUILDING_LOCAL_GEOJSON", file=sys.stderr)
            return 2
        try:
            # IMPORTANT:
            # Preloading must happen in the parent process BEFORE creating the ProcessPoolExecutor.
            # When using fork, the worker processes inherit the preloaded in-memory cache.
            _preload_buildings(config.buildings_path, config.buildings_layer)
        except Exception as exc:
            print(f"[Fatal] Failed to preload buildings dataset: {exc}", file=sys.stderr)
            return 2

    mp_ctx = None
    if config.buildings_mode == "preload":
        try:
            if "fork" in mp.get_all_start_methods():
                mp_ctx = mp.get_context("fork")
        except Exception:
            mp_ctx = None

    total = len(files)
    executor_kwargs = {"max_workers": config.concurrency}
    if mp_ctx is not None:
        executor_kwargs["mp_context"] = mp_ctx

    failures: List[str] = []
    with ProcessPoolExecutor(**executor_kwargs) as executor:
        for i, file_path in enumerate(files):
            try:
                process_file(file_path, i, total, config, executor=executor)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                rel = os.path.relpath(file_path, config.input_root)
                print(f"[File crash][{i + 1}/{total}] {rel}: {str(exc)[:200]}", file=sys.stderr)
                failures.append(str(file_path))

    print("All files completed.")
    if failures:
        print(f"[Summary] Failed files: {len(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
