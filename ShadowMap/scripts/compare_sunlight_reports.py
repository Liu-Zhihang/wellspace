#!/usr/bin/env python3

"""Compare sunlight daily reports across multiple runs.

This script is designed to work with the outputs produced by:
  scripts/01_sunlight_data_description_800.py

That tool writes:
  <out>/数据/sunlight_daily_800.csv

We compute a compact comparison table for key metrics (window vs daylight),
including "有效日照量" which corresponds to:
  - sunlight_min_cloud_daylight (cloud+geometry, minutes)
  - sunlight_min_geom_daylight  (geometry only, minutes)
"""

from __future__ import annotations

import argparse
import csv
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple


def _to_float(value: object) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    try:
        return float(s)
    except Exception:
        return None


def _mean(values: List[float]) -> Optional[float]:
    return None if not values else (sum(values) / len(values))


def _median(values: List[float]) -> Optional[float]:
    return None if not values else statistics.median(values)


def _fmt(value: Optional[float], *, digits: int = 2) -> str:
    if value is None:
        return ""
    return f"{value:.{digits}f}"


def _resolve_daily_csv(path: Path) -> Path:
    p = path.expanduser().resolve()
    if p.is_file():
        return p

    # Common output layout from 01_sunlight_data_description_800.py
    candidates = [
        p / "数据" / "sunlight_daily_800.csv",
        p / "data" / "sunlight_daily_800.csv",
        p / "sunlight_daily_800.csv",
    ]
    for c in candidates:
        if c.exists() and c.is_file():
            return c

    raise FileNotFoundError(f"daily_report_not_found: {p}")


