#!/usr/bin/env python3
"""Materialize exact task-point rows for a selected task set.

This is an explicit bridge stage between:
1. task-graph preprocessing, and
2. exact shadow solve.

It avoids repeated full rescans of raw input files during benchmarking by scanning
the input once, emitting only the point rows needed by the selected task set.
"""

from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import json
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.ops.build_national_task_graph_raw_stays import (  # noqa: E402
    IndoorPostGISClassifier,
    _raw_row_coords,
    _safe_int,
)
from scripts.ops.run_exact_partition_executor import (  # noqa: E402
    BucketPoint,
    PointMeta,
    build_cell_key,
    load_selected_tasks,
    scan_points_for_tasks,
    scan_raw_stay_points_for_tasks,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-graph-db", required=True)
    parser.add_argument("--partition-manifest-csv", required=True)
    parser.add_argument("--edge-table-name", default="task_partition_edges_deg05_ctx400")
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--output-csv", required=True)
    parser.add_argument("--summary-json", required=True)
    parser.add_argument("--task-id-file", default="", help="Optional newline-delimited task allowlist.")
    parser.add_argument("--input-mode", choices=("minute-rows", "raw-stays"), default="minute-rows")
    parser.add_argument("--max-tasks", type=int, default=0)
    parser.add_argument("--step-seconds", type=int, default=60)
    parser.add_argument("--solar-elevation-threshold-deg", type=float, default=0.0)
    parser.add_argument("--indoor-backend", choices=("none", "postgis"), default="none")
    parser.add_argument("--postgis-dsn", default="")
    parser.add_argument("--postgis-host", default="")
    parser.add_argument("--postgis-port", default="5432")
    parser.add_argument("--postgis-database", default="")
    parser.add_argument("--postgis-user", default="")
    parser.add_argument("--postgis-password", default="")
    parser.add_argument("--postgis-table", default="public.buildings_us_lod1")
    parser.add_argument("--postgis-geom-column", default="geom")
    parser.add_argument(
        "--file-relpath-file",
        default="",
        help="Optional newline-delimited file_relpath allowlist for worker sharding.",
    )
    return parser


def parse_allowlist(path: str) -> set[str] | None:
    if not path:
        return None
    values = {
        line.strip()
        for line in Path(path).expanduser().resolve().read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    return values or None


def filter_file_relpaths(file_relpaths: Sequence[str], allowlist: set[str] | None) -> List[str]:
    if not allowlist:
        return list(file_relpaths)
    return [file_relpath for file_relpath in file_relpaths if file_relpath in allowlist]


def write_point_cache(
    output_csv: Path,
    task_points,
    point_meta,
) -> int:
    output_csv.parent.mkdir(parents=True, exist_ok=True)
    row_count = 0
    with output_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["task_id", "file_relpath", "row_index", "timestamp", "lon", "lat"],
            lineterminator="\n",
        )
        writer.writeheader()
        for task_id in sorted(task_points):
            for point in task_points[task_id]:
                meta = point_meta[(task_id, point.file_index, point.index)]
                writer.writerow(
                    {
                        "task_id": task_id,
                        "file_relpath": meta.file_relpath,
                        "row_index": meta.row_index,
                        "timestamp": meta.timestamp,
                        "lon": meta.lon,
                        "lat": meta.lat,
                    }
                )
                row_count += 1
    return row_count


def minute_iso_to_epoch(minute_iso: str) -> int:
    normalized = minute_iso.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    return int(dt.datetime.fromisoformat(normalized).timestamp())


def build_selected_minutes_by_cell(tasks) -> Dict[str, Dict[str, List]]:
    per_cell: Dict[str, List[Tuple[int, str]]] = defaultdict(list)
    for task in tasks:
        per_cell[str(task.cell_key)].append((minute_iso_to_epoch(str(task.minute_iso)), str(task.task_id)))
    selected: Dict[str, Dict[str, List]] = {}
    for cell_key, entries in per_cell.items():
        entries.sort()
        selected[cell_key] = {
            "epochs": [epoch for epoch, _ in entries],
            "task_ids": [task_id for _, task_id in entries],
        }
    return selected


def scan_raw_stays_for_selected_tasks(
    *,
    input_root: Path,
    file_relpaths: Sequence[str],
    tasks,
    step_seconds: int,
    indoor_classifier: IndoorPostGISClassifier | None,
):
    if int(step_seconds) != 60:
        return scan_raw_stay_points_for_tasks(
            input_root,
            file_relpaths,
            tasks,
            step_seconds=int(step_seconds),
            solar_elevation_threshold_deg=0.0,
        )

    provider_set = {task.cell_provider for task in tasks}
    resolution_set = {task.cell_resolution for task in tasks}
    if len(provider_set) != 1 or len(resolution_set) != 1:
        raise RuntimeError("Prototype materializer expects a single cell provider/resolution in the selected task set.")
    provider = next(iter(provider_set))
    resolution = next(iter(resolution_set))
    task_lookup = {str(task.task_id): task for task in tasks}
    selected_minutes_by_cell = build_selected_minutes_by_cell(tasks)
    file_index_by_relpath = {file_relpath: idx for idx, file_relpath in enumerate(file_relpaths)}

    task_points = defaultdict(list)
    point_meta = {}
    scanned: Dict[str, int] = {}

    for file_relpath in file_relpaths:
        file_index = file_index_by_relpath[file_relpath]
        file_path = input_root / file_relpath
        scanned_rows = 0
        candidate_rows = []
        with file_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            for row_index, row in enumerate(reader):
                scanned_rows += 1
                lon, lat = _raw_row_coords(row)
                start_ts = _safe_int(row.get("start_time"))
                end_ts = _safe_int(row.get("end_time"))
                if lon is None or lat is None or start_ts is None:
                    continue
                if end_ts is None or end_ts < start_ts:
                    end_ts = start_ts

                cell_key = build_cell_key(provider, resolution, lon, lat)
                minute_bucket = selected_minutes_by_cell.get(cell_key)
                if minute_bucket is None:
                    continue

                point_count = max(1, int((max(end_ts, start_ts) - start_ts + int(step_seconds) - 1) // int(step_seconds)))
                last_ts = start_ts + (point_count - 1) * int(step_seconds)
                start_minute_epoch = (start_ts // 60) * 60
                end_minute_epoch = (last_ts // 60) * 60
                epochs = minute_bucket["epochs"]
                left = bisect.bisect_left(epochs, start_minute_epoch)
                right = bisect.bisect_right(epochs, end_minute_epoch)
                if left >= right:
                    continue
                task_ids = minute_bucket["task_ids"][left:right]
                if not task_ids:
                    continue

                candidate_rows.append(
                    {
                        "row_index": row_index,
                        "lon": lon,
                        "lat": lat,
                        "task_ids": task_ids,
                    }
                )
        indoor_map = {}
        if indoor_classifier is not None and candidate_rows:
            indoor_map = indoor_classifier.classify_points(
                [(float(candidate["lon"]), float(candidate["lat"])) for candidate in candidate_rows]
            )
        for candidate in candidate_rows:
            lon = float(candidate["lon"])
            lat = float(candidate["lat"])
            cache_key = (int(round(lon * 1e5)), int(round(lat * 1e5)))
            if indoor_map.get(cache_key, False):
                continue
            for task_id in candidate["task_ids"]:
                task = task_lookup.get(task_id)
                if task is None:
                    continue
                point = BucketPoint(index=int(candidate["row_index"]), lon=lon, lat=lat, file_index=file_index)
                task_points[task_id].append(point)
                point_meta[(task_id, file_index, int(candidate["row_index"]))] = PointMeta(
                    task_id=task_id,
                    file_relpath=file_relpath,
                    row_index=int(candidate["row_index"]),
                    timestamp=str(task.minute_iso),
                    lon=lon,
                    lat=lat,
                )
        scanned[file_relpath] = scanned_rows

    return task_points, point_meta, scanned


def main() -> int:
    args = build_parser().parse_args()
    started = time.time()

    task_graph_db = Path(args.task_graph_db).expanduser().resolve()
    manifest_csv = Path(args.partition_manifest_csv).expanduser().resolve()
    input_root = Path(args.input_root).expanduser().resolve()
    output_csv = Path(args.output_csv).expanduser().resolve()
    summary_json = Path(args.summary_json).expanduser().resolve()

    task_allowlist = parse_allowlist(args.task_id_file)
    file_allowlist = parse_allowlist(args.file_relpath_file)
    indoor_classifier = None

    tasks, file_relpaths = load_selected_tasks(
        db_path=task_graph_db,
        manifest_path=manifest_csv,
        edge_table_name=str(args.edge_table_name),
        max_tasks=int(args.max_tasks),
        allowlist=task_allowlist,
    )
    file_relpaths = filter_file_relpaths(file_relpaths, file_allowlist)

    if args.input_mode == "raw-stays":
        if args.indoor_backend == "postgis":
            indoor_classifier = IndoorPostGISClassifier(
                dsn=str(args.postgis_dsn or ""),
                host=str(args.postgis_host or ""),
                port=str(args.postgis_port or "5432"),
                database=str(args.postgis_database or ""),
                user=str(args.postgis_user or ""),
                password=str(args.postgis_password or ""),
                table=str(args.postgis_table or "public.buildings_us_lod1"),
                geom_column=str(args.postgis_geom_column or "geom"),
            )
        task_points, point_meta, scanned = scan_raw_stays_for_selected_tasks(
            input_root=input_root,
            file_relpaths=file_relpaths,
            tasks=tasks,
            step_seconds=int(args.step_seconds),
            indoor_classifier=indoor_classifier,
        )
    else:
        task_points, point_meta, scanned = scan_points_for_tasks(input_root, file_relpaths, tasks)

    point_row_count = write_point_cache(output_csv, task_points, point_meta)
    task_hit_count = sum(1 for task_id in task_points if task_points[task_id])

    summary = {
        "taskGraphDb": str(task_graph_db),
        "partitionManifestCsv": str(manifest_csv),
        "inputRoot": str(input_root),
        "outputCsv": str(output_csv),
        "selectedTaskCount": len(tasks),
        "selectedFileCount": len(file_relpaths),
        "scannedFileCount": len(scanned),
        "scannedRowCount": sum(scanned.values()),
        "materializedTaskCount": task_hit_count,
        "materializedPointRowCount": point_row_count,
        "indoorBackend": str(args.indoor_backend),
        "elapsedSeconds": time.time() - started,
    }
    summary_json.parent.mkdir(parents=True, exist_ok=True)
    summary_json.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
