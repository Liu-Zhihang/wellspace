# -*- coding: utf-8 -*-
"""
GLAN_processed_800 阳光暴露数据处理与质量检查

功能：
- 扫描原始 sunlight 文件（四区）并去重（同一 ID 取最大文件）。
- 逐文件聚合日层面/小时层面/个体层面暴露指标。
- 输出核心质量检查（零暴露比例、失败文件）。
- 生成 24 小时极坐标图和描述性多面板图。

输出目录：项目根目录/新结果

口径说明（用于对齐分析）：
- “窗口口径（window）”：仅按本地时间筛选 [DAY_START, DAY_END)（默认 05:00–20:00），用于行为覆盖统计。
- “日照口径（daylight）”：在 window 的基础上，进一步按 `source != night`（或 `solarIrradianceWm2 > 0`）筛选，仅用于归因拆解
  （几何遮挡、云量衰减等）。否则会把夜晚误算为“遮挡”。
"""

from __future__ import annotations

import argparse
import glob
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# 兼容旧脚本默认路径（可通过 CLI 覆盖）
RAW_DIR = PROJECT_ROOT / "数据" / "GLAN_processed_800"
OUT_DIR = PROJECT_ROOT / "新结果"
OUT_DATA_DIR = OUT_DIR / "数据"
OUT_FIG_DIR = OUT_DIR / "图"

FILE_GLOB = "*-sunlight.csv"

DAY_START = 5
DAY_END = 20
TIMEZONE = "Asia/Hong_Kong"

REGIONS = ["CW", "ST", "KT", "KQ"]
REGION_NAMES = {
    "CW": "Central & Western",
    "ST": "Sha Tin",
    "KT": "Kwun Tong",
    "KQ": "Kwai Tsing",
}
REGION_COLORS = {
    "CW": "#E64B35",
    "ST": "#4DBBD5",
    "KT": "#00A087",
    "KQ": "#3C5488",
}

SUN_COLS = ["sunlightSeconds", "sunlight_seconds"]
DUR_COLS = ["durationSeconds", "duration_seconds"]
IRR_COLS = ["irradianceJ", "irradiance_j"]
EFF_COLS = ["sunlitEffective", "sunlit_effective"]
SUNLIT_COLS = ["sunlit"]
SHADOW_COLS = ["shadowPercent", "shadow_percent"]
INDOOR_COLS = ["indoor"]
TIME_COLS = ["bucketStart", "timestamp"]
SOLAR_COLS = ["solarIrradianceWm2", "solar_irradiance_wm2"]
SOURCE_COLS = ["source"]


@dataclass
class FileRecord:
    pid: str
    region: str
    path: Path
    size: int


