#!/usr/bin/env python3
import sys
import json
from datetime import datetime, timedelta, timezone

import numpy as np
import xarray as xr


def open_ds(file_path: str):
    """尝试不同 engine 打开 NetCDF，返回 (dataset, engine)。"""
    engines = ["netcdf4", "h5netcdf", "scipy"]
    last_err = None
    for eng in engines:
        try:
            ds = xr.open_dataset(file_path, engine=eng)
            return ds, eng
        except Exception as exc:
            last_err = exc
            continue
    raise RuntimeError(f"open_failed: {last_err}")


def respond(obj, exit_code: int = 0):
    def convert(o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, dict):
            return {k: convert(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [convert(v) for v in o]
        return o

    print(json.dumps(convert(obj)))
    sys.exit(exit_code)


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        respond({"error": "invalid_input", "message": str(e)}, exit_code=1)

    file = req.get("file")
    lat = req.get("lat")
    lon = req.get("lon")
    iso_time = req.get("isoTime")
    if not file or iso_time is None or lat is None or lon is None:
        respond({"error": "missing_fields"}, exit_code=1)

    try:
        lat = float(lat)
        lon = float(lon)
        target = datetime.fromisoformat(str(iso_time).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception as e:
        respond({"error": "invalid_params", "message": str(e)}, exit_code=1)

    try:
        ds, engine_used = open_ds(file)
    except Exception as e:
        respond({"error": "open_failed", "message": str(e)}, exit_code=1)

    # 兼容 time 或 valid_time
    time_var = None
    for candidate in ("time", "valid_time"):
        if candidate in ds:
            time_var = candidate
            break
    if time_var is None:
        respond({"error": "missing_time_coord", "message": f"no time/valid_time in {list(ds.variables)}"}, exit_code=1)

    times = ds[time_var].values
    if len(times) < 2:
        respond({"error": "insufficient_time_steps"}, exit_code=1)

    # 处理经度 0-360
    lon_values = ds["longitude"].values
    if lon < 0 and lon_values.max() > 180:
        lon = (lon + 360) % 360

    def nearest_idx(dt: datetime) -> int:
        dt_naive = dt.replace(tzinfo=None)
        diffs = np.abs(
            np.array([(np.datetime64(dt_naive) - t).astype("timedelta64[s]").astype(int) for t in times])
        )
        return int(np.argmin(diffs))

    # Prefer hour bucket endpoints to avoid noon/afternoon artifacts.
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
        point_tcc = float(t1["tcc"].sel(latitude=lat, longitude=lon, method="nearest").values)
        ssrd0 = float(t0["ssrd"].sel(latitude=lat, longitude=lon, method="nearest").values)
        ssrd1 = float(t1["ssrd"].sel(latitude=lat, longitude=lon, method="nearest").values)
    except Exception as e:
        respond({"error": "variable_missing", "message": str(e)}, exit_code=1)

    time0 = np.datetime64(t0[time_var].values).astype("datetime64[s]").astype(int)
    time1 = np.datetime64(t1[time_var].values).astype("datetime64[s]").astype(int)
    dt = max(int(time1 - time0), 1)

    # Detect whether ssrd is cumulative or already hourly-accumulated (incremental).
    try:
        series = ds["ssrd"].sel(latitude=lat, longitude=lon, method="nearest").values
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

    if mode == "incremental":
        energy_jm2 = ssrd1
        energy_source = "ssrd(t1)"
    else:
        energy_jm2 = ssrd1 - ssrd0
        if energy_jm2 < 0:
            energy_jm2 = ssrd1
            energy_source = "ssrd(t1) reset"
        else:
            energy_source = "ssrd(t1)-ssrd(t0)"

    irradiance = max(float(energy_jm2) / float(dt), 0.0)

    out = {
        "cloudCover": max(min(point_tcc, 1.0), 0.0),
        "irradianceWm2": irradiance,
        "source": "era5_single",
        "details": {
            "file": file,
            "engine": engine_used,
            "idx0": int(idx0),
            "idx1": int(idx1),
            "dt_seconds": dt,
            "time_var": time_var,
            "ssrd_mode": mode,
            "ssrd_energy": energy_source,
        },
    }
    respond(out)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        respond({"error": "unknown_error", "message": str(e)}, exit_code=1)
