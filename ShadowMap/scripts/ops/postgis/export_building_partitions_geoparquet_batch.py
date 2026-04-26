#!/usr/bin/env python3
"""Batch-export selected building partitions to GeoParquet with resume support."""

from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--partition-catalog-json", required=True, help="Partition catalog JSON path.")
    parser.add_argument("--partition-ids-file", required=True, help="Newline-delimited partition ID list.")
    parser.add_argument("--output-root", required=True, help="Directory for GeoParquet outputs.")
    parser.add_argument(
        "--exporter-script",
        default=str(Path(__file__).with_name("export_building_partitions_geoparquet.py")),
        help="Exporter entrypoint. Defaults to sibling export_building_partitions_geoparquet.py.",
    )
    parser.add_argument(
        "--python-bin",
        default=sys.executable,
        help="Python interpreter used for child export jobs.",
    )
    parser.add_argument(
        "--table",
        default="public.buildings_us_lod1",
        help="Source PostGIS table. Defaults to public.buildings_us_lod1.",
    )
    parser.add_argument(
        "--pg-dsn",
        default=os.getenv("SHADOWMAP_POSTGIS_OGR_DSN", "PG:dbname=shadowmap_gis"),
        help="OGR PG: connection string. Defaults to SHADOWMAP_POSTGIS_OGR_DSN or PG:dbname=shadowmap_gis.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=4,
        help="Concurrent child export processes. Defaults to 4.",
    )
    parser.add_argument(
        "--temp-driver",
        default="GPKG",
        choices=("GPKG", "GeoJSON"),
        help="Temporary vector format used by the child exporter.",
    )
    parser.add_argument(
        "--ogr2ogr-bin",
        default="ogr2ogr",
        help="ogr2ogr binary passed to the child exporter. Defaults to `ogr2ogr` on PATH.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional cap on selected partitions. 0 means no cap.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing parquet files.",
    )
    parser.add_argument(
        "--summary-json",
        default="",
        help="Optional summary JSON path. Defaults to <output-root>/batch_export_summary.json.",
    )
    parser.add_argument(
        "--manifest-csv",
        default="",
        help="Optional aggregated manifest CSV path. Defaults to <output-root>/export_manifest.csv.",
    )
    parser.add_argument(
        "--log-dir",
        default="",
        help="Optional per-partition log directory. Defaults to <output-root>/_logs.",
    )
    parser.add_argument(
        "--write-covering-bbox",
        action="store_true",
        help="Write GeoParquet covering bbox metadata in child export jobs.",
    )
    return parser


