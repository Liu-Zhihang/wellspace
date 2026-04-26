#!/usr/bin/env python3
"""Shard a raw stay-point CSV by ad_id hash for parallel preprocessing."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, TextIO


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-csv", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--shard-count", type=int, required=True)
    parser.add_argument("--progress-every", type=int, default=500_000)
    return parser


def shard_index_for(ad_id: str, shard_count: int) -> int:
    digest = hashlib.sha1(ad_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=False) % int(shard_count)


def main(argv: List[str]) -> int:
    args = build_parser().parse_args(argv)
    started_at = time.monotonic()

    input_csv = Path(args.input_csv).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    handles: Dict[int, TextIO] = {}
    writers: Dict[int, csv.writer] = {}
    shard_paths = [output_root / f"shard_{idx:02d}.csv" for idx in range(int(args.shard_count))]
    shard_counts = [0 for _ in range(int(args.shard_count))]
    unique_users: List[set[str]] = [set() for _ in range(int(args.shard_count))]

    raw_rows = 0
    skipped_rows = 0
    try:
        with input_csv.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise RuntimeError(f"Missing header in raw CSV: {input_csv}")
            header = list(reader.fieldnames)
            for row in reader:
                raw_rows += 1
                ad_id = (row.get("ad_id") or "").strip()
                if not ad_id:
                    skipped_rows += 1
                    continue
                shard_idx = shard_index_for(ad_id, int(args.shard_count))
                writer = writers.get(shard_idx)
                if writer is None:
                    shard_path = shard_paths[shard_idx]
                    shard_path.parent.mkdir(parents=True, exist_ok=True)
                    shard_handle = shard_path.open("w", encoding="utf-8", newline="")
                    writer = csv.writer(shard_handle, lineterminator="\n")
                    writer.writerow(header)
                    handles[shard_idx] = shard_handle
                    writers[shard_idx] = writer
                writer.writerow([row.get(col, "") for col in header])
                shard_counts[shard_idx] += 1
                unique_users[shard_idx].add(ad_id)
                if args.progress_every > 0 and raw_rows % int(args.progress_every) == 0:
                    print(
                        f"[ShardRawStay] rows={raw_rows} skipped={skipped_rows}",
                        file=sys.stderr,
                        flush=True,
                    )
    finally:
        for handle in handles.values():
            handle.close()

    manifest_path = output_root / "shards.txt"
    with manifest_path.open("w", encoding="utf-8") as handle:
        for shard_path, row_count in zip(shard_paths, shard_counts):
            if row_count <= 0:
                continue
            handle.write(f"{shard_path.name}\n")

    shard_rows = []
    for idx, (path, row_count, users) in enumerate(zip(shard_paths, shard_counts, unique_users)):
        if row_count <= 0:
            continue
        shard_rows.append(
            {
                "shardIndex": idx,
                "path": str(path),
                "rowCount": row_count,
                "userCount": len(users),
            }
        )

    summary = {
        "input_csv": str(input_csv),
        "output_root": str(output_root),
        "shard_count": int(args.shard_count),
        "raw_rows": raw_rows,
        "skipped_rows": skipped_rows,
        "written_rows": sum(shard_counts),
        "nonempty_shards": sum(1 for count in shard_counts if count > 0),
        "manifest_path": str(manifest_path),
        "elapsed_seconds": time.monotonic() - started_at,
        "shards": shard_rows,
    }
    summary_path = output_root / "shard_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
