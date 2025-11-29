"""FastAPI shadow engine service with process pool.

This service mirrors the CLI behaviour of ``service_cli.py`` but runs as a
long-lived HTTP server. It is intended to be pointed to by the Node backend via
``SHADOW_ENGINE_BASE_URL``. Each request is executed in a process pool to make
better use of multi-core hosts.

Environment variables:
  BACKEND_BASE_URL   URL for building fetches (default: http://localhost:3500)
  TIMEZONE           Timezone string (default: Asia/Hong_Kong)
  MAX_FEATURES       Max building features to load (default: 8000)
  WORKERS            Process pool size (default: CPU count)
  SAMPLE_GRID        Grid size for sunlight sampling (default: 6)

Run locally (example):
  uvicorn engine_server:app --host 0.0.0.0 --port 9000
"""

from __future__ import annotations

import os
import uuid
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from engine_core import (
    AnalysisInput,
    calculate_shadow_coverage,
    gdf_to_feature_collection,
    get_pybdshadow_version,
    run_analysis,
)
from service_cli import analyse_samples, make_heatmap  # reuse sampling helpers


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


DEFAULT_BACKEND = os.getenv("BACKEND_BASE_URL", "http://localhost:3500")
DEFAULT_TZ = os.getenv("TIMEZONE", "Asia/Hong_Kong")
DEFAULT_MAX_FEATURES = _env_int("MAX_FEATURES", 8000)
DEFAULT_GRID = _env_int("SAMPLE_GRID", 6)
POOL_SIZE = _env_int("WORKERS", os.cpu_count() or 4)


class BoundingBox(BaseModel):
    west: float
    south: float
    east: float
    north: float


class ShadowRequest(BaseModel):
    bbox: BoundingBox
    timestamp: str
    timezone: Optional[str] = Field(default=None)
    backendUrl: Optional[str] = Field(default=None, alias="backend_url")
    maxFeatures: Optional[int] = None
    outputs: Optional[Dict[str, bool]] = None
    geometry: Optional[Dict[str, Any]] = None
    samples: Optional[Dict[str, int]] = None


def _run_single(payload: ShadowRequest) -> Dict[str, Any]:
    params = AnalysisInput(
        bbox=payload.bbox.model_dump(),
        timestamp=payload.timestamp,
        backend_url=(payload.backendUrl or DEFAULT_BACKEND).rstrip("/"),
        timezone=payload.timezone or DEFAULT_TZ,
        max_features=payload.maxFeatures or DEFAULT_MAX_FEATURES,
        geometry=payload.geometry,
    )

    result = run_analysis(params)
    shadows_gdf = result["shadows"]
    buildings_gdf = result["buildings"]

    grid = payload.samples.get("grid") if payload.samples else None
    grid = grid or DEFAULT_GRID

    coverage_stats = calculate_shadow_coverage(params.bbox, shadows_gdf)
    samples = analyse_samples(shadows_gdf, params.bbox, grid)
    samples["metrics"]["avgShadowPercent"] = coverage_stats["coverage_percent"]
    sunlight_fc = {"type": "FeatureCollection", "features": samples["features"]}
    heatmap_fc = make_heatmap(samples["features"])

    return {
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
            "engineLatencyMs": 0,
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


app = FastAPI(title="PyShadow Engine", version=get_pybdshadow_version())
pool = ProcessPoolExecutor(max_workers=POOL_SIZE)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "engineVersion": get_pybdshadow_version(),
        "backend": DEFAULT_BACKEND,
        "timezone": DEFAULT_TZ,
        "workers": POOL_SIZE,
    }


@app.post("/shadow")
def shadow(payload: ShadowRequest) -> Dict[str, Any]:
    try:
        future = pool.submit(_run_single, payload)
        return future.result()
    except Exception as exc:  # pragma: no cover - surfaced to client
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.on_event("shutdown")
def shutdown_event() -> None:
    pool.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("engine_server:app", host="0.0.0.0", port=9000, reload=False)
