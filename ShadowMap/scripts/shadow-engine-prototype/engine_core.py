"""Reusable helpers for running pybdshadow analysis."""

from __future__ import annotations

import datetime as dt
import json
import os
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple
from zoneinfo import ZoneInfo

import geopandas as gpd
import pandas as pd
import numpy as np
import rasterio
from rasterio.features import shapes as rio_shapes
import requests
from shapely.geometry import shape, box, mapping, Point
from shapely.ops import unary_union

# Optional local buildings override (bypass HTTP)
ENGINE_BUILDING_LOCAL_GEOJSON = os.getenv("ENGINE_BUILDING_LOCAL_GEOJSON") or os.getenv(
    "BUILDING_LOCAL_GEOJSON"
)

_PYBDSHADOW_API: str | None = None
# Default canopy raster path (can be overridden by env or request metadata)
CANOPY_RASTER_PATH = (
    os.getenv("CANOPY_RASTER_PATH")
    or os.getenv("SHADOW_ENGINE_CANOPY_RASTER_PATH")
    or ""
)
# Minimum canopy height (meters) to consider
CANOPY_HEIGHT_THRESHOLD = float(os.getenv('CANOPY_HEIGHT_THRESHOLD', '1'))
try:  # pragma: no cover - handled at runtime
    import pybdshadow as _PYBDSHADOW_MODULE  # type: ignore
except ImportError as exc:
    _PYBDSHADOW_MODULE = None  # type: ignore
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None

try:  # pragma: no cover - handled at runtime
    from pybdshadow.shadow import sunlight_shadow  # type: ignore[attr-defined]
except ImportError as exc:
    fallback = getattr(_PYBDSHADOW_MODULE, "bdshadow_sunlight", None) if _PYBDSHADOW_MODULE else None
    if fallback is None:
        sunlight_shadow = None  # type: ignore
        _IMPORT_ERROR = _IMPORT_ERROR or exc
    else:
        sunlight_shadow = fallback  # type: ignore
        _PYBDSHADOW_API = "top_level"
else:
    _PYBDSHADOW_API = "submodule"


def _read_local_buildings(bounds: Mapping[str, float], local_path: str) -> Dict[str, Any]:
    """Read buildings from a local GeoJSON/GPKG and return FeatureCollection-like dict."""
    bbox = (bounds["west"], bounds["south"], bounds["east"], bounds["north"])
    gdf = gpd.read_file(local_path, bbox=bbox)
    features = json.loads(gdf.to_json()) if not gdf.empty else {"type": "FeatureCollection", "features": []}
    return {
        "type": "FeatureCollection",
        "features": features["features"] if isinstance(features, dict) else [],
        "metadata": {
            "source": "local-file",
            "totalFeatures": len(gdf),
            "numberReturned": len(gdf),
        },
    }


def fetch_buildings(bounds: Mapping[str, float], backend_url: str, max_features: int) -> Dict[str, Any]:
    # Prefer local override if provided
    if ENGINE_BUILDING_LOCAL_GEOJSON:
        return _read_local_buildings(bounds, ENGINE_BUILDING_LOCAL_GEOJSON)

    url = f"{backend_url.rstrip('/')}/api/buildings/bounds"
    payload = {**bounds, "maxFeatures": max_features}
    response = requests.post(url, json=payload, timeout=60)
    response.raise_for_status()
    data = response.json()
    if not data.get("success"):
        raise RuntimeError(f"Backend returned error: {data.get('message')}")
    return data["data"]


def extract_height(properties: Mapping[str, Any]) -> float:
    for key in ("height", "HEIGHT", "height_mean", "levels"):
        value = properties.get(key)
        if value is None:
            continue
        try:
            height = float(value)
        except (TypeError, ValueError):
            continue
        if key == "levels":
            return height * 3.5
        return height
    return 12.0


def features_to_gdf(features: Iterable[Dict[str, Any]]) -> gpd.GeoDataFrame:
    records: List[Dict[str, Any]] = []
    geometries = []
    for feature in features:
        geom = feature.get("geometry")
        if not geom:
            continue
        shapely_geom = shape(geom)
        props = feature.get("properties") or {}
        props = dict(props)
        props.setdefault("height_m", extract_height(props))
        records.append(props)
        geometries.append(shapely_geom)

    gdf = gpd.GeoDataFrame(records, geometry=geometries, crs="EPSG:4326")
    return gdf


