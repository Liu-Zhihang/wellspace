#!/usr/bin/env python3
"""Materialize task-graph CSV artifacts into a DuckDB dataset.

This is the second-stage preprocessing step for the national compute framework.
It converts task-graph CSV outputs into normalized DuckDB tables plus Parquet
exports that can be reused by downstream candidate-obstacle preprocessing.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Optional


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary-json", required=True, help="Path to task-graph summary.json")
    parser.add_argument("--output-dir", required=True, help="Directory for DuckDB and Parquet outputs")
    parser.add_argument(
        "--db-name",
        default="task_graph.duckdb",
        help="DuckDB database filename under --output-dir",
    )
    parser.add_argument(
        "--export-parquet",
        action="store_true",
        help="Also export normalized tables to Parquet files.",
    )
    return parser


def sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def main() -> int:
    args = build_parser().parse_args()

    summary_path = Path(args.summary_json).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    db_path = output_dir / args.db_name

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    tasks_csv = Path(summary["tasks_path"]).expanduser().resolve()
    memberships_csv = Path(summary["memberships_path"]).expanduser().resolve()

    try:
        import duckdb
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "DuckDB materialization requires the `duckdb` Python package."
        ) from exc

    con = duckdb.connect(str(db_path))
    try:
        con.execute("PRAGMA threads=8")
        con.execute("DROP TABLE IF EXISTS tasks_raw")
        con.execute("DROP TABLE IF EXISTS memberships_raw")
        con.execute("DROP TABLE IF EXISTS tasks")
        con.execute("DROP TABLE IF EXISTS memberships")
        con.execute("DROP TABLE IF EXISTS task_graph_meta")
        con.execute("DROP TABLE IF EXISTS task_graph_hourly")
        con.execute("DROP TABLE IF EXISTS task_graph_files")

        con.execute(
            f"""
            CREATE TABLE tasks_raw AS
            SELECT *
            FROM read_csv_auto(
                {sql_quote(str(tasks_csv))},
                header = true,
                sample_size = -1
            )
            """
        )
        con.execute(
            f"""
            CREATE TABLE memberships_raw AS
            SELECT *
            FROM read_csv_auto(
                {sql_quote(str(memberships_csv))},
                header = true,
                sample_size = -1
            )
            """
        )

        task_columns = [row[1] for row in con.execute("PRAGMA table_info('tasks_raw')").fetchall()]
        has_night = "is_night" in task_columns
        has_cloud = "cloud_cover" in task_columns
        has_irr = "solar_irradiance_wm2" in task_columns

        con.execute(
            f"""
            CREATE TABLE tasks AS
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
                    {", is_night::INTEGER AS is_night" if has_night else ", NULL::INTEGER AS is_night"}
                    {", cloud_cover::DOUBLE AS cloud_cover" if has_cloud else ", NULL::DOUBLE AS cloud_cover"}
                    {", solar_irradiance_wm2::DOUBLE AS solar_irradiance_wm2" if has_irr else ", NULL::DOUBLE AS solar_irradiance_wm2"}
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
                north,
                is_night,
                cloud_cover,
                solar_irradiance_wm2
            FROM split
            """
        )

        con.execute(
            """
            CREATE TABLE memberships AS
            SELECT
                task_id,
                file_relpath,
                point_count::BIGINT AS point_count
            FROM memberships_raw
            """
        )

        con.execute("CREATE INDEX IF NOT EXISTS idx_tasks_task_id ON tasks(task_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_memberships_task_id ON memberships(task_id)")

        con.execute(
            """
            CREATE TABLE task_graph_hourly AS
            SELECT
                minute_date,
                minute_hour,
                count(*) AS task_count,
                sum(point_count) AS point_count,
                sum(file_count) AS file_count,
                avg(point_count) AS avg_points_per_task,
                avg(file_count) AS avg_files_per_task,
                sum(CASE WHEN coalesce(is_night, 0) = 1 THEN 1 ELSE 0 END) AS night_task_count
            FROM tasks
            GROUP BY 1, 2
            ORDER BY 1, 2
            """
        )

        con.execute(
            """
            CREATE TABLE task_graph_files AS
            SELECT
                file_relpath,
                count(*) AS task_count,
                sum(point_count) AS point_count
            FROM memberships
            GROUP BY 1
            ORDER BY task_count DESC, point_count DESC, file_relpath
            """
        )

        metrics = con.execute(
            """
            SELECT
                count(*) AS task_count,
                count(DISTINCT cell_key) AS cell_count,
                count(DISTINCT minute_iso) AS minute_count,
                sum(point_count) AS point_count,
                avg(point_count) AS avg_points_per_task,
                max(point_count) AS max_points_per_task,
                avg(file_count) AS avg_files_per_task,
                max(file_count) AS max_files_per_task,
                sum(CASE WHEN coalesce(is_night, 0) = 1 THEN 1 ELSE 0 END) AS night_task_count
            FROM tasks
            """
        ).fetchone()

        membership_metrics = con.execute(
            """
            SELECT
                count(*) AS membership_edge_count,
                avg(point_count) AS avg_points_per_edge,
                max(point_count) AS max_points_per_edge
            FROM memberships
            """
        ).fetchone()

        task_count = int(metrics[0] or 0)
        point_count = int(metrics[3] or 0)
        row_compression_ratio = float(point_count) / float(task_count) if task_count else 0.0

        meta = {
            "summary_json": str(summary_path),
            "source_tasks_csv": str(tasks_csv),
            "source_memberships_csv": str(memberships_csv),
            "duckdb_path": str(db_path),
            "task_count": task_count,
            "cell_count": int(metrics[1] or 0),
            "minute_count": int(metrics[2] or 0),
            "point_count": point_count,
            "avg_points_per_task": float(metrics[4] or 0.0),
            "max_points_per_task": int(metrics[5] or 0),
            "avg_files_per_task": float(metrics[6] or 0.0),
            "max_files_per_task": int(metrics[7] or 0),
            "night_task_count": int(metrics[8] or 0),
            "membership_edge_count": int(membership_metrics[0] or 0),
            "avg_points_per_edge": float(membership_metrics[1] or 0.0),
            "max_points_per_edge": int(membership_metrics[2] or 0),
            "row_compression_ratio": row_compression_ratio,
        }

        con.execute("CREATE TABLE task_graph_meta (key VARCHAR, value VARCHAR)")
        con.executemany(
            "INSERT INTO task_graph_meta VALUES (?, ?)",
            [(key, json.dumps(value, ensure_ascii=False)) for key, value in meta.items()],
        )

        if args.export_parquet:
            parquet_dir = output_dir / "parquet"
            parquet_dir.mkdir(parents=True, exist_ok=True)
            con.execute(f"COPY tasks TO {sql_quote(str(parquet_dir / 'tasks.parquet'))} (FORMAT PARQUET)")
            con.execute(
                f"COPY memberships TO {sql_quote(str(parquet_dir / 'memberships.parquet'))} (FORMAT PARQUET)"
            )
            con.execute(
                f"COPY task_graph_hourly TO {sql_quote(str(parquet_dir / 'task_graph_hourly.parquet'))} (FORMAT PARQUET)"
            )
            con.execute(
                f"COPY task_graph_files TO {sql_quote(str(parquet_dir / 'task_graph_files.parquet'))} (FORMAT PARQUET)"
            )
            meta["parquet_dir"] = str(parquet_dir)

        (output_dir / "duckdb_summary.json").write_text(
            json.dumps(meta, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(json.dumps(meta, indent=2, ensure_ascii=False))
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
