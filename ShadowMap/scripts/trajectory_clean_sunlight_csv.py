#!/usr/bin/env python3

"""Trajectory continuity cleaning for `*-sunlight.csv` outputs (post-process).

Why
---
When GPS has severe jitter/teleportation, points can "jump" across the city,
causing sunlight/shadow to be computed at the wrong locations and inflating the
apparent outdoor time. Buffering building footprints is often questioned; this
script instead applies a reproducible *trajectory continuity* filter:

- Split by large time gaps.
- Drop "teleport" points above a speed threshold.
- Drop "return spikes" (A->B->A) where the middle point is implausible.
- Drop segments shorter than a minimum duration.

Mode
----
- flag: add columns (`trajKeep`, `trajReason`, ...) but keep original values.
- mask (default): for dropped rows, set `durationSeconds/sunlightSeconds/shadowSeconds/irradianceJ` to 0.
  For kept rows, recompute `durationSeconds` on the cleaned timeline and recompute derived seconds/J.

Optional
--------
If you also have a "no-canopy" run (buildings-only) with the same row order, you
can attach a few no-canopy exposure columns for comparison.
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple


def _env_float(name: str, default: float) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except Exception:
        return default


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except Exception:
        return default


def _format_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.replace("\r", " ").replace("\n", " ")
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return str(value)
    return str(value)


def _parse_bool(value: object, default: bool = False) -> bool:
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


def _is_stay_point(row: Dict[str, str]) -> bool:
    raw = (row.get("stay_status") or "").strip()
    if not raw:
        return False
    try:
        return float(raw) >= 1.0
    except Exception:
        return raw.lower() in {"1", "true", "yes", "y"}


def _coord_priority(env_name: str, default: str) -> list[str]:
    raw = (os.getenv(env_name) or default).strip()
    return [p.strip().lower() for p in raw.replace(";", ",").split(",") if p.strip()]


def pick_lon_lat(row: Dict[str, str]) -> Tuple[Optional[float], Optional[float], str]:
    # Default: use stay-point center when staying, otherwise fnl then gps.
    priority = _coord_priority("MOBILITY_CLEAN_COORD_PRIORITY", "stay_point,fnl,gps,gpx,air,lnglat")
    is_stay = _is_stay_point(row)

    sources: Dict[str, Tuple[str, str]] = {
        "stay_point": ("stay_point_x", "stay_point_y"),
        "fnl": ("fnl_lon", "fnl_lat"),
        "gps": ("gps_lon", "gps_lat"),
        "gpx": ("gpx_lon", "gpx_lat"),
        "air": ("air_lon", "air_lat"),
        "lnglat": ("lng", "lat"),
        "lonlat": ("lon", "lat"),
    }

    for src in priority:
        pair = sources.get(src)
        if not pair:
            continue
        if src == "stay_point" and not is_stay:
            continue
        lon_key, lat_key = pair
        lon_raw = (row.get(lon_key) or "").strip()
        lat_raw = (row.get(lat_key) or "").strip()
        if not lon_raw or not lat_raw:
            continue
        try:
            lon = float(lon_raw)
            lat = float(lat_raw)
        except Exception:
            continue
        if not (math.isfinite(lon) and math.isfinite(lat)):
            continue
        return lon, lat, src

    return None, None, ""


def parse_timestamp_s(row: Dict[str, str]) -> Optional[float]:
    for key in ("timestamp", "time"):
        raw = (row.get(key) or "").strip()
        if not raw:
            continue
        try:
            ts = float(raw)
            if math.isfinite(ts) and ts > 0:
                return ts
        except Exception:
            pass
        try:
            s = raw
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except Exception:
            continue

    bucket = (row.get("bucketStart") or "").strip()
    if bucket:
        try:
            s = bucket
            if s.endswith("Z"):
                s = s[:-1] + "+00:00"
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.timestamp()
        except Exception:
            return None
    return None


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = phi2 - phi1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2.0) ** 2
    return 2.0 * r * math.asin(math.sqrt(max(0.0, min(1.0, a))))


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else (hi if x > hi else x)


def iter_sunlight_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith("_")]
        for name in filenames:
            if name.lower().endswith("-sunlight.csv"):
                yield Path(dirpath) / name


def read_file_list(file_list: Path) -> list[str]:
    text = file_list.read_text(encoding="utf-8")
    out: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


@dataclass
class CleanResult:
    rows: int = 0
    kept: int = 0
    kept_seconds: float = 0.0
    dropped: int = 0
    dropped_seconds: float = 0.0
    stay_point: int = 0
    missing_coords: int = 0
    invalid_timestamp: int = 0
    jump_speed: int = 0
    spike_return: int = 0
    short_segment: int = 0
    warnings: int = 0


def _safe_float(raw: object) -> float:
    try:
        v = float(str(raw).strip())
        return v if math.isfinite(v) else 0.0
    except Exception:
        return 0.0


def _try_import_movingpandas() -> Optional[Tuple[Any, Any, Any, Any, Any]]:
    try:
        import pandas as pd  # type: ignore

        import geopandas as gpd  # type: ignore
        import movingpandas as mpd  # type: ignore
        from shapely.geometry import Point  # type: ignore

        from datetime import timedelta

        return mpd, gpd, pd, Point, timedelta
    except Exception:
        return None


def _compute_keep_mask(
    file_path: Path,
    *,
    keep_only_moving: bool,
    max_speed_kmh: float,
    max_gap_s: float,
    min_segment_s: float,
    spike_return_m: float,
    spike_distance_m: float,
) -> Tuple[list[bool], list[str], list[int], list[float], list[float]]:
    # Pass 1: read timestamps + coords only.
    ts: list[Optional[float]] = []
    lon: list[Optional[float]] = []
    lat: list[Optional[float]] = []
    dur_raw: list[float] = []
    is_stay: list[bool] = []
    reason: list[str] = []

    with file_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            t = parse_timestamp_s(row)
            x, y, _src = pick_lon_lat(row)
            ts.append(t)
            lon.append(x)
            lat.append(y)
            dur_raw.append(_safe_float(row.get("durationSeconds")))
            is_stay.append(_is_stay_point(row))
            if t is None:
                reason.append("invalid_timestamp")
            elif x is None or y is None:
                reason.append("missing_coords")
            else:
                reason.append("")

    n = len(ts)
    keep = [True] * n
    seg_id = [-1] * n
    speed_to_prev = [0.0] * n

    # Mark invalid upfront.
    for i in range(n):
        if reason[i]:
            keep[i] = False
        elif keep_only_moving and is_stay[i]:
            keep[i] = False
            reason[i] = "stay_point"

    valid_indices = [i for i in range(n) if keep[i]]
    valid_indices.sort(key=lambda i: float(ts[i] or 0.0))

    # Teleport detection (drop the later point).
    for pos in range(len(valid_indices) - 1):
        i = valid_indices[pos]
        j = valid_indices[pos + 1]
        t0 = float(ts[i] or 0.0)
        t1 = float(ts[j] or 0.0)
        dt = t1 - t0
        if dt <= 0 or dt > max_gap_s:
            continue
        d = haversine_m(float(lon[i]), float(lat[i]), float(lon[j]), float(lat[j]))
        sp = (d / dt) * 3.6 if dt > 0 else float("inf")
        speed_to_prev[j] = sp
        if sp > max_speed_kmh:
            keep[j] = False
            reason[j] = "jump_speed"

    # Spike return: A -> B -> A (middle point implausible).
    for pos in range(1, len(valid_indices) - 1):
        a = valid_indices[pos - 1]
        b = valid_indices[pos]
        c = valid_indices[pos + 1]
        if not keep[a] or not keep[b] or not keep[c]:
            continue
        ta = float(ts[a] or 0.0)
        tb = float(ts[b] or 0.0)
        tc = float(ts[c] or 0.0)
        dt1 = tb - ta
        dt2 = tc - tb
        if dt1 <= 0 or dt2 <= 0 or dt1 > max_gap_s or dt2 > max_gap_s:
            continue
        dab = haversine_m(float(lon[a]), float(lat[a]), float(lon[b]), float(lat[b]))
        dbc = haversine_m(float(lon[b]), float(lat[b]), float(lon[c]), float(lat[c]))
        dac = haversine_m(float(lon[a]), float(lat[a]), float(lon[c]), float(lat[c]))
        sp1 = (dab / dt1) * 3.6
        sp2 = (dbc / dt2) * 3.6
        if sp1 > max_speed_kmh and sp2 > max_speed_kmh and dac <= spike_return_m and dab >= spike_distance_m and dbc >= spike_distance_m:
            keep[b] = False
            reason[b] = "spike_return"

    # Build segments on remaining kept points; drop short segments.
    kept_sorted = [i for i in valid_indices if keep[i]]
    segments: list[list[int]] = []
    cur: list[int] = []
    for idx in kept_sorted:
        if not cur:
            cur = [idx]
            continue
        prev = cur[-1]
        dt = float(ts[idx] or 0.0) - float(ts[prev] or 0.0)
        if dt <= 0 or dt > max_gap_s:
            segments.append(cur)
            cur = [idx]
        else:
            cur.append(idx)
    if cur:
        segments.append(cur)

    # Recompute durations on cleaned timeline (per kept point).
    new_duration = [0.0] * n
    seg_counter = 0
    for seg in segments:
        if not seg:
            continue
        # Segment length in seconds.
        # keep_only_moving: use original per-row durations (avoid counting stop-time).
        if keep_only_moving:
            seg_len = 0.0
            for i in seg:
                seg_len += clamp(float(dur_raw[i] or 0.0), 0.0, 300.0)
        else:
            seg_len = 0.0
            for pos in range(len(seg) - 1):
                i = seg[pos]
                j = seg[pos + 1]
                dt = float(ts[j] or 0.0) - float(ts[i] or 0.0)
                if dt > 0:
                    seg_len += clamp(dt, 1.0, 300.0)
            seg_len += 60.0

        if seg_len < min_segment_s:
            for i in seg:
                keep[i] = False
                reason[i] = "short_segment"
            continue

        for pos in range(len(seg)):
            i = seg[pos]
            seg_id[i] = seg_counter
            if keep_only_moving:
                new_duration[i] = clamp(float(dur_raw[i] or 0.0), 0.0, 300.0)
            else:
                if pos + 1 < len(seg):
                    j = seg[pos + 1]
                    dt = float(ts[j] or 0.0) - float(ts[i] or 0.0)
                    new_duration[i] = clamp(dt, 1.0, 300.0) if dt > 0 else 60.0
                else:
                    new_duration[i] = 60.0
        seg_counter += 1

    return keep, reason, seg_id, new_duration, speed_to_prev


def _compute_keep_mask_movingpandas(
    file_path: Path,
    *,
    keep_only_moving: bool,
    max_speed_kmh: float,
    max_gap_s: float,
    min_segment_s: float,
    spike_return_m: float,
    spike_distance_m: float,
) -> Tuple[list[bool], list[str], list[int], list[float], list[float]]:
    """MovingPandas 后端（可选）。

    目标：用 MovingPandas 的标准工具完成“按 gap 分段 + 速度异常点剔除”，
    然后继续复用本脚本已有的 spike-return + 段长过滤 + duration 重算逻辑。

    如果运行环境缺少 movingpandas/geopandas/pandas/shapely，则自动回退到内置后端。
    """

    imported = _try_import_movingpandas()
    if imported is None:
        return _compute_keep_mask(
            file_path,
            keep_only_moving=keep_only_moving,
            max_speed_kmh=max_speed_kmh,
            max_gap_s=max_gap_s,
            min_segment_s=min_segment_s,
            spike_return_m=spike_return_m,
            spike_distance_m=spike_distance_m,
        )

    mpd, gpd, pd, Point, timedelta = imported

    # Pass 1: read timestamps + coords only.
    ts: list[Optional[float]] = []
    lon: list[Optional[float]] = []
    lat: list[Optional[float]] = []
    dur_raw: list[float] = []
    is_stay: list[bool] = []
    reason: list[str] = []

    with file_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            t = parse_timestamp_s(row)
            x, y, _src = pick_lon_lat(row)
            ts.append(t)
            lon.append(x)
            lat.append(y)
            dur_raw.append(_safe_float(row.get("durationSeconds")))
            is_stay.append(_is_stay_point(row))
            if t is None:
                reason.append("invalid_timestamp")
            elif x is None or y is None:
                reason.append("missing_coords")
            else:
                reason.append("")

    n = len(ts)
    keep = [True] * n
    seg_id = [-1] * n
    speed_to_prev = [0.0] * n

    # Mark invalid upfront.
    for i in range(n):
        if reason[i]:
            keep[i] = False
        elif keep_only_moving and is_stay[i]:
            keep[i] = False
            reason[i] = "stay_point"

    valid_indices = [i for i in range(n) if keep[i]]
    valid_indices.sort(key=lambda i: float(ts[i] or 0.0))
    if not valid_indices:
        return keep, reason, seg_id, [0.0] * n, speed_to_prev

    # Build GeoDataFrame required by MovingPandas (DatetimeIndex + geometry).
    rows = []
    for i in valid_indices:
        t = float(ts[i] or 0.0)
        try:
            dt = datetime.fromtimestamp(t, tz=timezone.utc)
        except Exception:
            keep[i] = False
            reason[i] = "invalid_timestamp"
            continue
        try:
            rows.append(
                {
                    "t": dt,
                    "orig_idx": int(i),
                    "geometry": Point(float(lon[i]), float(lat[i])),
                }
            )
        except Exception:
            keep[i] = False
            reason[i] = "missing_coords"

    if not rows:
        return keep, reason, seg_id, [0.0] * n, speed_to_prev

    df = pd.DataFrame(rows).set_index("t")
    gdf = gpd.GeoDataFrame(df, geometry="geometry", crs="EPSG:4326")

    def _iter_trajs(obj: object) -> list[Any]:
        if obj is None:
            return []
        if hasattr(obj, "trajectories"):
            try:
                return list(getattr(obj, "trajectories"))
            except Exception:
                pass
        if isinstance(obj, (list, tuple)):
            return list(obj)
        try:
            return list(obj)  # type: ignore[arg-type]
        except Exception:
            return [obj]

    try:
        traj = mpd.Trajectory(gdf, file_path.stem)
        split = mpd.ObservationGapSplitter(traj).split(gap=timedelta(seconds=max_gap_s))
        cleaned = mpd.OutlierCleaner(split).clean(v_max=max_speed_kmh, units=("km", "h"))
    except Exception:
        # MovingPandas 执行失败则回退到内置后端（避免跑到一半全崩）
        return _compute_keep_mask(
            file_path,
            keep_only_moving=keep_only_moving,
            max_speed_kmh=max_speed_kmh,
            max_gap_s=max_gap_s,
            min_segment_s=min_segment_s,
            spike_return_m=spike_return_m,
            spike_distance_m=spike_distance_m,
        )

    keep_set: set[int] = set()
    for t in _iter_trajs(cleaned):
        df2 = getattr(t, "df", None)
        if df2 is None:
            continue
        if "orig_idx" not in getattr(df2, "columns", []):
            continue
        for v in df2["orig_idx"].tolist():
            try:
                keep_set.add(int(v))
            except Exception:
                continue

    for i in valid_indices:
        if keep[i] and not reason[i] and int(i) not in keep_set:
            keep[i] = False
            reason[i] = "jump_speed"

    # --- Continue with the same post rules as builtin ---
    kept_sorted = [i for i in valid_indices if keep[i]]

    # Speed-to-prev diagnostics (only for kept points).
    for pos in range(len(kept_sorted) - 1):
        i = kept_sorted[pos]
        j = kept_sorted[pos + 1]
        t0 = float(ts[i] or 0.0)
        t1 = float(ts[j] or 0.0)
        dt = t1 - t0
        if dt <= 0 or dt > max_gap_s:
            continue
        d = haversine_m(float(lon[i]), float(lat[i]), float(lon[j]), float(lat[j]))
        sp = (d / dt) * 3.6 if dt > 0 else float("inf")
        speed_to_prev[j] = sp

    # Spike return: A -> B -> A (middle point implausible).
    for pos in range(1, len(kept_sorted) - 1):
        a = kept_sorted[pos - 1]
        b = kept_sorted[pos]
        c = kept_sorted[pos + 1]
        if not keep[a] or not keep[b] or not keep[c]:
            continue
        ta = float(ts[a] or 0.0)
        tb = float(ts[b] or 0.0)
        tc = float(ts[c] or 0.0)
        dt1 = tb - ta
        dt2 = tc - tb
        if dt1 <= 0 or dt2 <= 0 or dt1 > max_gap_s or dt2 > max_gap_s:
            continue
        dab = haversine_m(float(lon[a]), float(lat[a]), float(lon[b]), float(lat[b]))
        dbc = haversine_m(float(lon[b]), float(lat[b]), float(lon[c]), float(lat[c]))
        dac = haversine_m(float(lon[a]), float(lat[a]), float(lon[c]), float(lat[c]))
        sp1 = (dab / dt1) * 3.6
        sp2 = (dbc / dt2) * 3.6
        if (
            sp1 > max_speed_kmh
            and sp2 > max_speed_kmh
            and dac <= spike_return_m
            and dab >= spike_distance_m
            and dbc >= spike_distance_m
        ):
            keep[b] = False
            reason[b] = "spike_return"

    # Rebuild segments on remaining kept points; drop short segments.
    kept_sorted = [i for i in valid_indices if keep[i]]
    segments: list[list[int]] = []
    cur: list[int] = []
    for idx in kept_sorted:
        if not cur:
            cur = [idx]
            continue
        prev = cur[-1]
        dt = float(ts[idx] or 0.0) - float(ts[prev] or 0.0)
        if dt <= 0 or dt > max_gap_s:
            segments.append(cur)
            cur = [idx]
        else:
            cur.append(idx)
    if cur:
        segments.append(cur)

    new_duration = [0.0] * n
    seg_counter = 0
    for seg in segments:
        if not seg:
            continue
        if keep_only_moving:
            seg_len = 0.0
            for i in seg:
                seg_len += clamp(float(dur_raw[i] or 0.0), 0.0, 300.0)
        else:
            seg_len = 0.0
            for pos in range(len(seg) - 1):
                i = seg[pos]
                j = seg[pos + 1]
                dt = float(ts[j] or 0.0) - float(ts[i] or 0.0)
                if dt > 0:
                    seg_len += clamp(dt, 1.0, 300.0)
            seg_len += 60.0

        if seg_len < min_segment_s:
            for i in seg:
                keep[i] = False
                reason[i] = "short_segment"
            continue

        for pos in range(len(seg)):
            i = seg[pos]
            seg_id[i] = seg_counter
            if keep_only_moving:
                new_duration[i] = clamp(float(dur_raw[i] or 0.0), 0.0, 300.0)
            else:
                if pos + 1 < len(seg):
                    j = seg[pos + 1]
                    dt = float(ts[j] or 0.0) - float(ts[i] or 0.0)
                    new_duration[i] = clamp(dt, 1.0, 300.0) if dt > 0 else 60.0
                else:
                    new_duration[i] = 60.0
        seg_counter += 1

    return keep, reason, seg_id, new_duration, speed_to_prev


def _apply_mask(
    row: Dict[str, str],
    *,
    duration_s: float,
    has_no_canopy: bool,
    no_canopy_row: Optional[Dict[str, str]],
) -> None:
    row["durationSeconds"] = _format_cell(duration_s)

    sunlit_eff = _safe_float(row.get("sunlitEffective"))
    shadow_eff = _safe_float(row.get("shadowPercentEffective"))
    irr_eff = _safe_float(row.get("irradianceEffective"))

    row["sunlightSeconds"] = _format_cell(sunlit_eff * duration_s)
    row["shadowSeconds"] = _format_cell((shadow_eff / 100.0) * duration_s)
    row["irradianceJ"] = _format_cell(max(0.0, irr_eff) * duration_s) if duration_s > 0 else "0"

    if not has_no_canopy:
        return

    if no_canopy_row is None:
        row.setdefault("sunlitNoCanopy", "")
        row.setdefault("sunlitEffectiveNoCanopy", "")
        row.setdefault("sunlightSecondsNoCanopy", "")
        row.setdefault("irradianceJNoCanopy", "")
        row.setdefault("sunlightSecondsCanopyLoss", "")
        row.setdefault("irradianceJCanopyLoss", "")
        return

    sunlit_nc = (no_canopy_row.get("sunlit") or "").strip()
    row["sunlitNoCanopy"] = sunlit_nc
    sunlit_eff_nc = _safe_float(no_canopy_row.get("sunlitEffective"))
    row["sunlitEffectiveNoCanopy"] = _format_cell(sunlit_eff_nc)
    irr_eff_nc = _safe_float(no_canopy_row.get("irradianceEffective"))

    sec_nc = sunlit_eff_nc * duration_s
    j_nc = max(0.0, irr_eff_nc) * duration_s
    row["sunlightSecondsNoCanopy"] = _format_cell(sec_nc)
    row["irradianceJNoCanopy"] = _format_cell(j_nc)

    sec_on = _safe_float(row.get("sunlightSeconds"))
    j_on = _safe_float(row.get("irradianceJ"))
    row["sunlightSecondsCanopyLoss"] = _format_cell(max(0.0, sec_nc - sec_on))
    row["irradianceJCanopyLoss"] = _format_cell(max(0.0, j_nc - j_on))


def process_file(
    src: Path,
    dst: Path,
    *,
    mode: str,
    no_canopy_root: Optional[Path],
    backend: str,
    keep_only_moving: bool,
    max_speed_kmh: float,
    max_gap_s: float,
    min_segment_s: float,
    spike_return_m: float,
    spike_distance_m: float,
) -> CleanResult:
    if backend == "movingpandas":
        keep, reason, seg_id, new_duration, speed_to_prev = _compute_keep_mask_movingpandas(
            src,
            keep_only_moving=keep_only_moving,
            max_speed_kmh=max_speed_kmh,
            max_gap_s=max_gap_s,
            min_segment_s=min_segment_s,
            spike_return_m=spike_return_m,
            spike_distance_m=spike_distance_m,
        )
    else:
        keep, reason, seg_id, new_duration, speed_to_prev = _compute_keep_mask(
            src,
            keep_only_moving=keep_only_moving,
            max_speed_kmh=max_speed_kmh,
            max_gap_s=max_gap_s,
            min_segment_s=min_segment_s,
            spike_return_m=spike_return_m,
            spike_distance_m=spike_distance_m,
        )

    has_no_canopy = no_canopy_root is not None
    nc_path: Optional[Path] = None

    stats = CleanResult()
    stats.rows = len(keep)

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dst.with_name(f"{dst.name}.tmp.{os.getpid()}")

    no_canopy_reader = None
    no_canopy_fh = None

    if has_no_canopy and no_canopy_root is not None:
        try:
            rel2 = src.relative_to(Path(os.getenv("__CLEAN_ROOT__", src.parent)).resolve())
        except Exception:
            rel2 = None
        if rel2 is not None:
            candidate = no_canopy_root / rel2
            if candidate.exists():
                nc_path = candidate
        if nc_path is not None and nc_path.exists():
            try:
                no_canopy_fh = nc_path.open("r", encoding="utf-8", newline="")
                no_canopy_reader = csv.DictReader(no_canopy_fh)
            except Exception:
                stats.warnings += 1
                no_canopy_reader = None

    with src.open("r", encoding="utf-8", newline="") as in_fh, tmp_path.open(
        "w", encoding="utf-8", newline=""
    ) as out_fh:
        reader = csv.DictReader(in_fh)
        headers = list(reader.fieldnames or [])
        if not headers:
            return stats

        # Ensure essential fields exist in output.
        for k in ("durationSeconds", "sunlightSeconds", "shadowSeconds", "irradianceJ"):
            if k not in headers:
                headers.append(k)

        # Trajectory QC columns.
        for k in ("trajKeep", "trajReason", "trajSegId", "trajSpeedKmhToPrev"):
            if k not in headers:
                headers.append(k)

        # Optional no-canopy columns.
        if has_no_canopy:
            for k in (
                "sunlitNoCanopy",
                "sunlitEffectiveNoCanopy",
                "sunlightSecondsNoCanopy",
                "irradianceJNoCanopy",
                "sunlightSecondsCanopyLoss",
                "irradianceJCanopyLoss",
            ):
                if k not in headers:
                    headers.append(k)

        writer = csv.writer(out_fh, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
        writer.writerow(headers)

        for idx, row in enumerate(reader):
            orig_duration = _safe_float(row.get("durationSeconds"))
            ok = bool(keep[idx])
            row["trajKeep"] = "1" if ok else "0"
            row["trajReason"] = reason[idx] if not ok else ""
            row["trajSegId"] = "" if seg_id[idx] < 0 else str(seg_id[idx])
            row["trajSpeedKmhToPrev"] = _format_cell(speed_to_prev[idx]) if speed_to_prev[idx] > 0 else ""

            nc_row = None
            if has_no_canopy and no_canopy_reader is not None:
                try:
                    nc_row = next(no_canopy_reader)
                except Exception:
                    nc_row = None
                    no_canopy_reader = None
                    stats.warnings += 1

            duration_s = float(new_duration[idx]) if ok else 0.0

            if mode == "mask":
                _apply_mask(row, duration_s=duration_s, has_no_canopy=has_no_canopy, no_canopy_row=nc_row)
            else:
                # flag-only: still attach no-canopy values if available (no recompute).
                if has_no_canopy and nc_row is not None:
                    row["sunlitNoCanopy"] = (nc_row.get("sunlit") or "").strip()
                    row["sunlitEffectiveNoCanopy"] = (nc_row.get("sunlitEffective") or "").strip()
                    row["sunlightSecondsNoCanopy"] = (nc_row.get("sunlightSeconds") or "").strip()
                    row["irradianceJNoCanopy"] = (nc_row.get("irradianceJ") or "").strip()
                    try:
                        row["sunlightSecondsCanopyLoss"] = _format_cell(
                            max(0.0, _safe_float(row.get("sunlightSecondsNoCanopy")) - _safe_float(row.get("sunlightSeconds")))
                        )
                        row["irradianceJCanopyLoss"] = _format_cell(
                            max(0.0, _safe_float(row.get("irradianceJNoCanopy")) - _safe_float(row.get("irradianceJ")))
                        )
                    except Exception:
                        row["sunlightSecondsCanopyLoss"] = ""
                        row["irradianceJCanopyLoss"] = ""

            stats.kept += 1 if ok else 0
            stats.dropped += 0 if ok else 1
            if ok:
                stats.kept_seconds += duration_s
            else:
                stats.dropped_seconds += orig_duration
                if reason[idx] == "stay_point":
                    stats.stay_point += 1
                elif reason[idx] == "missing_coords":
                    stats.missing_coords += 1
                elif reason[idx] == "invalid_timestamp":
                    stats.invalid_timestamp += 1
                elif reason[idx] == "jump_speed":
                    stats.jump_speed += 1
                elif reason[idx] == "spike_return":
                    stats.spike_return += 1
                elif reason[idx] == "short_segment":
                    stats.short_segment += 1

            writer.writerow([_format_cell(row.get(h, "")) for h in headers])

    if no_canopy_fh is not None:
        try:
            no_canopy_fh.close()
        except Exception:
            pass

    os.replace(tmp_path, dst)
    return stats


def scan_file(
    src: Path,
    *,
    backend: str,
    keep_only_moving: bool,
    max_speed_kmh: float,
    max_gap_s: float,
    min_segment_s: float,
    spike_return_m: float,
    spike_distance_m: float,
) -> CleanResult:
    if backend == "movingpandas":
        keep, reason, _seg_id, new_duration, _speed_to_prev = _compute_keep_mask_movingpandas(
            src,
            keep_only_moving=keep_only_moving,
            max_speed_kmh=max_speed_kmh,
            max_gap_s=max_gap_s,
            min_segment_s=min_segment_s,
            spike_return_m=spike_return_m,
            spike_distance_m=spike_distance_m,
        )
    else:
        keep, reason, _seg_id, new_duration, _speed_to_prev = _compute_keep_mask(
            src,
            keep_only_moving=keep_only_moving,
            max_speed_kmh=max_speed_kmh,
            max_gap_s=max_gap_s,
            min_segment_s=min_segment_s,
            spike_return_m=spike_return_m,
            spike_distance_m=spike_distance_m,
        )
    st = CleanResult()
    st.rows = len(keep)
    for i in range(len(keep)):
        if keep[i]:
            st.kept += 1
            st.kept_seconds += float(new_duration[i])
            continue
        st.dropped += 1
        if reason[i] == "stay_point":
            st.stay_point += 1
        elif reason[i] == "missing_coords":
            st.missing_coords += 1
        elif reason[i] == "invalid_timestamp":
            st.invalid_timestamp += 1
        elif reason[i] == "jump_speed":
            st.jump_speed += 1
        elif reason[i] == "spike_return":
            st.spike_return += 1
        elif reason[i] == "short_segment":
            st.short_segment += 1
    return st


def _looks_processed(path: Path) -> bool:
    try:
        if not path.exists() or path.stat().st_size <= 0:
            return False
        with path.open("r", encoding="utf-8", newline="") as fh:
            header = fh.readline().strip("\r\n")
    except Exception:
        return False
    cols = [c.strip() for c in header.split(",") if c.strip()]
    return "trajKeep" in cols and "trajReason" in cols


def _run_one(
    src_path: str,
    dst_path: str,
    *,
    mode: str,
    no_canopy_root: Optional[str],
    backend: str,
    keep_only_moving: bool,
    max_speed_kmh: float,
    max_gap_s: float,
    min_segment_s: float,
    spike_return_m: float,
    spike_distance_m: float,
) -> CleanResult:
    src = Path(src_path)
    dst = Path(dst_path)
    nc_root = Path(no_canopy_root).expanduser().resolve() if no_canopy_root else None
    return process_file(
        src,
        dst,
        mode=mode,
        no_canopy_root=nc_root,
        backend=backend,
        keep_only_moving=keep_only_moving,
        max_speed_kmh=max_speed_kmh,
        max_gap_s=max_gap_s,
        min_segment_s=min_segment_s,
        spike_return_m=spike_return_m,
        spike_distance_m=spike_distance_m,
    )


def main(argv: Sequence[str]) -> int:
    p = argparse.ArgumentParser(description="Trajectory continuity cleaning for *-sunlight.csv outputs")
    p.add_argument("--root", required=True, help="Root directory containing *-sunlight.csv files")
    p.add_argument(
        "--backend",
        choices=("auto", "builtin", "movingpandas"),
        default="auto",
        help="Cleaning backend. auto: prefer movingpandas if available; builtin: no extra deps.",
    )
    p.add_argument(
        "--mode",
        choices=("mask", "flag"),
        default="mask",
        help="mask: zero out duration/exposure for dropped rows and recompute cleaned durations; flag: only add flags",
    )
    p.add_argument("--out-root", default="", help="Write to a new root (recommended). If omitted, requires --in-place.")
    p.add_argument("--in-place", action="store_true", help="Rewrite in place (no backup).")
    p.add_argument("--write", action="store_true", help="Actually write outputs. Default: dry-run stats only.")
    p.add_argument("--files-list", default="", help="Optional list of relative paths (relative to --root).")
    p.add_argument("--limit-files", type=int, default=0, help="Optional: stop after N files (0 = no limit).")
    p.add_argument("--workers", type=int, default=1, help="Parallel workers (file-level). Default: 1")
    p.add_argument(
        "--no-resume",
        action="store_true",
        help="Do not skip already-processed destination files (default: resume/skip when writing).",
    )
    p.add_argument(
        "--no-canopy-root",
        default="",
        help="Optional root of buildings-only (no canopy) *-sunlight.csv outputs (same relative paths).",
    )

    p.add_argument("--max-speed-kmh", type=float, default=_env_float("MOBILITY_CLEAN_MAX_SPEED_KMH", 200.0))
    p.add_argument("--max-gap-s", type=float, default=_env_float("MOBILITY_CLEAN_MAX_GAP_S", 600.0))
    p.add_argument("--min-segment-min", type=float, default=_env_float("MOBILITY_CLEAN_MIN_SEGMENT_MIN", 5.0))
    p.add_argument("--spike-return-m", type=float, default=_env_float("MOBILITY_CLEAN_SPIKE_RETURN_M", 50.0))
    p.add_argument("--spike-distance-m", type=float, default=_env_float("MOBILITY_CLEAN_SPIKE_DISTANCE_M", 200.0))
    p.add_argument(
        "--keep-only-moving",
        action="store_true",
        help="Drop stay points (stay_status>=1) and keep only continuous moving points. Durations are taken from the original file.",
    )

    args = p.parse_args(list(argv))

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    out_root_raw = str(args.out_root).strip()
    if args.write:
        if not out_root_raw and not args.in_place:
            print("[Fatal] When --write, provide --out-root or use --in-place.", file=sys.stderr)
            return 2
    out_root = Path(out_root_raw).expanduser().resolve() if out_root_raw else root

    no_canopy_root = (str(args.no_canopy_root).strip() or "")
    if no_canopy_root:
        nc = Path(no_canopy_root).expanduser().resolve()
        if not nc.exists():
            print(f"[Fatal] no-canopy root not found: {nc}", file=sys.stderr)
            return 2
        no_canopy_root = str(nc)

    if args.files_list:
        rels = read_file_list(Path(args.files_list).expanduser().resolve())
        files = [root / rel for rel in rels]
    else:
        files = list(iter_sunlight_files(root))

    if args.limit_files and int(args.limit_files) > 0:
        files = files[: int(args.limit_files)]

    if not files:
        print(f"[Fatal] no *-sunlight.csv files under {root}", file=sys.stderr)
        return 2

    workers = int(args.workers)
    if workers < 1:
        print("[Fatal] --workers must be >= 1", file=sys.stderr)
        return 2

    backend = str(args.backend).strip().lower()
    if backend == "auto":
        backend = "movingpandas" if _try_import_movingpandas() is not None else "builtin"
    if backend not in {"builtin", "movingpandas"}:
        backend = "builtin"

    max_speed_kmh = float(args.max_speed_kmh)
    max_gap_s = float(args.max_gap_s)
    min_segment_s = float(args.min_segment_min) * 60.0
    spike_return_m = float(args.spike_return_m)
    spike_distance_m = float(args.spike_distance_m)
    keep_only_moving = bool(args.keep_only_moving) or _parse_bool(os.getenv("MOBILITY_CLEAN_KEEP_ONLY_MOVING"), default=False)

    print(f"[Scan] files={len(files)} root={root}")
    print(
        f"[Config] backend={backend} mode={args.mode} write={bool(args.write)} out_root={out_root} in_place={bool(args.in_place)} "
        f"workers={workers} max_speed_kmh={max_speed_kmh:g} max_gap_s={max_gap_s:g} min_segment_min={float(args.min_segment_min):g} "
        f"spike_return_m={spike_return_m:g} spike_distance_m={spike_distance_m:g} "
        f"keep_only_moving={bool(keep_only_moving)} no_canopy_root={no_canopy_root or '(none)'}"
    )

    resume = bool(args.write) and (not bool(args.no_resume))
    skipped_existing = 0
    jobs: list[Tuple[str, str]] = []
    root_str = str(root)
    os.environ["__CLEAN_ROOT__"] = root_str

    for src in files:
        if not src.exists():
            continue
        try:
            rel = src.relative_to(root)
        except Exception:
            rel = Path(src.name)
        dst = (out_root / rel) if not args.in_place else src
        if resume and dst.exists() and _looks_processed(dst):
            skipped_existing += 1
            continue
        jobs.append((str(src), str(dst)))

    if skipped_existing:
        print(f"[Resume] skipped_existing={skipped_existing}")

    started = time.time()
    total_rows = total_kept = total_dropped = 0
    total_kept_s = 0.0
    total_dropped_s = 0.0
    reasons: Dict[str, int] = {
        "stay_point": 0,
        "missing_coords": 0,
        "invalid_timestamp": 0,
        "jump_speed": 0,
        "spike_return": 0,
        "short_segment": 0,
    }
    warnings = 0

    def accumulate(st: CleanResult) -> None:
        nonlocal total_rows, total_kept, total_dropped, total_kept_s, total_dropped_s, warnings
        total_rows += st.rows
        total_kept += st.kept
        total_dropped += st.dropped
        total_kept_s += st.kept_seconds
        total_dropped_s += st.dropped_seconds
        reasons["stay_point"] += st.stay_point
        reasons["missing_coords"] += st.missing_coords
        reasons["invalid_timestamp"] += st.invalid_timestamp
        reasons["jump_speed"] += st.jump_speed
        reasons["spike_return"] += st.spike_return
        reasons["short_segment"] += st.short_segment
        warnings += st.warnings

    completed = 0
    if workers == 1:
        for src_path, dst_path in jobs:
            if args.write:
                st = _run_one(
                    src_path,
                    dst_path,
                    mode=str(args.mode),
                    no_canopy_root=no_canopy_root or None,
                    backend=backend,
                    keep_only_moving=keep_only_moving,
                    max_speed_kmh=max_speed_kmh,
                    max_gap_s=max_gap_s,
                    min_segment_s=min_segment_s,
                    spike_return_m=spike_return_m,
                    spike_distance_m=spike_distance_m,
                )
            else:
                st = scan_file(
                    Path(src_path),
                    backend=backend,
                    keep_only_moving=keep_only_moving,
                    max_speed_kmh=max_speed_kmh,
                    max_gap_s=max_gap_s,
                    min_segment_s=min_segment_s,
                    spike_return_m=spike_return_m,
                    spike_distance_m=spike_distance_m,
                )
            accumulate(st)
            completed += 1
            if completed % 5 == 0 or completed == len(jobs):
                elapsed = int(round(time.time() - started))
                kept_min = total_kept_s / 60.0
                print(f"[Progress] {completed}/{len(jobs)} rows={total_rows} kept_rows={total_kept} kept_min={kept_min:.1f} elapsed={elapsed}s")
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futures = []
            for src_path, dst_path in jobs:
                if args.write:
                    futures.append(
                        ex.submit(
                            _run_one,
                            src_path,
                            dst_path,
                            mode=str(args.mode),
                            no_canopy_root=no_canopy_root or None,
                            backend=backend,
                            keep_only_moving=keep_only_moving,
                            max_speed_kmh=max_speed_kmh,
                            max_gap_s=max_gap_s,
                            min_segment_s=min_segment_s,
                            spike_return_m=spike_return_m,
                            spike_distance_m=spike_distance_m,
                        )
                    )
                else:
                    futures.append(
                        ex.submit(
                            scan_file,
                            Path(src_path),
                            backend=backend,
                            keep_only_moving=keep_only_moving,
                            max_speed_kmh=max_speed_kmh,
                            max_gap_s=max_gap_s,
                            min_segment_s=min_segment_s,
                            spike_return_m=spike_return_m,
                            spike_distance_m=spike_distance_m,
                        )
                    )
            for fut in as_completed(futures):
                st = fut.result()
                accumulate(st)
                completed += 1
                if completed % 5 == 0 or completed == len(jobs):
                    elapsed = int(round(time.time() - started))
                    kept_min = total_kept_s / 60.0
                    print(f"[Progress] {completed}/{len(jobs)} rows={total_rows} kept_rows={total_kept} kept_min={kept_min:.1f} elapsed={elapsed}s")

    elapsed = int(round(time.time() - started))
    kept_min = total_kept_s / 60.0
    drop_ratio = 0.0 if total_rows <= 0 else (total_dropped / total_rows) * 100.0
    print(
        f"[Done] files={len(files)} processed={len(jobs)} skipped_existing={skipped_existing} rows={total_rows} "
        f"kept_rows={total_kept} kept_min={kept_min:.1f} dropped_rows={total_dropped} ({drop_ratio:.2f}%) "
        f"warnings={warnings} elapsed={elapsed}s"
    )
    print("[Reasons] " + " ".join(f"{k}={v}" for k, v in reasons.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
