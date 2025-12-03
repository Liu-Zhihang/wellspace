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
from shapely.geometry import shape, box, mapping
from shapely.ops import unary_union

_PYBDSHADOW_API: str | None = None
# Default canopy raster path (can be overridden by env or request metadata)
CANOPY_RASTER_PATH = os.getenv('CANOPY_RASTER_PATH', '/home/jinlin/data/HKtree_reprojected4326.tif')
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


def fetch_buildings(bounds: Mapping[str, float], backend_url: str, max_features: int) -> Dict[str, Any]:
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

    if "height" not in buildings.columns:
        buildings = buildings.copy()
        if "height_m" in buildings.columns:
            buildings["height"] = buildings["height_m"]
        else:
            buildings["height"] = 12.0

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


def generate_shadows(buildings: gpd.GeoDataFrame, timestamp: str, timezone: str) -> gpd.GeoDataFrame:
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


def load_canopy_raster() -> Optional[rasterio.io.DatasetReader]:
    if not CANOPY_RASTER_PATH or not os.path.exists(CANOPY_RASTER_PATH):
        return None
    try:
        return rasterio.open(CANOPY_RASTER_PATH)
    except Exception as exc:  # pragma: no cover - runtime
        print(f"[canopy] Failed to open raster {CANOPY_RASTER_PATH}: {exc}")
        return None


def canopy_to_gdf(raster: rasterio.io.DatasetReader, bbox: Mapping[str, float]) -> gpd.GeoDataFrame:
    # Windowed read of canopy raster to the bbox
    transform = raster.transform
    window = raster.window(bbox["west"], bbox["south"], bbox["east"], bbox["north"])
    if window.width <= 0 or window.height <= 0:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    data = raster.read(1, window=window, boundless=True, fill_value=0)
    # Mask values below threshold
    mask = data >= CANOPY_HEIGHT_THRESHOLD
    if not np.any(mask):
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    # Polygonize the canopy mask
    shapes_and_values: List[Tuple[dict, float]] = list(
        rio_shapes(
            data.astype(np.uint8),
            mask=mask,
            transform=raster.window_transform(window),
        )
    )

    if not shapes_and_values:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

    records = []
    geoms = []
    for geom, val in shapes_and_values:
        if not geom:
            continue
        geoms.append(shape(geom))
        records.append({"height": float(val)})

    gdf = gpd.GeoDataFrame(records, geometry=geoms, crs=raster.crs)
    if gdf.crs and gdf.crs.to_string() != "EPSG:4326":
        gdf = gdf.to_crs("EPSG:4326")
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
            print("[canopy-debug] no canopy polygons merged")

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
