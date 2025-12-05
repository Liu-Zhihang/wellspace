#!/usr/bin/env python3
#!/usr/bin/env python3
import sys
import json
from datetime import datetime

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


def respond(obj):
    print(json.dumps(obj))
    sys.exit(0)


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        respond({"error": "invalid_input", "message": str(e)})

    file = req.get("file")
    lat = req.get("lat")
    lon = req.get("lon")
    iso_time = req.get("isoTime")
    if not file or iso_time is None or lat is None or lon is None:
        respond({"error": "missing_fields"})

    try:
        lat = float(lat)
        lon = float(lon)
        target = datetime.fromisoformat(str(iso_time).replace("Z", "+00:00"))
    except Exception as e:
        respond({"error": "invalid_params", "message": str(e)})

    try:
        ds, engine_used = open_ds(file)
    except Exception as e:
        respond({"error": "open_failed", "message": str(e)})

    # 经度转换（如数据为 0-360）
    lon_values = ds["longitude"].values
    if lon < 0 and lon_values.max() > 180:
        lon = (lon + 360) % 360

    # 兼容不同时间维度命名（常见 time / valid_time）
    time_var = None
    for candidate in ("time", "valid_time"):
        if candidate in ds:
            time_var = candidate
            break
    if time_var is None:
        respond({"error": "missing_time_coord", "message": f"no time/valid_time in {list(ds.variables)}"})

    times = ds[time_var].values
    if len(times) < 2:
        respond({"error": "insufficient_time_steps"})

    # 最近时间步
    time_diffs = np.abs(np.array([(np.datetime64(target) - t).astype("timedelta64[s]").astype(int) for t in times]))
    idx = int(np.argmin(time_diffs))
    if idx == 0:
        idx0, idx1 = 0, 1
    elif idx == len(times) - 1:
        idx0, idx1 = len(times) - 2, len(times) - 1
    else:
        idx0, idx1 = idx - 1, idx

    t0 = ds.isel(time=idx0)
    t1 = ds.isel(time=idx1)

    # 插值取 tcc
    try:
        point_tcc = float(t1["tcc"].sel(latitude=lat, longitude=lon, method="nearest").values)
        ssrd0 = float(t0["ssrd"].sel(latitude=lat, longitude=lon, method="nearest").values)
        ssrd1 = float(t1["ssrd"].sel(latitude=lat, longitude=lon, method="nearest").values)
    except Exception as e:
        respond({"error": "variable_missing", "message": str(e)})

    time0 = np.datetime64(t0[time_var].values).astype("datetime64[s]").astype(int)
    time1 = np.datetime64(t1[time_var].values).astype("datetime64[s]").astype(int)
    dt = max(time1 - time0, 1)
    irradiance = max((ssrd1 - ssrd0) / dt, 0.0)

    out = {
        "cloudCover": max(min(point_tcc, 1.0), 0.0),
        "irradianceWm2": irradiance,
        "source": "era5_single",
        "details": {
            "file": file,
            "engine": engine_used,
            "idx0": idx0,
            "idx1": idx1,
            "dt_seconds": dt,
        },
    }
    respond(out)


if __name__ == "__main__":
    main()