def _read_rows(csv_path: Path) -> List[Dict[str, str]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        return [dict(row) for row in reader]


@dataclass
class RunStats:
    label: str
    people: int
    person_days: int

    window_hours_mean: Optional[float]
    window_hours_median: Optional[float]
    daylight_hours_mean: Optional[float]
    daylight_hours_median: Optional[float]

    eff_sun_min_mean: Optional[float]
    eff_sun_min_median: Optional[float]
    geom_sun_min_mean: Optional[float]
    geom_sun_min_median: Optional[float]

    eff_ratio_mean_pct: Optional[float]
    eff_ratio_median_pct: Optional[float]

    # Unweighted per-person averages (each participant contributes equally)
    window_hours_mean_person: Optional[float]
    daylight_hours_mean_person: Optional[float]
    eff_sun_min_mean_person: Optional[float]
    geom_sun_min_mean_person: Optional[float]
    eff_ratio_mean_person_pct: Optional[float]


def _compute_run_stats(label: str, rows: List[Dict[str, str]]) -> RunStats:
    ids: set[str] = set()
    window_hours: List[float] = []
    daylight_hours: List[float] = []
    eff_sun_min: List[float] = []
    geom_sun_min: List[float] = []
    eff_ratio_pct: List[float] = []

    per_person: Dict[str, Dict[str, float]] = {}
    per_person_counts: Dict[str, Dict[str, int]] = {}

    def add_person_value(pid: str, key: str, value: float) -> None:
        if pid not in per_person:
            per_person[pid] = {}
            per_person_counts[pid] = {}
        per_person[pid][key] = per_person[pid].get(key, 0.0) + value
        per_person_counts[pid][key] = per_person_counts[pid].get(key, 0) + 1

    for row in rows:
        pid = (row.get("ID") or row.get("id") or "").strip()
        if not pid:
            continue
        ids.add(pid)

        tracked_min = _to_float(row.get("tracked_min"))
        if tracked_min is not None:
            h = tracked_min / 60.0
            window_hours.append(h)
            add_person_value(pid, "window_hours", h)

        tracked_min_day = _to_float(row.get("tracked_min_daylight"))
        if tracked_min_day is not None:
            h = tracked_min_day / 60.0
            daylight_hours.append(h)
            add_person_value(pid, "daylight_hours", h)

        eff_min = _to_float(row.get("sunlight_min_cloud_daylight"))
        if eff_min is not None:
            eff_sun_min.append(eff_min)
            add_person_value(pid, "eff_sun_min", eff_min)

        geom_min = _to_float(row.get("sunlight_min_geom_daylight"))
        if geom_min is not None:
            geom_sun_min.append(geom_min)
            add_person_value(pid, "geom_sun_min", geom_min)

        ratio = _to_float(row.get("sunlight_ratio_cloud_daylight"))
        if ratio is not None:
            eff_ratio_pct.append(ratio)
            add_person_value(pid, "eff_ratio_pct", ratio)

    def person_means(key: str) -> List[float]:
        out: List[float] = []
        for pid in per_person.keys():
            s = per_person[pid].get(key)
            n = per_person_counts[pid].get(key, 0)
            if s is None or n <= 0:
                continue
            out.append(s / n)
        return out

    window_person = person_means("window_hours")
    daylight_person = person_means("daylight_hours")
    eff_min_person = person_means("eff_sun_min")
    geom_min_person = person_means("geom_sun_min")
    eff_ratio_person = person_means("eff_ratio_pct")

    return RunStats(
        label=label,
        people=len(ids),
        person_days=len(rows),
        window_hours_mean=_mean(window_hours),
        window_hours_median=_median(window_hours),
        daylight_hours_mean=_mean(daylight_hours),
        daylight_hours_median=_median(daylight_hours),
        eff_sun_min_mean=_mean(eff_sun_min),
        eff_sun_min_median=_median(eff_sun_min),
        geom_sun_min_mean=_mean(geom_sun_min),
        geom_sun_min_median=_median(geom_sun_min),
        eff_ratio_mean_pct=_mean(eff_ratio_pct),
        eff_ratio_median_pct=_median(eff_ratio_pct),
        window_hours_mean_person=_mean(window_person),
        daylight_hours_mean_person=_mean(daylight_person),
        eff_sun_min_mean_person=_mean(eff_min_person),
        geom_sun_min_mean_person=_mean(geom_min_person),
        eff_ratio_mean_person_pct=_mean(eff_ratio_person),
    )


def _stats_to_row(st: RunStats) -> Dict[str, str]:
    return {
        "label": st.label,
        "people": str(st.people),
        "person_days": str(st.person_days),
        "window_hours_mean": _fmt(st.window_hours_mean, digits=2),
        "window_hours_median": _fmt(st.window_hours_median, digits=2),
        "daylight_hours_mean": _fmt(st.daylight_hours_mean, digits=2),
        "daylight_hours_median": _fmt(st.daylight_hours_median, digits=2),
        "eff_sun_min_mean": _fmt(st.eff_sun_min_mean, digits=2),
        "eff_sun_min_median": _fmt(st.eff_sun_min_median, digits=2),
        "geom_sun_min_mean": _fmt(st.geom_sun_min_mean, digits=2),
        "geom_sun_min_median": _fmt(st.geom_sun_min_median, digits=2),
        "eff_ratio_mean_pct": _fmt(st.eff_ratio_mean_pct, digits=2),
        "eff_ratio_median_pct": _fmt(st.eff_ratio_median_pct, digits=2),
        "window_hours_mean_person": _fmt(st.window_hours_mean_person, digits=2),
        "daylight_hours_mean_person": _fmt(st.daylight_hours_mean_person, digits=2),
        "eff_sun_min_mean_person": _fmt(st.eff_sun_min_mean_person, digits=2),
        "geom_sun_min_mean_person": _fmt(st.geom_sun_min_mean_person, digits=2),
        "eff_ratio_mean_person_pct": _fmt(st.eff_ratio_mean_person_pct, digits=2),
    }


def _print_markdown(rows: List[Dict[str, str]]) -> None:
    headers = [
        "label",
        "people",
        "person_days",
        "daylight_hours_mean",
        "eff_sun_min_mean",
        "geom_sun_min_mean",
        "eff_ratio_mean_pct",
        "daylight_hours_mean_person",
        "eff_sun_min_mean_person",
        "eff_ratio_mean_person_pct",
    ]
    print("\n[对照表]（日层面=按人天加权；person=每人等权）")
    print("| " + " | ".join(headers) + " |")
    print("|" + "|".join(["---"] * len(headers)) + "|")
    for r in rows:
        print("| " + " | ".join(r.get(h, "") for h in headers) + " |")


def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(description="Compare sunlight daily reports across runs")
    p.add_argument(
        "--report",
        action="append",
        default=[],
        help="Run spec: LABEL=PATH (PATH can be a report dir or a sunlight_daily_800.csv file). Repeatable.",
    )
    p.add_argument("--out", default="", help="Optional output CSV path to write comparison table.")
    args = p.parse_args(argv)

    if not args.report:
        print("[Fatal] Provide at least one --report LABEL=PATH", file=sys.stderr)
        return 2

    stats: List[RunStats] = []
    for spec in args.report:
        if "=" not in spec:
            print(f"[Fatal] invalid --report (expected LABEL=PATH): {spec}", file=sys.stderr)
            return 2
        label, raw_path = spec.split("=", 1)
        label = label.strip()
        if not label:
            print(f"[Fatal] empty label in --report: {spec}", file=sys.stderr)
            return 2
        daily_csv = _resolve_daily_csv(Path(raw_path.strip()))
        rows = _read_rows(daily_csv)
        stats.append(_compute_run_stats(label, rows))

    rows_out = [_stats_to_row(s) for s in stats]
    _print_markdown(rows_out)

    if args.out:
        out_path = Path(args.out).expanduser().resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        headers = list(rows_out[0].keys())
        with out_path.open("w", encoding="utf-8", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=headers, lineterminator="\n")
            w.writeheader()
            w.writerows(rows_out)
        print(f"\n[Done] CSV saved: {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

