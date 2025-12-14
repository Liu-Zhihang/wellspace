#!/usr/bin/env python3

"""Rebuild mobility retry task files (after /tmp cleanup or migration).

This tool helps when the bucket directory (e.g. /tmp/buckets_*.txt) was cleared
after reboot and you need to:
1) Count how many CSVs still need outputs, and/or
2) Recreate `*_retry.txt` files in a persistent task directory.

Conventions:
- Input CSVs live under INPUT_ROOT.
- Outputs mirror the same relative path under OUTPUT_ROOT and are named
  `*-sunlight.csv` (same as batch scripts).
- Retry files are named `<stem>-sunlight_retry.txt` (content may be empty for
  file-level recompute).
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


def _normalize_bucket_key(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ""
    if raw.endswith("Z") and "." not in raw:
        return raw[:-1] + ".000Z"
    return raw


def iter_csv_files(root: Path) -> Iterable[Path]:
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith(".csv"):
                yield Path(dirpath) / name


def expected_output_path(input_csv: Path, input_root: Path, output_root: Path) -> Path:
    rel = input_csv.relative_to(input_root)
    out_dir = output_root / rel.parent
    return out_dir / f"{input_csv.stem}-sunlight.csv"


def resolve_task_root(output_root: Path) -> Path:
    raw = (os.getenv("SHADOWMAP_TASK_ROOT") or "").strip()
    if raw:
        return Path(raw)
    return output_root / "_shadowmap_tasks"


def resolve_bucket_dir(output_root: Path, default_subdir: str) -> Path:
    raw = (os.getenv("BUCKET_DIR") or "").strip()
    if raw:
        return Path(raw)
    return resolve_task_root(output_root) / default_subdir


@dataclass(frozen=True)
class Summary:
    total: int
    done: int
    missing: int


def cmd_missing_outputs(args: argparse.Namespace) -> int:
    input_root = Path(args.input_root).resolve()
    output_root = Path(args.output_root).resolve()
    bucket_dir = (
        Path(args.bucket_dir).resolve()
        if args.bucket_dir
        else resolve_bucket_dir(output_root, "buckets_part1_migrated")
    )

    total = 0
    done = 0
    missing = 0

    missing_inputs: list[Path] = []
    for input_csv in iter_csv_files(input_root):
        total += 1
        out_file = expected_output_path(input_csv, input_root, output_root)
        if out_file.exists():
            done += 1
            continue
        missing += 1
        if len(missing_inputs) < args.sample:
            missing_inputs.append(input_csv)

    print(f"[Summary] input={total} output_ok={done} output_missing={missing}")
    if missing_inputs:
        print("[Sample] first missing inputs:")
        for item in missing_inputs:
            print(f"  - {item}")

    if args.write:
        bucket_dir.mkdir(parents=True, exist_ok=True)
        created = 0
        for input_csv in iter_csv_files(input_root):
            out_file = expected_output_path(input_csv, input_root, output_root)
            if out_file.exists():
                continue
            task_stem = f"{input_csv.stem}-sunlight"
            retry_file = bucket_dir / f"{task_stem}_retry.txt"
            if retry_file.exists() and not args.overwrite:
                continue
            retry_file.write_text("", encoding="utf-8")
            created += 1
        print(f"[Write] bucket_dir={bucket_dir} created={created}")

    return 0


def cmd_retry_from_output(args: argparse.Namespace) -> int:
    output_root = Path(args.output_root).resolve()
    bucket_dir = (
        Path(args.bucket_dir).resolve()
        if args.bucket_dir
        else resolve_bucket_dir(output_root, "buckets_part1")
    )

    include_prefixes = [p.strip() for p in args.source_prefix.split(",") if p.strip()]
    if not include_prefixes:
        include_prefixes = ["fallback_error"]

    output_files = sorted(output_root.rglob(args.pattern))
    total_files = 0
    files_with_retries = 0
    total_buckets = 0

    for out_file in output_files:
        if not out_file.is_file():
            continue
        total_files += 1
        try:
            with out_file.open("r", encoding="utf-8", newline="") as fh:
                reader = csv.reader(fh)
                headers = next(reader, None)
                if not headers:
                    continue
                try:
                    idx_source = headers.index("source")
                    idx_bucket_start = headers.index("bucketStart")
                except ValueError:
                    continue

                buckets: set[str] = set()
                for row in reader:
                    if idx_source >= len(row) or idx_bucket_start >= len(row):
                        continue
                    source = (row[idx_source] or "").strip()
                    if not source:
                        continue
                    if not any(source.startswith(prefix) for prefix in include_prefixes):
                        continue
                    bucket_key = _normalize_bucket_key(row[idx_bucket_start])
                    if bucket_key:
                        buckets.add(bucket_key)
        except Exception:
            continue

        if not buckets:
            continue
        files_with_retries += 1
        total_buckets += len(buckets)

        if args.write:
            bucket_dir.mkdir(parents=True, exist_ok=True)
            retry_file = bucket_dir / f"{out_file.stem}_retry.txt"
            text = "\n".join(sorted(buckets)) + "\n"
            retry_file.write_text(text, encoding="utf-8")

    print(
        f"[Summary] scanned_outputs={total_files} files_with_retries={files_with_retries} total_retry_buckets={total_buckets}"
    )
    if args.write:
        print(f"[Write] bucket_dir={bucket_dir}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Rebuild mobility retry task files.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_missing = sub.add_parser("missing-outputs", help="Count missing outputs and optionally create retry files.")
    p_missing.add_argument("--input-root", default=os.getenv("INPUT_ROOT", ""), required=False)
    p_missing.add_argument("--output-root", default=os.getenv("OUTPUT_ROOT", ""), required=False)
    p_missing.add_argument("--bucket-dir", default=None)
    p_missing.add_argument("--sample", type=int, default=10, help="Print N missing examples.")
    p_missing.add_argument("--write", action="store_true", help="Create `*_retry.txt` files for missing outputs.")
    p_missing.add_argument("--overwrite", action="store_true", help="Overwrite existing retry files.")
    p_missing.set_defaults(func=cmd_missing_outputs)

    p_retry = sub.add_parser(
        "retry-from-output",
        help="Scan existing `*-sunlight.csv` outputs and rebuild bucket retry lists from row sources.",
    )
    p_retry.add_argument("--output-root", default=os.getenv("OUTPUT_ROOT", ""), required=False)
    p_retry.add_argument("--bucket-dir", default=None)
    p_retry.add_argument("--pattern", default="*-sunlight.csv", help="Glob pattern under OUTPUT_ROOT.")
    p_retry.add_argument(
        "--source-prefix",
        default="fallback_error",
        help="Comma-separated prefixes to include (e.g. fallback_error,fallback_error:500).",
    )
    p_retry.add_argument("--write", action="store_true", help="Write retry files into BUCKET_DIR.")
    p_retry.set_defaults(func=cmd_retry_from_output)

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.cmd == "missing-outputs":
        if not args.input_root:
            parser.error("missing-outputs: missing --input-root (or set $INPUT_ROOT)")
        if not args.output_root:
            parser.error("missing-outputs: missing --output-root (or set $OUTPUT_ROOT)")
    if args.cmd == "retry-from-output":
        if not args.output_root:
            parser.error("retry-from-output: missing --output-root (or set $OUTPUT_ROOT)")

    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

