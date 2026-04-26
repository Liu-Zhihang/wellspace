#!/usr/bin/env python3
"""Generate a finer-grained building partition catalog from a coarse tile catalog."""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tile-catalog-json", required=True, help="Input coarse tile catalog JSON.")
    parser.add_argument("--output-json", required=True, help="Output partition catalog JSON.")
    parser.add_argument("--output-csv", default="", help="Optional CSV copy of the partition catalog.")
    parser.add_argument(
        "--partition-size-deg",
        type=float,
        default=1.0,
        help="Partition size in lon/lat degrees (for example 1.0 or 0.5).",
    )
    parser.add_argument(
        "--partition-prefix",
        default="part",
        help="Prefix to embed in generated partition IDs.",
    )
    return parser


def encode_coord(value: float) -> str:
    scaled = int(round(abs(value) * 100))
    sign = "e" if value >= 0 else "w"
    if value >= 0 and abs(value) <= 90:
        sign = "n"
    if value < 0 and abs(value) <= 90:
        sign = "s"
    return f"{sign}{scaled:05d}"


def encode_lon(value: float) -> str:
    return f"{'e' if value >= 0 else 'w'}{int(round(abs(value) * 100)):05d}"


def encode_lat(value: float) -> str:
    return f"{'n' if value >= 0 else 's'}{int(round(abs(value) * 100)):05d}"


def frange(start: float, stop: float, step: float) -> Iterable[float]:
    current = start
    guard = 0
    while current < stop - 1e-12:
        yield round(current, 10)
        current += step
        guard += 1
        if guard > 1000000:
            raise RuntimeError("Unexpected partition loop overflow")


def load_tile_catalog(path: Path) -> List[Dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise RuntimeError(f"Tile catalog must be an array: {path}")
    rows: List[Dict[str, Any]] = []
    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            raise RuntimeError(f"Tile catalog entry #{idx} is not an object")
        rows.append(
            {
                "tileId": str(item["tileId"]),
                "minLon": float(item["minLon"]),
                "minLat": float(item["minLat"]),
                "maxLon": float(item["maxLon"]),
                "maxLat": float(item["maxLat"]),
                "region": None if item.get("region") is None else str(item.get("region")),
                "description": None
                if item.get("description") is None
                else str(item.get("description")),
            }
        )
    return rows


def build_partition_id(prefix: str, partition_size_deg: float, west: float, south: float, east: float, north: float) -> str:
    size_token = int(round(partition_size_deg * 100))
    return (
        f"{prefix}_d{size_token:03d}_"
        f"{encode_lon(west)}_{encode_lat(south)}_{encode_lon(east)}_{encode_lat(north)}"
    )


def main() -> int:
    args = build_parser().parse_args()
    partition_size_deg = float(args.partition_size_deg)
    if partition_size_deg <= 0:
        raise RuntimeError("--partition-size-deg must be positive")

    tile_catalog_path = Path(args.tile_catalog_json).expanduser().resolve()
    output_json = Path(args.output_json).expanduser().resolve()
    output_csv = Path(args.output_csv).expanduser().resolve() if args.output_csv else None

    tiles = load_tile_catalog(tile_catalog_path)

    partitions: List[Dict[str, Any]] = []
    for tile in tiles:
        west = float(tile["minLon"])
        south = float(tile["minLat"])
        east = float(tile["maxLon"])
        north = float(tile["maxLat"])
        for part_west in frange(west, east, partition_size_deg):
            part_east = min(east, round(part_west + partition_size_deg, 10))
            for part_south in frange(south, north, partition_size_deg):
                part_north = min(north, round(part_south + partition_size_deg, 10))
                partition_id = build_partition_id(
                    args.partition_prefix,
                    partition_size_deg,
                    part_west,
                    part_south,
                    part_east,
                    part_north,
                )
                partitions.append(
                    {
                        "partitionId": partition_id,
                        "parentTileId": tile["tileId"],
                        "partitionSizeDeg": partition_size_deg,
                        "minLon": part_west,
                        "minLat": part_south,
                        "maxLon": part_east,
                        "maxLat": part_north,
                        "region": tile["region"],
                        "description": tile["description"],
                    }
                )

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(partitions, indent=2, ensure_ascii=False), encoding="utf-8")

    if output_csv:
        output_csv.parent.mkdir(parents=True, exist_ok=True)
        with output_csv.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "partitionId",
                    "parentTileId",
                    "partitionSizeDeg",
                    "minLon",
                    "minLat",
                    "maxLon",
                    "maxLat",
                    "region",
                    "description",
                ],
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(partitions)

    summary = {
        "tile_catalog_json": str(tile_catalog_path),
        "partition_size_deg": partition_size_deg,
        "partition_prefix": args.partition_prefix,
        "tile_count": len(tiles),
        "partition_count": len(partitions),
        "output_json": str(output_json),
    }
    if output_csv:
        summary["output_csv"] = str(output_csv)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
