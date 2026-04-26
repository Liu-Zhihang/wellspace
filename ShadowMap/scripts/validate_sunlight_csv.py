#!/usr/bin/env python3

"""Validate `*-sunlight.csv` outputs for structural integrity.

Why this exists:
- Some legacy outputs were written without CSV quoting/escaping, so error strings
  containing commas/newlines can break column alignment.
- This tool detects malformed rows (row length != header length) quickly and can
  optionally write a bad-file list for repair.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import DefaultDict, Iterable, Optional


def iter_sunlight_files(root: Path, include_repair_backups: bool) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        if not include_repair_backups:
            dirnames[:] = [d for d in dirnames if not d.startswith("_repair_backup_")]
        for name in filenames:
            if name.lower().endswith("-sunlight.csv"):
                yield Path(dirpath) / name


def district_from_path(root: Path, file_path: Path) -> str:
    try:
        rel = file_path.relative_to(root)
    except Exception:
        return "(unknown)"
    return rel.parts[0] if rel.parts else "(unknown)"


@dataclass
class FileResult:
    header_len: int
    rows_checked: int
    bad_rows: int
    first_bad_line: Optional[int]


def check_file(file_path: Path, max_rows: int) -> FileResult:
    with file_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if not header:
            return FileResult(header_len=0, rows_checked=0, bad_rows=0, first_bad_line=None)
        expected = len(header)

        rows_checked = 0
        bad_rows = 0
        first_bad_line: Optional[int] = None

        for line_no, row in enumerate(reader, start=2):
            rows_checked += 1
            if expected and len(row) != expected:
                bad_rows += 1
                if first_bad_line is None:
                    first_bad_line = line_no
            if max_rows > 0 and rows_checked >= max_rows:
                break

    return FileResult(
        header_len=expected,
        rows_checked=rows_checked,
        bad_rows=bad_rows,
        first_bad_line=first_bad_line,
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate *-sunlight.csv structural integrity")
    parser.add_argument("--root", required=True, help="Root directory containing district subfolders (e.g. GLAN_processed)")
    parser.add_argument(
        "--max-rows-per-file",
        type=int,
        default=5000,
        help="Rows to check per file (0 = scan full file). Default: 5000",
    )
    parser.add_argument(
        "--write-bad-list",
        default="",
        help="Optional path to write bad-file list (one path per line, relative to --root).",
    )
    parser.add_argument(
        "--include-repair-backups",
        action="store_true",
        help="Also scan `_repair_backup_*` directories (off by default).",
    )
    parser.add_argument("--limit-files", type=int, default=0, help="Optional: stop after N files (0 = no limit).")
    args = parser.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    per_district: DefaultDict[str, dict[str, int]] = defaultdict(
        lambda: {"files": 0, "files_bad": 0, "rows_checked": 0, "bad_rows": 0}
    )
    bad_files: list[str] = []

    total_files = 0
    for file_path in iter_sunlight_files(root, include_repair_backups=bool(args.include_repair_backups)):
        total_files += 1
        if args.limit_files > 0 and total_files > args.limit_files:
            break
        district = district_from_path(root, file_path)
        stat = per_district[district]
        stat["files"] += 1

        res = check_file(file_path, max_rows=int(args.max_rows_per_file))
        stat["rows_checked"] += res.rows_checked
        stat["bad_rows"] += res.bad_rows
        if res.bad_rows > 0:
            stat["files_bad"] += 1
            try:
                bad_files.append(str(file_path.relative_to(root)))
            except Exception:
                bad_files.append(str(file_path))

    print(f"[Scan] root={root}")
    print(f"[Scan] files={total_files} max_rows_per_file={args.max_rows_per_file}")
    print("------------------------------------------------------")
    print("District  files_bad/files  bad_rows/rows_checked")
    for district in sorted(per_district.keys()):
        stat = per_district[district]
        files = stat["files"]
        files_bad = stat["files_bad"]
        rows_checked = stat["rows_checked"]
        bad_rows = stat["bad_rows"]
        print(
            f"{district:8s} {files_bad:6d}/{files:<6d}  {bad_rows:9d}/{rows_checked:<9d}"
        )
    print("------------------------------------------------------")

    if args.write_bad_list:
        out_path = Path(args.write_bad_list).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text("\n".join(sorted(set(bad_files))) + ("\n" if bad_files else ""), encoding="utf-8")
        print(f"[Write] bad_list={out_path} files={len(set(bad_files))}")

    if bad_files:
        print(f"[Result] BAD files detected: {len(set(bad_files))}", file=sys.stderr)
        return 1

    print("[Result] OK: no structural issues detected in sampled rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
