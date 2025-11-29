"""CLI bridge used by the Node backend to run pybdshadow locally.

The script expects a JSON payload on STDIN with the following structure:

{
  "bbox": {"west": ..., "south": ..., "east": ..., "north": ...},
  "timestamp": "2025-01-01T03:00:00",
  "timezone": "Asia/Hong_Kong",
  "backendUrl": "http://localhost:3500",
  "maxFeatures": 8000,
  "geometry": {... optional GeoJSON feature ...},
  "samples": {"grid": 6}
}
"""

from __future__ import annotations

import json
import math
import sys
import uuid
from dataclasses import asdict
from typing import Any, Dict, Iterable, List, Tuple

import geopandas as gpd
from shapely.geometry import Point, mapping, shape
from shapely.ops import unary_union

from engine_core import AnalysisInput, gdf_to_feature_collection, get_pybdshadow_version, run_analysis, calculate_shadow_coverage


def load_payload() -> Dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:  # pragma: no cover - runtime validation
        raise SystemExit(f"Invalid JSON payload: {exc}") from exc
    return payload


def normalize_geometry_obj(value: Any) -> Dict[str, Any] | None:
    if value is None:
        return None

    if isinstance(value, dict) and value.get("type") == "Feature":
        return value.get("geometry")

    if isinstance(value, dict) and value.get("type") == "FeatureCollection":
        geometries = []
        for feature in value.get("features", []):
            geom = feature.get("geometry")
            if geom:
                geometries.append(shape(geom))
        if not geometries:
            return None
        union = unary_union(geometries)
        return mapping(union)

    if isinstance(value, dict) and "type" in value and "coordinates" in value:
        return value

    raise ValueError("Unsupported geometry payload")


def validate_payload(payload: Dict[str, Any]) -> AnalysisInput:
    bbox = payload.get("bbox")
    if not bbox:
        raise SystemExit("Payload missing bbox")
    required = {"west", "south", "east", "north"}
    if not required.issubset(bbox):
        raise SystemExit("bbox must contain west/south/east/north")

    timestamp = payload.get("timestamp")
    if not timestamp:
        raise SystemExit("Payload missing timestamp")

    backend_url = payload.get("backendUrl") or "http://localhost:3500"
    timezone = payload.get("timezone") or "Asia/Hong_Kong"
    max_features = int(payload.get("maxFeatures") or 8000)
    geometry_obj = None
    if payload.get("geometry") is not None:
        geometry_obj = normalize_geometry_obj(payload["geometry"])

    return AnalysisInput(
        bbox={k: float(bbox[k]) for k in required},
        timestamp=str(timestamp),
        backend_url=str(backend_url),
        timezone=str(timezone),
        max_features=max_features,
        geometry=geometry_obj,
    )


def sample_points(
    bounds: Dict[str, float],
    grid: int,
) -> List[Tuple[float, float]]:
    grid = max(3, min(grid, 25))
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


def analyse_samples(shadow_gdf: gpd.GeoDataFrame, bounds: Dict[str, float], grid: int) -> Dict[str, Any]:
    points = sample_points(bounds, grid)
    if not points:
        return {
            "features": [],
            "metrics": {"sampleCount": 0, "avgShadowPercent": 0.0, "avgSunlightHours": 0.0},
        }

    union_geom = unary_union(shadow_gdf.geometry) if not shadow_gdf.empty else None
    features = []
    shadow_hits = 0
    hours_shadow = 3.0
    hours_sun = 10.0

    for lon, lat in points:
        point = Point(lon, lat)
        in_shadow = union_geom.contains(point) if union_geom else False
        shadow_hits += 1 if in_shadow else 0
        hours = hours_shadow if in_shadow else hours_sun
        shadow_percent = 85.0 if in_shadow else 5.0
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "hoursOfSun": hours,
                    "shadowPercent": shadow_percent,
                    "weight": max(0.1, min(hours / hours_sun, 1.0)),
                },
            }
        )

    avg_shadow = (shadow_hits / len(points)) * 100.0
    avg_sunlight = (
        ((shadow_hits * hours_shadow) + ((len(points) - shadow_hits) * hours_sun)) / len(points)
    )

    return {
        "features": features,
        "metrics": {
            "sampleCount": len(points),
            "avgShadowPercent": avg_shadow,
            "avgSunlightHours": avg_sunlight,
        },
    }


def make_heatmap(features: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    items = []
    for feature in features:
        items.append(
            {
                "type": "Feature",
                "geometry": feature["geometry"],
                "properties": {
                    "intensity": feature["properties"].get("hoursOfSun", 0),
                },
            }
        )
    return {"type": "FeatureCollection", "features": items}


def main() -> None:
    payload = load_payload()
    params = validate_payload(payload)
    grid = int(payload.get("samples", {}).get("grid") or 6)

    result = run_analysis(params)
    shadows_gdf = result["shadows"]
    buildings_gdf = result["buildings"]

    coverage_stats = calculate_shadow_coverage(params.bbox, shadows_gdf)

    samples = analyse_samples(shadows_gdf, params.bbox, grid)
    samples["metrics"]["avgShadowPercent"] = coverage_stats["coverage_percent"]
    sunlight_fc = {"type": "FeatureCollection", "features": samples["features"]}
    heatmap_fc = make_heatmap(samples["features"])

    response = {
        "requestId": f"pybdshadow-{uuid.uuid4().hex[:10]}",
        "data": {
            "shadows": gdf_to_feature_collection(shadows_gdf),
            "sunlight": sunlight_fc,
            "heatmap": heatmap_fc,
            "buildings": gdf_to_feature_collection(buildings_gdf),
        },
        "metrics": {
            "sampleCount": samples["metrics"]["sampleCount"],
            "avgShadowPercent": coverage_stats["coverage_percent"],
            "avgSunlightHours": samples["metrics"]["avgSunlightHours"],
            "engineLatencyMs": payload.get("profiling", {}).get("engineLatencyMs", 0),
            "engineVersion": get_pybdshadow_version(),
            "shadowAreaSqm": coverage_stats["shadow_area_sqm"],
            "bboxAreaSqm": coverage_stats["bbox_area_sqm"],
          "coverageSource": "area",
        },
        "metadata": {
            "timezone": params.timezone,
            "backendUrl": params.backend_url,
            "maxFeatures": params.max_features,
        },
    }

    json.dump(response, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - surfaced to Node process
        print(f"[shadow-engine-cli] {exc}", file=sys.stderr)
        sys.exit(1)
