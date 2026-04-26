#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional


PROFILE_PROGRESS_EVERY = 500_000


@dataclass
class ProfileSummary:
    input_csv: str
    step_seconds: int
    raw_rows: int
    unique_users: int
    total_duration_seconds: int
    expanded_points: int
    min_start_time: Optional[int]
    max_end_time: Optional[int]


@dataclass
class SampleSummary:
    input_csv: str
    output_root: str
    step_seconds: int
    sample_ratio: float
    raw_rows_scanned: int
    selected_raw_rows: int
    selected_users: int
    expanded_points: int
    files_written: int
    manifest_path: str


def _safe_int(value: object) -> Optional[int]:
    try:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        return int(float(text))
    except Exception:
        return None


def _expanded_points(start_ts: int, end_ts: int, step_seconds: int) -> int:
    if end_ts <= start_ts:
      return 1
    return max(1, int(math.ceil((end_ts - start_ts) / float(step_seconds))))


def _iter_input_rows(input_csv: Path) -> Iterable[dict[str, str]]:
    with input_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            yield row


def profile_input(input_csv: Path, step_seconds: int) -> ProfileSummary:
    raw_rows = 0
    unique_users: set[str] = set()
    total_duration_seconds = 0
    expanded_points = 0
    min_start_time: Optional[int] = None
    max_end_time: Optional[int] = None

    for row in _iter_input_rows(input_csv):
        raw_rows += 1
        ad_id = (row.get("ad_id") or "").strip()
        if ad_id:
            unique_users.add(ad_id)

        start_ts = _safe_int(row.get("start_time"))
        end_ts = _safe_int(row.get("end_time"))
        if start_ts is None:
            continue
        if end_ts is None or end_ts < start_ts:
            end_ts = start_ts

        total_duration_seconds += max(0, end_ts - start_ts)
        expanded_points += _expanded_points(start_ts, end_ts, step_seconds)
        min_start_time = start_ts if min_start_time is None else min(min_start_time, start_ts)
        max_end_time = end_ts if max_end_time is None else max(max_end_time, end_ts)

        if raw_rows % PROFILE_PROGRESS_EVERY == 0:
            print(
                f"[Profile] rows={raw_rows} unique_users={len(unique_users)} expanded_points={expanded_points}",
                file=sys.stderr,
                flush=True,
            )

    return ProfileSummary(
        input_csv=str(input_csv),
        step_seconds=step_seconds,
        raw_rows=raw_rows,
        unique_users=len(unique_users),
        total_duration_seconds=total_duration_seconds,
        expanded_points=expanded_points,
        min_start_time=min_start_time,
        max_end_time=max_end_time,
    )


def _selected_by_ratio(ad_id: str, sample_ratio: float) -> bool:
    digest = hashlib.sha1(ad_id.encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], byteorder="big", signed=False) / float(2**64)
    return value < sample_ratio