def preprocess_buildings(buildings: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if buildings.crs is None:
        buildings = buildings.set_crs("EPSG:4326")
    elif buildings.crs.to_string() != "EPSG:4326":
        buildings = buildings.to_crs("EPSG:4326")

    buildings = buildings.copy()

    if "height" in buildings.columns:
        buildings["height"] = pd.to_numeric(buildings["height"], errors="coerce").fillna(12.0)
    else:
        height_series = None
        for candidate in ("height_m", "HEIGHT", "height_mean"):
            if candidate in buildings.columns:
                height_series = pd.to_numeric(buildings[candidate], errors="coerce")
                break

        if height_series is None and "levels" in buildings.columns:
            levels = pd.to_numeric(buildings["levels"], errors="coerce")
            height_series = levels * 3.5

        buildings["height"] = height_series.fillna(12.0) if height_series is not None else 12.0

    if _PYBDSHADOW_MODULE is not None and hasattr(_PYBDSHADOW_MODULE, "bd_preprocess"):
        return _PYBDSHADOW_MODULE.bd_preprocess(buildings, height="height")  # type: ignore[attr-defined]

    exploded = buildings.explode(index_parts=False, ignore_index=True)
    exploded = exploded[exploded.geometry.geom_type == "Polygon"].reset_index(drop=True)
    return exploded


def parse_timestamp(value: str) -> dt.datetime:
    # Accept ISO strings that end with 'Z'
    if value.endswith('Z'):
        value = value[:-1] + '+00:00'
    return dt.datetime.fromisoformat(value)


def generate_shadows(
    buildings: gpd.GeoDataFrame,
    timestamp: str,
    timezone: str,
    *,
    buildings_preprocessed: bool = False,
) -> gpd.GeoDataFrame:
    if sunlight_shadow is None or _PYBDSHADOW_API is None:
        raise RuntimeError(
            "pybdshadow is not installed. Install dependencies listed in requirements.txt"
        ) from _IMPORT_ERROR

    tzinfo = ZoneInfo(timezone)
    naive_dt = parse_timestamp(timestamp)
    if naive_dt.tzinfo is None:
        aware_dt = naive_dt.replace(tzinfo=tzinfo)
    else:
        aware_dt = naive_dt.astimezone(tzinfo)

    if not buildings_preprocessed:
        buildings = preprocess_buildings(buildings)

    if _PYBDSHADOW_API == "submodule":
        return sunlight_shadow(  # type: ignore[misc]
            building_gdf=buildings,
            timestamp=aware_dt,
            timezone=timezone,
            height_field="height",
        )

    utc_dt = aware_dt.astimezone(ZoneInfo("UTC"))
    return sunlight_shadow(buildings, utc_dt)  # type: ignore[call-arg]


def calculate_shadow_coverage(bounds: Dict[str, float], shadows: gpd.GeoDataFrame) -> Dict[str, float]:
    bbox_geom = box(bounds['west'], bounds['south'], bounds['east'], bounds['north'])
    bbox_series = gpd.GeoSeries([bbox_geom], crs="EPSG:4326").to_crs(3857)
    bbox_area = float(bbox_series.area.iloc[0]) if not bbox_series.empty else 0.0

    if bbox_area <= 0 or shadows.empty:
        return {
            'bbox_area_sqm': max(bbox_area, 0.0),
            'shadow_area_sqm': 0.0,
            'coverage_percent': 0.0,
        }

    union = unary_union(shadows.geometry)
    if union.is_empty:
        return {
            'bbox_area_sqm': bbox_area,
            'shadow_area_sqm': 0.0,
            'coverage_percent': 0.0,
        }

    clipped = union.intersection(bbox_geom)
    if clipped.is_empty:
        return {
            'bbox_area_sqm': bbox_area,
            'shadow_area_sqm': 0.0,
            'coverage_percent': 0.0,
        }

    shadow_series = gpd.GeoSeries([clipped], crs="EPSG:4326").to_crs(3857)
    shadow_area = float(shadow_series.area.iloc[0]) if not shadow_series.empty else 0.0
    coverage = 0.0 if bbox_area == 0 else max(0.0, min(100.0, (shadow_area / bbox_area) * 100.0))

    return {
        'bbox_area_sqm': bbox_area,
        'shadow_area_sqm': shadow_area,
        'coverage_percent': coverage,
    }


def gdf_to_feature_collection(gdf: gpd.GeoDataFrame) -> Dict[str, Any]:
    if gdf.empty:
        return {"type": "FeatureCollection", "features": []}
    raw = json.loads(gdf.to_json())
    return raw


def sample_grid(bounds: Dict[str, float], grid: int) -> List[Tuple[float, float]]:
    grid = max(3, min(grid, 50))
    lon_span = bounds["east"] - bounds["west"]
    lat_span = bounds["north"] - bounds["south"]
    if lon_span <= 0 or lat_span <= 0:
        return []

    step_lon = lon_span / (grid + 1)
    step_lat = lat_span / (grid + 1)

    points: List[Tuple[float, float]] = []
    for i in range(1, grid + 1):
        for j in range(1, grid + 1):
            lon = bounds["west"] + step_lon * i
            lat = bounds["south"] + step_lat * j
            points.append((lon, lat))
    return points


def compute_sunlight_profile(
    buildings: gpd.GeoDataFrame,
    bounds: Dict[str, float],
    base_timestamp: str,
    timezone: str,
    grid: int = 8,
    time_steps: int = 12,
    step_minutes: int = 60,
) -> Dict[str, Any]:
    points = sample_grid(bounds, grid)
    if not points:
        return {
            "features": [],
            "metrics": {
                "sampleCount": 0,
                "avgSunlightHours": 0.0,
            },
        }

    if buildings.empty:
        # If no buildings, all points are in full sun for all steps
        total_minutes = time_steps * step_minutes
        features = []
        for (lon, lat) in points:
            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "hoursOfSun": total_minutes / 60.0,
                        "shadowPercent": 0.0,
                        "weight": 1.0,
                    },
                }
            )
        return {
            "features": features,
            "metrics": {
                "sampleCount": len(points),
                "avgSunlightHours": total_minutes / 60.0,
            },
        }

    time_steps = max(1, min(time_steps, 48))
    step_minutes = max(5, min(step_minutes, 180))

    base_dt = parse_timestamp(base_timestamp)
    tzinfo = ZoneInfo(timezone)
    if base_dt.tzinfo is None:
        base_dt = base_dt.replace(tzinfo=tzinfo)
    else:
        base_dt = base_dt.astimezone(tzinfo)

    total_minutes = time_steps * step_minutes
    sun_minutes = [0 for _ in points]

    preprocessed = preprocess_buildings(buildings)

    for step in range(time_steps):
        ts = base_dt + dt.timedelta(minutes=step * step_minutes)
        try:
            shadows_gdf = generate_shadows(preprocessed, ts.isoformat(), timezone, buildings_preprocessed=True)
        except Exception as exc:
            # If sun below horizon or pybdshadow fails, treat as no shadow (full sun) for this step
            if debug_canopy := os.getenv("DEBUG_CANOPY_LOG", "").lower() in ("1", "true", "yes"):
                print(f"[sun-profile] skip step {step} ({ts.isoformat()}): {exc}")
            for idx in range(len(points)):
                sun_minutes[idx] += step_minutes
            continue
        union = unary_union(shadows_gdf.geometry) if not shadows_gdf.empty else None
        for idx, (lon, lat) in enumerate(points):
            if union is None or union.is_empty:
                sun_minutes[idx] += step_minutes
            else:
                pt = Point(lon, lat)
                if not union.contains(pt):
                    sun_minutes[idx] += step_minutes

    features = []
    for (lon, lat), minutes in zip(points, sun_minutes):
        hours = minutes / 60.0
        shadow_percent = 100.0 - max(0.0, min(100.0, (minutes / total_minutes) * 100.0))
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "hoursOfSun": hours,
                    "shadowPercent": shadow_percent,
                    "weight": max(0.1, min(hours / (total_minutes / 60.0), 1.0)),
                },
            }
        )

    avg_sunlight_hours = sum(sun_minutes) / (len(points) * 60.0)

    return {
        "features": features,
        "metrics": {
            "sampleCount": len(points),
            "avgSunlightHours": avg_sunlight_hours,
        },
    }