def _pick_first(columns: Iterable[str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in columns:
            return c
    return None


def _parse_pid(filename: str) -> str:
    base = filename.split("-")[0]
    return base.replace("T", "").replace("t", "")


def _parse_datetime(df: pd.DataFrame) -> pd.Series | None:
    if "bucketStart" in df.columns:
        dt = pd.to_datetime(df["bucketStart"], errors="coerce", utc=True)
    elif "timestamp" in df.columns:
        dt = pd.to_datetime(pd.to_numeric(df["timestamp"], errors="coerce"),
                            unit="s", errors="coerce", utc=True)
    else:
        return None

    if dt.isna().all():
        return None

    return dt.dt.tz_convert(TIMEZONE).dt.tz_localize(None)


def _safe_numeric(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce").fillna(0)


def collect_files() -> tuple[pd.DataFrame, pd.DataFrame]:
    records = []
    for region in REGIONS:
        region_dir = RAW_DIR / region
        if not region_dir.exists():
            continue
        pattern = str(region_dir / "**" / FILE_GLOB)
        for f in glob.glob(pattern, recursive=True):
            if "sunlight-sunlight" in f:
                continue
            path = Path(f)
            pid = _parse_pid(path.name)
            size = path.stat().st_size
            records.append(FileRecord(pid=pid, region=region, path=path, size=size))

    if not records:
        return pd.DataFrame(), pd.DataFrame()

    df = pd.DataFrame([r.__dict__ for r in records])
    df_sorted = df.sort_values("size", ascending=False)
    df_dedup = df_sorted.drop_duplicates(subset=["pid"], keep="first")
    dup_df = df_sorted[df_sorted.duplicated(subset=["pid"], keep="first")].copy()

    df_dedup.to_csv(OUT_DATA_DIR / "file_inventory_800.csv", index=False, encoding="utf-8-sig")
    if not dup_df.empty:
        dup_df.to_csv(OUT_DATA_DIR / "duplicate_files_800.csv", index=False, encoding="utf-8-sig")

    return df_dedup, dup_df


def _aggregate_frames(df: pd.DataFrame, record: FileRecord, sun_col: str,
                      dur_col: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    daily = df.groupby(["date"]).agg(
        sunlight_seconds=(sun_col, "sum"),
        sunlight_geom_seconds=("_geom_seconds", "sum"),
        sunlight_seconds_daylight=("_sunlight_seconds_daylight", "sum"),
        sunlight_geom_seconds_daylight=("_geom_seconds_daylight", "sum"),
        duration_seconds=(dur_col, "sum"),
        duration_seconds_daylight=("_duration_seconds_daylight", "sum"),
        irradiance_j=("_energy_j", "sum"),
        irradiance_j_daylight=("_energy_j_daylight", "sum"),
        records_count=(sun_col, "count"),
        cloud_adj_seconds=("_cloud_adj_seconds", "sum"),
        cloud_adj_seconds_daylight=("_cloud_adj_seconds_daylight", "sum"),
        daylight_rows=("_is_daylight", "sum"),
    ).reset_index()

    daily["ID"] = record.pid
    daily["Region"] = record.region
    daily["sunlight_min_cloud"] = daily["sunlight_seconds"] / 60
    daily["sunlight_min_geom"] = daily["sunlight_geom_seconds"] / 60
    daily["sunlight_min_cloud_daylight"] = daily["sunlight_seconds_daylight"] / 60
    daily["sunlight_min_geom_daylight"] = daily["sunlight_geom_seconds_daylight"] / 60
    daily["sunlight_min"] = daily["sunlight_min_cloud"]
    daily["tracked_min"] = daily["duration_seconds"] / 60
    daily["tracked_min_daylight"] = daily["duration_seconds_daylight"] / 60
    daily["energy_kJ"] = daily["irradiance_j"] / 1000
    daily["irradiance_kJ"] = daily["energy_kJ"]
    daily["cloud_adj_min"] = daily["sunlight_min_cloud"]
    daily["daylight_share"] = np.where(
        daily["duration_seconds"] > 0,
        daily["duration_seconds_daylight"] / daily["duration_seconds"],
        np.nan,
    )
    daily["sunlight_ratio_cloud"] = np.where(
        daily["tracked_min"] > 0,
        daily["sunlight_min_cloud"] / daily["tracked_min"] * 100,
        np.nan,
    )
    daily["sunlight_ratio_geom"] = np.where(
        daily["tracked_min"] > 0,
        daily["sunlight_min_geom"] / daily["tracked_min"] * 100,
        np.nan,
    )
    daily["sunlight_ratio_cloud_daylight"] = np.where(
        daily["tracked_min_daylight"] > 0,
        daily["sunlight_min_cloud_daylight"] / daily["tracked_min_daylight"] * 100,
        np.nan,
    )
    daily["sunlight_ratio_geom_daylight"] = np.where(
        daily["tracked_min_daylight"] > 0,
        daily["sunlight_min_geom_daylight"] / daily["tracked_min_daylight"] * 100,
        np.nan,
    )
    daily["sunlight_ratio"] = daily["sunlight_ratio_cloud"]

    def _sum_period(col: str, start: int, end: int) -> pd.Series:
        subset = df[(df["hour"] >= start) & (df["hour"] < end)]
        if subset.empty:
            return pd.Series(dtype=float)
        return subset.groupby("date")[col].sum()

    morning_cloud = _sum_period(sun_col, 6, 10) / 60
    midday_cloud = _sum_period(sun_col, 10, 14) / 60
    afternoon_cloud = _sum_period(sun_col, 14, 18) / 60
    morning_cloud_daylight = _sum_period("_sunlight_seconds_daylight", 6, 10) / 60
    midday_cloud_daylight = _sum_period("_sunlight_seconds_daylight", 10, 14) / 60
    afternoon_cloud_daylight = _sum_period("_sunlight_seconds_daylight", 14, 18) / 60

    morning_geom = _sum_period("_geom_seconds", 6, 10) / 60
    midday_geom = _sum_period("_geom_seconds", 10, 14) / 60
    afternoon_geom = _sum_period("_geom_seconds", 14, 18) / 60
    morning_geom_daylight = _sum_period("_geom_seconds_daylight", 6, 10) / 60
    midday_geom_daylight = _sum_period("_geom_seconds_daylight", 10, 14) / 60
    afternoon_geom_daylight = _sum_period("_geom_seconds_daylight", 14, 18) / 60

    morning_energy = _sum_period("_energy_j", 6, 10) / 1000
    midday_energy = _sum_period("_energy_j", 10, 14) / 1000
    afternoon_energy = _sum_period("_energy_j", 14, 18) / 1000

    daily = daily.merge(morning_cloud.reset_index().rename(columns={sun_col: "morning_min_cloud"}), on="date", how="left")
    daily = daily.merge(midday_cloud.reset_index().rename(columns={sun_col: "midday_min_cloud"}), on="date", how="left")
    daily = daily.merge(afternoon_cloud.reset_index().rename(columns={sun_col: "afternoon_min_cloud"}), on="date", how="left")
    daily = daily.merge(morning_cloud_daylight.reset_index().rename(columns={"_sunlight_seconds_daylight": "morning_min_cloud_daylight"}), on="date", how="left")
    daily = daily.merge(midday_cloud_daylight.reset_index().rename(columns={"_sunlight_seconds_daylight": "midday_min_cloud_daylight"}), on="date", how="left")
    daily = daily.merge(afternoon_cloud_daylight.reset_index().rename(columns={"_sunlight_seconds_daylight": "afternoon_min_cloud_daylight"}), on="date", how="left")

    daily = daily.merge(morning_geom.reset_index().rename(columns={"_geom_seconds": "morning_min_geom"}), on="date", how="left")
    daily = daily.merge(midday_geom.reset_index().rename(columns={"_geom_seconds": "midday_min_geom"}), on="date", how="left")
    daily = daily.merge(afternoon_geom.reset_index().rename(columns={"_geom_seconds": "afternoon_min_geom"}), on="date", how="left")
    daily = daily.merge(morning_geom_daylight.reset_index().rename(columns={"_geom_seconds_daylight": "morning_min_geom_daylight"}), on="date", how="left")
    daily = daily.merge(midday_geom_daylight.reset_index().rename(columns={"_geom_seconds_daylight": "midday_min_geom_daylight"}), on="date", how="left")
    daily = daily.merge(afternoon_geom_daylight.reset_index().rename(columns={"_geom_seconds_daylight": "afternoon_min_geom_daylight"}), on="date", how="left")

    daily = daily.merge(morning_energy.reset_index().rename(columns={"_energy_j": "energy_kJ_morning"}), on="date", how="left")
    daily = daily.merge(midday_energy.reset_index().rename(columns={"_energy_j": "energy_kJ_midday"}), on="date", how="left")
    daily = daily.merge(afternoon_energy.reset_index().rename(columns={"_energy_j": "energy_kJ_afternoon"}), on="date", how="left")

    daily[["morning_min_cloud", "midday_min_cloud", "afternoon_min_cloud",
           "morning_min_cloud_daylight", "midday_min_cloud_daylight", "afternoon_min_cloud_daylight",
           "morning_min_geom", "midday_min_geom", "afternoon_min_geom",
           "morning_min_geom_daylight", "midday_min_geom_daylight", "afternoon_min_geom_daylight",
           "energy_kJ_morning", "energy_kJ_midday", "energy_kJ_afternoon"]] = (
        daily[["morning_min_cloud", "midday_min_cloud", "afternoon_min_cloud",
               "morning_min_cloud_daylight", "midday_min_cloud_daylight", "afternoon_min_cloud_daylight",
               "morning_min_geom", "midday_min_geom", "afternoon_min_geom",
               "morning_min_geom_daylight", "midday_min_geom_daylight", "afternoon_min_geom_daylight",
               "energy_kJ_morning", "energy_kJ_midday", "energy_kJ_afternoon"]].fillna(0)
    )

    daily["morning_min"] = daily["morning_min_cloud"]
    daily["midday_min"] = daily["midday_min_cloud"]
    daily["afternoon_min"] = daily["afternoon_min_cloud"]

    hourly = df.groupby(["date", "hour"]).agg(
        sunlight_seconds=(sun_col, "sum"),
        sunlight_geom_seconds=("_geom_seconds", "sum"),
        sunlight_seconds_daylight=("_sunlight_seconds_daylight", "sum"),
        sunlight_geom_seconds_daylight=("_geom_seconds_daylight", "sum"),
        duration_seconds=(dur_col, "sum"),
        duration_seconds_daylight=("_duration_seconds_daylight", "sum"),
        irradiance_j=("_energy_j", "sum"),
        irradiance_j_daylight=("_energy_j_daylight", "sum"),
    ).reset_index()
    hourly["ID"] = record.pid
    hourly["Region"] = record.region
    hourly["sunlight_min_cloud"] = hourly["sunlight_seconds"] / 60
    hourly["sunlight_min_geom"] = hourly["sunlight_geom_seconds"] / 60
    hourly["sunlight_min_cloud_daylight"] = hourly["sunlight_seconds_daylight"] / 60
    hourly["sunlight_min_geom_daylight"] = hourly["sunlight_geom_seconds_daylight"] / 60
    hourly["sunlight_min"] = hourly["sunlight_min_cloud"]
    hourly["energy_kJ"] = hourly["irradiance_j"] / 1000
    hourly["tracked_min"] = hourly["duration_seconds"] / 60
    hourly["tracked_min_daylight"] = hourly["duration_seconds_daylight"] / 60

    return daily, hourly


def aggregate_file(record: FileRecord):
    try:
        header = pd.read_csv(record.path, nrows=0).columns
        wanted = set(TIME_COLS + SUN_COLS + DUR_COLS + IRR_COLS + EFF_COLS +
                     SUNLIT_COLS + SHADOW_COLS + INDOOR_COLS + SOLAR_COLS + SOURCE_COLS + ["date"])
        usecols = [c for c in header if c in wanted]
        if not usecols:
            return None, None, {"pid": record.pid, "path": str(record.path), "error": "no usable columns"}
        df = pd.read_csv(record.path, usecols=usecols, low_memory=False, on_bad_lines="skip")
    except Exception as e:
        return None, None, {"pid": record.pid, "path": str(record.path), "error": str(e)}

    df = df.loc[:, ~df.columns.astype(str).str.startswith("Unnamed")]

    indoor_col = _pick_first(df.columns, INDOOR_COLS)
    if indoor_col:
        df[indoor_col] = pd.to_numeric(df[indoor_col], errors="coerce").fillna(0)
        df = df[df[indoor_col] == 0]
        if df.empty:
            return None, None, {"pid": record.pid, "path": str(record.path), "error": "empty after indoor filter"}

    dt = _parse_datetime(df)
    if dt is None:
        return None, None, {"pid": record.pid, "path": str(record.path), "error": "no valid datetime"}

    df["datetime"] = dt
    df = df.dropna(subset=["datetime"])
    if df.empty:
        return None, None, {"pid": record.pid, "path": str(record.path), "error": "empty after datetime"}

    df["date"] = df["datetime"].dt.date
    df["hour"] = df["datetime"].dt.hour
    df = df[(df["hour"] >= DAY_START) & (df["hour"] < DAY_END)]
    if df.empty:
        return None, None, {"pid": record.pid, "path": str(record.path), "error": "empty after day filter"}

    sun_col = _pick_first(df.columns, SUN_COLS)
    dur_col = _pick_first(df.columns, DUR_COLS)
    irr_col = _pick_first(df.columns, IRR_COLS)
    eff_col = _pick_first(df.columns, EFF_COLS)
    sunlit_col = _pick_first(df.columns, SUNLIT_COLS)
    shadow_col = _pick_first(df.columns, SHADOW_COLS)
    solar_col = _pick_first(df.columns, SOLAR_COLS)
    source_col = _pick_first(df.columns, SOURCE_COLS)

    if sun_col is None or dur_col is None:
        return None, None, {"pid": record.pid, "path": str(record.path), "error": "missing sunlight/duration columns"}

    df[sun_col] = _safe_numeric(df[sun_col])
    df[dur_col] = _safe_numeric(df[dur_col])
    if irr_col:
        df[irr_col] = _safe_numeric(df[irr_col])
    if eff_col:
        df[eff_col] = _safe_numeric(df[eff_col])
    if sunlit_col:
        df[sunlit_col] = _safe_numeric(df[sunlit_col])
    if shadow_col:
        df[shadow_col] = _safe_numeric(df[shadow_col])
    if solar_col:
        df[solar_col] = _safe_numeric(df[solar_col])

    if eff_col:
        df["_cloud_adj_seconds"] = df[eff_col] * df[dur_col]
    else:
        df["_cloud_adj_seconds"] = 0.0

    if sunlit_col:
        df["_geom_seconds"] = df[sunlit_col] * df[dur_col]
    elif shadow_col:
        df["_geom_seconds"] = (1 - df[shadow_col] / 100.0) * df[dur_col]
    else:
        df["_geom_seconds"] = 0.0

    if irr_col:
        df["_energy_j"] = df[irr_col]
    else:
        df["_energy_j"] = 0.0

    if source_col:
        df["_is_daylight"] = df[source_col].astype(str).str.lower().ne("night")
    elif solar_col:
        df["_is_daylight"] = df[solar_col] > 0
    else:
        df["_is_daylight"] = True

    daylight_mask = df["_is_daylight"].astype(float)
    df["_duration_seconds_daylight"] = df[dur_col] * daylight_mask
    df["_sunlight_seconds_daylight"] = df[sun_col] * daylight_mask
    df["_geom_seconds_daylight"] = df["_geom_seconds"] * daylight_mask
    df["_cloud_adj_seconds_daylight"] = df["_cloud_adj_seconds"] * daylight_mask
    df["_energy_j_daylight"] = df["_energy_j"] * daylight_mask

    daily, hourly = _aggregate_frames(df, record, sun_col, dur_col)
    return daily, hourly, None


def _ensure_out_dirs() -> None:
    global OUT_DATA_DIR, OUT_FIG_DIR
    OUT_DATA_DIR = OUT_DIR / "数据"
    OUT_FIG_DIR = OUT_DIR / "图"
    OUT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_FIG_DIR.mkdir(parents=True, exist_ok=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GLAN sunlight exposure description + QC (window vs daylight)")
    p.add_argument("--root", type=Path, default=RAW_DIR, help="输入数据根目录（包含 CW/ST/KT/KQ 子目录）")
    p.add_argument("--out", type=Path, default=OUT_DIR, help="输出目录（将写入 数据/ 与 图/ 子目录）")
    p.add_argument("--pattern", type=str, default=FILE_GLOB, help="每个区域下递归匹配的文件名模式（glob）")
    p.add_argument("--day-start", type=int, default=DAY_START, help="本地时间窗口起始小时（含）")
    p.add_argument("--day-end", type=int, default=DAY_END, help="本地时间窗口结束小时（不含）")
    p.add_argument("--timezone", type=str, default=TIMEZONE, help="本地时区（用于把 bucketStart/timestamp 转为本地小时）")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    global RAW_DIR, OUT_DIR, FILE_GLOB, DAY_START, DAY_END, TIMEZONE
    args = parse_args(argv)

    RAW_DIR = args.root
    OUT_DIR = args.out
    FILE_GLOB = args.pattern
    DAY_START = int(args.day_start)
    DAY_END = int(args.day_end)
    TIMEZONE = str(args.timezone)
    _ensure_out_dirs()

    print("=" * 70)
    print("GLAN_processed_800 阳光暴露数据处理")
    print("=" * 70)

    file_df, dup_df = collect_files()
    if file_df.empty and FILE_GLOB == "*-sunlight.csv":
        FILE_GLOB = "*-sunlight*.csv"
        file_df, dup_df = collect_files()
    if file_df.empty:
        print("未找到任何 sunlight 文件，请检查路径。")
        return

    print(f"总文件数: {len(file_df)} (去重后)")
    if not dup_df.empty:
        print(f"重复文件记录: {len(dup_df)}")

    daily_list = []
    hourly_list = []
    error_list = []

    for row in file_df.itertuples(index=False):
        record = FileRecord(pid=row.pid, region=row.region, path=Path(row.path), size=row.size)
        daily, hourly, err = aggregate_file(record)
        if err:
            error_list.append(err)
            continue
        if daily is not None and not daily.empty:
            daily_list.append(daily)
        if hourly is not None and not hourly.empty:
            hourly_list.append(hourly)

    if not daily_list:
        print("未生成日层面数据，终止。")
        return

    daily_df = pd.concat(daily_list, ignore_index=True)
    hourly_df = pd.concat(hourly_list, ignore_index=True) if hourly_list else pd.DataFrame()

    daily_df.to_csv(OUT_DATA_DIR / "sunlight_daily_800.csv", index=False, encoding="utf-8-sig")
    if not hourly_df.empty:
        hourly_df.to_csv(OUT_DATA_DIR / "sunlight_hourly_800.csv", index=False, encoding="utf-8-sig")

    individual_df = daily_df.groupby(["ID", "Region"]).agg(
        sunlight_min_mean=("sunlight_min", "mean"),
        sunlight_min_cloud_mean=("sunlight_min_cloud", "mean"),
        sunlight_min_geom_mean=("sunlight_min_geom", "mean"),
        energy_kJ_mean=("energy_kJ", "mean"),
        cloud_adj_min_mean=("cloud_adj_min", "mean"),
        irradiance_kJ_mean=("irradiance_kJ", "mean"),
        tracked_min_mean=("tracked_min", "mean"),
        sunlight_ratio_mean=("sunlight_ratio", "mean"),
        sunlight_ratio_cloud_mean=("sunlight_ratio_cloud", "mean"),
        sunlight_ratio_geom_mean=("sunlight_ratio_geom", "mean"),
        morning_min_mean=("morning_min", "mean"),
        midday_min_mean=("midday_min", "mean"),
        afternoon_min_mean=("afternoon_min", "mean"),
        morning_min_cloud_mean=("morning_min_cloud", "mean"),
        midday_min_cloud_mean=("midday_min_cloud", "mean"),
        afternoon_min_cloud_mean=("afternoon_min_cloud", "mean"),
        morning_min_geom_mean=("morning_min_geom", "mean"),
        midday_min_geom_mean=("midday_min_geom", "mean"),
        afternoon_min_geom_mean=("afternoon_min_geom", "mean"),
        energy_kJ_morning_mean=("energy_kJ_morning", "mean"),
        energy_kJ_midday_mean=("energy_kJ_midday", "mean"),
        energy_kJ_afternoon_mean=("energy_kJ_afternoon", "mean"),
        valid_days=("date", "nunique"),
    ).reset_index()

    individual_df.to_csv(OUT_DATA_DIR / "sunlight_individual_800.csv", index=False, encoding="utf-8-sig")

    daily_df["zero_exposure"] = daily_df["sunlight_min"] <= 0
    region_summary = daily_df.groupby("Region").agg(
        n_days=("sunlight_min", "size"),
        mean_sunlight=("sunlight_min", "mean"),
        median_sunlight=("sunlight_min", "median"),
        zero_day_rate=("zero_exposure", "mean"),
        mean_ratio=("sunlight_ratio", "mean"),
        mean_tracked_min=("tracked_min", "mean"),
        mean_tracked_min_daylight=("tracked_min_daylight", "mean"),
        mean_ratio_daylight=("sunlight_ratio_cloud_daylight", "mean"),
    ).reset_index()
    region_summary.to_csv(OUT_DATA_DIR / "region_summary_800.csv", index=False, encoding="utf-8-sig")


    if error_list:
        pd.DataFrame(error_list).to_csv(OUT_DATA_DIR / "failed_files_800.csv", index=False, encoding="utf-8-sig")

    print("\n处理完成：")
    print(f"- 日层面: {len(daily_df):,} 条")
    print(f"- 个体层面: {len(individual_df):,} 人")
    if "tracked_min" in daily_df.columns:
        print(
            f"- Window(本地{DAY_START:02d}:00–{DAY_END:02d}:00) 平均户外跟踪时长: {daily_df['tracked_min'].mean() / 60:.2f} 小时/天"
        )
    if "tracked_min_daylight" in daily_df.columns:
        print(f"- Daylight(太阳日照) 平均户外跟踪时长: {daily_df['tracked_min_daylight'].mean() / 60:.2f} 小时/天")

    if not hourly_df.empty:
        plot_polar(hourly_df, suffix="")
    plot_descriptive_panel(daily_df, hourly_df, individual_df, suffix="")


def plot_polar(hourly_df: pd.DataFrame, suffix: str = "") -> None:
    hours = list(range(DAY_START, DAY_END))
    fig = plt.figure(figsize=(10, 9))
    ax = fig.add_subplot(111, projection="polar")

    for region in REGIONS:
        sub = hourly_df[hourly_df["Region"] == region]
        if sub.empty:
            continue
        mean_by_hour = sub.groupby("hour")["sunlight_min"].mean()
        values = [mean_by_hour.get(h, 0) for h in hours]

        theta = np.linspace(0, 2 * np.pi, len(hours), endpoint=False)
        theta = np.append(theta, theta[0])
        values = values + [values[0]]

        ax.plot(theta, values, color=REGION_COLORS.get(region, "#333333"), linewidth=2.2, label=REGION_NAMES.get(region, region))
        ax.fill(theta, values, color=REGION_COLORS.get(region, "#333333"), alpha=0.12)

    ax.set_theta_zero_location("N")
    ax.set_theta_direction(-1)
    ax.set_xticks(np.linspace(0, 2 * np.pi, len(hours), endpoint=False))
    ax.set_xticklabels([f"{h}:00" for h in hours], fontsize=9)
    ax.set_title(
        f"Sunlight Exposure Pattern by District ({DAY_START:02d}:00–{DAY_END:02d}:00, window)",
        fontsize=14,
        fontweight="bold",
        pad=18,
    )
    ax.legend(loc="upper right", bbox_to_anchor=(1.32, 1.05), frameon=False, fontsize=9)

    fig.tight_layout()
    fig.savefig(OUT_FIG_DIR / f"Sunlight_Polar_Combined_800{suffix}.png", dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def plot_descriptive_panel(daily_df: pd.DataFrame, hourly_df: pd.DataFrame,
                           individual_df: pd.DataFrame, suffix: str = "") -> None:
    configs = [
        ("geom", "sunlight_min_geom", "sunlight_ratio_geom", "Geometric"),
        ("cloud", "sunlight_min_cloud", "sunlight_ratio_cloud", "Cloud-adjusted"),
        ("energy", "energy_kJ", None, "Energy"),
    ]

    for metric_suffix, daily_col, ratio_col, label in configs:
        fig = plt.figure(figsize=(14, 10))
        gs = GridSpec(2, 3, figure=fig, wspace=0.35, hspace=0.35)

        ax_a = fig.add_subplot(gs[0, 0:2])
        hours = list(range(DAY_START, DAY_END))
        for region in REGIONS:
            sub = hourly_df[hourly_df["Region"] == region]
            if sub.empty:
                continue
            mean_by_hour = sub.groupby("hour")[daily_col].mean()
            values = [mean_by_hour.get(h, 0) for h in hours]
            ax_a.plot(hours, values, marker="o", linewidth=2, markersize=3,
                      color=REGION_COLORS.get(region, "#333333"), label=region)
        ax_a.set_xlabel("Hour of Day")
        ax_a.set_ylabel("Mean Exposure (per hour)")
        ax_a.set_title(f"A  Hourly exposure ({label})", loc="left", fontweight="bold")
        ax_a.legend(frameon=False, ncol=4, fontsize=9)

        ax_b = fig.add_subplot(gs[0, 2])
        stats = daily_df.groupby("Region")[daily_col].agg(["mean", "sem"]).reindex(REGIONS)
        ax_b.bar(range(len(stats)), stats["mean"], yerr=stats["sem"],
                 color=[REGION_COLORS.get(r, "#333333") for r in stats.index])
        ax_b.set_xticks(range(len(stats)))
        ax_b.set_xticklabels(stats.index)
        ax_b.set_ylabel("Mean Daily Exposure")
        ax_b.set_title(f"B  Mean daily exposure ({label})", loc="left", fontweight="bold")

        ax_c = fig.add_subplot(gs[1, 0])
        if ratio_col:
            ratio = daily_df[ratio_col].dropna()
            ax_c.hist(ratio, bins=30, color="#4C72B0", alpha=0.85)
            median_ratio = np.median(ratio) if len(ratio) else 0
            ax_c.axvline(median_ratio, color="#D62728", linestyle="--", linewidth=1.5)
            ax_c.set_xlabel("Exposure Ratio (%)")
            ax_c.set_title(f"C  Exposure ratio ({label})", loc="left", fontweight="bold")
        else:
            ax_c.hist(daily_df[daily_col].dropna(), bins=30, color="#4C72B0", alpha=0.85)
            ax_c.set_xlabel("Daily Energy (kJ/m^2)")
            ax_c.set_title("C  Energy distribution", loc="left", fontweight="bold")
        ax_c.set_ylabel("Frequency")

        ax_d = fig.add_subplot(gs[1, 1])
        if daily_col != "energy_kJ":
            for region in REGIONS:
                sub = daily_df[daily_df["Region"] == region]
                ax_d.scatter(sub[daily_col], sub["energy_kJ"], s=14,
                             color=REGION_COLORS.get(region, "#333333"), alpha=0.6, label=region)
            ax_d.set_xlabel("Daily Exposure (min)")
            ax_d.set_ylabel("Daily Energy (kJ/m^2)")
            ax_d.set_title("D  Energy vs duration", loc="left", fontweight="bold")
        else:
            for region in REGIONS:
                sub = daily_df[daily_df["Region"] == region]
                ax_d.scatter(sub["sunlight_min_geom"], sub["energy_kJ"], s=14,
                             color=REGION_COLORS.get(region, "#333333"), alpha=0.6, label=region)
            ax_d.set_xlabel("Daily Geometric Exposure (min)")
            ax_d.set_ylabel("Daily Energy (kJ/m^2)")
            ax_d.set_title("D  Energy vs geometric duration", loc="left", fontweight="bold")

        ax_e = fig.add_subplot(gs[1, 2])
        if daily_col != "energy_kJ":
            bins = [0, 5, 15, 30, 60, 120, 10_000]
            labels = ["0-5", "5-15", "15-30", "30-60", "60-120", ">120"]
            indiv_col = f"{daily_col}_mean"
            indiv = individual_df[indiv_col].dropna()
            cats = pd.cut(indiv, bins=bins, labels=labels, right=False)
            counts = cats.value_counts().reindex(labels).fillna(0)
            ax_e.bar(range(len(labels)), counts, color="#A1D99B")
            ax_e.set_xticks(range(len(labels)))
            ax_e.set_xticklabels(labels, rotation=45)
            ax_e.set_ylabel("Number of Participants")
            ax_e.set_title("E  Exposure categories", loc="left", fontweight="bold")
        else:
            indiv_col = f"{daily_col}_mean"
            ax_e.hist(individual_df[indiv_col].dropna(), bins=25, color="#A1D99B")
            ax_e.set_xlabel("Daily Energy (kJ/m^2)")
            ax_e.set_ylabel("Number of Participants")
            ax_e.set_title("E  Energy categories", loc="left", fontweight="bold")

        for ax in [ax_a, ax_b, ax_c, ax_d, ax_e]:
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)

        fig.tight_layout()
        fig.savefig(OUT_FIG_DIR / f"Sunlight_Descriptive_Panel_800{suffix}_{metric_suffix}.png",
                    dpi=300, bbox_inches="tight", facecolor="white")
        plt.close(fig)


if __name__ == "__main__":
    main()
