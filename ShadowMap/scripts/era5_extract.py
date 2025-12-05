#!/usr/bin/env python3
import sys
import json
from datetime import datetime, timedelta

import numpy as np
import xarray as xr

def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except Exception as e:
        print(f"{{\"error\":\"invalid_input\",\"message\":\"{e}\"}}")
        sys.exit(1)

    file = req.get("file")
    lat = float(req.get("lat"))
    lon = float(req.get("lon"))
    iso_time = req.get("isoTime")
    if not file or iso_time is None:
        print(json.dumps({"error": "missing_fields"}))
        sys.exit(1)

    try:
        target = datetime.fromisoformat(iso_time.replace("Z", "+00:00"))
    except Exception as e:
        print(json.dumps({"error": "invalid_time", "message": str(e)}))
        sys.exit(1)

    ds = xr.open_dataset(file)
    # ERA5 使用经度 0-360，必要时转换
    lon_values = ds['longitude'].values
    if lon < 0 and lon_values.max() > 180:
        lon = (lon + 360) % 360

    # 取目标时间的最近两步做 ssrd 差分（小时数据）
    times = ds['time'].values
    if len(times) < 2:
        print(json.dumps({"error": "insufficient_time_steps"}))
        sys.exit(1)

    # 找到最近的时间索引
    time_diffs = np.abs(np.array([(np.datetime64(target) - t).astype('timedelta64[s]').astype(int) for t in times]))
    idx = int(np.argmin(time_diffs))

    # 确定差分的前后步
    if idx == 0:
        idx0, idx1 = 0, 1
    elif idx == len(times) - 1:
        idx0, idx1 = len(times) - 2, len(times) - 1
    else:
        idx0, idx1 = idx - 1, idx

    t0 = ds.isel(time=idx0)
    t1 = ds.isel(time=idx1)

    # 插值位置
    point_tcc = float(t1['tcc'].sel(latitude=lat, longitude=lon, method='nearest').values)
    ssrd0 = float(t0['ssrd'].sel(latitude=lat, longitude=lon, method='nearest').values)
    ssrd1 = float(t1['ssrd'].sel(latitude=lat, longitude=lon, method='nearest').values)

    # 计算时间差（秒）和辐照度（W/m2）
    time0 = np.datetime64(t0['time'].values).astype('datetime64[s]').astype(int)
    time1 = np.datetime64(t1['time'].values).astype('datetime64[s]').astype(int)
    dt = max(time1 - time0, 1)
    irradiance = max((ssrd1 - ssrd0) / dt, 0.0)

    out = {
        "cloudCover": max(min(point_tcc, 1.0), 0.0),
        "irradianceWm2": irradiance,
        "source": "era5_single",
        "details": {
          "file": file,
          "idx0": idx0,
          "idx1": idx1,
          "dt_seconds": dt
        }
    }
    print(json.dumps(out))

if __name__ == "__main__":
    main()
