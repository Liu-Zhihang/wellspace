"""Shadow analysis prototype using pybdshadow."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from engine_core import AnalysisInput, gdf_to_feature_collection, run_analysis


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate building shadows via pybdshadow")
    parser.add_argument("--west", type=float, required=True)
    parser.add_argument("--south", type=float, required=True)
    parser.add_argument("--east", type=float, required=True)
    parser.add_argument("--north", type=float, required=True)
    parser.add_argument(
        "--timestamp",
        type=str,
        required=True,
        help="ISO-8601 timestamp (local time unless --timezone supplied)",
    )
    parser.add_argument("--timezone", type=str, default="Asia/Hong_Kong")
    parser.add_argument("--backend-url", type=str, default="http://localhost:3500")
    parser.add_argument("--max-features", type=int, default=8000)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("outputs"),
        help="Directory to save buildings.geojson and shadows.geojson",
    )
    return parser.parse_args()


def dump_geojson(gdf, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(path, driver="GeoJSON")


def main() -> None:
    args = parse_args()
    bounds = {"west": args.west, "south": args.south, "east": args.east, "north": args.north}

    params = AnalysisInput(
        bbox=bounds,
        timestamp=args.timestamp,
        backend_url=args.backend_url,
        timezone=args.timezone,
        max_features=args.max_features,
    )

    print("[shadow-prototype] Fetching buildings & generating shadows…", file=sys.stderr)
    result = run_analysis(params)
    buildings_gdf = result["buildings"]
    shadows_gdf = result["shadows"]

    print(f"[shadow-prototype] Retrieved {len(buildings_gdf)} buildings", file=sys.stderr)
    dump_geojson(buildings_gdf, args.output_dir / "buildings.geojson")

    print("[shadow-prototype] Writing shadow polygons via pybdshadow…", file=sys.stderr)
    dump_geojson(shadows_gdf, args.output_dir / "shadows.geojson")

    summary = {
        "buildings": len(buildings_gdf),
        "shadows": len(shadows_gdf),
        "timestamp": args.timestamp,
        "timezone": args.timezone,
        "bounds": bounds,
    }

    with (args.output_dir / "summary.json").open("w", encoding="utf-8") as fp:
        json.dump(summary, fp, indent=2)

    print("[shadow-prototype] Done. Outputs saved to", args.output_dir, file=sys.stderr)


if __name__ == "__main__":
    main()
