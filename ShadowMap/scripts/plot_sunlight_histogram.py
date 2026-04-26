#!/usr/bin/env python3

"""Plot histogram for daylight exposure metrics from `sunlight_daily_800.csv`.

Input is the daily report produced by:
  scripts/01_sunlight_data_description_800.py

Typical usage:
  python3 ShadowMap/scripts/plot_sunlight_histogram.py \
    --qc-dir "$QC_B_BUF20" \
    --metric sunlight_min_cloud_daylight \
    --out "$QC_B_BUF20/hist_eff_sunlight_buf20m.png"
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path
from typing import Optional


def _resolve_daily_csv(path: Path) -> Path:
    p = path.expanduser().resolve()
    if p.is_file():
        return p
    for c in (
        p / "数据" / "sunlight_daily_800.csv",
        p / "data" / "sunlight_daily_800.csv",
        p / "sunlight_daily_800.csv",
    ):
        if c.exists() and c.is_file():
            return c
    raise FileNotFoundError(f"daily_report_not_found: {p}")


def _fmt(x: Optional[float], digits: int = 2) -> str:
    if x is None:
        return ""
    return f"{x:.{digits}f}"


def _summary(values) -> dict[str, float]:
    values = [float(v) for v in values if v is not None]
    values = [v for v in values if v == v]  # NaN guard
    if not values:
        return {}
    values_sorted = sorted(values)
    n = len(values_sorted)
    def pct(p: float) -> float:
        if n == 1:
            return values_sorted[0]
        idx = int(round((n - 1) * p))
        idx = max(0, min(n - 1, idx))
        return values_sorted[idx]

    return {
        "n": float(n),
        "mean": float(sum(values_sorted) / n),
        "median": float(statistics.median(values_sorted)),
        "p90": float(pct(0.90)),
        "p95": float(pct(0.95)),
        "p99": float(pct(0.99)),
        "min": float(values_sorted[0]),
        "max": float(values_sorted[-1]),
        "zero_rate": float(sum(1 for v in values_sorted if v <= 0.0) / n),
    }


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="Plot histogram from sunlight_daily_800.csv")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--qc-dir", type=Path, help="QC output dir (contains 数据/sunlight_daily_800.csv)")
    g.add_argument("--daily-csv", type=Path, help="Path to sunlight_daily_800.csv")
    p.add_argument(
        "--metric",
        default="sunlight_min_cloud_daylight",
        help="Metric column name. Default: sunlight_min_cloud_daylight",
    )
    p.add_argument(
        "--mode",
        choices=("person-day", "person", "both"),
        default="both",
        help="Histogram mode. Default: both",
    )
    p.add_argument("--bins", type=int, default=60, help="Histogram bins. Default: 60")
    p.add_argument(
        "--clip-max",
        type=float,
        default=0.0,
        help="Optional: clip values above this max (0 disables). Useful for visualization only.",
    )
    p.add_argument(
        "--drop-zero",
        action="store_true",
        help="Drop zero values (visualization only). Default: keep zeros",
    )
    p.add_argument("--out", type=Path, default=Path("hist.png"), help="Output PNG path.")
    args = p.parse_args(argv)

    try:
        import pandas as pd
        import matplotlib.pyplot as plt
    except Exception as exc:
        print(f"[Fatal] Missing deps: need pandas + matplotlib: {exc}", file=sys.stderr)
        return 2

    daily_path = _resolve_daily_csv(args.daily_csv if args.daily_csv else args.qc_dir)
    df = pd.read_csv(daily_path, low_memory=False)
    metric = str(args.metric)
    if metric not in df.columns:
        print(f"[Fatal] metric not found: {metric}. Available: {list(df.columns)[:20]}...", file=sys.stderr)
        return 2

    def prep(series):
        s = pd.to_numeric(series, errors="coerce").dropna()
        if float(args.clip_max) > 0:
            s = s.clip(upper=float(args.clip_max))
        if bool(args.drop_zero):
            s = s[s > 0]
        return s

    panels = 1 if args.mode != "both" else 2
    fig, axes = plt.subplots(
        1,
        panels,
        figsize=(7.2 * panels, 4.6),
        dpi=200,
        constrained_layout=True,
    )
    if panels == 1:
        axes = [axes]

    out_stats = {}
    idx = 0
    if args.mode in ("person-day", "both"):
        s = prep(df[metric])
        ax = axes[idx]
        idx += 1
        ax.hist(s.values, bins=int(args.bins), color="#4C78A8", alpha=0.9, edgecolor="white")
        ax.set_title(f"Person-day: {metric}")
        ax.set_xlabel("Minutes / day")
        ax.set_ylabel("Count (person-days)")
        out_stats["person_day"] = _summary(s.values)

    if args.mode in ("person", "both"):
        if "ID" not in df.columns:
            print("[Fatal] column missing: ID (cannot compute per-person)", file=sys.stderr)
            return 2
        per = df.groupby("ID")[metric].mean()
        s = prep(per)
        ax = axes[idx]
        ax.hist(s.values, bins=int(args.bins), color="#F58518", alpha=0.9, edgecolor="white")
        ax.set_title(f"Per-person mean: {metric}")
        ax.set_xlabel("Minutes / day")
        ax.set_ylabel("Count (people)")
        out_stats["person"] = _summary(s.values)

    out_path = args.out.expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.suptitle(f"{daily_path.name} | mode={args.mode}", fontsize=10)
    fig.savefig(out_path)

    print(f"[Done] saved: {out_path}")
    for k, st in out_stats.items():
        if not st:
            continue
        print(
            f"[Stats:{k}] n={int(st['n'])} mean={_fmt(st['mean'])} median={_fmt(st['median'])} "
            f"p90={_fmt(st['p90'])} p95={_fmt(st['p95'])} zero_rate={_fmt(st['zero_rate']*100, 2)}%"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

