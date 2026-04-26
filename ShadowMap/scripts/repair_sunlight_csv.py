#!/usr/bin/env python3

"""Repair malformed `*-sunlight.csv` outputs.

Repairs focus on one thing: restore column alignment so that CSV parsers can read
the output deterministically.

Common failure modes:
- Unquoted commas in `errorDetail` (e.g. JSON strings) -> extra columns.
- Older writers missing a column (often `irradianceEffective`) -> duration fields shift.

This tool:
- Normalizes each row length to match the header length.
- Merges overflow columns into `errorDetail` (if present).
- Inserts a missing empty field near the weather/duration boundary when it looks
  like an old schema row.
- Writes output using Python's csv.writer (with quoting) and sanitizes newlines.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


def iter_sunlight_files(root: Path) -> Iterable[Path]:
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith("-sunlight.csv"):
                yield Path(dirpath) / name


def _format_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.replace("\r", " ").replace("\n", " ")
    return str(value)


def _try_float(value: str) -> Optional[float]:
    raw = value.strip()
    if not raw:
        return None
    try:
        return float(raw)
    except Exception:
        return None


@dataclass
class FixStats:
    rows: int = 0
    fixed_overflow: int = 0
    fixed_underflow: int = 0
    padded: int = 0
    truncated: int = 0
    sanitized: int = 0


def _merge_overflow_into_error_detail(fields: list[str], header: list[str], expected_len: int) -> list[str]:
    if len(fields) <= expected_len:
        return fields
    if "errorDetail" not in header:
        return fields[:expected_len]
    idx = header.index("errorDetail")
    if idx >= len(fields):
        return fields[:expected_len]

    overflow = len(fields) - expected_len
    end = idx + overflow + 1
    merged = ",".join(fields[idx:end])
    return fields[:idx] + [merged] + fields[end:]


def _best_insert_index_for_missing_field(fields: list[str], header: list[str]) -> Optional[int]:
    if "durationSeconds" not in header:
        return None
    if "irradianceEffective" not in header:
        return None

    idx_dur = header.index("durationSeconds")
    idx_ie = header.index("irradianceEffective")

    # Heuristic: if the value sitting at irradianceEffective looks like a duration (1..300),
    # it's usually an old row missing irradianceEffective (so duration shifted left).
    if idx_ie < len(fields):
        maybe_dur = _try_float(fields[idx_ie])
        if maybe_dur is not None and 1.0 <= maybe_dur <= 300.0:
            # Only apply when durationSeconds would otherwise point into the tail.
            if idx_dur == idx_ie + 1:
                return idx_ie

    # Fallback: try inserting at likely "weather tail" boundary.
    for name in ("solarIrradianceWm2", "irradianceEffective"):
        if name in header:
            pos = header.index(name)
            if pos <= len(fields):
                return pos
    return None


def _is_numeric_or_blank(value: str) -> bool:
    return _try_float(value) is not None or not (value or "").strip()


def _sanitize_corrupt_error_row(fields: list[str], header: list[str], stats: FixStats) -> list[str]:
    if not header:
        return fields

    idx = {name: header.index(name) for name in header if name in header}
    src_i = idx.get("source")
    if src_i is None or src_i >= len(fields):
        return fields
    src = (fields[src_i] or "").strip()
    if src != "fallback_error":
        return fields

    # Detect a common corruption pattern: HTTP error JSON fragments spilled into numeric columns,
    # and derived sunlight fields become non-sense even when sunlit==0.
    sunlit_i = idx.get("sunlit")
    sunlit_eff_i = idx.get("sunlitEffective")

    sunlit_val = _try_float(fields[sunlit_i]) if sunlit_i is not None and sunlit_i < len(fields) else None
    sunlit_eff_val = (
        _try_float(fields[sunlit_eff_i]) if sunlit_eff_i is not None and sunlit_eff_i < len(fields) else None
    )

    fragments: list[str] = []
    err_i = idx.get("errorDetail")
    if err_i is not None and err_i < len(fields):
        fragments.append(fields[err_i])

    corruption = False
    for name in ("cloudCover", "sunlightFactor", "solarIrradianceWm2", "irradianceEffective"):
        i = idx.get(name)
        if i is None or i >= len(fields):
            continue
        raw = fields[i]
        if raw and not _is_numeric_or_blank(raw):
            corruption = True
            fragments.append(raw)

    if sunlit_val == 0 and sunlit_eff_val is not None and sunlit_eff_val > 0:
        corruption = True

    if not corruption:
        return fields

    # Merge spilled fragments into errorDetail and clear numeric columns.
    merged = " | ".join([f.strip() for f in fragments if (f or "").strip()])
    if err_i is not None and err_i < len(fields):
        fields[err_i] = merged

    for name in ("cloudCover", "sunlightFactor", "solarIrradianceWm2", "irradianceEffective"):
        i = idx.get(name)
        if i is not None and i < len(fields) and not _is_numeric_or_blank(fields[i]):
            fields[i] = ""

    # Clear invalid derived sunlight fields and force derived totals to 0.
    for name in ("sunlitEffective", "shadowPercentEffective"):
        i = idx.get(name)
        if i is not None and i < len(fields):
            fields[i] = ""
    for name in ("sunlightSeconds", "shadowSeconds", "irradianceJ"):
        i = idx.get(name)
        if i is not None and i < len(fields):
            fields[i] = "0"

    stats.sanitized += 1
    return fields


def normalize_row(fields: list[str], header: list[str], stats: FixStats) -> list[str]:
    expected_len = len(header)
    if expected_len == 0:
        return fields

    if len(fields) > expected_len:
        before = len(fields)
        fields = _merge_overflow_into_error_detail(fields, header, expected_len)
        if len(fields) != before:
            stats.fixed_overflow += 1
        if len(fields) > expected_len:
            stats.truncated += 1
            fields = fields[:expected_len]

    if len(fields) < expected_len:
        # Try fix a single missing field near the weather/duration boundary (common legacy schema).
        if len(fields) == expected_len - 1:
            insert_at = _best_insert_index_for_missing_field(fields, header)
            if insert_at is not None:
                fields = fields[:insert_at] + [""] + fields[insert_at:]
                stats.fixed_underflow += 1

        if len(fields) < expected_len:
            stats.padded += 1
            fields = fields + [""] * (expected_len - len(fields))

    return _sanitize_corrupt_error_row(fields, header, stats)


def repair_file(src: Path, dst: Path) -> FixStats:
    stats = FixStats()
    dst.parent.mkdir(parents=True, exist_ok=True)

    with src.open("r", encoding="utf-8", newline="") as in_fh, dst.open(
        "w", encoding="utf-8", newline=""
    ) as out_fh:
        reader = csv.reader(in_fh)
        writer = csv.writer(out_fh, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)

        header = next(reader, None)
        if not header:
            return stats
        header = [str(h) for h in header]
        writer.writerow(header)

        for row in reader:
            stats.rows += 1
            fields = [str(x) for x in row]
            fields = normalize_row(fields, header, stats)
            writer.writerow([_format_cell(v) for v in fields])

    return stats


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Repair malformed *-sunlight.csv outputs")
    parser.add_argument("--root", required=True, help="Root directory containing district subfolders (e.g. GLAN_processed)")
    parser.add_argument(
        "--bad-list",
        default="",
        help="Optional: newline-separated list of files to repair (relative to --root, or absolute).",
    )
    parser.add_argument(
        "--output-root",
        default="",
        help="Optional: write repaired copies under this directory (preserving relative paths).",
    )
    parser.add_argument("--write", action="store_true", help="Actually write repaired files (required).")
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Overwrite in-place without moving originals (use only if you already have backups).",
    )
    parser.add_argument(
        "--backup-dir",
        default="",
        help="When repairing in-place, move originals into this directory (default: <root>/_repair_backup_<ts>).",
    )
    parser.add_argument("--limit-files", type=int, default=0, help="Optional: stop after N files (0 = no limit).")
    args = parser.parse_args(argv)

    if not args.write:
        print("[Fatal] missing --write (refusing to modify outputs).", file=sys.stderr)
        return 2

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    if args.output_root:
        output_root = Path(args.output_root).expanduser().resolve()
        backup_dir = None
    else:
        output_root = root
        if args.no_backup:
            backup_dir = None
        else:
            backup_dir = (
                Path(args.backup_dir).expanduser().resolve()
                if args.backup_dir
                else root / f"_repair_backup_{time.strftime('%Y-%m-%d_%H%M%S')}"
            )
            backup_dir.mkdir(parents=True, exist_ok=True)

    # Determine target files.
    targets: list[Path] = []
    if args.bad_list:
        bad_list_path = Path(args.bad_list).expanduser()
        text = bad_list_path.read_text(encoding="utf-8")
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            p = Path(line)
            if not p.is_absolute():
                p = root / p
            targets.append(p)
    else:
        targets = list(iter_sunlight_files(root))

    repaired = 0
    total = 0
    for src in targets:
        if not src.exists():
            continue
        total += 1
        if args.limit_files > 0 and total > args.limit_files:
            break

        try:
            rel = src.relative_to(root)
        except Exception:
            rel = Path(src.name)

        dst = output_root / rel
        tmp = dst.with_name(dst.name + f".tmp.{os.getpid()}")
        stats = repair_file(src, tmp)

        if backup_dir is not None:
            backup_path = backup_dir / rel
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            src.replace(backup_path)
            tmp.replace(dst)
        else:
            # Overwrite in-place or to output_root (no backup).
            tmp.replace(dst)

        repaired += 1
        print(
            f"[Repaired][{repaired}/{len(targets)}] {rel} rows={stats.rows} "
            f"overflow={stats.fixed_overflow} underflow={stats.fixed_underflow} "
            f"sanitized={stats.sanitized} padded={stats.padded} truncated={stats.truncated}"
        )

    print(f"[Done] repaired={repaired} root={root} output_root={output_root}")
    if backup_dir is not None:
        print(f"[Backup] {backup_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
