#!/usr/bin/env python3

"""Semantic QC for `*-sunlight.csv` outputs.

This tool catches a common silent failure mode: daylight rows incorrectly marked
as "night" and/or `solarIrradianceWm2` being systemically zero during afternoon
hours. Structural CSV integrity is handled by `validate_sunlight_csv.py`; this
script focuses on *meaningful* daylight signals.

Typical usage (Hong Kong):
  python3 ShadowMap/scripts/qc_sunlight_daylight.py --root GLAN_processed
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import DefaultDict, Iterable, Optional

try:
    from zoneinfo import ZoneInfo  # py3.9+
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore


def iter_sunlight_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith("_repair_backup_") and not d.startswith("_")]
        for name in filenames:
            if name.lower().endswith("-sunlight.csv"):
                yield Path(dirpath) / name


def district_from_path(root: Path, file_path: Path) -> str:
    try:
        rel = file_path.relative_to(root)
    except Exception:
        return "(unknown)"
    return rel.parts[0] if rel.parts else "(unknown)"


def parse_hours(spec: str) -> list[int]:
    spec = spec.strip()
    if not spec:
        return []
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start = int(a)
            end = int(b)
            if start <= end:
                for h in range(start, end + 1):
                    out.add(h)
            else:
                for h in range(start, 24):
                    out.add(h)
                for h in range(0, end + 1):
                    out.add(h)
        else:
            out.add(int(part))
    return sorted([h for h in out if 0 <= h <= 23])


@dataclass
class FileStats:
    rows: int
    rows_in_hours: int
    irr_nonzero: int
    source_night: int
    first_ts_utc: Optional[float]
    last_ts_utc: Optional[float]


def scan_file(
    file_path: Path,
    tz: timezone,
    hours: set[int],
    max_rows: int,
) -> FileStats:
    rows = 0
    rows_in_hours = 0
    irr_nonzero = 0
    source_night = 0
    first_ts: Optional[float] = None
    last_ts: Optional[float] = None

    with file_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames:
            return FileStats(0, 0, 0, 0, None, None)
        if "timestamp" not in reader.fieldnames:
            raise RuntimeError("missing_column: timestamp")

        for row in reader:
            rows += 1
            if max_rows > 0 and rows > max_rows:
                break
            ts_raw = row.get("timestamp")
            if not ts_raw:
                continue
            try:
                ts = float(ts_raw)
            except Exception:
                continue
            if first_ts is None:
                first_ts = ts
            last_ts = ts

            hour = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(tz).hour
            if hour not in hours:
                continue
            rows_in_hours += 1

            irr_raw = row.get("solarIrradianceWm2") or ""
            try:
                irr = float(irr_raw) if irr_raw.strip() else 0.0
            except Exception:
                irr = 0.0
            if irr > 0:
                irr_nonzero += 1

            if (row.get("source") or "").strip() == "night":
                source_night += 1

    return FileStats(rows, rows_in_hours, irr_nonzero, source_night, first_ts, last_ts)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="QC daylight semantics for *-sunlight.csv")
    parser.add_argument("--root", required=True, help="Root directory containing district subfolders (e.g. GLAN_processed)")
    parser.add_argument("--timezone", default="Asia/Hong_Kong", help="IANA timezone name. Default: Asia/Hong_Kong")
    parser.add_argument(
        "--hours",
        default="15-19",
        help="Local hours to check (comma-separated; supports ranges, e.g. 15-19,7,8). Default: 15-19",
    )
    parser.add_argument(
        "--min-rows",
        type=int,
        default=500,
        help="Minimum rows within --hours to judge a file. Default: 500",
    )
    parser.add_argument(
        "--max-rows-per-file",
        type=int,
        default=0,
        help="Rows to scan per file (0 = scan full file). Default: 0",
    )
    parser.add_argument(
        "--irr-nonzero-ratio-lt",
        type=float,
        default=0.01,
        help="Flag if nonzero solarIrradiance ratio is below this threshold. Default: 0.01",
    )
    parser.add_argument(
        "--night-ratio-gt",
        type=float,
        default=0.9,
        help="Flag if source==night ratio is above this threshold. Default: 0.9",
    )
    parser.add_argument(
        "--write-suspects",
        default="",
        help="Optional path to write suspect files list (paths relative to --root).",
    )
    parser.add_argument("--limit-files", type=int, default=0, help="Optional: stop after N files (0 = no limit).")
    args = parser.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    hours = set(parse_hours(args.hours))
    if not hours:
        print("[Fatal] --hours is empty/invalid", file=sys.stderr)
        return 2

    if ZoneInfo is None:
        print("[Fatal] zoneinfo unavailable in this Python; install tzdata or use a newer Python", file=sys.stderr)
        return 2
    tz = ZoneInfo(args.timezone)

    per_district: DefaultDict[str, dict[str, int]] = defaultdict(lambda: {"files": 0, "suspects": 0})
    suspects: list[str] = []

    total_files = 0
    for file_path in iter_sunlight_files(root):
        total_files += 1
        if args.limit_files > 0 and total_files > args.limit_files:
            break
        district = district_from_path(root, file_path)
        stat = per_district[district]
        stat["files"] += 1

        try:
            fs = scan_file(
                file_path,
                tz=tz,
                hours=hours,
                max_rows=int(args.max_rows_per_file),
            )
        except Exception as exc:
            stat["suspects"] += 1
            try:
                rel = str(file_path.relative_to(root))
            except Exception:
                rel = str(file_path)
            suspects.append(rel)
            print(f"[Suspect] {rel}: scan_failed: {exc}", file=sys.stderr)
            continue

        n = fs.rows_in_hours
        if n < int(args.min_rows):
            continue

        irr_ratio = float(fs.irr_nonzero) / float(max(n, 1))
        night_ratio = float(fs.source_night) / float(max(n, 1))
        if irr_ratio < float(args.irr_nonzero_ratio_lt) or night_ratio > float(args.night_ratio_gt):
            stat["suspects"] += 1
            try:
                rel = str(file_path.relative_to(root))
            except Exception:
                rel = str(file_path)
            suspects.append(rel)
            print(
                f"[Suspect] {rel}: n={n} irr_nonzero={irr_ratio:.2%} night={night_ratio:.2%}",
                file=sys.stderr,
            )

    print(f"[Scan] root={root}")
    print(f"[Scan] files={total_files} timezone={args.timezone} hours={','.join(map(str, sorted(hours)))}")
    print("------------------------------------------------------")
    print("District  suspects/files")
    for district in sorted(per_district.keys()):
        stat = per_district[district]
        print(f"{district:8s} {stat['suspects']:8d}/{stat['files']:<6d}")
    print("------------------------------------------------------")

    if args.write_suspects:
        out_path = Path(args.write_suspects).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text("\n".join(sorted(set(suspects))) + ("\n" if suspects else ""), encoding="utf-8")
        print(f"[Write] suspects={out_path} files={len(set(suspects))}")

    if suspects:
        print(f"[Result] SUSPECT files detected: {len(set(suspects))}", file=sys.stderr)
        return 1

    print("[Result] OK: no daylight semantic anomalies detected (within configured hours).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

