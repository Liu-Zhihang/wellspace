#!/usr/bin/env python3
"""Assign mobility target CSVs to shard manifests."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.batch_mobility_shadow import pick_lon_lat, read_targets_from_file


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--targets-file", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--shards", required=True, type=int)
    parser.add_argument("--strategy", default="round-robin", choices=["round-robin", "spatial"])
    parser.add_argument("--spatial-shard-bin-deg", default=2.0, type=float)
    parser.add_argument("--output-summary", default="")
    return parser.parse_args()


def read_first_valid_coord(file_path: Path) -> Tuple[Optional[float], Optional[float], int]:
    scanned_rows = 0
    with file_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if not row:
                continue
            scanned_rows += 1
            lon_raw, lat_raw = pick_lon_lat(row)
            if not lon_raw or not lat_raw:
                continue
            try:
                lon = float(lon_raw)
                lat = float(lat_raw)
            except Exception:
                continue
            if math.isfinite(lon) and math.isfinite(lat):
                return lon, lat, scanned_rows
    return None, None, scanned_rows


def spatial_key(lon: float, lat: float, bin_deg: float) -> Tuple[int, int]:
    return (math.floor(lon / bin_deg), math.floor(lat / bin_deg))


def assign_round_robin(targets: Sequence[Path], shard_count: int) -> Tuple[List[List[Path]], Dict[str, object]]:
    assignments: List[List[Path]] = [[] for _ in range(shard_count)]
    for idx, target in enumerate(targets):
        assignments[idx % shard_count].append(target)
    return assignments, {"unresolved_targets": 0}


def assign_spatial(
    targets: Sequence[Path],
    shard_count: int,
    bin_deg: float,
) -> Tuple[List[List[Path]], Dict[str, object]]:
    assignments: List[List[Path]] = [[] for _ in range(shard_count)]
    grouped: Dict[Tuple[int, int], List[Path]] = defaultdict(list)
    unresolved: List[Path] = []
    scanned_rows = 0

    for target in targets:
        lon, lat, rows_used = read_first_valid_coord(target)
        scanned_rows += rows_used
        if lon is None or lat is None:
            unresolved.append(target)
            continue
        grouped[spatial_key(lon, lat, bin_deg)].append(target)

    ordered_groups = sorted(grouped.items(), key=lambda item: (item[0][1], item[0][0]))
    total_grouped = sum(len(paths) for _, paths in ordered_groups)
    target_per_shard = max(1, math.ceil(total_grouped / max(1, shard_count)))
    shard_idx = 0
    current_count = 0
    shard_cell_counts = [0 for _ in range(shard_count)]

    for _, paths in ordered_groups:
        remaining = sorted(paths)
        touched_shards = set()
        while remaining:
            if shard_idx < shard_count - 1 and current_count >= target_per_shard:
                shard_idx += 1
                current_count = 0
            room = target_per_shard - current_count if shard_idx < shard_count - 1 else len(remaining)
            room = max(1, room)
            chunk = remaining[:room]
            remaining = remaining[room:]
            assignments[shard_idx].extend(chunk)
            current_count += len(chunk)
            touched_shards.add(shard_idx)
            if remaining and shard_idx < shard_count - 1:
                shard_idx += 1
                current_count = 0
        for touched in touched_shards:
            shard_cell_counts[touched] += 1

    for idx, target in enumerate(unresolved):
        assignments[idx % shard_count].append(target)

    return assignments, {
        "spatial_shard_bin_deg": bin_deg,
        "spatial_cell_count": len(ordered_groups),
        "unresolved_targets": len(unresolved),
        "rows_scanned_for_assignment": scanned_rows,
        "shard_cell_counts": shard_cell_counts,
    }


def write_assignments(assignments: Sequence[Sequence[Path]], output_dir: Path, input_root: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for idx, targets in enumerate(assignments):
        shard_path = output_dir / f"targets_{idx:02d}.txt"
        with shard_path.open("w", encoding="utf-8") as handle:
            for target in targets:
                try:
                    rel = target.relative_to(input_root)
                except Exception:
                    rel = target
                handle.write(f"{rel.as_posix()}\n")


def main() -> int:
    args = parse_args()
    if args.shards <= 0:
        raise SystemExit("--shards must be a positive integer")
    if args.strategy == "spatial" and args.spatial_shard_bin_deg <= 0:
        raise SystemExit("--spatial-shard-bin-deg must be positive")

    input_root = Path(args.input_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    targets = read_targets_from_file(args.targets_file, input_root)

    if args.strategy == "spatial":
        assignments, extra = assign_spatial(targets, args.shards, args.spatial_shard_bin_deg)
    else:
        assignments, extra = assign_round_robin(targets, args.shards)

    write_assignments(assignments, output_dir, input_root)

    if args.output_summary:
        summary_path = Path(args.output_summary).expanduser().resolve()
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary = {
            "strategy": args.strategy,
            "input_root": str(input_root),
            "targets_file": str(Path(args.targets_file).expanduser().resolve()),
            "target_count": len(targets),
            "shards": args.shards,
            "shard_target_counts": [len(items) for items in assignments],
        }
        summary.update(extra)
        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"strategy={args.strategy}")
    print(f"target_count={len(targets)}")
    print(f"shards={args.shards}")
    print(f"shard_target_counts={','.join(str(len(items)) for items in assignments)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