def load_canopy_raster() -> Optional[rasterio.io.DatasetReader]:
    if not CANOPY_RASTER_PATH or not os.path.exists(CANOPY_RASTER_PATH):
        return None
    try:
        return rasterio.open(CANOPY_RASTER_PATH)
    except Exception as exc:  # pragma: no cover - runtime
        print(f"[canopy] Failed to open raster {CANOPY_RASTER_PATH}: {exc}")
        return None


def canopy_to_gdf(raster: rasterio.io.DatasetReader, bbox: Mapping[str, float]) -> gpd.GeoDataFrame:
    # Windowed read of canopy raster to the bbox.
    # Guardrails: cap the read size to avoid allocating huge arrays when a bucket bbox is very large
    # (e.g. points scattered across the city in the same minute).
    window = raster.window(bbox["west"], bbox["south"], bbox["east"], bbox["north"])
    if window.width <= 0 or window.height <= 0:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    try:
        import math
        from affine import Affine
        from rasterio.enums import Resampling
    except Exception:
        math = None  # type: ignore[assignment]

    width = int(math.ceil(float(window.width))) if math else int(float(window.width))
    height = int(math.ceil(float(window.height))) if math else int(float(window.height))
    if width <= 0 or height <= 0:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    max_pixels_raw = os.getenv("CANOPY_MAX_PIXELS", "1000000")
    try:
        max_pixels = int(float(max_pixels_raw))
    except Exception:
        max_pixels = 1_000_000

    out_width = width
    out_height = height
    window_transform = raster.window_transform(window)

    if max_pixels > 0 and width * height > max_pixels and not math:
        # Cannot downsample safely without Affine/Resampling helpers; skip canopy for this bbox.
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    if math and max_pixels > 0 and width * height > max_pixels:
        scale = math.sqrt((width * height) / float(max_pixels))
        out_width = max(1, int(math.ceil(width / scale)))
        out_height = max(1, int(math.ceil(height / scale)))
        window_transform = window_transform * Affine.scale(width / float(out_width), height / float(out_height))

    if out_width != width or out_height != height:
        try:
            data = raster.read(
                1,
                window=window,
                out_shape=(out_height, out_width),
                resampling=Resampling.nearest,
                boundless=True,
                fill_value=0,
            )
        except Exception:
            # Avoid a potentially huge fallback read; skip canopy for this bbox instead.
            return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    else:
        data = raster.read(1, window=window, boundless=True, fill_value=0)

    mask = data >= CANOPY_HEIGHT_THRESHOLD
    if not np.any(mask):
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    records: List[Dict[str, Any]] = []
    geoms: List[Any] = []
    for geom, val in rio_shapes(mask.astype(np.uint8), mask=mask, transform=window_transform):
        if not geom:
            continue
        geoms.append(shape(geom))
        records.append({"height": float(val)})

    if not geoms:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    canopy_crs = raster.crs or "EPSG:4326"
    gdf = gpd.GeoDataFrame(records, geometry=geoms, crs=canopy_crs)
    if gdf.crs and gdf.crs.to_string() != "EPSG:4326":
        gdf = gdf.to_crs("EPSG:4326")
    elif gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326", allow_override=True)
    return gdf


