#!/usr/bin/env python3

"""Recompute cloud attenuation (`sunlightFactor`) and dependent fields in `*-sunlight.csv`.

This is a post-processing tool. It does NOT recompute geometry shadows, canopy, or ERA5.
Use it to run sensitivity analyses (e.g., removing the 0.15 lower bound) quickly on
already-computed sunlight outputs.

What it updates (when inputs are available):
- sunlightFactor
- sunlitEffective
- shadowPercentEffective
- sunlightSeconds
- shadowSeconds

It intentionally does NOT change:
- solarIrradianceWm2 / irradianceEffective / irradianceJ
  (ERA5 `ssrd` already includes cloud effects; those energy metrics are physical.)
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional, Sequence, Tuple


def iter_sunlight_files(root: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith("_")]
        for name in filenames:
            if name.lower().endswith("-sunlight.csv"):
                yield Path(dirpath) / name


def read_file_list(file_list: Path) -> list[str]:
    text = file_list.read_text(encoding="utf-8")
    out: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _parse_float(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def _format_float(v: float) -> str:
    if v == 0.0:
        return "0"
    if v == 1.0:
        return "1"
    # keep short & stable
    return f"{v:.6f}".rstrip("0").rstrip(".")


def _safe_header_index(headers: list[str], name: str) -> int:
    try:
        return headers.index(name)
    except ValueError:
        return -1


@dataclass
class FileStats:
    rows: int = 0
    rows_weather: int = 0
    rows_impacted: int = 0
    sunlight_seconds_delta: float = 0.0
    sunlight_seconds_old_total: float = 0.0
    sunlight_seconds_new_total: float = 0.0


def recompute_row(
    row: Dict[str, str],
    *,
    coef: float,
    min_factor: float,
    compare_min_factor: Optional[float],
) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    cf = _parse_float(row.get("cloudCover"))
    if cf is None:
        return None, None, None
    cf = clamp(cf, 0.0, 1.0)

    base = 1.0 - cf * coef
    factor_new = max(min_factor, base)
    factor_old = None if compare_min_factor is None else max(compare_min_factor, base)
    return cf, factor_new, factor_old


def process_file(
    src: Path,
    dst: Path,
    *,
    coef: float,
    min_factor: float,
    compare_min_factor: Optional[float],
    write: bool,
) -> FileStats:
    stats = FileStats()

    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dst.with_name(f"{dst.name}.tmp.{os.getpid()}")

    with src.open("r", encoding="utf-8", newline="") as in_fh:
        reader = csv.DictReader(in_fh)
        headers = list(reader.fieldnames or [])
        if not headers:
            return stats

        needed = {"sunlit", "cloudCover", "durationSeconds"}
        if not needed.issubset(set(headers)):
            return stats

        if write:
            out_fh = tmp_path.open("w", encoding="utf-8", newline="")
            writer = csv.DictWriter(out_fh, fieldnames=headers, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
            writer.writeheader()
        else:
            out_fh = None
            writer = None

        try:
            for row in reader:
                stats.rows += 1

                source = (row.get("source") or "").strip().lower()
                if source == "night":
                    if writer:
                        writer.writerow(row)
                    continue

                sunlit = _parse_float(row.get("sunlit"))
                dur = _parse_float(row.get("durationSeconds"))
                if sunlit is None or dur is None:
                    if writer:
                        writer.writerow(row)
                    continue

                cf, factor_new, factor_old = recompute_row(
                    row,
                    coef=coef,
                    min_factor=min_factor,
                    compare_min_factor=compare_min_factor,
                )
                if cf is None or factor_new is None:
                    if writer:
                        writer.writerow(row)
                    continue

                stats.rows_weather += 1

                sunlight_seconds_old = _parse_float(row.get("sunlightSeconds"))
                if sunlight_seconds_old is not None:
                    stats.sunlight_seconds_old_total += float(sunlight_seconds_old)

                sunlit_effective = float(sunlit) * float(factor_new)
                shadow_percent_effective = 100.0 - sunlit_effective * 100.0
                sunlight_seconds_new = sunlit_effective * float(dur)
                shadow_seconds_new = (shadow_percent_effective / 100.0) * float(dur)
                stats.sunlight_seconds_new_total += float(sunlight_seconds_new)

                row["sunlightFactor"] = _format_float(float(factor_new))
                row["sunlitEffective"] = _format_float(sunlit_effective)
                row["shadowPercentEffective"] = _format_float(shadow_percent_effective)
                row["sunlightSeconds"] = _format_float(sunlight_seconds_new)
                row["shadowSeconds"] = _format_float(shadow_seconds_new)

                if factor_old is not None:
                    sunlight_seconds_old = float(sunlit) * float(factor_old) * float(dur)
                    delta = sunlight_seconds_new - sunlight_seconds_old
                    if abs(delta) > 1e-9:
                        stats.rows_impacted += 1
                        stats.sunlight_seconds_delta += delta

                if writer:
                    writer.writerow(row)
        finally:
            if out_fh is not None:
                out_fh.close()

    if write:
        os.replace(tmp_path, dst)
    else:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass
    return stats


def _run_one(
    src_path: str,
    dst_path: str,
    rel_path: str,
    *,
    coef: float,
    min_factor: float,
    compare_min_factor: Optional[float],
    write: bool,
) -> Tuple[str, FileStats]:
    st = process_file(
        Path(src_path),
        Path(dst_path),
        coef=coef,
        min_factor=min_factor,
        compare_min_factor=compare_min_factor,
        write=write,
    )
    return rel_path, st


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(description="Recompute sunlightFactor/sunlitEffective in *-sunlight.csv")
    parser.add_argument("--root", required=True, help="Root directory containing *-sunlight.csv files")
    parser.add_argument("--out-root", default="", help="Write outputs to a new root directory (recommended).")
    parser.add_argument("--in-place", action="store_true", help="Rewrite files in place.")
    parser.add_argument("--write", action="store_true", help="Actually write outputs. Default: dry-run stats only.")
    parser.add_argument("--files-list", default="", help="Optional file list (paths relative to --root).")
    parser.add_argument("--limit-files", type=int, default=0, help="Optional: stop after N files (0 = no limit).")
    parser.add_argument("--workers", type=int, default=1, help="Parallel workers (file-level). Default: 1")
    parser.add_argument("--no-resume", action="store_true", help="Do not skip existing destination files.")
    parser.add_argument("--coef", type=float, default=0.85, help="Cloud attenuation coefficient. Default: 0.85")
    parser.add_argument(
        "--min-factor",
        type=float,
        default=0.15,
        help="Lower bound for sunlightFactor. Set to 0 to remove the 0.15 floor. Default: 0.15",
    )
    parser.add_argument(
        "--compare-min-factor",
        type=float,
        default=None,
        help="Optional: also compute delta vs this min-factor (for sensitivity). Example: --compare-min-factor 0.15",
    )
    args = parser.parse_args(list(argv))

    root = Path(args.root).expanduser().resolve()
    if not root.exists():
        print(f"[Fatal] root not found: {root}", file=sys.stderr)
        return 2

    workers = int(args.workers)
    if workers < 1:
        print("[Fatal] --workers must be >= 1", file=sys.stderr)
        return 2

    coef = float(args.coef)
    min_factor = float(args.min_factor)
    compare_min = None if args.compare_min_factor is None else float(args.compare_min_factor)

    if min_factor < 0:
        print("[Fatal] --min-factor must be >= 0", file=sys.stderr)
        return 2

    out_root_raw = str(args.out_root).strip()
    if args.write:
        if not out_root_raw and not args.in_place:
            print("[Fatal] When --write, provide --out-root or use --in-place.", file=sys.stderr)
            return 2
    out_root = Path(out_root_raw).expanduser().resolve() if out_root_raw else root

    if args.files_list:
        file_list = Path(args.files_list).expanduser().resolve()
        rels = read_file_list(file_list)
        files = [root / rel for rel in rels]
    else:
        files = list(iter_sunlight_files(root))

    if args.limit_files > 0:
        files = files[: int(args.limit_files)]

    if not files:
        print(f"[Fatal] no *-sunlight.csv files under {root}", file=sys.stderr)
        return 2

    print(f"[Scan] files={len(files)} root={root}")
    print(
        f"[Config] write={bool(args.write)} in_place={bool(args.in_place)} out_root={out_root} workers={workers} "
        f"coef={coef} min_factor={min_factor} compare_min_factor={compare_min}"
    )

    resume = (not bool(args.no_resume)) and bool(args.write)
    jobs: list[Tuple[str, str, str]] = []
    skipped_existing = 0
    for src in files:
        if not src.exists():
            print(f"[Skip] missing: {src}", file=sys.stderr)
            continue
        try:
            rel = src.relative_to(root)
        except Exception:
            rel = Path(src.name)
        dst = (out_root / rel) if not args.in_place else src
        if resume and dst.exists() and dst.stat().st_size > 0:
            skipped_existing += 1
            continue
        jobs.append((str(src), str(dst), str(rel)))

    if skipped_existing:
        print(f"[Resume] skipped_existing={skipped_existing}")

    started = time.time()
    total = FileStats()
    completed = 0

    def merge(st: FileStats) -> None:
        total.rows += st.rows
        total.rows_weather += st.rows_weather
        total.rows_impacted += st.rows_impacted
        total.sunlight_seconds_delta += st.sunlight_seconds_delta
        total.sunlight_seconds_old_total += st.sunlight_seconds_old_total
        total.sunlight_seconds_new_total += st.sunlight_seconds_new_total

    if workers == 1:
        for src_path, dst_path, rel_path in jobs:
            _, st = _run_one(
                src_path,
                dst_path,
                rel_path,
                coef=coef,
                min_factor=min_factor,
                compare_min_factor=compare_min,
                write=bool(args.write),
            )
            completed += 1
            merge(st)
            if completed % 10 == 0 or completed == len(jobs):
                elapsed = int(round(time.time() - started))
                print(
                    f"[Progress] {completed}/{len(jobs)} rows={total.rows} weather_rows={total.rows_weather} "
                    f"impacted_rows={total.rows_impacted} elapsed={elapsed}s"
                )
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futures = [
                ex.submit(
                    _run_one,
                    src_path,
                    dst_path,
                    rel_path,
                    coef=coef,
                    min_factor=min_factor,
                    compare_min_factor=compare_min,
                    write=bool(args.write),
                )
                for src_path, dst_path, rel_path in jobs
            ]
            for fut in as_completed(futures):
                _, st = fut.result()
                completed += 1
                merge(st)
                if completed % 10 == 0 or completed == len(jobs):
                    elapsed = int(round(time.time() - started))
                    print(
                        f"[Progress] {completed}/{len(jobs)} rows={total.rows} weather_rows={total.rows_weather} "
                        f"impacted_rows={total.rows_impacted} elapsed={elapsed}s"
                    )

    elapsed = int(round(time.time() - started))
    delta_min = total.sunlight_seconds_delta / 60.0
    old_min = total.sunlight_seconds_old_total / 60.0
    new_min = total.sunlight_seconds_new_total / 60.0
    pct = 0.0 if old_min == 0 else ((new_min - old_min) / old_min) * 100.0
    print(
        f"[Done] files={len(files)} processed={len(jobs)} skipped_existing={skipped_existing} "
        f"rows={total.rows} weather_rows={total.rows_weather} impacted_rows={total.rows_impacted} "
        f"sunlight_old_min={old_min:.2f} sunlight_new_min={new_min:.2f} sunlight_delta_min={delta_min:.2f} "
        f"sunlight_delta_pct={pct:.2f}% elapsed={elapsed}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
