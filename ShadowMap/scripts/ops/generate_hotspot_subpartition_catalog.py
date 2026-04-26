#!/usr/bin/env python3
"""Generate finer-grained hotspot subpartitions from an existing partition catalog."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-partition-catalog-json",
        required=True,
        help="Existing partition catalog JSON path (for example 0.5° partitions).",
    )
    parser.add_argument(
        "--partition-ids-file",
        default="",
        help="Optional newline-delimited allowlist of parent partition IDs to refine.",
    )
    parser.add_argument(
        "--partition-id",
        action="append",
        default=[],
        help="Optional explicit parent partition ID(s) to refine.",
    )
    parser.add_argument("--output-json", required=True, help="Output hotspot subpartition catalog JSON.")
    parser.add_argument("--output-csv", default="", help="Optional CSV copy of the hotspot subpartition catalog.")
    parser.add_argument(
        "--subpartition-size-deg",
        type=float,
        default=0.25,
        help="Target subpartition size in lon/lat degrees. Defaults to 0.25.",
    )
    parser.add_argument(
        "--partition-prefix",
        default="uspart",
        help="Prefix to embed in generated hotspot subpartition IDs.",
    )
    return parser


def encode_lon(value: float) -> str:
    return f"{'e' if value >= 0 else 'w'}{int(round(abs(value) * 100)):05d}"


def encode_lat(value: float) -> str:
    return f"{'n' if value >= 0 else 's'}{int(round(abs(value) * 100)):05d}"


def build_partition_id(prefix: str, size_deg: float, west: float, south: float, east: float, north: float) -> str:
    size_token = int(round(size_deg * 100))
    return (
        f"{prefix}_d{size_token:03d}_"
        f"{encode_lon(west)}_{encode_lat(south)}_{encode_lon(east)}_{encode_lat(north)}"
    )


def frange(start: float, stop: float, step: float) -> Iterable[float]:
    current = start
    guard = 0
    while current < stop - 1e-12:
        yield round(current, 10)
        current += step
        guard += 1
        if guard > 1000000:
            raise RuntimeError("Unexpected subpartition loop overflow")


def load_catalog(path: Path) -> List[Dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError(f"Partition catalog must be a JSON array: {path}")
    rows: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeError(f"Partition catalog entry #{idx} is not an object")
        partition_id = str(item.get("partitionId") or "").strip()
        parent_tile_id = str(item.get("parentTileId") or "").strip()
        if not partition_id or not parent_tile_id:
            raise RuntimeError(f"Partition catalog entry #{idx} is missing partitionId/parentTileId")
        rows.append(
            {
                "partitionId": partition_id,
                "parentTileId": parent_tile_id,
                "minLon": float(item["minLon"]),
                "minLat": float(item["minLat"]),
                "maxLon": float(item["maxLon"]),
                "maxLat": float(item["maxLat"]),
                "partitionSizeDeg": float(item.get("partitionSizeDeg", 0.0) or 0.0),
                "region": None if item.get("region") is None else str(item.get("region")),
                "description": None if item.get("description") is None else str(item.get("description")),
            }
        )
    return rows


def load_selected_ids(args: argparse.Namespace) -> Optional[Set[str]]:
    values: Set[str] = {str(v).strip() for v in (args.partition_id or []) if str(v).strip()}
    if args.partition_ids_file:
        path = Path(args.partition_ids_file).expanduser().resolve()
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped:
                values.add(stripped)
    return values or None


def write_csv(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    rows = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "partitionId",
                "parentPartitionId",
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
        writer.writerows(rows)


def main() -> int:
    args = build_parser().parse_args()
    target_size = float(args.subpartition_size_deg)
    if target_size <= 0:
        raise RuntimeError("--subpartition-size-deg must be positive")

    base_catalog_path = Path(args.base_partition_catalog_json).expanduser().resolve()
    output_json = Path(args.output_json).expanduser().resolve()
    output_csv = Path(args.output_csv).expanduser().resolve() if args.output_csv else None

    base_rows = load_catalog(base_catalog_path)
    selected_ids = load_selected_ids(args)
    if selected_ids is not None:
        base_rows = [row for row in base_rows if row["partitionId"] in selected_ids]
    if not base_rows:
        raise RuntimeError("No base partitions selected for hotspot subpartition generation")

    subpartitions: List[Dict[str, Any]] = []
    for row in base_rows:
        base_size = float(row["partitionSizeDeg"] or 0.0)
        if base_size > 0 and target_size > base_size + 1e-12:
            raise RuntimeError(
                f"Requested subpartition size {target_size}° is larger than parent partition "
                f"{row['partitionId']} size {base_size}°"
            )
        west = float(row["minLon"])
        south = float(row["minLat"])
        east = float(row["maxLon"])
        north = float(row["maxLat"])
        for part_west in frange(west, east, target_size):
            part_east = min(east, round(part_west + target_size, 10))
            for part_south in frange(south, north, target_size):
                part_north = min(north, round(part_south + target_size, 10))
                subpartitions.append(
                    {
                        "partitionId": build_partition_id(
                            args.partition_prefix,
                            target_size,
                            part_west,
                            part_south,
                            part_east,
                            part_north,
                        ),
                        "parentPartitionId": row["partitionId"],
                        "parentTileId": row["parentTileId"],
                        "partitionSizeDeg": target_size,
                        "minLon": part_west,
                        "minLat": part_south,
                        "maxLon": part_east,
                        "maxLat": part_north,
                        "region": row["region"],
                        "description": row["description"],
                    }
                )

    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(subpartitions, indent=2, ensure_ascii=False), encoding="utf-8")
    if output_csv:
        write_csv(output_csv, subpartitions)

    summary = {
        "base_partition_catalog_json": str(base_catalog_path),
        "selected_parent_partition_count": len(base_rows),
        "subpartition_size_deg": target_size,
        "subpartition_count": len(subpartitions),
        "output_json": str(output_json),
    }
    if output_csv:
        summary["output_csv"] = str(output_csv)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
