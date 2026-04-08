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
from collections import OrderedDict
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
ENGINE_PATH = SCRIPT_DIR / "shadow-engine-prototype"


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


def configure_runtime() -> None:
    # Performance: avoid BLAS oversubscription when using multiprocessing.
    for key in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "GDAL_NUM_THREADS",
    ):
        os.environ.setdefault(key, "1")

    suppress = parse_bool(os.getenv("MOBILITY_SUPPRESS_NOISY_WARNINGS", "true"), default=True)
    if not suppress:
        return

    # Reduce log spam from common geospatial dependencies.
    warnings.filterwarnings(
        "ignore",
        message=r".*No explicit representation of timezones available for np\\.datetime64.*",
        category=UserWarning,
    )
    warnings.filterwarnings(
        "ignore",
        message=r".*syntax is deprecated\\..*authority:code.*",
        category=FutureWarning,
    )


configure_runtime()


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
    return items or None


def read_targets_from_file(file_path: str, input_root: Path) -> List[Path]:
    path = Path(file_path)
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        raise RuntimeError(f"targets_read_failed: {file_path}: {exc}") from exc

    skip_missing_targets = parse_bool(os.getenv("MOBILITY_SKIP_MISSING_TARGETS", "false"), default=False)
    input_root_abs = Path(os.path.abspath(str(input_root)))
    try:
        input_root_resolved = input_root.resolve()
    except Exception:
        input_root_resolved = input_root_abs

    targets: List[Path] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        candidate = Path(line)
        if not candidate.is_absolute():
            candidate = input_root_abs / candidate

        candidate_abs = Path(os.path.abspath(str(candidate)))
        if candidate_abs.suffix.lower() != ".csv":
            continue

        # Prefer the non-resolved absolute path when it is already under input_root,
        # so symlinked directories do not break the relative output mapping.
        try:
            candidate_abs.relative_to(input_root_abs)
            targets.append(candidate_abs)
            continue
        except Exception:
            pass

        try:
            candidate_resolved = candidate.resolve()
        except Exception:
            candidate_resolved = candidate_abs

        try:
            candidate_resolved.relative_to(input_root_resolved)
        except Exception as exc:
            raise RuntimeError(
                "target_outside_input_root: "
                f"candidate={candidate_abs} resolved={candidate_resolved} "
                f"input_root={input_root_abs} input_root_resolved={input_root_resolved}"
            ) from exc
        targets.append(candidate_resolved)

    unique: List[Path] = []
    seen: set[Path] = set()
    for item in targets:
        if item in seen:
            continue
        seen.add(item)
        unique.append(item)
    missing = [str(p) for p in unique if not p.exists()]
    if missing:
        if skip_missing_targets:
            print(f"[Targets] skip missing files: {len(missing)} (first={missing[0]})", file=sys.stderr)
            unique = [p for p in unique if p.exists()]
        else:
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


def write_csv(out_file: Path, headers: Sequence[str], rows: Sequence[Dict[str, Any]]) -> None:
    def format_cell(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.replace("\r", " ").replace("\n", " ")
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int):
            return str(value)
        if isinstance(value, float):
            if math.isfinite(value) and value.is_integer():
                return str(int(value))
            return str(value)
        return str(value)

    tmp_path = out_file.with_name(f"{out_file.name}.tmp.{os.getpid()}")
    try:
        with tmp_path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
            writer.writerow(list(headers))
            for row in rows:
                writer.writerow([format_cell(row.get(h, "")) for h in headers])
        os.replace(tmp_path, out_file)
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


def _coord_priority(env_key: str, default: str) -> List[str]:
    raw = (os.getenv(env_key) or default).strip()
    parts = [p.strip().lower() for p in raw.replace(";", ",").split(",") if p.strip()]
    return parts


def _is_stay_point(row: Dict[str, str]) -> bool:
    raw = (row.get("stay_status") or "").strip()
    if not raw:
        return False
    try:
        return float(raw) >= 1.0
    except Exception:
        return raw.lower() in {"1", "true", "yes", "y"}


