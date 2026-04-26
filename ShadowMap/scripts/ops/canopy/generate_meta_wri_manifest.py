#!/usr/bin/env python3
"""Generate a reproducible canopy tile manifest from the Meta/WRI tiles index.

The global CHM bucket publishes `tiles.geojson`, which provides tile footprints
and tile ids. This script filters that index by coarse US AOI presets and emits
a manifest that the downloader can consume.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


TILES_INDEX_URL = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/tiles.geojson"
GLOBAL_CHM_PREFIX = "forests/v1/alsgedi_global_v6_float/chm/"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preset",
        default="us-all",
        choices=["us-contiguous", "us-all", "alaska", "hawaii", "pr-vi"],
        help="AOI preset to use. Default: us-all",
    )
    parser.add_argument(
        "--bbox",
        action="append",
        default=[],
        help="Custom bbox west,south,east,north. May be repeated. When present, overrides --preset.",
    )
    parser.add_argument(
        "--tiles-index",
        default=TILES_INDEX_URL,
        help="Path or URL to tiles.geojson. Default: public AWS tiles.geojson",
    )
    parser.add_argument(
        "--output-manifest",
        required=True,
        help="Output manifest text file",
    )
    parser.add_argument(
        "--output-summary",
        default="",
        help="Optional summary JSON path",
    )
    parser.add_argument(
        "--output-format",
        default="filename",
        choices=["filename", "key", "url"],
        help="Manifest entry format. Default: filename",
    )
    parser.add_argument(
        "--output-tiles-geojson",
        default="",
        help="Optional clipped GeoJSON path containing the selected tile footprints",
    )
    return parser.parse_args()


def _region_boxes():
    from shapely.geometry import box

    return {
        "us-contiguous": [("lower48", box(-125.0, 24.0, -66.0, 49.5))],
        "alaska": [("alaska", box(-179.5, 51.0, -129.5, 72.0))],
        "hawaii": [("hawaii", box(-161.0, 18.5, -154.0, 22.5))],
        "pr-vi": [("pr_vi", box(-67.5, 17.5, -64.0, 19.5))],
        "us-all": [
            ("lower48", box(-125.0, 24.0, -66.0, 49.5)),
            ("alaska", box(-179.5, 51.0, -129.5, 72.0)),
            ("hawaii", box(-161.0, 18.5, -154.0, 22.5)),
            ("pr_vi", box(-67.5, 17.5, -64.0, 19.5)),
        ],
    }


def _custom_boxes(raw_boxes):
    from shapely.geometry import box

    regions = []
    for idx, raw in enumerate(raw_boxes, start=1):
        parts = [part.strip() for part in str(raw).split(",")]
        if len(parts) != 4:
            raise SystemExit(f"Invalid --bbox '{raw}'. Expected west,south,east,north.")
        west, south, east, north = [float(part) for part in parts]
        regions.append((f"bbox_{idx:02d}", box(west, south, east, north)))
    return regions


def _format_entry(tile_id: str, output_format: str) -> str:
    filename = f"{tile_id}.tif"
    if output_format == "filename":
        return filename
    if output_format == "key":
        return f"{GLOBAL_CHM_PREFIX}{filename}"
    if output_format == "url":
        return f"https://dataforgood-fb-data.s3.amazonaws.com/{GLOBAL_CHM_PREFIX}{filename}"
    raise ValueError(f"Unsupported output format: {output_format}")


def main() -> int:
    args = _parse_args()

    try:
        import geopandas as gpd
        import pandas as pd
    except Exception as exc:
        raise SystemExit("Missing dependency geopandas in the active Python environment.") from exc

    regions = _custom_boxes(args.bbox) if args.bbox else _region_boxes()[args.preset]
    gdf = gpd.read_file(args.tiles_index)
    if "tile" not in gdf.columns:
        raise SystemExit(f"Tiles index missing 'tile' column: {args.tiles_index}")

    selected_parts = []
    region_counts = {}
    for region_name, geom in regions:
        part = gdf[gdf.intersects(geom)].copy()
        selected_parts.append(part)
        region_counts[region_name] = int(len(part))

    selected = gpd.GeoDataFrame(
        pd.concat(selected_parts, ignore_index=True),
        geometry="geometry",
        crs=gdf.crs,
    ).drop_duplicates(subset=["tile"]).reset_index(drop=True)
    selected = selected.sort_values("tile").reset_index(drop=True)

    manifest_path = Path(args.output_manifest).expanduser().resolve()
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        for tile_id in selected["tile"].astype(str):
            handle.write(_format_entry(tile_id, args.output_format) + "\n")

    if args.output_tiles_geojson:
        output_geojson = Path(args.output_tiles_geojson).expanduser().resolve()
        output_geojson.parent.mkdir(parents=True, exist_ok=True)
        selected.to_file(output_geojson, driver="GeoJSON")

    if args.output_summary:
        summary_path = Path(args.output_summary).expanduser().resolve()
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary = {
            "preset": None if args.bbox else args.preset,
            "bboxes": list(args.bbox),
            "tiles_index": args.tiles_index,
            "output_format": args.output_format,
            "tile_count": int(len(selected)),
            "region_counts": region_counts,
            "tile_min": str(selected["tile"].min()) if len(selected) else None,
            "tile_max": str(selected["tile"].max()) if len(selected) else None,
        }
        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"preset={args.preset if not args.bbox else 'custom-bbox'}")
    print(f"tile_count={len(selected)}")
    for region_name, count in region_counts.items():
        print(f"{region_name}={count}")
    print(f"manifest={manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
