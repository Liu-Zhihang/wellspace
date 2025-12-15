#!/usr/bin/env python3

"""Residence sunlight exposure (IRBM) - pure Python batch compute.

This script:
1) Infers a "home" coordinate from each individual's mobility CSV by selecting the
   dominant night-time (22:00-06:00, Asia/Hong_Kong) stay location.
2) For each local day present in the CSV, samples fixed hours (default 06:00-21:00)
   and computes buffer-level sunlight exposure metrics aligned with the RMBM schema.

It bypasses Node/HTTP/backend and uses local buildings/canopy + ERA5 on disk.
"""

from __future__ import annotations

import argparse
import csv
import math
import multiprocessing as mp
import os
import sys
import time
import warnings
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple
from zoneinfo import ZoneInfo


SCRIPT_DIR = Path(__file__).resolve().parent
ENGINE_PATH = SCRIPT_DIR / "shadow-engine-prototype"


def configure_runtime() -> None:
    # Performance: avoid BLAS oversubscription when using multiprocessing.
    for key in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(key, "1")

    suppress = parse_bool(os.getenv("IRBM_SUPPRESS_NOISY_WARNINGS", "true"), default=True)
    if not suppress:
        return

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


def isoformat_z(dt: datetime) -> str:
    dt_utc = dt.astimezone(timezone.utc)
    return dt_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def clamp(value: float, min_value: float, max_value: float) -> float:
    return min(max(value, min_value), max_value)


