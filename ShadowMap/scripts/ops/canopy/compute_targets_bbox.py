#!/usr/bin/env python3
"""Compute a reproducible lon/lat bbox for a sharded mobility target manifest."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Dict, Optional


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from batch_mobility_shadow import _expand_bounds_by_meters, pick_lon_lat, read_csv_table, read_targets_from_file


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", required=True, help="Root directory containing the target CSV files.")
    parser.add_argument("--targets-file", required=True, help="Manifest of CSV paths relative to input-root.")
    parser.add_argument(
        "--expand-meters",
        default="0",
        help="Approximate bbox expansion margin in meters. Default: 0",
    )
    parser.add_argument("--output-summary", required=True, help="Output summary JSON path.")
    return parser.parse_args()


def _empty_summary(args: argparse.Namespace, target_count: int) -> Dict[str, object]:
    return {
        "input_root": str(Path(args.input_root).expanduser().resolve()),
        "targets_file": str(Path(args.targets_file).expanduser().resolve()),
        "target_count": int(target_count),
        "row_count": 0,
        "valid_points": 0,
        "skipped_rows": 0,
        "expand_meters": float(args.expand_meters),
        "bbox_raw": None,
        "bbox_expanded": None,
        "coord_priority": os.getenv("MOBILITY_COORD_PRIORITY", "fnl,gps,gpx,air,lnglat"),
    }


def _main() -> int:
    args = _parse_args()
    input_root = Path(args.input_root).expanduser().resolve()
    targets_file = Path(args.targets_file).expanduser().resolve()
    summary_path = Path(args.output_summary).expanduser().resolve()
    expand_meters = float(args.expand_meters)

    files = read_targets_from_file(str(targets_file), input_root)

    west = math.inf
    east = -math.inf
    south = math.inf
    north = -math.inf
    row_count = 0
    valid_points = 0
    skipped_rows = 0

    for file_path in files:
        _, rows = read_csv_table(file_path)
        row_count += len(rows)
        for row in rows:
            lon_raw, lat_raw = pick_lon_lat(row)
            if not lon_raw or not lat_raw:
                skipped_rows += 1
                continue
            try:
                lon = float(lon_raw)
                lat = float(lat_raw)
            except Exception:
                skipped_rows += 1
                continue
            if not (math.isfinite(lon) and math.isfinite(lat)):
                skipped_rows += 1
                continue
            west = min(west, lon)
            east = max(east, lon)
            south = min(south, lat)
            north = max(north, lat)
            valid_points += 1

    summary = _empty_summary(args, len(files))
    summary["row_count"] = int(row_count)
    summary["valid_points"] = int(valid_points)
    summary["skipped_rows"] = int(skipped_rows)

    if valid_points > 0:
        raw_bounds: Dict[str, float] = {
            "west": float(west),
            "east": float(east),
            "south": float(south),
            "north": float(north),
        }
        expanded_bounds: Optional[Dict[str, float]]
        if expand_meters > 0:
            expanded_bounds = _expand_bounds_by_meters(raw_bounds, expand_meters)
        else:
            expanded_bounds = dict(raw_bounds)
        summary["bbox_raw"] = raw_bounds
        summary["bbox_expanded"] = expanded_bounds

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"target_count={summary['target_count']}")
    print(f"row_count={summary['row_count']}")
    print(f"valid_points={summary['valid_points']}")
    if summary["bbox_expanded"]:
        bbox = summary["bbox_expanded"]
        print(
            "bbox_expanded="
            f"{bbox['west']},{bbox['south']},{bbox['east']},{bbox['north']}"
        )
    else:
        print("bbox_expanded=")
    print(f"summary={summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
