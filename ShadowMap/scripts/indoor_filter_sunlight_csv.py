#!/usr/bin/env python3

"""Indoor filtering for `*-sunlight.csv` outputs (post-process, no re-compute).

Motivation
----------
Mobility sunlight outputs assume points are "outdoor ground points" by default.
If a large share of points are actually indoors (home/office), daily sunlight
exposure can be inflated.

This script marks points that fall inside building footprints (from a local
GPKG/GeoJSON) and optionally masks exposure fields to 0 for those rows.

Modes
-----
- flag: only adds `indoor` / `indoorReason` columns
- mask: (default) additionally sets sunlight-related fields to 0 when indoor

This is designed as a *post-processing* step: it does NOT rerun shadows/canopy
or weather, so it is much faster than a full recompute.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple


def pick_lon_lat(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    # Indoor filtering can be sensitive to GPS jitter; we support a configurable
    # coordinate priority (comma-separated sources).
    #
    # Default: use stay-point center when staying, otherwise `fnl_*` (legacy), then GPS.
    # Override with: `MOBILITY_INDOOR_COORD_PRIORITY="stay_point,fnl,gps,gpx,air"`, etc.
    raw = (os.getenv("MOBILITY_INDOOR_COORD_PRIORITY") or "stay_point,fnl,gps,gpx,air,lnglat").strip()
    priority = [p.strip().lower() for p in raw.replace(";", ",").split(",") if p.strip()]

    stay_raw = (row.get("stay_status") or "").strip()
    is_stay = False
    if stay_raw:
        try:
            is_stay = float(stay_raw) >= 1.0
        except Exception:
            is_stay = stay_raw.lower() in {"1", "true", "yes", "y"}

    sources: Dict[str, Tuple[str, str]] = {
        "stay_point": ("stay_point_x", "stay_point_y"),
        "gps": ("gps_lon", "gps_lat"),
        "fnl": ("fnl_lon", "fnl_lat"),
        "gpx": ("gpx_lon", "gpx_lat"),
        "air": ("air_lon", "air_lat"),
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


def iter_sunlight_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip internal task/log folders and backups
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


@dataclass
class FileStats:
    rows: int = 0
    indoor_rows: int = 0
    missing_coords: int = 0
    buildings_loaded: int = 0


def _load_buildings(buildings_path: str, layer: Optional[str], bbox: Tuple[float, float, float, float]):
    import geopandas as gpd

    if layer:
        gdf = gpd.read_file(buildings_path, bbox=bbox, layer=layer)
    else:
        gdf = gpd.read_file(buildings_path, bbox=bbox)
    return gdf


def _build_tree(buildings_gdf):
    from shapely.strtree import STRtree

    geoms = [g for g in buildings_gdf.geometry if g is not None and not g.is_empty]
    tree = STRtree(geoms) if geoms else None
    return tree, geoms


def _is_indoor(tree, geoms, pt) -> bool:
    if tree is None:
        return False
    candidates = tree.query(pt)
    for cand in candidates:
        geom = cand if hasattr(cand, "covers") else geoms[int(cand)]
        if geom.covers(pt):
            return True
    return False


def _compute_bounds(file_path: Path) -> Optional[Tuple[float, float, float, float]]:
    return _compute_bounds_limited(file_path, max_rows=0)


def _compute_bounds_limited(file_path: Path, *, max_rows: int) -> Optional[Tuple[float, float, float, float]]:
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    found = 0

    with file_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            lon_raw, lat_raw = pick_lon_lat(row)
            if not lon_raw or not lat_raw:
                continue
            try:
                lon = float(lon_raw)
                lat = float(lat_raw)
            except Exception:
                continue
            minx = min(minx, lon)
            maxx = max(maxx, lon)
            miny = min(miny, lat)
            maxy = max(maxy, lat)
            found += 1
            if max_rows > 0 and found >= max_rows:
                break

    if found == 0 or not (minx < float("inf") and miny < float("inf")):
        return None
    return (minx, miny, maxx, maxy)


def _mask_indoor_row(row: Dict[str, str]) -> None:
    row["sunlit"] = "0"
    row["shadowPercent"] = "100"
    row["sunlitEffective"] = "0"
    row["shadowPercentEffective"] = "100"
    row["irradianceEffective"] = "0"
    row["sunlightSeconds"] = "0"
    row["irradianceJ"] = "0"
    dur = (row.get("durationSeconds") or "").strip()
    row["shadowSeconds"] = dur if dur else "0"


def process_file(
    src: Path,
    dst: Path,
    *,
    buildings_path: str,
    buildings_layer: Optional[str],
    mode: str,
) -> FileStats:
    from shapely.geometry import Point

    stats = FileStats()
    bounds = _compute_bounds(src)
    if bounds is None:
        return stats

    buildings_gdf = _load_buildings(buildings_path, buildings_layer, bbox=bounds)
    stats.buildings_loaded = int(len(buildings_gdf))
    tree, geoms = _build_tree(buildings_gdf)

    coord_cache: Dict[Tuple[int, int], bool] = {}

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dst.with_name(f"{dst.name}.tmp.{os.getpid()}")

    with src.open("r", encoding="utf-8", newline="") as in_fh, tmp_path.open(
        "w", encoding="utf-8", newline=""
    ) as out_fh:
        reader = csv.DictReader(in_fh)
        headers = list(reader.fieldnames or [])
        if not headers:
            return stats

        if "indoor" not in headers:
            headers.append("indoor")
        if "indoorReason" not in headers:
            headers.append("indoorReason")

        writer = csv.writer(out_fh, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
        writer.writerow(headers)

        for row in reader:
            stats.rows += 1
            lon_raw, lat_raw = pick_lon_lat(row)
            if not lon_raw or not lat_raw:
                row["indoor"] = "0"
                row["indoorReason"] = ""
                stats.missing_coords += 1
                writer.writerow([_format_cell(row.get(h, "")) for h in headers])
                continue
            try:
                lon = float(lon_raw)
                lat = float(lat_raw)
            except Exception:
                row["indoor"] = "0"
                row["indoorReason"] = ""
                stats.missing_coords += 1
                writer.writerow([_format_cell(row.get(h, "")) for h in headers])
                continue

            key = (int(round(lon * 1e5)), int(round(lat * 1e5)))  # ~1m grid cache
            indoor = coord_cache.get(key)
            if indoor is None:
                indoor = _is_indoor(tree, geoms, Point(lon, lat))
                coord_cache[key] = indoor

            row["indoor"] = "1" if indoor else "0"
            row["indoorReason"] = "building" if indoor else ""
            if indoor:
                stats.indoor_rows += 1
                if mode == "mask":
                    _mask_indoor_row(row)

            writer.writerow([_format_cell(row.get(h, "")) for h in headers])

    os.replace(tmp_path, dst)
    return stats


def scan_file(
    src: Path,
    *,
    buildings_path: str,
    buildings_layer: Optional[str],
    max_rows: int,
) -> FileStats:
    from shapely.geometry import Point

    stats = FileStats()
    bounds = _compute_bounds_limited(src, max_rows=max_rows)
    if bounds is None:
        return stats

    buildings_gdf = _load_buildings(buildings_path, buildings_layer, bbox=bounds)
    stats.buildings_loaded = int(len(buildings_gdf))
    tree, geoms = _build_tree(buildings_gdf)

    coord_cache: Dict[Tuple[int, int], bool] = {}

    with src.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            stats.rows += 1
            lon_raw, lat_raw = pick_lon_lat(row)
            if not lon_raw or not lat_raw:
                stats.missing_coords += 1
                continue
            try:
                lon = float(lon_raw)
                lat = float(lat_raw)
            except Exception:
                stats.missing_coords += 1
                continue

            key = (int(round(lon * 1e5)), int(round(lat * 1e5)))  # ~1m grid cache
            indoor = coord_cache.get(key)
            if indoor is None:
                indoor = _is_indoor(tree, geoms, Point(lon, lat))
                coord_cache[key] = indoor
            if indoor:
                stats.indoor_rows += 1

            if max_rows > 0 and stats.rows >= max_rows:
                break

    return stats


def _looks_processed(path: Path) -> bool:
    try:
        if not path.exists() or path.stat().st_size <= 0:
            return False
        with path.open("r", encoding="utf-8", newline="") as fh:
            header = fh.readline().strip("\r\n")
    except Exception:
        return False
    if not header:
        return False
    cols = [c.strip() for c in header.split(",")]
    return "indoor" in cols and "indoorReason" in cols


def _run_one(
    src_path: str,
    dst_path: str,
    rel_path: str,
    *,
    buildings_path: str,
    buildings_layer: Optional[str],
    mode: str,
    write: bool,
    max_rows_per_file: int,
) -> Tuple[str, FileStats]:
    src = Path(src_path)
    if write:
        st = process_file(
            src,
            Path(dst_path),
            buildings_path=buildings_path,
            buildings_layer=buildings_layer,
            mode=mode,
        )
    else:
        st = scan_file(
            src,
            buildings_path=buildings_path,
            buildings_layer=buildings_layer,
            max_rows=max_rows_per_file,
        )
    return rel_path, st


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description="Indoor filter for *-sunlight.csv")
    parser.add_argument("--root", required=True, help="Root directory containing *-sunlight.csv files")
    parser.add_argument("--buildings", required=True, help="Buildings dataset path (GPKG/GeoJSON)")
    parser.add_argument("--buildings-layer", default="", help="Optional layer name for GPKG")
    parser.add_argument(
        "--mode",
        choices=("mask", "flag"),
        default="mask",
        help="mask: set exposure fields to 0 when indoor; flag: only add indoor columns",
    )
    parser.add_argument(
        "--out-root",
        default="",
        help="Write outputs to a new root directory (recommended). If omitted, requires --in-place.",
    )
    parser.add_argument("--in-place", action="store_true", help="Rewrite files in place (no backup).")
    parser.add_argument("--write", action="store_true", help="Actually write outputs. Default: dry-run stats only.")
    parser.add_argument(
        "--files-list",
        default="",
        help="Optional file list (one relative path per line, relative to --root).",
    )
    parser.add_argument("--limit-files", type=int, default=0, help="Optional: stop after N files (0 = no limit).")
    parser.add_argument(
        "--max-rows-per-file",
        type=int,
        default=0,
        help="Rows to scan per file (0 = full file). Default: 0",
    )
    parser.add_argument("--workers", type=int, default=1, help="Parallel workers (file-level). Default: 1")
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Do not skip already-processed destination files (default: resume/skip).",
    )
    args = parser.parse_args(list(argv))

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    buildings_path = str(Path(args.buildings).expanduser().resolve())
    if not os.path.exists(buildings_path):
        print(f"[Fatal] buildings not found: {buildings_path}", file=sys.stderr)
        return 2

    try:
        import geopandas  # noqa: F401
        import shapely  # noqa: F401
    except Exception as exc:
        print(
            f"[Fatal] Missing dependencies for indoor filtering (need geopandas + shapely): {exc}",
            file=sys.stderr,
        )
        return 2

    layer = str(args.buildings_layer).strip() or None

    out_root_raw = str(args.out_root).strip()
    if args.write:
        if not out_root_raw and not args.in_place:
            print("[Fatal] When --write, provide --out-root or use --in-place.", file=sys.stderr)
            return 2
    out_root = Path(out_root_raw).expanduser().resolve() if out_root_raw else root

    if args.files_list:
        file_list = Path(args.files_list).expanduser().resolve()
        rels = read_file_list(file_list)
        files = [root / rel for rel in rels]
    else:
        files = list(iter_sunlight_files(root))

    if args.limit_files > 0:
        files = files[: int(args.limit_files)]

    if not files:
        print(f"[Fatal] no *-sunlight.csv files under {root}", file=sys.stderr)
        return 2

    workers = int(args.workers)
    if workers < 1:
        print("[Fatal] --workers must be >= 1", file=sys.stderr)
        return 2

    print(f"[Scan] files={len(files)} root={root}")
    print(
        f"[Config] mode={args.mode} write={bool(args.write)} out_root={out_root} in_place={bool(args.in_place)} "
        f"workers={workers} max_rows_per_file={int(args.max_rows_per_file) or 0}"
    )

    started = time.time()
    total_rows = 0
    total_indoor = 0
    jobs: list[Tuple[str, str, str]] = []
    skipped_existing = 0
    resume = (not bool(args.no_resume)) and bool(args.write)
    for src in files:
        if not src.exists():
            print(f"[Skip] missing: {src}", file=sys.stderr)
            continue
        try:
            rel = src.relative_to(root)
        except Exception:
            rel = Path(src.name)
        dst = (out_root / rel) if not args.in_place else src
        if resume and dst.exists() and _looks_processed(dst):
            skipped_existing += 1
            continue
        jobs.append((str(src), str(dst), str(rel)))

    if skipped_existing:
        print(f"[Resume] skipped_existing={skipped_existing}")

    completed = 0
    if workers == 1:
        for src_path, dst_path, rel_path in jobs:
            rel_out, st = _run_one(
                src_path,
                dst_path,
                rel_path,
                buildings_path=buildings_path,
                buildings_layer=layer,
                mode=str(args.mode),
                write=bool(args.write),
                max_rows_per_file=int(args.max_rows_per_file),
            )
            completed += 1
            total_rows += st.rows
            total_indoor += st.indoor_rows
            if completed % 10 == 0 or completed == len(jobs):
                elapsed = int(round(time.time() - started))
                ratio = 0.0 if total_rows == 0 else (total_indoor / total_rows) * 100.0
                print(
                    f"[Progress] {completed}/{len(jobs)} rows={total_rows} indoor={total_indoor} "
                    f"({ratio:.2f}%) elapsed={elapsed}s"
                )
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futures = [
                ex.submit(
                    _run_one,
                    src_path,
                    dst_path,
                    rel_path,
                    buildings_path=buildings_path,
                    buildings_layer=layer,
                    mode=str(args.mode),
                    write=bool(args.write),
                    max_rows_per_file=int(args.max_rows_per_file),
                )
                for src_path, dst_path, rel_path in jobs
            ]
            for fut in as_completed(futures):
                rel_out, st = fut.result()
                completed += 1
                total_rows += st.rows
                total_indoor += st.indoor_rows
                if completed % 10 == 0 or completed == len(jobs):
                    elapsed = int(round(time.time() - started))
                    ratio = 0.0 if total_rows == 0 else (total_indoor / total_rows) * 100.0
                    print(
                        f"[Progress] {completed}/{len(jobs)} rows={total_rows} indoor={total_indoor} "
                        f"({ratio:.2f}%) elapsed={elapsed}s"
                    )

    elapsed = int(round(time.time() - started))
    ratio = 0.0 if total_rows == 0 else (total_indoor / total_rows) * 100.0
    print(
        f"[Done] files={len(files)} processed={len(jobs)} skipped_existing={skipped_existing} "
        f"rows={total_rows} indoor={total_indoor} ({ratio:.2f}%) elapsed={elapsed}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