def pick_lon_lat(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    lon = row.get("fnl_lon") or row.get("gps_lon") or row.get("gpx_lon") or row.get("air_lon")
    lat = row.get("fnl_lat") or row.get("gps_lat") or row.get("gpx_lat") or row.get("air_lat")
    return lon, lat


def meters_to_bbox(lat: float, lon: float, radius_m: float) -> Dict[str, float]:
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    deg_lat = radius_m / 111_000.0
    deg_lon = radius_m / (111_000.0 * cos_lat)
    return {
        "west": lon - deg_lon,
        "east": lon + deg_lon,
        "south": lat - deg_lat,
        "north": lat + deg_lat,
    }


HOURS_FIXED_DEFAULT: List[int] = list(range(6, 22))  # 06..21
PERIODS: List[Tuple[str, Set[int]]] = [
    ("morning", set(range(6, 10))),
    ("midday", set(range(10, 14))),
    ("afternoon", set(range(14, 18))),
    ("evening", set(range(18, 22))),
]


@dataclass(frozen=True)
class HomeConfig:
    timezone: str
    grid_m: float
    max_gap_seconds: int


@dataclass(frozen=True)
class IrbmConfig:
    input_root: str
    output: str
    buffers_m: List[int]
    hours_local: List[int]
    solar_day: bool
    timezone: str
    era5_file_template: Optional[str]
    era5_file_path: Optional[str]
    night_irradiance_threshold: float
    buildings_path: str
    buildings_layer: Optional[str]
    buildings_mode: str
    max_features: int
    canopy_raster_path: Optional[str]
    include_canopy: bool
    home: HomeConfig
    include_home_coords: bool
    include_home_meta: bool


def _import_engine_core():
    if str(ENGINE_PATH) not in sys.path:
        sys.path.append(str(ENGINE_PATH))
    from engine_core import calculate_shadow_coverage, canopy_to_gdf, generate_shadows, preprocess_buildings

    return calculate_shadow_coverage, canopy_to_gdf, generate_shadows, preprocess_buildings


def _import_mobility_helpers():
    # Reuse stable, battle-tested helpers from mobility batch compute.
    from batch_mobility_shadow import _get_weather_cached, _load_buildings, _load_buildings_preloaded, _open_canopy_dataset, _preload_buildings

    return _get_weather_cached, _load_buildings, _load_buildings_preloaded, _open_canopy_dataset, _preload_buildings


def _iter_csv_rows(file_path: Path) -> Iterable[Dict[str, str]]:
    with file_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            yield {k: (v if v is not None else "") for k, v in row.items()}


def _is_night_local(dt_local: datetime) -> bool:
    h = dt_local.hour
    return h >= 22 or h < 6


def _build_cell_key_3857(lon: float, lat: float, grid_m: float, transformer) -> Tuple[int, int]:
    x, y = transformer.transform(lon, lat)
    return (int(math.floor(float(x) / grid_m)), int(math.floor(float(y) / grid_m)))


def extract_home_and_dates(file_path: Path, cfg: HomeConfig) -> Tuple[Tuple[float, float], List[date], Dict[str, Any]]:
    from pyproj import Transformer

    tz = ZoneInfo(cfg.timezone)
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    max_gap = max(int(cfg.max_gap_seconds), 1)

    # We keep two streams:
    # - all-night points (fallback)
    # - night points with stay_status==1 (preferred if the column exists and matches any rows)
    seconds_all: Dict[Tuple[int, int], float] = {}
    sum_lon_all: Dict[Tuple[int, int], float] = {}
    sum_lat_all: Dict[Tuple[int, int], float] = {}

    seconds_stay: Dict[Tuple[int, int], float] = {}
    sum_lon_stay: Dict[Tuple[int, int], float] = {}
    sum_lat_stay: Dict[Tuple[int, int], float] = {}

    dates: Set[date] = set()

    prev_ts: Optional[float] = None
    prev_all_cell: Optional[Tuple[int, int]] = None
    prev_all_lon: Optional[float] = None
    prev_all_lat: Optional[float] = None
    prev_stay_cell: Optional[Tuple[int, int]] = None
    prev_stay_lon: Optional[float] = None
    prev_stay_lat: Optional[float] = None

    saw_stay_status = False
    all_rows = 0
    night_rows = 0
    night_stay_rows = 0

    for row in _iter_csv_rows(file_path):
        all_rows += 1
        ts_raw = row.get("timestamp")
        if not ts_raw:
            continue
        try:
            ts = float(ts_raw)
        except Exception:
            continue
        if not math.isfinite(ts):
            continue

        if prev_ts is not None:
            dt = ts - prev_ts
            if dt < 0:
                dt = 0.0
            dt = min(dt, float(max_gap))

            if prev_all_cell is not None and prev_all_lon is not None and prev_all_lat is not None:
                seconds_all[prev_all_cell] = seconds_all.get(prev_all_cell, 0.0) + dt
                sum_lon_all[prev_all_cell] = sum_lon_all.get(prev_all_cell, 0.0) + prev_all_lon * dt
                sum_lat_all[prev_all_cell] = sum_lat_all.get(prev_all_cell, 0.0) + prev_all_lat * dt

            if prev_stay_cell is not None and prev_stay_lon is not None and prev_stay_lat is not None:
                seconds_stay[prev_stay_cell] = seconds_stay.get(prev_stay_cell, 0.0) + dt
                sum_lon_stay[prev_stay_cell] = sum_lon_stay.get(prev_stay_cell, 0.0) + prev_stay_lon * dt
                sum_lat_stay[prev_stay_cell] = sum_lat_stay.get(prev_stay_cell, 0.0) + prev_stay_lat * dt

        dt_utc = datetime.fromtimestamp(ts, tz=timezone.utc)
        dt_local = dt_utc.astimezone(tz)
        dates.add(dt_local.date())

        is_night = _is_night_local(dt_local)
        if not is_night:
            prev_all_cell = None
            prev_stay_cell = None
            prev_ts = ts
            continue

        night_rows += 1

        stay_status_raw = row.get("stay_status")
        if stay_status_raw is not None:
            saw_stay_status = True
        stay_status = parse_float(stay_status_raw, default=0.0)
        is_stay = stay_status >= 0.5 if stay_status_raw is not None else True

        lon = None
        lat = None

        spx = row.get("stay_point_x")
        spy = row.get("stay_point_y")
        if spx and spy:
            lon_val = parse_float(spx, default=math.nan)
            lat_val = parse_float(spy, default=math.nan)
            if math.isfinite(lon_val) and math.isfinite(lat_val):
                lon, lat = lon_val, lat_val

        if lon is None or lat is None:
            lon_raw, lat_raw = pick_lon_lat(row)
            lon_val = parse_float(lon_raw, default=math.nan)
            lat_val = parse_float(lat_raw, default=math.nan)
            if math.isfinite(lon_val) and math.isfinite(lat_val):
                lon, lat = lon_val, lat_val

        if lon is None or lat is None:
            prev_all_cell = None
            prev_stay_cell = None
            prev_ts = ts
            continue

        cell = _build_cell_key_3857(lon, lat, cfg.grid_m, transformer)
        prev_all_cell = cell
        prev_all_lon = lon
        prev_all_lat = lat

        if is_stay:
            night_stay_rows += 1
            prev_stay_cell = cell
            prev_stay_lon = lon
            prev_stay_lat = lat
        else:
            prev_stay_cell = None

        prev_ts = ts

    def pick_best(seconds_map, sum_lon_map, sum_lat_map) -> Optional[Tuple[float, float]]:
        if not seconds_map:
            return None
        best_cell = max(seconds_map.items(), key=lambda kv: kv[1])[0]
        total = seconds_map.get(best_cell, 0.0)
        if total <= 0:
            return None
        lon = sum_lon_map.get(best_cell, 0.0) / total
        lat = sum_lat_map.get(best_cell, 0.0) / total
        return (lat, lon)

    picked = pick_best(seconds_stay, sum_lon_stay, sum_lat_stay) if saw_stay_status else None
    if picked is None:
        picked = pick_best(seconds_all, sum_lon_all, sum_lat_all)
    if picked is None:
        raise RuntimeError("home_not_found: no valid night points found")

    meta = {
        "rows": all_rows,
        "night_rows": night_rows,
        "night_stay_rows": night_stay_rows,
        "saw_stay_status": saw_stay_status,
        "home_grid_m": cfg.grid_m,
        "home_max_gap_s": max_gap,
    }
    return (picked[0], picked[1]), sorted(dates), meta


def _hours_for_config(cfg: IrbmConfig) -> List[int]:
    if cfg.hours_local:
        return cfg.hours_local
    return HOURS_FIXED_DEFAULT


def _compute_one_file(file_path: str, file_id: str, cfg: IrbmConfig) -> List[Dict[str, Any]]:
    _get_weather_cached, _load_buildings, _load_buildings_preloaded, _open_canopy_dataset, _preload_buildings = _import_mobility_helpers()
    calculate_shadow_coverage, canopy_to_gdf, generate_shadows, preprocess_buildings = _import_engine_core()

    tz = ZoneInfo(cfg.timezone)

    home_lat, home_lon, meta = (0.0, 0.0, {})
    home, dates, meta = extract_home_and_dates(Path(file_path), cfg.home)
    home_lat, home_lon = home

    hours = _hours_for_config(cfg)
    results: List[Dict[str, Any]] = []

    for buffer_m in cfg.buffers_m:
        bbox = meters_to_bbox(home_lat, home_lon, float(buffer_m))

        buildings = (
            _load_buildings_preloaded(bbox, cfg.buildings_path, cfg.max_features, cfg.buildings_layer)
            if cfg.buildings_mode == "preload"
            else _load_buildings(bbox, cfg.buildings_path, cfg.max_features, cfg.buildings_layer)
        )

        if cfg.include_canopy and cfg.canopy_raster_path:
            canopy_path = cfg.canopy_raster_path
            if canopy_path and os.path.exists(canopy_path):
                canopy_ds = _open_canopy_dataset(canopy_path)
                canopy_gdf = canopy_to_gdf(canopy_ds, bbox)
                if canopy_gdf is not None and not canopy_gdf.empty:
                    import pandas as pd

                    buildings = pd.concat([buildings, canopy_gdf], ignore_index=True)

        if buildings.empty:
            # Treat missing buildings as full-sun for the bbox (still keep weather adjustments).
            buildings_preprocessed = None
        else:
            buildings_preprocessed = preprocess_buildings(buildings)

        for d in dates:
            sum_sun_eff_s = 0.0
            sum_sun_raw_s = 0.0
            sum_energy_j = 0.0
            n_samples = 0

            per_period = {name: {"sun_s": 0.0, "energy_j": 0.0} for name, _ in PERIODS}

            for hour in hours:
                local_dt = datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=tz)
                ts_iso = isoformat_z(local_dt)

                cloud_cover = None
                solar_irradiance = None
                sunlight_factor = 1.0
                try:
                    cloud_cover, solar_irradiance = _get_weather_cached(
                        home_lat,
                        home_lon,
                        ts_iso,
                        cfg.era5_file_template,
                        cfg.era5_file_path,
                    )
                    if cloud_cover is not None:
                        sunlight_factor = max(0.15, 1.0 - clamp(float(cloud_cover), 0.0, 1.0) * 0.85)
                except Exception:
                    cloud_cover = None
                    solar_irradiance = None
                    sunlight_factor = 1.0

                if solar_irradiance is not None and float(solar_irradiance) <= cfg.night_irradiance_threshold:
                    if cfg.solar_day:
                        continue
                    n_samples += 1
                    continue

                avg_shadow = 0.0
                if buildings_preprocessed is not None:
                    try:
                        shadows = generate_shadows(buildings_preprocessed, ts_iso, cfg.timezone, buildings_preprocessed=True)
                        avg_shadow = float(calculate_shadow_coverage(bbox, shadows)["coverage_percent"])
                        avg_shadow = clamp(avg_shadow, 0.0, 100.0)
                    except Exception as exc:
                        msg = str(exc)
                        expected = "sunrise" in msg.lower() or "sunset" in msg.lower() or "outside daylight" in msg.lower()
                        if expected:
                            if cfg.solar_day:
                                continue
                            n_samples += 1
                            continue
                        # Skip this hour on unexpected engine errors.
                        continue

                sunlit_raw = clamp(1.0 - avg_shadow / 100.0, 0.0, 1.0)
                sunlit_eff = sunlit_raw * sunlight_factor

                dt = 3600.0
                sum_sun_raw_s += sunlit_raw * dt
                sum_sun_eff_s += sunlit_eff * dt

                if solar_irradiance is not None:
                    sum_energy_j += max(0.0, float(solar_irradiance)) * sunlit_raw * dt

                for name, hours_set in PERIODS:
                    if hour in hours_set:
                        per_period[name]["sun_s"] += sunlit_eff * dt
                        if solar_irradiance is not None:
                            per_period[name]["energy_j"] += max(0.0, float(solar_irradiance)) * sunlit_raw * dt
                        break

                n_samples += 1

            mean_irr = (sum_energy_j / sum_sun_eff_s) if sum_sun_eff_s > 0 else ""
            row: Dict[str, Any] = {
                "ID": file_id,
                "date": f"{d.year:04d}-{d.month:02d}-{d.day:02d}",
                "buffer_m": buffer_m,
                "IRBM_sunlight_min": sum_sun_eff_s / 60.0,
                "IRBM_raw_sunlight_min": sum_sun_raw_s / 60.0,
                "IRBM_irradiance_kJ": sum_energy_j / 1000.0,
                "IRBM_mean_irradiance": mean_irr,
                "n_samples": n_samples,
            }

            for name, _hours in PERIODS:
                row[f"IRBM_{name}_min"] = per_period[name]["sun_s"] / 60.0
                row[f"IRBM_{name}_irradiance_kJ"] = per_period[name]["energy_j"] / 1000.0

            if cfg.include_home_coords:
                row["home_lat"] = home_lat
                row["home_lon"] = home_lon
            if cfg.include_home_meta:
                row["_home_meta_rows"] = meta.get("rows", "")
                row["_home_meta_night_rows"] = meta.get("night_rows", "")
                row["_home_meta_night_stay_rows"] = meta.get("night_stay_rows", "")
                row["_home_meta_grid_m"] = meta.get("home_grid_m", "")

            results.append(row)

    return results