@dataclass
class AnalysisInput:
    bbox: Dict[str, float]
    timestamp: str
    backend_url: str
    timezone: str = "Asia/Hong_Kong"
    max_features: int = 8000
    geometry: Optional[Dict[str, Any]] = None
    canopy_raster_path: Optional[str] = None
    include_canopy: bool = True


def filter_buildings(buildings: gpd.GeoDataFrame, geometry: Optional[Dict[str, Any]]) -> gpd.GeoDataFrame:
    if geometry is None:
        return buildings
    geom = shape(geometry)
    if geom.is_empty:
        return buildings.iloc[0:0]
    return buildings[buildings.intersects(geom)]


def run_analysis(params: AnalysisInput) -> Dict[str, Any]:
    raw = fetch_buildings(params.bbox, params.backend_url, params.max_features)
    buildings_gdf = features_to_gdf(raw.get("features", []))
    if params.geometry:
        buildings_gdf = filter_buildings(buildings_gdf, params.geometry)
    debug_canopy = os.getenv("DEBUG_CANOPY_LOG", "").lower() in ("1", "true", "yes")
    if debug_canopy:
        print(f"[canopy-debug] buildings before canopy: {len(buildings_gdf)}")

    if params.include_canopy:
        canopy_ds = None
        try:
            if params.canopy_raster_path:
                canopy_ds = rasterio.open(params.canopy_raster_path)
            else:
                canopy_ds = load_canopy_raster()
        except Exception as exc:  # pragma: no cover
            print(f"[canopy] Failed to open raster: {exc}")
            canopy_ds = None

        canopy_gdf = canopy_to_gdf(canopy_ds, params.bbox) if canopy_ds else gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

        # Merge buildings and canopy (treat canopy as additional polygons with height)
        if canopy_gdf is not None and not canopy_gdf.empty:
            canopy_gdf = canopy_gdf.rename(columns={"height": "height"})
            buildings_gdf = pd.concat([buildings_gdf, canopy_gdf], ignore_index=True)
            if debug_canopy:
                print(f"[canopy-debug] canopy polygons: {len(canopy_gdf)}, merged total: {len(buildings_gdf)}")
        else:
            if debug_canopy:
                print("[canopy-debug] no canopy polygons merged (include_canopy enabled but none found)")
    else:
        if debug_canopy:
            print("[canopy-debug] include_canopy is False; skipping canopy merge")

    if buildings_gdf.empty:
        raise RuntimeError("No building features returned for the specified bounds/geometry")

    shadows_gdf = generate_shadows(buildings_gdf, params.timestamp, params.timezone)

    return {
        "buildings": buildings_gdf,
        "shadows": shadows_gdf,
    }


def get_pybdshadow_version() -> str:
    if _PYBDSHADOW_MODULE and hasattr(_PYBDSHADOW_MODULE, "__version__"):
        return str(getattr(_PYBDSHADOW_MODULE, "__version__"))
    return "unknown"