def pick_lon_lat(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    # Default priority follows the legacy pipeline: `fnl_*` first.
    # If you need to bypass `fnl_*` jitter for an experiment, override with:
    #   MOBILITY_COORD_PRIORITY="gps,fnl,gpx,air"
    priority = _coord_priority("MOBILITY_COORD_PRIORITY", "fnl,gps,gpx,air,lnglat")
    is_stay = _is_stay_point(row)

    sources: Dict[str, Tuple[str, str]] = {
        "gps": ("gps_lon", "gps_lat"),
        "fnl": ("fnl_lon", "fnl_lat"),
        "gpx": ("gpx_lon", "gpx_lat"),
        "air": ("air_lon", "air_lat"),
        # Some pipelines keep stay-point centers (lon/lat) for stable indoor checks.
        "stay_point": ("stay_point_x", "stay_point_y"),
        # Frontend datasets may use `lng/lat` or `lon/lat`.
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


@dataclass(frozen=True)
class BucketPoint:
    index: int
    lon: float
    lat: float
    file_index: int = 0


def build_buckets(rows: List[Dict[str, str]], file_index: int = 0) -> Dict[str, List[BucketPoint]]:
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
        buckets.setdefault(bucket_start, []).append(BucketPoint(index=idx, lon=lon, lat=lat, file_index=file_index))
    return buckets


WEB_MERCATOR_RADIUS_M = 6_378_137.0
WEB_MERCATOR_MAX_LAT = 85.05112878


def _expand_bounds_by_meters(bounds: Dict[str, float], margin_m: float) -> Dict[str, float]:
    if margin_m <= 0:
        return dict(bounds)
    mean_lat = (float(bounds["north"]) + float(bounds["south"])) / 2.0
    deg_lat = margin_m / 111_000.0
    cos_lat = max(math.cos(math.radians(mean_lat)), 1e-6)
    deg_lon = margin_m / (111_000.0 * cos_lat)
    return ensure_non_zero_bounds(
        {
            "west": float(bounds["west"]) - deg_lon,
            "east": float(bounds["east"]) + deg_lon,
            "south": float(bounds["south"]) - deg_lat,
            "north": float(bounds["north"]) + deg_lat,
        }
    )


def _mercator_cell_id(lat: float, lon: float, cell_size_m: float) -> Tuple[int, int]:
    safe_lat = clamp(float(lat), -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT)
    x = WEB_MERCATOR_RADIUS_M * math.radians(float(lon))
    y = WEB_MERCATOR_RADIUS_M * math.log(math.tan(math.pi / 4.0 + math.radians(safe_lat) / 2.0))
    return (math.floor(x / cell_size_m), math.floor(y / cell_size_m))


def _mercator_cell_bounds(cell_x: int, cell_y: int, cell_size_m: float) -> Dict[str, float]:
    min_x = float(cell_x) * float(cell_size_m)
    max_x = float(cell_x + 1) * float(cell_size_m)
    min_y = float(cell_y) * float(cell_size_m)
    max_y = float(cell_y + 1) * float(cell_size_m)

    west = math.degrees(min_x / WEB_MERCATOR_RADIUS_M)
    east = math.degrees(max_x / WEB_MERCATOR_RADIUS_M)
    south = math.degrees(2.0 * math.atan(math.exp(min_y / WEB_MERCATOR_RADIUS_M)) - math.pi / 2.0)
    north = math.degrees(2.0 * math.atan(math.exp(max_y / WEB_MERCATOR_RADIUS_M)) - math.pi / 2.0)
    return ensure_non_zero_bounds({"west": west, "east": east, "south": south, "north": north})


def _normalize_shadow_cache_cell_size(cell_size_m: float, shadow_cache_cell_size_m: float) -> float:
    if shadow_cache_cell_size_m <= 0:
        return 0.0
    if shadow_cache_cell_size_m <= cell_size_m:
        return float(cell_size_m)
    multiplier = max(1, int(math.ceil(float(shadow_cache_cell_size_m) / float(cell_size_m))))
    return float(multiplier) * float(cell_size_m)


def build_bucket_payload(
    bucket_key: str,
    points: Sequence[BucketPoint],
    *,
    context_margin_m: float = 0.0,
) -> Dict[str, Any]:
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
    bounds = _expand_bounds_by_meters(bounds, context_margin_m)
    return {
        "bucketKey": bucket_key,
        "bbox": bounds,
        "timestamp": bucket_key,
        "points": [{"index": p.index, "lon": p.lon, "lat": p.lat} for p in points],
    }


@dataclass(frozen=True)
class WorkerConfig:
    buildings_source: str
    buildings_path: str
    buildings_layer: Optional[str]
    buildings_mode: str
    buildings_point_buffer_m: float
    buildings_point_buffer_threshold_m: float
    postgis_dsn: Optional[str]
    postgis_host: Optional[str]
    postgis_port: Optional[int]
    postgis_database: Optional[str]
    postgis_user: Optional[str]
    postgis_password: Optional[str]
    postgis_table: Optional[str]
    postgis_geom_column: str
    postgis_height_column: Optional[str]
    postgis_where: Optional[str]
    canopy_raster_path: Optional[str]
    include_canopy: bool
    timezone: str
    max_features: int
    era5_file_template: Optional[str]
    era5_file_path: Optional[str]
    shadow_cache_cell_size_m: float
    shadow_cache_max_entries: int


@dataclass(frozen=True)
class BucketJob:
    bucket_key: str
    bbox: Dict[str, float]
    points: List[BucketPoint]
    worker: WorkerConfig
    file_label: str
    shadow_cache_key: Optional[str] = None
    shadow_cache_bbox: Optional[Dict[str, float]] = None
    cell_x: Optional[int] = None
    cell_y: Optional[int] = None
    shadow_cell_x: Optional[int] = None
    shadow_cell_y: Optional[int] = None


@dataclass(frozen=True)
class RowUpdate:
    index: int
    values: Dict[str, Any]
    file_index: int = 0


@dataclass(frozen=True)
class BucketResult:
    bucket_key: str
    row_updates: List[RowUpdate]
    warnings: List[str]


_WEATHER_CACHE: Dict[str, Tuple[Optional[float], Optional[float]]] = {}
_ERA5_DATASET_CACHE: Dict[str, Tuple[Any, str]] = {}
_ERA5_SSRD_MODE_CACHE: Dict[str, str] = {}
_CANOPY_DATASET_CACHE: Dict[str, Any] = {}
_BUILDINGS_PRELOAD_CACHE: Dict[Tuple[str, Optional[str]], Dict[str, Any]] = {}
_POSTGIS_CONNECTION_CACHE: Dict[Tuple[Optional[str], Optional[str], Optional[int], Optional[str], Optional[str], Optional[str]], Any] = {}
_POSTGIS_COLUMNS_CACHE: Dict[Tuple[Tuple[Optional[str], Optional[str], Optional[int], Optional[str], Optional[str], Optional[str]], str], Tuple[str, ...]] = {}
_SHADOW_RESULT_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()


def _cleanup_caches() -> None:
    for ds, _engine in list(_ERA5_DATASET_CACHE.values()):
        try:
            close = getattr(ds, "close", None)
            if callable(close):
                close()
        except Exception:
            pass
    _ERA5_DATASET_CACHE.clear()
    _ERA5_SSRD_MODE_CACHE.clear()

    for ds in list(_CANOPY_DATASET_CACHE.values()):
        try:
            close = getattr(ds, "close", None)
            if callable(close):
                close()
        except Exception:
            pass
    _CANOPY_DATASET_CACHE.clear()

    for conn in list(_POSTGIS_CONNECTION_CACHE.values()):
        try:
            close = getattr(conn, "close", None)
            if callable(close):
                close()
        except Exception:
            pass
    _POSTGIS_CONNECTION_CACHE.clear()
    _POSTGIS_COLUMNS_CACHE.clear()
    _SHADOW_RESULT_CACHE.clear()


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

    def nearest_idx(dt: datetime) -> int:
        dt_naive = dt.replace(tzinfo=None)
        diffs = np.abs(
            np.array([(np.datetime64(dt_naive) - t).astype("timedelta64[s]").astype(int) for t in times])
        )
        return int(np.argmin(diffs))

    # Prefer a stable "hour bucket" lookup:
    # For any minute within the hour, compute the irradiance for [hour, hour+1h] rather than using the nearest
    # timestamp. This avoids noon/afternoon artifacts when ssrd is already hourly-accumulated.
    hour0 = target.replace(minute=0, second=0, microsecond=0)
    hour1 = hour0 + timedelta(hours=1)
    idx0 = nearest_idx(hour0)
    idx1 = nearest_idx(hour1)
    if idx0 == idx1:
        # Fallback to the old behavior if the dataset cannot resolve the two endpoints.
        idx = nearest_idx(target)
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

    mode = _ERA5_SSRD_MODE_CACHE.get(file_path)
    if mode is None:
        try:
            series = ds["ssrd"].sel(latitude=lat, longitude=lon_norm, method="nearest").values
            values = np.array(series, dtype="float64").reshape(-1)
            values = values[np.isfinite(values)]
            if len(values) < 10:
                mode = "cumulative"
            else:
                diffs = np.diff(values)
                neg_ratio = float((diffs < -1e-3).sum()) / float(max(len(diffs), 1))
                mode = "incremental" if neg_ratio > 0.2 else "cumulative"
        except Exception:
            mode = "cumulative"
        _ERA5_SSRD_MODE_CACHE[file_path] = mode

    # ERA5 ssrd can appear in two common shapes depending on preprocessing:
    # - cumulative (monotonic within a reset window): use delta between endpoints
    # - incremental (hourly accumulation already): use the endpoint value (t1)
    if mode == "incremental":
        energy_jm2 = ssrd1
        energy_source = "ssrd(t1)"
    else:
        energy_jm2 = ssrd1 - ssrd0
        if energy_jm2 < 0:
            # Handle reset windows (e.g., forecast accumulation resets) robustly.
            energy_jm2 = ssrd1
            energy_source = "ssrd(t1) reset"
        else:
            energy_source = "ssrd(t1)-ssrd(t0)"

    irradiance = max(float(energy_jm2) / float(dt_seconds), 0.0)

    cloud_cover = clamp(point_tcc, 0.0, 1.0)
    return cloud_cover, irradiance, {
        "file": file_path,
        "engine": engine_used,
        "idx0": idx0,
        "idx1": idx1,
        "dt_seconds": dt_seconds,
        "time_var": time_var,
        "ssrd_mode": mode,
        "ssrd_energy": energy_source,
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


def _split_table_name(raw: str) -> Tuple[str, str]:
    value = str(raw or "").strip()
    if not value:
        raise ValueError("Missing PostGIS table name")
    parts = [part.strip() for part in value.split(".") if part.strip()]
    if len(parts) == 1:
        return ("public", parts[0])
    if len(parts) == 2:
        return (parts[0], parts[1])
    raise ValueError(f"Invalid PostGIS table name: {raw}")


def _quote_ident(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _qualified_ident(schema: str, table: str) -> str:
    return f"{_quote_ident(schema)}.{_quote_ident(table)}"


def _postgis_conn_key(worker: WorkerConfig) -> Tuple[Optional[str], Optional[str], Optional[int], Optional[str], Optional[str], Optional[str]]:
    return (
        worker.postgis_dsn,
        worker.postgis_host,
        worker.postgis_port,
        worker.postgis_database,
        worker.postgis_user,
        worker.postgis_password,
    )


def _connect_postgis(worker: WorkerConfig):
    key = _postgis_conn_key(worker)
    cached = _POSTGIS_CONNECTION_CACHE.get(key)
    if cached is not None and not getattr(cached, "closed", False):
        return cached

    connect_kwargs: Dict[str, Any] = {}
    if worker.postgis_host:
        connect_kwargs["host"] = worker.postgis_host
    if worker.postgis_port:
        connect_kwargs["port"] = int(worker.postgis_port)
    if worker.postgis_database:
        connect_kwargs["dbname"] = worker.postgis_database
    if worker.postgis_user:
        connect_kwargs["user"] = worker.postgis_user
    if worker.postgis_password:
        connect_kwargs["password"] = worker.postgis_password

    last_exc: Optional[Exception] = None
    if worker.postgis_dsn:
        try:
            import psycopg2  # type: ignore

            conn = psycopg2.connect(worker.postgis_dsn)
            _POSTGIS_CONNECTION_CACHE[key] = conn
            return conn
        except Exception as exc:
            last_exc = exc
        try:
            import psycopg  # type: ignore

            conn = psycopg.connect(worker.postgis_dsn)
            _POSTGIS_CONNECTION_CACHE[key] = conn
            return conn
        except Exception as exc:
            last_exc = exc
    else:
        try:
            import psycopg2  # type: ignore

            conn = psycopg2.connect(**connect_kwargs)
            _POSTGIS_CONNECTION_CACHE[key] = conn
            return conn
        except Exception as exc:
            last_exc = exc
        try:
            import psycopg  # type: ignore

            conn = psycopg.connect(**connect_kwargs)
            _POSTGIS_CONNECTION_CACHE[key] = conn
            return conn
        except Exception as exc:
            last_exc = exc

    raise RuntimeError(
        "Unable to connect to PostGIS. Install psycopg2-binary or psycopg, and verify PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD."
        f" last_error={last_exc}"
    )


def _get_postgis_columns(worker: WorkerConfig) -> Tuple[str, ...]:
    if not worker.postgis_table:
        raise RuntimeError("Missing PostGIS table: set --postgis-table or $MOBILITY_POSTGIS_TABLE")

    schema, table = _split_table_name(worker.postgis_table)
    cache_key = (_postgis_conn_key(worker), f"{schema}.{table}")
    cached = _POSTGIS_COLUMNS_CACHE.get(cache_key)
    if cached is not None:
        return cached

    conn = _connect_postgis(worker)
    query = (
        "SELECT column_name "
        "FROM information_schema.columns "
        "WHERE table_schema = %s AND table_name = %s"
    )
    with conn.cursor() as cur:
        cur.execute(query, (schema, table))
        rows = cur.fetchall()
    columns = tuple(str(row[0]) for row in rows)
    if not columns:
        raise RuntimeError(f"PostGIS table not found or has no visible columns: {schema}.{table}")
    _POSTGIS_COLUMNS_CACHE[cache_key] = columns
    return columns


def _select_postgis_columns(worker: WorkerConfig) -> List[str]:
    columns = set(_get_postgis_columns(worker))
    selected: List[str] = []

    height_candidates: List[str] = []
    if worker.postgis_height_column:
        height_candidates.append(worker.postgis_height_column)
    height_candidates.extend(["height", "HEIGHT", "height_mean", "levels", "height_m"])

    for candidate in height_candidates:
        if candidate and candidate in columns and candidate != worker.postgis_geom_column and candidate not in selected:
            selected.append(candidate)

    for candidate in ("tile_id", "region"):
        if candidate in columns and candidate != worker.postgis_geom_column and candidate not in selected:
            selected.append(candidate)

    return selected


def _load_buildings_postgis(bounds: Dict[str, float], worker: WorkerConfig):
    import geopandas as gpd

    if not worker.postgis_table:
        raise RuntimeError("Missing PostGIS table: set --postgis-table or $MOBILITY_POSTGIS_TABLE")

    schema, table = _split_table_name(worker.postgis_table)
    geom_column = worker.postgis_geom_column or "geom"
    columns = _get_postgis_columns(worker)
    if geom_column not in columns:
        raise RuntimeError(f"PostGIS geometry column not found: {schema}.{table}.{geom_column}")

    select_columns = _select_postgis_columns(worker)
    select_list = [f"ST_AsBinary({_quote_ident(geom_column)}) AS geom"]
    select_list.extend(_quote_ident(col) for col in select_columns)

    envelope_sql = "ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
    clauses = [
        f"{_quote_ident(geom_column)} IS NOT NULL",
        f"{_quote_ident(geom_column)} && {envelope_sql}",
        f"ST_Intersects({_quote_ident(geom_column)}, {envelope_sql})",
    ]
    params: List[Any] = [
        bounds["west"],
        bounds["south"],
        bounds["east"],
        bounds["north"],
        bounds["west"],
        bounds["south"],
        bounds["east"],
        bounds["north"],
    ]

    if worker.postgis_where:
        clauses.append(f"({worker.postgis_where})")

    sql_query = (
        f"SELECT {', '.join(select_list)} "
        f"FROM {_qualified_ident(schema, table)} "
        f"WHERE {' AND '.join(clauses)}"
    )
    if worker.max_features > 0:
        sql_query += " LIMIT %s"
        params.append(int(worker.max_features))

    conn = _connect_postgis(worker)
    gdf = gpd.read_postgis(sql_query, conn, geom_col="geom", params=params)
    if gdf.crs is None:
        try:
            gdf.set_crs(epsg=4326, inplace=True)
        except Exception:
            pass
    return gdf


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


def _bounds_diagonal_m(bounds: Mapping[str, float]) -> float:
    mean_lat = (float(bounds["north"]) + float(bounds["south"])) / 2.0
    lat_m = (float(bounds["north"]) - float(bounds["south"])) * 111_000.0
    lon_m = (float(bounds["east"]) - float(bounds["west"])) * 111_000.0 * math.cos(math.radians(mean_lat))
    return float(math.hypot(lat_m, lon_m))


def _load_buildings_preloaded_points(points: Sequence[BucketPoint], worker: WorkerConfig):
    import numpy as np

    buffer_m = float(worker.buildings_point_buffer_m)
    if buffer_m <= 0 or not points:
        key = (worker.buildings_path, worker.buildings_layer)
        if key not in _BUILDINGS_PRELOAD_CACHE:
            _preload_buildings(worker.buildings_path, worker.buildings_layer)
        return _BUILDINGS_PRELOAD_CACHE[key]["gdf"].iloc[0:0]

    key = (worker.buildings_path, worker.buildings_layer)
    if key not in _BUILDINGS_PRELOAD_CACHE:
        _preload_buildings(worker.buildings_path, worker.buildings_layer)
    cache = _BUILDINGS_PRELOAD_CACHE[key]
    gdf = cache["gdf"]

    minx = cache["minx"]
    miny = cache["miny"]
    maxx = cache["maxx"]
    maxy = cache["maxy"]

    deg_lat = buffer_m / 111_000.0
    mask_total = None
    for p in points:
        cos_lat = max(math.cos(math.radians(float(p.lat))), 1e-6)
        deg_lon = buffer_m / (111_000.0 * cos_lat)
        west = float(p.lon) - deg_lon
        east = float(p.lon) + deg_lon
        south = float(p.lat) - deg_lat
        north = float(p.lat) + deg_lat
        mask = (minx <= east) & (maxx >= west) & (miny <= north) & (maxy >= south)
        mask_total = mask if mask_total is None else (mask_total | mask)

    idx = np.nonzero(mask_total)[0] if mask_total is not None else np.array([], dtype=np.int64)
    subset = gdf.iloc[idx]
    if worker.max_features > 0 and len(subset) > worker.max_features:
        subset = subset.iloc[: worker.max_features]
    return subset


def _get_buildings(bounds: Dict[str, float], worker: WorkerConfig):
    if worker.buildings_source == "postgis":
        return _load_buildings_postgis(bounds, worker)
    if worker.buildings_mode == "preload":
        return _load_buildings_preloaded(bounds, worker.buildings_path, worker.max_features, worker.buildings_layer)
    return _load_buildings(bounds, worker.buildings_path, worker.max_features, worker.buildings_layer)


def _get_shadow_cache_entry(cache_key: Optional[str]) -> Optional[Dict[str, Any]]:
    if not cache_key:
        return None
    cached = _SHADOW_RESULT_CACHE.get(cache_key)
    if cached is not None:
        _SHADOW_RESULT_CACHE.move_to_end(cache_key)
    return cached


def _put_shadow_cache_entry(cache_key: Optional[str], entry: Dict[str, Any], max_entries: int) -> None:
    if not cache_key or max_entries == 0:
        return
    _SHADOW_RESULT_CACHE[cache_key] = entry
    _SHADOW_RESULT_CACHE.move_to_end(cache_key)
    while max_entries > 0 and len(_SHADOW_RESULT_CACHE) > max_entries:
        _SHADOW_RESULT_CACHE.popitem(last=False)


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
        sunlight_min = float(os.getenv("MOBILITY_SUNLIGHT_FACTOR_MIN", "0.15"))
        sunlight_coef = float(os.getenv("MOBILITY_SUNLIGHT_FACTOR_COEF", "0.85"))
        if sunlight_min < 0:
            sunlight_min = 0.0
        if sunlight_coef < 0:
            sunlight_coef = 0.0
        sunlight_factor_value = max(sunlight_min, 1.0 - cf * sunlight_coef)
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
                    file_index=point.file_index,
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
        from shapely.strtree import STRtree

        from engine_core import canopy_to_gdf, generate_shadows

        cache_entry = _get_shadow_cache_entry(job.shadow_cache_key)
        query_bounds = job.shadow_cache_bbox or job.bbox

        use_point_buffer = (
            cache_entry is None
            and job.worker.buildings_source == "file"
            and job.worker.buildings_mode == "preload"
            and float(job.worker.buildings_point_buffer_m) > 0.0
            and (
                float(job.worker.buildings_point_buffer_threshold_m) <= 0.0
                or _bounds_diagonal_m(query_bounds) >= float(job.worker.buildings_point_buffer_threshold_m)
            )
        )
        if cache_entry is None:
            buildings = (
                _load_buildings_preloaded_points(job.points, job.worker)
                if use_point_buffer
                else _get_buildings(query_bounds, job.worker)
            )

            if job.worker.include_canopy and job.worker.canopy_raster_path:
                canopy_path = job.worker.canopy_raster_path
                if os.path.exists(canopy_path):
                    canopy_ds = _open_canopy_dataset(canopy_path)
                    canopy_gdf = None
                    if use_point_buffer:
                        buffer_m = float(job.worker.buildings_point_buffer_m)
                        if buffer_m > 0:
                            parts: List[Any] = []
                            seen: set[Tuple[float, float]] = set()
                            deg_lat = buffer_m / 111_000.0
                            for bp in job.points:
                                key = (round(float(bp.lat), 3), round(float(bp.lon), 3))
                                if key in seen:
                                    continue
                                seen.add(key)
                                cos_lat = max(math.cos(math.radians(float(bp.lat))), 1e-6)
                                deg_lon = buffer_m / (111_000.0 * cos_lat)
                                bbox = {
                                    "west": float(bp.lon) - deg_lon,
                                    "east": float(bp.lon) + deg_lon,
                                    "south": float(bp.lat) - deg_lat,
                                    "north": float(bp.lat) + deg_lat,
                                }
                                part = canopy_to_gdf(canopy_ds, bbox)
                                if part is not None and not part.empty:
                                    parts.append(part)
                            if parts:
                                canopy_gdf = pd.concat(parts, ignore_index=True)
                    else:
                        canopy_gdf = canopy_to_gdf(canopy_ds, query_bounds)
                    if canopy_gdf is not None and not canopy_gdf.empty:
                        try:
                            if getattr(canopy_gdf, "crs", None) is None and getattr(buildings, "crs", None) is not None:
                                canopy_gdf = canopy_gdf.set_crs(buildings.crs, allow_override=True)
                        except Exception:
                            pass
                        buildings = pd.concat([buildings, canopy_gdf], ignore_index=True)
                else:
                    warnings.append(f"[Canopy] raster not found: {canopy_path}")

            if buildings.empty:
                cache_entry = {"mode": "empty", "geoms": [], "tree": None}
                _put_shadow_cache_entry(job.shadow_cache_key, cache_entry, int(job.worker.shadow_cache_max_entries))
            else:
                try:
                    shadows = generate_shadows(buildings, job.bucket_key, job.worker.timezone)
                except Exception as exc:
                    err_msg = str(exc)
                    if (
                        "Given time before sunrise or after sunset" in err_msg
                        or "outside daylight" in err_msg.lower()
                    ):
                        cache_entry = {"mode": "night", "geoms": [], "tree": None}
                        _put_shadow_cache_entry(
                            job.shadow_cache_key,
                            cache_entry,
                            int(job.worker.shadow_cache_max_entries),
                        )
                    else:
                        raise
                if cache_entry is None:
                    geoms = [g for g in shadows.geometry if g is not None and not g.is_empty] if not shadows.empty else []
                    cache_entry = {
                        "mode": "shadow",
                        "geoms": geoms,
                        "tree": STRtree(geoms) if geoms else None,
                    }
                    _put_shadow_cache_entry(job.shadow_cache_key, cache_entry, int(job.worker.shadow_cache_max_entries))

        if cache_entry is not None and cache_entry.get("mode") == "empty":
            updates: List[RowUpdate] = []
            for point in job.points:
                sunlit = 1
                shadow_percent = 0.0
                sunlit_effective = (
                    float(sunlit) if sunlight_factor_value is None else float(sunlit) * float(sunlight_factor_value)
                )
                shadow_percent_effective = 100.0 - sunlit_effective * 100.0
                irradiance_effective = None if solar_irradiance_value is None else float(solar_irradiance_value)
                updates.append(
                    RowUpdate(
                        index=point.index,
                        file_index=point.file_index,
                        values={
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
                        },
                    )
                )
            return BucketResult(bucket_key=job.bucket_key, row_updates=updates, warnings=warnings)

        if cache_entry is not None and cache_entry.get("mode") == "night":
            updates = []
            for point in job.points:
                updates.append(
                    RowUpdate(
                        index=point.index,
                        file_index=point.file_index,
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
                            "solarIrradianceWm2": 0.0,
                            "irradianceEffective": "",
                        },
                    )
                )
            return BucketResult(bucket_key=job.bucket_key, row_updates=updates, warnings=warnings)

        geoms = list(cache_entry.get("geoms") or []) if cache_entry is not None else []
        tree = cache_entry.get("tree") if cache_entry is not None else None

        updates: List[RowUpdate] = []
        for point in job.points:
            pt = Point(point.lon, point.lat)
            in_shadow = False
            if tree is not None:
                candidates = tree.query(pt)
                for cand in candidates:
                    geom = cand if hasattr(cand, "covers") else geoms[int(cand)]
                    if geom.covers(pt):
                        in_shadow = True
                        break

            shadow_percent = 100.0 if (geoms and in_shadow) else 0.0
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
            updates.append(RowUpdate(index=point.index, file_index=point.file_index, values=values))

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
                    file_index=point.file_index,
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
                file_index=point.file_index,
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


def _load_table(
    file_path: Path,
    file_index: int,
    total: int,
    config: Config,
) -> Optional[LoadedTable]:
    relative = os.path.relpath(file_path, config.input_root)
    out_dir = Path(config.output_root) / Path(relative).parent
    out_file = out_dir / f"{file_path.stem}-sunlight.csv"
    filter_buckets = read_buckets_from_file(config.buckets_file)

    if not config.force and not filter_buckets and out_file.exists():
        print(f"[Skip existing][{file_index + 1}/{total}] {relative}")
        return None

    headers, rows = read_csv_table(file_path)
    if not rows:
        print(f"[Skip][{file_index + 1}/{total}] {relative} empty file")
        return None

    if filter_buckets:
        existing_headers, existing_rows = seed_existing_output(rows, out_file)
        if existing_headers and existing_rows and len(existing_rows) == len(rows):
            for i in range(len(rows)):
                target = rows[i]
                old = existing_rows[i]
                for h in existing_headers:
                    target[h] = old.get(h, target.get(h, ""))
            print(f"[Seed existing][{file_index + 1}/{total}] {relative}")

    for row in rows:
        for key in HEADERS_TO_APPEND:
            if key not in row:
                row[key] = ""

    return LoadedTable(
        file_index=file_index,
        file_path=file_path,
        relative=relative,
        out_file=out_file,
        headers=list(headers),
        rows=rows,
        filter_buckets=filter_buckets,
    )


def _finalize_unprocessed_rows(rows: List[Dict[str, Any]]) -> None:
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


def _write_loaded_table(table: LoadedTable, config: Config, idx: int, total: int, started_at: float, bucket_count: int) -> None:
    _finalize_unprocessed_rows(table.rows)
    table.out_file.parent.mkdir(parents=True, exist_ok=True)
    final_headers = list(table.headers) + list(HEADERS_TO_APPEND)
    compute_duration_fields(table.headers, table.rows)
    write_csv(table.out_file, final_headers, table.rows)

    try:
        rel_out = str(table.out_file.relative_to(Path(config.output_root)))
    except Exception:
        rel_out = table.out_file.name

    elapsed_s = int(round(time.time() - started_at))
    print(f"[Done][{idx + 1}/{total}] {table.relative} -> {rel_out} ({elapsed_s}s) buckets={bucket_count}")


def _build_run_cell_jobs(tables: Sequence[LoadedTable], worker_cfg: WorkerConfig, config: Config) -> Tuple[List[BucketJob], Dict[int, int], int]:
    grouped: Dict[Tuple[str, int, int], List[BucketPoint]] = {}
    bucket_counts: Dict[int, int] = {}
    raw_bucket_count = 0
    shadow_stride = max(1, int(round(worker_cfg.shadow_cache_cell_size_m / config.cell_size_m))) if worker_cfg.shadow_cache_cell_size_m > 0 else 1

    for table in tables:
        buckets = build_buckets(table.rows, file_index=table.file_index)
        bucket_counts[table.file_index] = len(buckets)
        for bucket_key, points in buckets.items():
            if not points:
                continue
            if table.filter_buckets and normalize_bucket_key(bucket_key) not in table.filter_buckets:
                continue
            raw_bucket_count += 1
            for point in points:
                cell_x, cell_y = _mercator_cell_id(point.lat, point.lon, config.cell_size_m)
                grouped.setdefault((bucket_key, cell_x, cell_y), []).append(point)

    jobs: List[BucketJob] = []
    for (bucket_key, cell_x, cell_y), points in grouped.items():
        payload = build_bucket_payload(bucket_key, points, context_margin_m=config.cell_context_m)
        shadow_cell_x = math.floor(cell_x / shadow_stride)
        shadow_cell_y = math.floor(cell_y / shadow_stride)
        shadow_cache_key: Optional[str] = None
        shadow_cache_bbox: Optional[Dict[str, float]] = None
        if worker_cfg.shadow_cache_cell_size_m > 0:
            shadow_cache_key = (
                f"{bucket_key}|shadow-cell|{shadow_cell_x}|{shadow_cell_y}|"
                f"{int(round(worker_cfg.shadow_cache_cell_size_m))}|{int(round(config.cell_context_m))}"
            )
            shadow_bounds = _mercator_cell_bounds(
                shadow_cell_x,
                shadow_cell_y,
                worker_cfg.shadow_cache_cell_size_m,
            )
            shadow_cache_bbox = _expand_bounds_by_meters(shadow_bounds, config.cell_context_m)
        jobs.append(
            BucketJob(
                bucket_key=bucket_key,
                bbox=payload["bbox"],
                points=list(points),
                worker=worker_cfg,
                file_label=(
                    f"run-cell-minute[{bucket_key}|cell={cell_x},{cell_y}|"
                    f"shadow={shadow_cell_x},{shadow_cell_y}|points={len(points)}]"
                ),
                shadow_cache_key=shadow_cache_key,
                shadow_cache_bbox=shadow_cache_bbox,
                cell_x=cell_x,
                cell_y=cell_y,
                shadow_cell_x=shadow_cell_x,
                shadow_cell_y=shadow_cell_y,
            )
        )

    jobs.sort(
        key=lambda job: (
            job.bucket_key,
            job.shadow_cell_x if job.shadow_cell_x is not None else job.cell_x if job.cell_x is not None else 0,
            job.shadow_cell_y if job.shadow_cell_y is not None else job.cell_y if job.cell_y is not None else 0,
            job.cell_x if job.cell_x is not None else 0,
            job.cell_y if job.cell_y is not None else 0,
            job.file_label,
        )
    )
    return jobs, bucket_counts, raw_bucket_count


def process_files_run_cell_minute(
    files: Sequence[Path],
    config: Config,
    executor: Optional[ProcessPoolExecutor] = None,
) -> None:
    total = len(files)
    loaded_tables: List[LoadedTable] = []
    for idx, file_path in enumerate(files):
        loaded = _load_table(file_path, idx, total, config)
        if loaded is not None:
            loaded_tables.append(loaded)

    if not loaded_tables:
        print("All files completed.")
        return

    _validate_buildings_config(config)

    worker_cfg = WorkerConfig(
        buildings_source=config.buildings_source,
        buildings_path=config.buildings_path,
        buildings_layer=config.buildings_layer,
        buildings_mode=config.buildings_mode,
        buildings_point_buffer_m=float(config.buildings_point_buffer_m),
        buildings_point_buffer_threshold_m=float(config.buildings_point_buffer_threshold_m),
        postgis_dsn=config.postgis_dsn,
        postgis_host=config.postgis_host,
        postgis_port=config.postgis_port,
        postgis_database=config.postgis_database,
        postgis_user=config.postgis_user,
        postgis_password=config.postgis_password,
        postgis_table=config.postgis_table,
        postgis_geom_column=config.postgis_geom_column,
        postgis_height_column=config.postgis_height_column,
        postgis_where=config.postgis_where,
        canopy_raster_path=config.canopy_raster_path,
        include_canopy=config.include_canopy,
        timezone=config.timezone,
        max_features=config.max_features,
        era5_file_template=config.era5_file_template,
        era5_file_path=config.era5_file_path,
        shadow_cache_cell_size_m=config.shadow_cache_cell_size_m,
        shadow_cache_max_entries=config.shadow_cache_max_entries,
    )

    jobs, bucket_counts, raw_bucket_count = _build_run_cell_jobs(loaded_tables, worker_cfg, config)
    total_points = sum(len(job.points) for job in jobs)
    print(
        f"[Run cell-minute] files={len(loaded_tables)} "
        f"rawBuckets={raw_bucket_count} groupedJobs={len(jobs)} "
        f"cellSizeM={config.cell_size_m:.0f} contextM={config.cell_context_m:.0f} "
        f"shadowCacheCellM={worker_cfg.shadow_cache_cell_size_m:.0f}"
    )

    started_at = time.time()
    completed_jobs = 0
    completed_points = 0
    last_progress = started_at
    progress_interval_s = max(0.0, float(config.progress_interval_s))
    progress_style = str(config.progress_style or "log")

    tables_by_index = {table.file_index: table for table in loaded_tables}

    for result in run_bucket_jobs(jobs, config.concurrency, executor=executor):
        completed_jobs += 1
        completed_points += len(result.row_updates)
        for warn in result.warnings:
            print(warn, file=sys.stderr)
        for update in result.row_updates:
            table = tables_by_index.get(update.file_index)
            if table is None:
                continue
            table.rows[update.index].update(update.values)

        now = time.time()
        should_report = (
            progress_interval_s > 0
            and (now - last_progress >= progress_interval_s or completed_jobs >= len(jobs))
            and len(jobs) > 0
        )
        if should_report:
            elapsed_s = max(0.001, now - started_at)
            rate = completed_jobs / elapsed_s
            remaining = max(0, len(jobs) - completed_jobs)
            eta_s = int(round(remaining / rate)) if rate > 0 else -1
            pct = (completed_jobs / len(jobs)) * 100.0
            line = (
                f"[Progress][run-cell-minute] jobs={completed_jobs}/{len(jobs)} ({pct:.1f}%) "
                f"points={completed_points}/{total_points} elapsed={int(round(elapsed_s))}s eta={eta_s}s"
            )
            if progress_style == "single":
                print(f"\r{line}", end="", flush=True)
            else:
                print(line, flush=True)
            last_progress = now

    if progress_style == "single" and len(jobs) > 0:
        print("", flush=True)

    for idx, table in enumerate(loaded_tables):
        table_started_at = started_at
        _write_loaded_table(
            table,
            config,
            idx=table.file_index,
            total=total,
            started_at=table_started_at,
            bucket_count=bucket_counts.get(table.file_index, 0),
        )


@dataclass
class Config:
    input_root: str
    output_root: str
    backend_url: str
    weather_url: str
    buildings_source: str
    buildings_path: str
    buildings_layer: Optional[str]
    buildings_mode: str
    buildings_point_buffer_m: float
    buildings_point_buffer_threshold_m: float
    postgis_dsn: Optional[str]
    postgis_host: Optional[str]
    postgis_port: Optional[int]
    postgis_database: Optional[str]
    postgis_user: Optional[str]
    postgis_password: Optional[str]
    postgis_table: Optional[str]
    postgis_geom_column: str
    postgis_height_column: Optional[str]
    postgis_where: Optional[str]
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
    grouping_mode: str
    cell_size_m: float
    cell_context_m: float
    shadow_cache_cell_size_m: float
    shadow_cache_max_entries: int


@dataclass
class LoadedTable:
    file_index: int
    file_path: Path
    relative: str
    out_file: Path
    headers: List[str]
    rows: List[Dict[str, Any]]
    filter_buckets: Optional[set[str]]


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
        "--buildings-source",
        dest="buildings_source",
        default=os.getenv("MOBILITY_BUILDINGS_SOURCE", "file"),
        choices=("file", "postgis"),
        help="Buildings source for the Python pipeline: local file or direct PostGIS.",
    )
    parser.add_argument(
        "--buildings",
        dest="buildings_path",
        default=os.getenv("BUILDING_LOCAL_GEOJSON", "") or os.getenv("ENGINE_BUILDING_LOCAL_GEOJSON", ""),
        help="Local buildings dataset (GPKG/GeoJSON) when --buildings-source=file.",
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
        help="Building query strategy for file mode: bbox (read window) or preload (load once in memory).",
    )
    parser.add_argument(
        "--postgis-dsn",
        dest="postgis_dsn",
        default=os.getenv("MOBILITY_POSTGIS_DSN", "") or os.getenv("POSTGIS_DSN", ""),
        help="Optional PostGIS DSN. If omitted, PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD are used.",
    )
    parser.add_argument(
        "--postgis-host",
        dest="postgis_host",
        default=os.getenv("MOBILITY_POSTGIS_HOST", "") or os.getenv("POSTGIS_HOST", "") or os.getenv("PGHOST", ""),
        help="PostGIS host. Defaults to $PGHOST.",
    )
    parser.add_argument(
        "--postgis-port",
        dest="postgis_port",
        default=os.getenv("MOBILITY_POSTGIS_PORT", "") or os.getenv("POSTGIS_PORT", "") or os.getenv("PGPORT", "5432"),
        help="PostGIS port. Defaults to $PGPORT or 5432.",
    )
    parser.add_argument(
        "--postgis-database",
        dest="postgis_database",
        default=os.getenv("MOBILITY_POSTGIS_DATABASE", "") or os.getenv("POSTGIS_DATABASE", "") or os.getenv("PGDATABASE", ""),
        help="PostGIS database name. Defaults to $PGDATABASE.",
    )
    parser.add_argument(
        "--postgis-user",
        dest="postgis_user",
        default=os.getenv("MOBILITY_POSTGIS_USER", "") or os.getenv("POSTGIS_USER", "") or os.getenv("PGUSER", ""),
        help="PostGIS user. Defaults to $PGUSER.",
    )
    parser.add_argument(
        "--postgis-password",
        dest="postgis_password",
        default=os.getenv("MOBILITY_POSTGIS_PASSWORD", "") or os.getenv("POSTGIS_PASSWORD", "") or os.getenv("PGPASSWORD", ""),
        help="PostGIS password. Defaults to $PGPASSWORD.",
    )
    parser.add_argument(
        "--postgis-table",
        dest="postgis_table",
        default=os.getenv("MOBILITY_POSTGIS_TABLE", "") or os.getenv("POSTGIS_TABLE", ""),
        help="PostGIS source table, for example public.buildings_us_lod1.",
    )
    parser.add_argument(
        "--postgis-geom-column",
        dest="postgis_geom_column",
        default=os.getenv("MOBILITY_POSTGIS_GEOM_COLUMN", "") or os.getenv("POSTGIS_GEOM_COLUMN", "geom"),
        help="Geometry column for the PostGIS source table.",
    )
    parser.add_argument(
        "--postgis-height-column",
        dest="postgis_height_column",
        default=os.getenv("MOBILITY_POSTGIS_HEIGHT_COLUMN", "") or os.getenv("POSTGIS_HEIGHT_COLUMN", ""),
        help="Optional preferred height column for PostGIS reads.",
    )
    parser.add_argument(
        "--postgis-where",
        dest="postgis_where",
        default=os.getenv("MOBILITY_POSTGIS_WHERE", "") or os.getenv("POSTGIS_WHERE", ""),
        help="Optional trusted SQL predicate appended to the PostGIS WHERE clause.",
    )
    parser.add_argument(
        "--buildings-point-buffer-m",
        dest="buildings_point_buffer_m",
        default=os.getenv("MOBILITY_BUILDINGS_POINT_BUFFER_M", "0"),
        help=(
            "Optional: in preload mode, select buildings by union of per-point buffers (meters). "
            "Useful when a 1-minute bucket has points scattered across the city."
        ),
    )
    parser.add_argument(
        "--buildings-point-buffer-threshold-m",
        dest="buildings_point_buffer_threshold_m",
        default=os.getenv("MOBILITY_BUILDINGS_POINT_BUFFER_THRESHOLD_M", "0"),
        help=(
            "Optional: only enable point-buffer selection when the bucket bbox diagonal >= this threshold (meters). "
            "0 disables threshold (always apply when buffer > 0)."
        ),
    )
    parser.add_argument(
        "--canopy",
        dest="canopy_raster_path",
        default=os.getenv("CANOPY_RASTER_PATH")
        or os.getenv("SHADOW_ENGINE_CANOPY_RASTER_PATH")
        or default_canopy,
        help="Canopy raster path (GeoTIFF).",
    )
    parser.add_argument(
        "--include-canopy",
        dest="include_canopy",
        nargs="?",
        const="true",
        default=os.getenv("MOBILITY_INCLUDE_CANOPY", "true"),
        help="Enable canopy raster contribution (true/false). Can be set via $MOBILITY_INCLUDE_CANOPY.",
    )
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
        default=(
            os.getenv("MOBILITY_PROGRESS_STYLE")
            or ("single" if sys.stdout.isatty() else "log")
        ),
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
    parser.add_argument(
        "--grouping-mode",
        dest="grouping_mode",
        default=os.getenv("MOBILITY_GROUPING_MODE", "file-minute"),
        choices=("file-minute", "run-cell-minute"),
        help=(
            "Job grouping strategy. "
            "file-minute preserves legacy per-file minute buckets; "
            "run-cell-minute groups points across the current run by minute and Web Mercator cell."
        ),
    )
    parser.add_argument(
        "--cell-size-m",
        dest="cell_size_m",
        default=os.getenv("MOBILITY_CELL_SIZE_M", "250"),
        help="Spatial cell size in meters for run-cell-minute grouping.",
    )
    parser.add_argument(
        "--cell-context-m",
        dest="cell_context_m",
        default=os.getenv("MOBILITY_CELL_CONTEXT_M", "1500"),
        help=(
            "Extra margin in meters added around each grouped cell-minute job "
            "to capture shadow casters outside the cell."
        ),
    )
    parser.add_argument(
        "--shadow-cache-cell-size-m",
        dest="shadow_cache_cell_size_m",
        default=os.getenv("MOBILITY_SHADOW_CACHE_CELL_SIZE_M", "0"),
        help=(
            "Optional larger cache cell size in meters. "
            "When > 0, adjacent run-cell-minute jobs within the same cache cell reuse one shadow result."
        ),
    )
    parser.add_argument(
        "--shadow-cache-max-entries",
        dest="shadow_cache_max_entries",
        default=os.getenv("MOBILITY_SHADOW_CACHE_MAX_ENTRIES", "128"),
        help="Per-worker LRU cache size for shadow results (0 disables caching).",
    )

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
    postgis_dsn = str(args.postgis_dsn).strip() or None
    postgis_host = str(args.postgis_host).strip() or None
    postgis_database = str(args.postgis_database).strip() or None
    postgis_user = str(args.postgis_user).strip() or None
    postgis_password = str(args.postgis_password).strip() or None
    postgis_table = str(args.postgis_table).strip() or None
    postgis_geom_column = str(args.postgis_geom_column).strip() or "geom"
    postgis_height_column = str(args.postgis_height_column).strip() or None
    postgis_where = str(args.postgis_where).strip() or None
    postgis_port_value = int(parse_float(args.postgis_port, 5432.0)) if str(args.postgis_port).strip() else None
    cell_size_m = max(1.0, parse_float(args.cell_size_m, 250.0))
    shadow_cache_cell_size_m = _normalize_shadow_cache_cell_size(
        cell_size_m,
        max(0.0, parse_float(args.shadow_cache_cell_size_m, 0.0)),
    )

    return Config(
        input_root=str(Path(args.input_root).resolve()),
        output_root=str(Path(args.output_root).resolve()),
        backend_url=str(args.backend_url).rstrip("/"),
        weather_url=str(args.weather_url).rstrip("/"),
        buildings_source=str(args.buildings_source),
        buildings_path=str(args.buildings_path),
        buildings_layer=str(args.buildings_layer).strip() or None,
        buildings_mode=str(args.buildings_mode),
        buildings_point_buffer_m=parse_float(args.buildings_point_buffer_m, 0.0),
        buildings_point_buffer_threshold_m=parse_float(args.buildings_point_buffer_threshold_m, 0.0),
        postgis_dsn=postgis_dsn,
        postgis_host=postgis_host,
        postgis_port=postgis_port_value,
        postgis_database=postgis_database,
        postgis_user=postgis_user,
        postgis_password=postgis_password,
        postgis_table=postgis_table,
        postgis_geom_column=postgis_geom_column,
        postgis_height_column=postgis_height_column,
        postgis_where=postgis_where,
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
        grouping_mode=str(args.grouping_mode),
        cell_size_m=cell_size_m,
        cell_context_m=max(0.0, parse_float(args.cell_context_m, 1500.0)),
        shadow_cache_cell_size_m=shadow_cache_cell_size_m,
        shadow_cache_max_entries=max(0, int(parse_float(args.shadow_cache_max_entries, 128.0))),
    )


def _validate_buildings_config(config: Config) -> None:
    if config.buildings_source == "file":
        if not config.buildings_path:
            raise SystemExit("Missing buildings path: set --buildings or $BUILDING_LOCAL_GEOJSON")
        return

    if config.buildings_mode == "preload":
        raise SystemExit("PostGIS buildings source does not support --buildings-mode preload; use --buildings-mode bbox")
    if not config.postgis_table:
        raise SystemExit("Missing PostGIS table: set --postgis-table or $MOBILITY_POSTGIS_TABLE")
    if not (config.postgis_dsn or config.postgis_database or os.getenv("PGDATABASE")):
        raise SystemExit("Missing PostGIS database config: set --postgis-database, --postgis-dsn, or $PGDATABASE")


def _config_for_print(config: Config) -> Dict[str, Any]:
    payload = asdict(config)
    if payload.get("postgis_password"):
        payload["postgis_password"] = "***"
    if payload.get("postgis_dsn"):
        payload["postgis_dsn"] = "***"
    return payload


def process_file(
    file_path: Path,
    idx: int,
    total: int,
    config: Config,
    executor: Optional[ProcessPoolExecutor] = None,
) -> None:
    started_at = time.time()
    table = _load_table(file_path, idx, total, config)
    if table is None:
        return

    buckets = build_buckets(table.rows, file_index=0)
    jobs: List[BucketJob] = []

    _validate_buildings_config(config)

    worker_cfg = WorkerConfig(
        buildings_source=config.buildings_source,
        buildings_path=config.buildings_path,
        buildings_layer=config.buildings_layer,
        buildings_mode=config.buildings_mode,
        buildings_point_buffer_m=float(config.buildings_point_buffer_m),
        buildings_point_buffer_threshold_m=float(config.buildings_point_buffer_threshold_m),
        postgis_dsn=config.postgis_dsn,
        postgis_host=config.postgis_host,
        postgis_port=config.postgis_port,
        postgis_database=config.postgis_database,
        postgis_user=config.postgis_user,
        postgis_password=config.postgis_password,
        postgis_table=config.postgis_table,
        postgis_geom_column=config.postgis_geom_column,
        postgis_height_column=config.postgis_height_column,
        postgis_where=config.postgis_where,
        canopy_raster_path=config.canopy_raster_path,
        include_canopy=config.include_canopy,
        timezone=config.timezone,
        max_features=config.max_features,
        era5_file_template=config.era5_file_template,
        era5_file_path=config.era5_file_path,
        shadow_cache_cell_size_m=config.shadow_cache_cell_size_m,
        shadow_cache_max_entries=config.shadow_cache_max_entries,
    )

    for bucket_key, points in buckets.items():
        if not points:
            continue
        if table.filter_buckets and normalize_bucket_key(bucket_key) not in table.filter_buckets:
            continue
        payload = build_bucket_payload(bucket_key, points)
        jobs.append(
            BucketJob(
                bucket_key=bucket_key,
                bbox=payload["bbox"],
                points=list(points),
                worker=worker_cfg,
                file_label=table.relative,
            )
        )

    print(
        f"[Process][{idx + 1}/{total}] {table.relative} buckets={len(jobs)}"
        f"{' (filtered)' if table.filter_buckets else ''}"
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
            table.rows[update.index].update(update.values)
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
                f"[Progress][{idx + 1}/{total}] {table.relative}"
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
    _write_loaded_table(table, config, idx=idx, total=total, started_at=started_at, bucket_count=len(jobs))


def main(argv: Sequence[str]) -> int:
    config = parse_args(argv)
    print("Batch mobility shadow")
    if config.print_config:
        print(json.dumps(_config_for_print(config), indent=2))

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

    _validate_buildings_config(config)

    if config.buildings_source == "file" and config.buildings_mode == "preload":
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

        try:
            # IMPORTANT:
            # Preloading must happen in the parent process BEFORE creating the ProcessPoolExecutor.
            # When using fork, the worker processes inherit the preloaded in-memory cache.
            _preload_buildings(config.buildings_path, config.buildings_layer)
        except Exception as exc:
            print(f"[Fatal] Failed to preload buildings dataset: {exc}", file=sys.stderr)
            return 2

    mp_ctx = None
    if config.buildings_source == "file" and config.buildings_mode == "preload":
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
    max_restarts_per_file = max(0, int(float(os.getenv("MOBILITY_POOL_RESTARTS_PER_FILE", "1"))))
    backoff_workers = parse_bool(os.getenv("MOBILITY_POOL_RESTART_BACKOFF", "true"), default=True)

    current_workers = max(1, int(executor_kwargs.get("max_workers") or 1))

    def start_executor(workers: int) -> ProcessPoolExecutor:
        kwargs = dict(executor_kwargs)
        kwargs["max_workers"] = max(1, int(workers))
        return ProcessPoolExecutor(**kwargs)

    executor = start_executor(current_workers)
    try:
        if config.grouping_mode == "run-cell-minute":
            restarts = 0
            while True:
                try:
                    process_files_run_cell_minute(files, config, executor=executor)
                    break
                except BrokenProcessPool as exc:
                    restarts += 1
                    print(f"[Pool crash][run-cell-minute] {str(exc)[:200]}", file=sys.stderr)
                    try:
                        executor.shutdown(wait=False, cancel_futures=True)
                    except Exception:
                        pass

                    if restarts > max_restarts_per_file:
                        print("[Run crash] run-cell-minute: broken_process_pool", file=sys.stderr)
                        failures.extend(str(file_path) for file_path in files)
                        executor = start_executor(current_workers)
                        break

                    if backoff_workers and current_workers > 1:
                        current_workers = max(1, current_workers // 2)
                        print(f"[Pool] restarting with workers={current_workers}", file=sys.stderr)
                    executor = start_executor(current_workers)
                    continue
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    print(f"[Run crash] run-cell-minute: {str(exc)[:200]}", file=sys.stderr)
                    failures.extend(str(file_path) for file_path in files)
                    break
        else:
            for i, file_path in enumerate(files):
                rel = os.path.relpath(file_path, config.input_root)
                restarts = 0
                while True:
                    try:
                        process_file(file_path, i, total, config, executor=executor)
                        break
                    except BrokenProcessPool as exc:
                        restarts += 1
                        print(
                            f"[Pool crash][{i + 1}/{total}] {rel}: {str(exc)[:200]}",
                            file=sys.stderr,
                        )
                        try:
                            executor.shutdown(wait=False, cancel_futures=True)
                        except Exception:
                            pass

                        if restarts > max_restarts_per_file:
                            print(f"[File crash][{i + 1}/{total}] {rel}: broken_process_pool", file=sys.stderr)
                            failures.append(str(file_path))
                            executor = start_executor(current_workers)
                            break

                        if backoff_workers and current_workers > 1:
                            current_workers = max(1, current_workers // 2)
                            print(f"[Pool] restarting with workers={current_workers}", file=sys.stderr)
                        executor = start_executor(current_workers)
                        continue
                    except KeyboardInterrupt:
                        raise
                    except Exception as exc:
                        print(f"[File crash][{i + 1}/{total}] {rel}: {str(exc)[:200]}", file=sys.stderr)
                        failures.append(str(file_path))
                        break
    finally:
        try:
            executor.shutdown(cancel_futures=True)
        except Exception:
            pass

    print("All files completed.")
    if failures:
        print(f"[Summary] Failed files: {len(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