def load_catalog(path: Path) -> Dict[str, Dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError(f"Partition catalog must be a JSON array: {path}")
    catalog: Dict[str, Dict[str, Any]] = {}
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeError(f"Partition catalog entry #{idx} is not an object")
        partition_id = str(item.get("partitionId") or "").strip()
        if not partition_id:
            raise RuntimeError(f"Partition catalog entry #{idx} is missing partitionId")
        catalog[partition_id] = item
    return catalog


def load_partition_ids(path: Path, limit: int) -> List[str]:
    ids: List[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped:
            ids.append(stripped)
    if limit > 0:
        ids = ids[:limit]
    return ids


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def parquet_row_count(path: Path) -> str:
    try:
        import pyarrow.parquet as pq
    except Exception:
        return ""
    try:
        return str(pq.ParquetFile(path).metadata.num_rows)
    except Exception:
        return ""


def build_child_command(
    args: argparse.Namespace,
    partition_catalog_json: Path,
    output_root: Path,
    manifest_path: Path,
    partition_id: str,
) -> List[str]:
    cmd = [
        str(args.python_bin),
        str(Path(args.exporter_script).expanduser().resolve()),
        "--partition-catalog-json",
        str(partition_catalog_json),
        "--output-root",
        str(output_root),
        "--table",
        str(args.table),
        "--pg-dsn",
        str(args.pg_dsn),
        "--partition-id",
        partition_id,
        "--append-manifest",
        str(manifest_path),
        "--temp-driver",
        str(args.temp_driver),
        "--ogr2ogr-bin",
        str(args.ogr2ogr_bin),
    ]
    if args.overwrite:
        cmd.append("--overwrite")
    if args.write_covering_bbox:
        cmd.append("--write-covering-bbox")
    return cmd


def run_one_partition(
    partition_id: str,
    args: argparse.Namespace,
    partition_catalog_json: Path,
    output_root: Path,
    manifest_parts_dir: Path,
    log_dir: Path,
) -> Dict[str, Any]:
    start = time.time()
    output_parquet = output_root / f"{partition_id}.parquet"
    manifest_path = manifest_parts_dir / f"{partition_id}.csv"
    log_path = log_dir / f"{partition_id}.log"

    if output_parquet.exists() and not args.overwrite:
        return {
            "partitionId": partition_id,
            "status": "skipped_existing",
            "elapsedSeconds": 0.0,
            "outputParquet": str(output_parquet),
            "logPath": str(log_path),
        }

    cmd = build_child_command(args, partition_catalog_json, output_root, manifest_path, partition_id)
    completed = subprocess.run(cmd, capture_output=True, text=True)
    log_path.write_text(
        "\n".join(
            [
                f"COMMAND={' '.join(cmd)}",
                f"EXIT_CODE={completed.returncode}",
                "STDOUT:",
                completed.stdout,
                "STDERR:",
                completed.stderr,
            ]
        ),
        encoding="utf-8",
    )
    elapsed = time.time() - start
    return {
        "partitionId": partition_id,
        "status": "ok" if completed.returncode == 0 else "failed",
        "elapsedSeconds": elapsed,
        "outputParquet": str(output_parquet),
        "manifestPart": str(manifest_path),
        "logPath": str(log_path),
        "exitCode": int(completed.returncode),
    }


def write_csv(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    rows = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "partitionId",
                "parentTileId",
                "outputParquet",
                "rowCount",
                "fileSizeBytes",
                "minLon",
                "minLat",
                "maxLon",
                "maxLat",
            ],
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)


def aggregate_manifest(
    catalog: Dict[str, Dict[str, Any]],
    partition_ids: Iterable[str],
    output_root: Path,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for partition_id in partition_ids:
        meta = catalog[partition_id]
        output_path = output_root / f"{partition_id}.parquet"
        file_size = output_path.stat().st_size if output_path.exists() else 0
        rows.append(
            {
                "partitionId": partition_id,
                "parentTileId": str(meta.get("parentTileId") or ""),
                "outputParquet": str(output_path),
                "rowCount": parquet_row_count(output_path) if output_path.exists() else "",
                "fileSizeBytes": file_size,
                "minLon": meta.get("minLon", ""),
                "minLat": meta.get("minLat", ""),
                "maxLon": meta.get("maxLon", ""),
                "maxLat": meta.get("maxLat", ""),
            }
        )
    return rows


def main() -> int:
    args = build_parser().parse_args()
    partition_catalog_json = Path(args.partition_catalog_json).expanduser().resolve()
    partition_ids_file = Path(args.partition_ids_file).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    ensure_dir(output_root)

    summary_json = (
        Path(args.summary_json).expanduser().resolve()
        if args.summary_json
        else output_root / "batch_export_summary.json"
    )
    manifest_csv = (
        Path(args.manifest_csv).expanduser().resolve()
        if args.manifest_csv
        else output_root / "export_manifest.csv"
    )
    log_dir = (
        Path(args.log_dir).expanduser().resolve()
        if args.log_dir
        else output_root / "_logs"
    )
    manifest_parts_dir = output_root / "_manifest_parts"
    ensure_dir(log_dir)
    ensure_dir(manifest_parts_dir)

    catalog = load_catalog(partition_catalog_json)
    partition_ids = load_partition_ids(partition_ids_file, int(args.limit))
    missing = [pid for pid in partition_ids if pid not in catalog]
    if missing:
        raise RuntimeError(f"Partition IDs missing from catalog: {missing[:10]}")
    if not partition_ids:
        raise RuntimeError("No partition IDs selected for batch export")

    workers = max(1, int(args.workers))
    results: List[Dict[str, Any]] = []
    start = time.time()

    iterator = iter(partition_ids)
    in_flight = set()
    future_to_pid: Dict[Any, str] = {}

    def submit_next(pool: ThreadPoolExecutor) -> bool:
        try:
            partition_id = next(iterator)
        except StopIteration:
            return False
        future = pool.submit(
            run_one_partition,
            partition_id,
            args,
            partition_catalog_json,
            output_root,
            manifest_parts_dir,
            log_dir,
        )
        in_flight.add(future)
        future_to_pid[future] = partition_id
        return True

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for _ in range(workers):
            if not submit_next(pool):
                break

        while in_flight:
            done, pending = wait(in_flight, return_when=FIRST_COMPLETED)
            in_flight = set(pending)
            for future in done:
                partition_id = future_to_pid.pop(future, "unknown")
                result = future.result()
                results.append(result)
                print(
                    json.dumps(
                        {
                            "partitionId": partition_id,
                            "status": result["status"],
                            "elapsedSeconds": round(float(result["elapsedSeconds"]), 2),
                            "completed": len(results),
                            "total": len(partition_ids),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                submit_next(pool)

    manifest_rows = aggregate_manifest(catalog, partition_ids, output_root)
    write_csv(manifest_csv, manifest_rows)

    ok = sum(1 for row in results if row["status"] == "ok")
    skipped = sum(1 for row in results if row["status"] == "skipped_existing")
    failed = sum(1 for row in results if row["status"] == "failed")
    existing_outputs = sum(1 for row in manifest_rows if Path(row["outputParquet"]).exists())
    total_bytes = sum(int(row["fileSizeBytes"] or 0) for row in manifest_rows)
    summary = {
        "partition_catalog_json": str(partition_catalog_json),
        "partition_ids_file": str(partition_ids_file),
        "output_root": str(output_root),
        "table": str(args.table),
        "workers": workers,
        "selected_partition_count": len(partition_ids),
        "result_ok_count": ok,
        "result_skipped_existing_count": skipped,
        "result_failed_count": failed,
        "existing_output_count": existing_outputs,
        "manifest_csv": str(manifest_csv),
        "log_dir": str(log_dir),
        "elapsedSeconds": time.time() - start,
        "totalOutputBytes": total_bytes,
    }
    summary_json.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