def sample_input(
    input_csv: Path,
    output_root: Path,
    step_seconds: int,
    sample_ratio: float,
    manifest_path: Path,
) -> SampleSummary:
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    headers = [
        "ad_id",
        "timestamp",
        "gps_lon",
        "gps_lat",
        "cluster_id",
        "user_timezone",
        "start_time",
        "end_time",
        "time_spent",
        "start_time_local",
        "end_time_local",
        "latitude",
        "longitude",
        "minute_offset_seconds",
    ]

    writers: Dict[Path, tuple[object, csv.writer]] = {}
    selected_users: set[str] = set()
    files_written: set[Path] = set()
    raw_rows_scanned = 0
    selected_raw_rows = 0
    expanded_points = 0

    def writer_for(ad_id: str) -> csv.writer:
        subdir = output_root / ad_id[:2].lower()
        subdir.mkdir(parents=True, exist_ok=True)
        out_file = subdir / f"{ad_id}.csv"
        if out_file not in writers:
            handle = out_file.open("w", encoding="utf-8", newline="")
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(headers)
            writers[out_file] = (handle, writer)
            files_written.add(out_file)
        return writers[out_file][1]

    try:
        for row in _iter_input_rows(input_csv):
            raw_rows_scanned += 1
            ad_id = (row.get("ad_id") or "").strip()
            if not ad_id or not _selected_by_ratio(ad_id, sample_ratio):
                continue

            lat = (row.get("latitude") or "").strip()
            lon = (row.get("longitude") or "").strip()
            if not lat or not lon:
                continue

            start_ts = _safe_int(row.get("start_time"))
            end_ts = _safe_int(row.get("end_time"))
            if start_ts is None:
                continue
            if end_ts is None or end_ts < start_ts:
                end_ts = start_ts

            selected_users.add(ad_id)
            selected_raw_rows += 1
            writer = writer_for(ad_id)
            point_count = _expanded_points(start_ts, end_ts, step_seconds)

            for offset_idx in range(point_count):
                ts_value = start_ts + offset_idx * step_seconds
                writer.writerow(
                    [
                        ad_id,
                        ts_value,
                        lon,
                        lat,
                        row.get("cluster_id", ""),
                        row.get("user_timezone", ""),
                        row.get("start_time", ""),
                        row.get("end_time", ""),
                        row.get("time_spent", ""),
                        row.get("start_time_local", ""),
                        row.get("end_time_local", ""),
                        lat,
                        lon,
                        offset_idx * step_seconds,
                    ]
                )
                expanded_points += 1

            if raw_rows_scanned % PROFILE_PROGRESS_EVERY == 0:
                print(
                    f"[Sample] scanned={raw_rows_scanned} selected_users={len(selected_users)} expanded_points={expanded_points}",
                    file=sys.stderr,
                    flush=True,
                )
    finally:
        for handle, _writer in writers.values():
            handle.close()  # type: ignore[call-arg]

    with manifest_path.open("w", encoding="utf-8") as handle:
        for out_file in sorted(files_written):
            handle.write(f"{out_file.relative_to(output_root)}\n")

    return SampleSummary(
        input_csv=str(input_csv),
        output_root=str(output_root),
        step_seconds=step_seconds,
        sample_ratio=sample_ratio,
        raw_rows_scanned=raw_rows_scanned,
        selected_raw_rows=selected_raw_rows,
        selected_users=len(selected_users),
        expanded_points=expanded_points,
        files_written=len(files_written),
        manifest_path=str(manifest_path),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Prepare stay-point mobility CSVs for shadow benchmarking.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    p_profile = subparsers.add_parser("profile", help="Profile a raw stay-point CSV.")
    p_profile.add_argument("--input-csv", required=True)
    p_profile.add_argument("--step-seconds", type=int, default=60)
    p_profile.add_argument("--output-json", default="")

    p_sample = subparsers.add_parser("sample", help="Sample users and expand stay-points into per-user CSVs.")
    p_sample.add_argument("--input-csv", required=True)
    p_sample.add_argument("--output-root", required=True)
    p_sample.add_argument("--manifest-path", required=True)
    p_sample.add_argument("--step-seconds", type=int, default=60)
    p_sample.add_argument("--sample-ratio", type=float, default=0.01)
    p_sample.add_argument("--output-json", default="")

    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "profile":
        summary = profile_input(Path(args.input_csv).resolve(), int(args.step_seconds))
        payload = asdict(summary)
        text = json.dumps(payload, indent=2)
        if args.output_json:
            Path(args.output_json).write_text(text + "\n", encoding="utf-8")
        print(text)
        return 0

    if args.command == "sample":
        summary = sample_input(
            input_csv=Path(args.input_csv).resolve(),
            output_root=Path(args.output_root).resolve(),
            step_seconds=int(args.step_seconds),
            sample_ratio=max(0.0, min(1.0, float(args.sample_ratio))),
            manifest_path=Path(args.manifest_path).resolve(),
        )
        payload = asdict(summary)
        text = json.dumps(payload, indent=2)
        if args.output_json:
            Path(args.output_json).write_text(text + "\n", encoding="utf-8")
        print(text)
        return 0

    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
