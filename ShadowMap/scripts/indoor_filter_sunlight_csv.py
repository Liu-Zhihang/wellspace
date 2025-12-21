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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple


def pick_lon_lat(row: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    lon = row.get("fnl_lon") or row.get("gps_lon") or row.get("gpx_lon") or row.get("air_lon")
    lat = row.get("fnl_lat") or row.get("gps_lat") or row.get("gpx_lat") or row.get("air_lat")
    return lon, lat


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
    args = parser.parse_args(list(argv))

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    buildings_path = str(Path(args.buildings).expanduser().resolve())
    if not os.path.exists(buildings_path):
        print(f"[Fatal] buildings not found: {buildings_path}", file=sys.stderr)
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

    print(f"[Scan] files={len(files)} root={root}")
    print(f"[Config] mode={args.mode} write={bool(args.write)} out_root={out_root} in_place={bool(args.in_place)}")

    started = time.time()
    total_rows = 0
    total_indoor = 0
    for i, src in enumerate(files, start=1):
        if not src.exists():
            print(f"[Skip] missing: {src}", file=sys.stderr)
            continue
        try:
            rel = src.relative_to(root)
        except Exception:
            rel = Path(src.name)
        dst = (out_root / rel) if not args.in_place else src

        if args.write:
            st = process_file(
                src,
                dst,
                buildings_path=buildings_path,
                buildings_layer=layer,
                mode=str(args.mode),
            )
        else:
            st = FileStats()

        total_rows += st.rows
        total_indoor += st.indoor_rows

        if i % 10 == 0 or i == len(files):
            elapsed = int(round(time.time() - started))
            ratio = 0.0 if total_rows == 0 else (total_indoor / total_rows) * 100.0
            print(f"[Progress] {i}/{len(files)} rows={total_rows} indoor={total_indoor} ({ratio:.2f}%) elapsed={elapsed}s")

    elapsed = int(round(time.time() - started))
    ratio = 0.0 if total_rows == 0 else (total_indoor / total_rows) * 100.0
    print(f"[Done] files={len(files)} rows={total_rows} indoor={total_indoor} ({ratio:.2f}%) elapsed={elapsed}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