def _load_targets(input_root: Path, targets_file: Optional[str]) -> List[Path]:
    if targets_file:
        p = Path(targets_file)
        lines = p.read_text(encoding="utf-8").splitlines()
        out: List[Path] = []
        for raw in lines:
            s = raw.strip()
            if not s:
                continue
            fp = Path(s)
            if not fp.is_absolute():
                fp = input_root / fp
            out.append(fp)
        return out
    return sorted(input_root.rglob("*.csv"))


def _read_existing_keys(output_path: Path) -> Set[Tuple[str, str, str]]:
    if not output_path.exists():
        return set()
    keys: Set[Tuple[str, str, str]] = set()
    with output_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid = (row.get("ID") or row.get("id") or "").strip()
            d = (row.get("date") or "").strip()
            b = (row.get("buffer_m") or "").strip()
            if rid and d and b:
                keys.add((rid, d, b))
    return keys


def _format_cell(value: Any) -> str:
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Residence sunlight exposure IRBM (pure Python).")
    parser.add_argument("--input-root", default=os.getenv("INPUT_ROOT", ""), help="Root directory of mobility CSV files.")
    parser.add_argument(
        "--output",
        default="",
        help="Output CSV path. Default: $OUTPUT_ROOT/IRBM_daily_all_buffers.csv (or ./IRBM_daily_all_buffers.csv).",
    )
    parser.add_argument("--targets-file", default="", help="Optional list of CSV paths (relative to input-root).")
    parser.add_argument("--buffers", default="200,100,500,1000", help="Comma-separated buffer radii in meters.")
    parser.add_argument("--timezone", default=os.getenv("SHADOW_ENGINE_TIMEZONE", "Asia/Hong_Kong"))
    parser.add_argument(
        "--hours",
        default="",
        help="Comma-separated local hours to sample (0-23). Default: 6..21. Ignored when --solar-day is true.",
    )
    parser.add_argument("--solar-day", default="false", help="If true, sample 0..23 and skip night hours by irradiance.")
    parser.add_argument("--concurrency", default=os.getenv("CONCURRENCY", "32"))
    parser.add_argument("--resume", default=os.getenv("IRBM_RESUME", "true"))

    parser.add_argument("--buildings", default=os.getenv("BUILDING_LOCAL_GEOJSON", ""))
    parser.add_argument("--buildings-layer", default=os.getenv("BUILDING_GPKG_LAYER", ""))
    parser.add_argument("--buildings-mode", default=os.getenv("MOBILITY_BUILDINGS_MODE", "preload"))
    parser.add_argument("--max-features", default=os.getenv("MOBILITY_MAX_FEATURES", "8000"))

    parser.add_argument("--era5-template", default=os.getenv("ERA5_FILE_TEMPLATE", ""))
    parser.add_argument("--era5-file", default=os.getenv("ERA5_FILE_PATH", ""))
    parser.add_argument("--night-irradiance-threshold", default=os.getenv("MOBILITY_NIGHT_IRRADIANCE_THRESHOLD", "1e-6"))

    parser.add_argument("--canopy", default=os.getenv("SHADOW_ENGINE_CANOPY_RASTER_PATH", ""))
    parser.add_argument("--include-canopy", default=os.getenv("MOBILITY_INCLUDE_CANOPY", "true"))

    parser.add_argument("--home-grid-m", default=os.getenv("IRBM_HOME_GRID_M", "100"))
    parser.add_argument("--home-max-gap-s", default=os.getenv("IRBM_HOME_MAX_GAP_S", "300"))
    parser.add_argument("--include-home-coords", default=os.getenv("IRBM_INCLUDE_HOME_COORDS", "false"))
    parser.add_argument("--include-home-meta", default=os.getenv("IRBM_INCLUDE_HOME_META", "false"))
    args = parser.parse_args()

    input_root = str(args.input_root).strip()
    if not input_root:
        print("[Fatal] missing --input-root (or $INPUT_ROOT).", file=sys.stderr)
        return 2

    buildings_path = str(args.buildings).strip()
    if not buildings_path:
        print("[Fatal] missing --buildings (or $BUILDING_LOCAL_GEOJSON).", file=sys.stderr)
        return 2
    if not Path(buildings_path).exists():
        print(f"[Fatal] buildings not found: {buildings_path}", file=sys.stderr)
        return 2

    output = str(args.output).strip()
    if not output:
        out_root = os.getenv("OUTPUT_ROOT", "").strip()
        output = str(Path(out_root) / "IRBM_daily_all_buffers.csv") if out_root else "IRBM_daily_all_buffers.csv"

    buffers = [int(v.strip()) for v in str(args.buffers).split(",") if v.strip().isdigit()]
    if not buffers:
        print("[Fatal] invalid --buffers", file=sys.stderr)
        return 2

    solar_day = parse_bool(args.solar_day, default=False)
    if solar_day:
        hours = list(range(0, 24))
    else:
        if str(args.hours).strip():
            raw = []
            for part in str(args.hours).split(","):
                part = part.strip()
                if not part:
                    continue
                try:
                    raw.append(int(part))
                except Exception:
                    continue
            hours = [h for h in raw if 0 <= h <= 23]
            if not hours:
                hours = HOURS_FIXED_DEFAULT
        else:
            hours = HOURS_FIXED_DEFAULT

    cfg = IrbmConfig(
        input_root=input_root,
        output=output,
        buffers_m=buffers,
        hours_local=hours,
        solar_day=solar_day,
        timezone=str(args.timezone),
        era5_file_template=str(args.era5_template).strip() or None,
        era5_file_path=str(args.era5_file).strip() or None,
        night_irradiance_threshold=float(args.night_irradiance_threshold),
        buildings_path=buildings_path,
        buildings_layer=str(args.buildings_layer).strip() or None,
        buildings_mode=str(args.buildings_mode).strip() or "preload",
        max_features=int(float(args.max_features)),
        canopy_raster_path=str(args.canopy).strip() or None,
        include_canopy=parse_bool(args.include_canopy, default=True),
        home=HomeConfig(
            timezone=str(args.timezone),
            grid_m=float(args.home_grid_m),
            max_gap_seconds=int(float(args.home_max_gap_s)),
        ),
        include_home_coords=parse_bool(args.include_home_coords, default=False),
        include_home_meta=parse_bool(args.include_home_meta, default=False),
    )

    try:
        concurrency = max(int(float(args.concurrency)), 1)
    except Exception:
        concurrency = 32

    resume = parse_bool(args.resume, default=True)

    input_root_path = Path(cfg.input_root)
    output_path = Path(cfg.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    targets = _load_targets(input_root_path, str(args.targets_file).strip() or None)
    if not targets:
        print(f"[Fatal] no targets found under {input_root_path}", file=sys.stderr)
        return 2

    existing = _read_existing_keys(output_path) if resume else set()

    # Preload buildings before forking so worker processes can inherit the cache (Linux/fork only).
    _get_weather_cached, _load_buildings, _load_buildings_preloaded, _open_canopy_dataset, _preload_buildings = _import_mobility_helpers()
    if cfg.buildings_mode == "preload":
        if sys.platform != "linux":
            print("[Warn] preload mode may not share memory on non-Linux platforms.", file=sys.stderr)
        _preload_buildings(cfg.buildings_path, cfg.buildings_layer)

    started = time.time()
    print("Residence IRBM (pure Python)")
    print(
        {
            "input_root": cfg.input_root,
            "output": str(output_path),
            "targets": len(targets),
            "buffers_m": cfg.buffers_m,
            "timezone": cfg.timezone,
            "solar_day": cfg.solar_day,
            "hours_local": cfg.hours_local if not cfg.solar_day else "0..23 (night skipped)",
            "concurrency": concurrency,
            "buildings": cfg.buildings_path,
            "buildings_layer": cfg.buildings_layer,
            "buildings_mode": cfg.buildings_mode,
            "include_canopy": cfg.include_canopy,
            "canopy": cfg.canopy_raster_path,
            "era5_template": cfg.era5_file_template,
            "resume": resume,
            "existing_keys": len(existing),
        }
    )

    headers = [
        "ID",
        "date",
        "buffer_m",
        "IRBM_sunlight_min",
        "IRBM_raw_sunlight_min",
        "IRBM_irradiance_kJ",
        "IRBM_mean_irradiance",
        "IRBM_morning_min",
        "IRBM_morning_irradiance_kJ",
        "IRBM_midday_min",
        "IRBM_midday_irradiance_kJ",
        "IRBM_afternoon_min",
        "IRBM_afternoon_irradiance_kJ",
        "IRBM_evening_min",
        "IRBM_evening_irradiance_kJ",
        "n_samples",
    ]
    if cfg.include_home_coords:
        headers += ["home_lat", "home_lon"]
    if cfg.include_home_meta:
        headers += [
            "_home_meta_rows",
            "_home_meta_night_rows",
            "_home_meta_night_stay_rows",
            "_home_meta_grid_m",
        ]

    write_header = not output_path.exists() or output_path.stat().st_size == 0
    out_f = output_path.open("a", encoding="utf-8", newline="")
    try:
        if write_header:
            out_f.write(",".join(headers) + "\n")
            out_f.flush()

        mp_ctx = None
        try:
            if "fork" in mp.get_all_start_methods():
                mp_ctx = mp.get_context("fork")
        except Exception:
            mp_ctx = None

        total = len(targets)
        submitted = 0
        completed = 0
        skipped = 0

        with ProcessPoolExecutor(max_workers=concurrency, mp_context=mp_ctx) as executor:
            futures = {}
            for t in targets:
                if not t.exists():
                    continue
                file_id = t.stem
                futures[executor.submit(_compute_one_file, str(t), file_id, cfg)] = (t, file_id)
                submitted += 1

            for future in as_completed(futures):
                t, file_id = futures[future]
                completed += 1
                if t.is_absolute():
                    try:
                        rel = str(t.relative_to(input_root_path))
                    except Exception:
                        rel = str(t)
                else:
                    rel = str(t)
                try:
                    rows = future.result()
                except Exception as exc:
                    print(f"[Fail][{completed}/{submitted}] {rel}: {exc}", file=sys.stderr)
                    continue

                wrote_any = False
                for row in rows:
                    key = (str(row.get("ID", "")), str(row.get("date", "")), str(row.get("buffer_m", "")))
                    if resume and key in existing:
                        skipped += 1
                        continue
                    existing.add(key)
                    line = ",".join(_format_cell(row.get(h, "")) for h in headers)
                    out_f.write(line + "\n")
                    wrote_any = True

                if wrote_any:
                    out_f.flush()

                elapsed = int(time.time() - started)
                print(f"[Done][{completed}/{submitted}] {rel} (elapsed={elapsed}s)")

        elapsed = int(time.time() - started)
        print(f"All completed. wrote_keys={len(existing)} skipped={skipped} elapsed={elapsed}s output={output_path}")
        return 0
    finally:
        out_f.close()


if __name__ == "__main__":
    raise SystemExit(main())
