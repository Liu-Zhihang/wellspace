#!/usr/bin/env python3
"""Merge shard-level raw task graphs into a single aggregated task graph.

This merge step serves two purposes:

1. Aggregate per-shard `tasks.csv` files into one normalized DuckDB dataset.
2. Materialize `memberships` so downstream executors can resolve task -> source
   file relations without rerunning raw preprocessing.

For legacy raw-stay shard outputs that only contain `tasks.csv`, this script can
derive count-mode memberships directly from each task file. That works because
each shard is produced from exactly one raw shard CSV.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import time
from pathlib import Path
from typing import List


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-glob", required=True, help="Glob for shard task CSV files.")
    parser.add_argument("--summary-glob", default="", help="Optional glob for shard summary JSON files.")
    parser.add_argument("--membership-glob", default="", help="Optional glob for shard membership CSV files.")
    parser.add_argument("--source-span-glob", default="", help="Optional glob for shard source-span CSV files.")
    parser.add_argument(
        "--derive-memberships-from-task-files",
        action="store_true",
        help="Derive count-mode memberships from task CSV file paths when membership CSVs are unavailable.",
    )
    parser.add_argument("--output-dir", required=True)
    return parser


def sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _derived_file_relpath(task_file: str) -> str:
    task_path = Path(task_file)
    shard_name = task_path.parent.name
    if shard_name:
        return f"{shard_name}.csv"
    return task_path.name


def main(argv: List[str]) -> int:
    args = build_parser().parse_args(argv)
    started_at = time.monotonic()

    import duckdb

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    task_files = sorted(glob.glob(args.input_glob))
    if not task_files:
        raise RuntimeError(f"No task CSV files matched: {args.input_glob}")
    membership_files = sorted(glob.glob(args.membership_glob)) if args.membership_glob else []
    source_span_files = sorted(glob.glob(args.source_span_glob)) if args.source_span_glob else []

    con = duckdb.connect(str(output_dir / "task_graph.duckdb"))
    union_paths = ", ".join(sql_quote(path) for path in task_files)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE tasks_raw AS
        SELECT
          task_id,
          minute_iso,
          cell_key,
          SUM(CAST(point_count AS BIGINT)) AS point_count,
          SUM(CAST(file_count AS BIGINT)) AS file_count,
          MIN(CAST(west AS DOUBLE)) AS west,
          MIN(CAST(south AS DOUBLE)) AS south,
          MAX(CAST(east AS DOUBLE)) AS east,
          MAX(CAST(north AS DOUBLE)) AS north
        FROM read_csv_auto([{union_paths}], header=true)
        GROUP BY 1, 2, 3
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TABLE tasks AS
        WITH split AS (
          SELECT
            task_id,
            CAST(minute_iso AS VARCHAR) AS minute_iso,
            cell_key,
            point_count::BIGINT AS point_count,
            file_count::BIGINT AS file_count,
            west::DOUBLE AS west,
            south::DOUBLE AS south,
            east::DOUBLE AS east,
            north::DOUBLE AS north,
            split_part(cell_key, ':', 1) AS cell_provider,
            split_part(cell_key, ':', 2) AS cell_resolution_token,
            split_part(cell_key, ':', 3) AS cell_token,
            CASE
              WHEN split_part(cell_key, ':', 1) = 'square' THEN split_part(cell_key, ':', 4)
              ELSE NULL
            END AS square_y_token
          FROM tasks_raw
        )
        SELECT
          task_id,
          minute_iso,
          CAST(try_cast(minute_iso AS TIMESTAMPTZ) AS TIMESTAMP) AS minute_ts,
          CAST(strftime(CAST(try_cast(minute_iso AS TIMESTAMPTZ) AS TIMESTAMP), '%Y-%m-%d') AS VARCHAR) AS minute_date,
          CAST(strftime(CAST(try_cast(minute_iso AS TIMESTAMPTZ) AS TIMESTAMP), '%H') AS INTEGER) AS minute_hour,
          cell_key,
          cell_provider,
          CASE
            WHEN cell_provider IN ('h3', 'square') THEN try_cast(cell_resolution_token AS INTEGER)
            ELSE NULL
          END AS cell_resolution,
          cell_token,
          try_cast(square_y_token AS BIGINT) AS square_y,
          point_count,
          file_count,
          west,
          south,
          east,
          north
        FROM split
        """
    )
    tasks_csv = output_dir / "tasks.csv"
    con.execute(f"COPY tasks TO '{str(tasks_csv)}' (HEADER, DELIMITER ',')")

    memberships_csv = output_dir / "task_membership_counts.csv"
    membership_edge_count = 0
    if membership_files:
        membership_union = ", ".join(sql_quote(path) for path in membership_files)
        con.execute(
            f"""
            CREATE OR REPLACE TABLE memberships AS
            SELECT
              task_id,
              CAST(file_relpath AS VARCHAR) AS file_relpath,
              SUM(CAST(point_count AS BIGINT)) AS point_count
            FROM read_csv_auto([{membership_union}], header=true)
            GROUP BY 1, 2
            """
        )
        con.execute(f"COPY memberships TO '{str(memberships_csv)}' (HEADER, DELIMITER ',')")
        membership_edge_count = int(con.execute("SELECT count(*) FROM memberships").fetchone()[0] or 0)
    elif args.derive_memberships_from_task_files:
        derived_selects = []
        for task_file in task_files:
            file_relpath = _derived_file_relpath(task_file)
            derived_selects.append(
                f"""
                SELECT
                  task_id,
                  {sql_quote(file_relpath)} AS file_relpath,
                  CAST(point_count AS BIGINT) AS point_count
                FROM read_csv_auto({sql_quote(task_file)}, header=true)
                """
            )
        con.execute(
            f"""
            CREATE OR REPLACE TABLE memberships AS
            {' UNION ALL '.join(derived_selects)}
            """
        )
        con.execute(f"COPY memberships TO '{str(memberships_csv)}' (HEADER, DELIMITER ',')")
        membership_edge_count = int(con.execute("SELECT count(*) FROM memberships").fetchone()[0] or 0)

    source_spans_csv = output_dir / "task_source_spans.csv"
    source_span_count = 0
    if source_span_files:
        source_span_union = ", ".join(sql_quote(path) for path in source_span_files)
        con.execute(
            f"""
            CREATE OR REPLACE TABLE source_spans AS
            SELECT
              CAST(cell_key AS VARCHAR) AS cell_key,
              CAST(start_minute_iso AS VARCHAR) AS start_minute_iso,
              CAST(end_minute_iso AS VARCHAR) AS end_minute_iso,
              CAST(try_cast(CAST(start_minute_iso AS VARCHAR) AS TIMESTAMPTZ) AS TIMESTAMP) AS start_minute_ts,
              CAST(try_cast(CAST(end_minute_iso AS VARCHAR) AS TIMESTAMPTZ) AS TIMESTAMP) AS end_minute_ts,
              CAST(file_relpath AS VARCHAR) AS file_relpath,
              CAST(row_index AS BIGINT) AS row_index,
              CAST(ad_id AS VARCHAR) AS ad_id,
              CAST(lon AS DOUBLE) AS lon,
              CAST(lat AS DOUBLE) AS lat,
              SUM(CAST(span_point_count AS BIGINT)) AS span_point_count
            FROM read_csv_auto([{source_span_union}], header=true)
            GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
            """
        )
        con.execute(f"COPY source_spans TO '{str(source_spans_csv)}' (HEADER, DELIMITER ',')")
        source_span_count = int(con.execute("SELECT count(*) FROM source_spans").fetchone()[0] or 0)

    row = con.execute(
        """
        SELECT
          COUNT(*) AS task_count,
          COALESCE(SUM(point_count), 0) AS retained_point_count,
          COALESCE(AVG(point_count), 0) AS rows_per_task_avg
        FROM tasks
        """
    ).fetchone()
    if membership_edge_count:
        con.execute(
            """
            CREATE OR REPLACE TABLE task_graph_files AS
            SELECT
              file_relpath,
              count(*) AS task_count,
              sum(point_count) AS point_count
            FROM memberships
            GROUP BY 1
            ORDER BY task_count DESC, point_count DESC, file_relpath
            """
        )

    scanned_rows = valid_rows = invalid_rows = indoor_rows = solar_prefilter_night_rows = 0
    if args.summary_glob:
        for summary_path in sorted(glob.glob(args.summary_glob)):
            payload = json.loads(Path(summary_path).read_text(encoding="utf-8"))
            scanned_rows += int(payload.get("scanned_rows", 0))
            valid_rows += int(payload.get("valid_rows", 0))
            invalid_rows += int(payload.get("invalid_rows", 0))
            indoor_rows += int(payload.get("indoor_rows", 0))
            solar_prefilter_night_rows += int(payload.get("solar_prefilter_night_rows", 0))

    summary = {
        "input_glob": args.input_glob,
        "summary_glob": args.summary_glob,
        "output_dir": str(output_dir),
        "task_file_count": len(task_files),
        "scanned_rows": scanned_rows,
        "valid_rows": valid_rows,
        "invalid_rows": invalid_rows,
        "indoor_rows": indoor_rows,
        "solar_prefilter_night_rows": solar_prefilter_night_rows,
        "task_count": int(row[0]),
        "retained_point_count": int(row[1]),
        "rows_per_task_avg": float(row[2] or 0.0),
        "memberships_path": str(memberships_csv) if membership_edge_count else "",
        "membership_edge_count": int(membership_edge_count),
        "source_spans_path": str(source_spans_csv) if source_span_count else "",
        "source_span_count": int(source_span_count),
        "elapsed_seconds": time.monotonic() - started_at,
    }
    summary_path = output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(__import__("sys").argv[1:]))
