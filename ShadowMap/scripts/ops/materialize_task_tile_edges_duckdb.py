#!/usr/bin/env python3
"""Materialize task-to-candidate-tile edges for the national compute framework.

This stage sits after the task-graph materialization. It turns a prepared
`tasks` table plus a building tile catalog into a reusable `task -> tile`
edge table so downstream exact shadow runs do not need to discover candidate
tiles online.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--task-graph-db",
        required=True,
        help="Path to the DuckDB produced by materialize_task_graph_duckdb.py",
    )
    parser.add_argument(
        "--tile-catalog-json",
        required=True,
        help="Tile catalog JSON path with entries like tileId/minLon/minLat/maxLon/maxLat.",
    )
    parser.add_argument(
        "--edge-table-name",
        default="task_tile_edges",
        help="Destination edge table name inside DuckDB.",
    )
    parser.add_argument(
        "--context-m",
        type=float,
        default=400.0,
        help=(
            "Meters to expand each task bbox before tile matching. "
            "This is a routing-side obstacle lookup margin, not output resolution."
        ),
    )
    parser.add_argument(
        "--export-parquet",
        action="store_true",
        help="Also export edge/fanout tables to Parquet under a sibling parquet directory.",
    )
    return parser


def sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def load_tile_catalog(path: Path) -> List[Dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError(f"Tile catalog must be a JSON array: {path}")

    rows: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeError(f"Tile catalog entry #{idx} is not an object")
        tile_id = str(item.get("tileId") or item.get("id") or "").strip()
        min_lon = float(item["minLon"])
        min_lat = float(item["minLat"])
        max_lon = float(item["maxLon"])
        max_lat = float(item["maxLat"])
        if not tile_id:
            raise RuntimeError(f"Tile catalog entry #{idx} is missing tileId")
        rows.append(
            {
                "tile_id": tile_id,
                "min_lon": min_lon,
                "min_lat": min_lat,
                "max_lon": max_lon,
                "max_lat": max_lat,
                "region": None if item.get("region") is None else str(item.get("region")),
                "description": None
                if item.get("description") is None
                else str(item.get("description")),
            }
        )
    if not rows:
        raise RuntimeError(f"Tile catalog is empty: {path}")
    return rows


def execute_many(con: Any, sql: str, rows: Iterable[tuple[Any, ...]]) -> None:
    materialized = list(rows)
    if materialized:
        con.executemany(sql, materialized)


def main() -> int:
    args = build_parser().parse_args()

    db_path = Path(args.task_graph_db).expanduser().resolve()
    catalog_path = Path(args.tile_catalog_json).expanduser().resolve()
    context_m = float(args.context_m)
    edge_table = args.edge_table_name
    fanout_table = f"{edge_table}_fanout"
    tile_fanout_table = f"{edge_table}_tile_fanout"

    if not db_path.exists():
        raise RuntimeError(f"Task-graph DuckDB not found: {db_path}")
    if not catalog_path.exists():
        raise RuntimeError(f"Tile catalog JSON not found: {catalog_path}")

    tile_rows = load_tile_catalog(catalog_path)

    try:
        import duckdb
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "Task-to-tile materialization requires the `duckdb` Python package."
        ) from exc

    con = duckdb.connect(str(db_path))
    try:
        con.execute("PRAGMA threads=8")
        con.execute("DROP TABLE IF EXISTS tile_catalog")
        con.execute("DROP TABLE IF EXISTS tile_catalog_raw")
        con.execute(f"DROP TABLE IF EXISTS {edge_table}")
        con.execute(f"DROP TABLE IF EXISTS {fanout_table}")
        con.execute(f"DROP TABLE IF EXISTS {tile_fanout_table}")

        con.execute(
            """
            CREATE TABLE tile_catalog_raw (
              tile_id VARCHAR,
              min_lon DOUBLE,
              min_lat DOUBLE,
              max_lon DOUBLE,
              max_lat DOUBLE,
              region VARCHAR,
              description VARCHAR
            )
            """
        )
        execute_many(
            con,
            "INSERT INTO tile_catalog_raw VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                (
                    row["tile_id"],
                    row["min_lon"],
                    row["min_lat"],
                    row["max_lon"],
                    row["max_lat"],
                    row["region"],
                    row["description"],
                )
                for row in tile_rows
            ),
        )
        con.execute(
            """
            CREATE TABLE tile_catalog AS
            SELECT DISTINCT
              tile_id,
              min_lon,
              min_lat,
              max_lon,
              max_lat,
              region,
              description
            FROM tile_catalog_raw
            """
        )

        con.execute(
            f"""
            CREATE TABLE {edge_table} AS
            WITH expanded_tasks AS (
              SELECT
                task_id,
                minute_iso,
                minute_ts,
                cell_key,
                point_count,
                file_count,
                west,
                south,
                east,
                north,
                (south + north) / 2.0 AS center_lat,
                {context_m} / 111320.0 AS pad_lat_deg,
                CASE
                  WHEN abs(cos(radians((south + north) / 2.0))) < 1e-6 THEN 180.0
                  ELSE {context_m} / (111320.0 * abs(cos(radians((south + north) / 2.0))))
                END AS pad_lon_deg
              FROM tasks
            )
            SELECT
              t.task_id,
              t.minute_iso,
              t.minute_ts,
              t.cell_key,
              t.point_count,
              t.file_count,
              t.west,
              t.south,
              t.east,
              t.north,
              tc.tile_id,
              tc.min_lon AS tile_min_lon,
              tc.min_lat AS tile_min_lat,
              tc.max_lon AS tile_max_lon,
              tc.max_lat AS tile_max_lat,
              tc.region,
              tc.description
            FROM expanded_tasks t
            JOIN tile_catalog tc
              ON tc.min_lon <= (t.east + t.pad_lon_deg)
             AND tc.max_lon >= (t.west - t.pad_lon_deg)
             AND tc.min_lat <= (t.north + t.pad_lat_deg)
             AND tc.max_lat >= (t.south - t.pad_lat_deg)
            """
        )
        con.execute(f"CREATE INDEX IF NOT EXISTS idx_{edge_table}_task_id ON {edge_table}(task_id)")
        con.execute(f"CREATE INDEX IF NOT EXISTS idx_{edge_table}_tile_id ON {edge_table}(tile_id)")

        con.execute(
            f"""
            CREATE TABLE {fanout_table} AS
            SELECT
              task_id,
              min(minute_iso) AS minute_iso,
              min(cell_key) AS cell_key,
              max(point_count) AS point_count,
              max(file_count) AS file_count,
              count(*)::BIGINT AS tile_count
            FROM {edge_table}
            GROUP BY 1
            ORDER BY tile_count DESC, point_count DESC, task_id
            """
        )
        con.execute(
            f"""
            CREATE TABLE {tile_fanout_table} AS
            SELECT
              tile_id,
              count(*)::BIGINT AS task_count,
              sum(point_count)::BIGINT AS point_count,
              avg(point_count)::DOUBLE AS avg_points_per_task
            FROM {edge_table}
            GROUP BY 1
            ORDER BY task_count DESC, point_count DESC, tile_id
            """
        )

        edge_metrics = con.execute(
            f"""
            SELECT
              count(*)::BIGINT AS edge_count,
              count(DISTINCT task_id)::BIGINT AS matched_task_count,
              count(DISTINCT tile_id)::BIGINT AS matched_tile_count
            FROM {edge_table}
            """
        ).fetchone()

        task_metrics = con.execute(
            f"""
            SELECT
              avg(tile_count)::DOUBLE AS avg_tiles_per_task,
              max(tile_count)::BIGINT AS max_tiles_per_task,
              sum(CASE WHEN tile_count > 1 THEN 1 ELSE 0 END)::BIGINT AS multi_tile_task_count
            FROM {fanout_table}
            """
        ).fetchone()

        tile_metrics = con.execute(
            f"""
            SELECT
              avg(task_count)::DOUBLE AS avg_tasks_per_tile,
              max(task_count)::BIGINT AS max_tasks_per_tile
            FROM {tile_fanout_table}
            """
        ).fetchone()

        total_task_count = int(con.execute("SELECT count(*) FROM tasks").fetchone()[0] or 0)
        matched_task_count = int(edge_metrics[1] or 0)
        unmatched_task_count = total_task_count - matched_task_count

        summary = {
            "task_graph_db": str(db_path),
            "tile_catalog_json": str(catalog_path),
            "context_m": context_m,
            "edge_table_name": edge_table,
            "fanout_table_name": fanout_table,
            "tile_fanout_table_name": tile_fanout_table,
            "task_count": total_task_count,
            "matched_task_count": matched_task_count,
            "unmatched_task_count": unmatched_task_count,
            "tile_catalog_count": len(tile_rows),
            "matched_tile_count": int(edge_metrics[2] or 0),
            "edge_count": int(edge_metrics[0] or 0),
            "avg_tiles_per_task": float(task_metrics[0] or 0.0),
            "max_tiles_per_task": int(task_metrics[1] or 0),
            "multi_tile_task_count": int(task_metrics[2] or 0),
            "avg_tasks_per_tile": float(tile_metrics[0] or 0.0),
            "max_tasks_per_tile": int(tile_metrics[1] or 0),
        }
        summary["multi_tile_task_fraction"] = (
            float(summary["multi_tile_task_count"]) / float(matched_task_count)
            if matched_task_count
            else 0.0
        )

        out_dir = db_path.parent
        if args.export_parquet:
            parquet_dir = out_dir / "parquet"
            parquet_dir.mkdir(parents=True, exist_ok=True)
            con.execute(
                f"COPY {edge_table} TO {sql_quote(str(parquet_dir / f'{edge_table}.parquet'))} (FORMAT PARQUET)"
            )
            con.execute(
                f"COPY {fanout_table} TO {sql_quote(str(parquet_dir / f'{fanout_table}.parquet'))} (FORMAT PARQUET)"
            )
            con.execute(
                f"COPY {tile_fanout_table} TO {sql_quote(str(parquet_dir / f'{tile_fanout_table}.parquet'))} (FORMAT PARQUET)"
            )
            summary["parquet_dir"] = str(parquet_dir)

        summary_path = out_dir / f"{edge_table}_summary.json"
        summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
