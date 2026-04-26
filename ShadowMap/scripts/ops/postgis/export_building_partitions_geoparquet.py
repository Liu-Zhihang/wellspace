#!/usr/bin/env python3
"""Export selected PostGIS building partitions into GeoParquet files.

The target host may not have GDAL's Parquet driver enabled. This prototype
therefore uses a two-step path:

1. `ogr2ogr` reads PostGIS and writes a temporary vector file (`GPKG` by default)
2. `GeoPandas` reads that temporary file and writes GeoParquet
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--partition-catalog-json", required=True, help="Partition catalog JSON path.")
    parser.add_argument("--output-root", required=True, help="Directory for GeoParquet partitions.")
    parser.add_argument(
        "--table",
        default="public.buildings_us_lod1",
        help="Source PostGIS table, defaults to public.buildings_us_lod1.",
    )
    parser.add_argument(
        "--pg-dsn",
        default=os.getenv("SHADOWMAP_POSTGIS_OGR_DSN", ""),
        help="OGR PG: connection string. Defaults to SHADOWMAP_POSTGIS_OGR_DSN.",
    )
    parser.add_argument(
        "--partition-ids-file",
        default="",
        help="Optional newline-delimited partition ID allowlist.",
    )
    parser.add_argument(
        "--partition-id",
        action="append",
        default=[],
        help="Optional explicit partition ID(s) to export.",
    )
    parser.add_argument(
        "--max-partitions",
        type=int,
        default=0,
        help="Optional cap for prototype exports. 0 means no cap.",
    )
    parser.add_argument(
        "--append-manifest",
        default="",
        help="Optional CSV path to record exported files and row counts.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing partition parquet files.",
    )
    parser.add_argument(
        "--temp-driver",
        default="GPKG",
        choices=("GPKG", "GeoJSON"),
        help="Temporary GDAL vector format used before writing GeoParquet.",
    )
    parser.add_argument(
        "--ogr2ogr-bin",
        default="ogr2ogr",
        help="ogr2ogr binary to invoke. Defaults to `ogr2ogr` on PATH.",
    )
    parser.add_argument(
        "--write-covering-bbox",
        action="store_true",
        help="Write GeoParquet covering bbox metadata to support bbox-filtered reads.",
    )
    return parser


def load_catalog(path: Path) -> List[Dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError(f"Partition catalog must be a JSON array: {path}")
    rows: List[Dict[str, Any]] = []
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeError(f"Partition catalog entry #{idx} is not an object")
        rows.append(
            {
                "partitionId": str(item["partitionId"]),
                "parentTileId": str(item["parentTileId"]),
                "minLon": float(item["minLon"]),
                "minLat": float(item["minLat"]),
                "maxLon": float(item["maxLon"]),
                "maxLat": float(item["maxLat"]),
                "partitionSizeDeg": float(item.get("partitionSizeDeg", 0.0) or 0.0),
                "region": None if item.get("region") is None else str(item.get("region")),
            }
        )
    return rows


def shell_escape_sql_literal(value: str) -> str:
    return value.replace("'", "''")


def selected_ids(args: argparse.Namespace) -> Optional[Set[str]]:
    ids: Set[str] = set(args.partition_id or [])
    if args.partition_ids_file:
        path = Path(args.partition_ids_file).expanduser().resolve()
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped:
                ids.add(stripped)
    return ids or None


def write_manifest(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "partitionId",
                "parentTileId",
                "outputParquet",
                "rowCount",
                "minLon",
                "minLat",
                "maxLon",
                "maxLat",
            ],
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    args = build_parser().parse_args()
    if not args.pg_dsn:
        raise RuntimeError(
            "Missing PostGIS connection string. Pass --pg-dsn or set SHADOWMAP_POSTGIS_OGR_DSN."
        )
    ogr2ogr_bin = str(args.ogr2ogr_bin)
    resolved_ogr2ogr = shutil.which(ogr2ogr_bin) if os.sep not in ogr2ogr_bin else ogr2ogr_bin
    if not resolved_ogr2ogr or not Path(resolved_ogr2ogr).exists():
        raise RuntimeError(f"ogr2ogr is required but not found: {ogr2ogr_bin}")
    try:
        import geopandas as gpd  # noqa: F401
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("GeoParquet export requires geopandas in this Python environment.") from exc
    try:
        import pyarrow.parquet as pq  # noqa: F401
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("GeoParquet export requires pyarrow in this Python environment.") from exc

    catalog_path = Path(args.partition_catalog_json).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = (
        Path(args.append_manifest).expanduser().resolve()
        if args.append_manifest
        else output_root / "export_manifest.csv"
    )

    allowed = selected_ids(args)
    rows = load_catalog(catalog_path)
    if allowed is not None:
        rows = [row for row in rows if row["partitionId"] in allowed]
    if args.max_partitions > 0:
        rows = rows[: args.max_partitions]
    if not rows:
        raise RuntimeError("No partitions selected for export")

    manifest_rows: List[Dict[str, Any]] = []
    ogr_pg_dsn = str(args.pg_dsn)
    if ogr_pg_dsn.lower().startswith("pg:"):
        ogr_pg_conn = ogr_pg_dsn
    else:
        ogr_pg_conn = f"PG:{ogr_pg_dsn}"
    for row in rows:
        partition_id = row["partitionId"]
        output_path = output_root / f"{partition_id}.parquet"
        if output_path.exists() and not args.overwrite:
            manifest_rows.append(
                {
                    "partitionId": partition_id,
                    "parentTileId": row["parentTileId"],
                    "outputParquet": str(output_path),
                    "rowCount": "",
                    "minLon": row["minLon"],
                    "minLat": row["minLat"],
                    "maxLon": row["maxLon"],
                    "maxLat": row["maxLat"],
                }
            )
            continue

        sql = f"""
SELECT
  ogc_fid,
  source,
  id,
  height,
  var,
  region,
  tile_id,
  geom
FROM {args.table}
WHERE tile_id = '{shell_escape_sql_literal(row["parentTileId"])}'
  AND geom && ST_MakeEnvelope({row["minLon"]}, {row["minLat"]}, {row["maxLon"]}, {row["maxLat"]}, 4326)
  AND ST_Intersects(
        geom,
        ST_MakeEnvelope({row["minLon"]}, {row["minLat"]}, {row["maxLon"]}, {row["maxLat"]}, 4326)
      )
""".strip()

        suffix = ".gpkg" if args.temp_driver == "GPKG" else ".geojson"
        temp_fd, temp_name = tempfile.mkstemp(prefix=f"{partition_id}_", suffix=suffix)
        os.close(temp_fd)
        temp_path = Path(temp_name)
        temp_path.unlink(missing_ok=True)
        try:
            temp_cmd = [
                str(resolved_ogr2ogr),
                "-overwrite",
                "-f",
                args.temp_driver,
                str(temp_path),
                ogr_pg_conn,
                "-dialect",
                "PostgreSQL",
                "-sql",
                sql,
            ]
            completed = subprocess.run(
                temp_cmd,
                check=False,
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                raise RuntimeError(
                    "ogr2ogr export failed for partition "
                    f"{partition_id}\n"
                    f"command: {' '.join(temp_cmd)}\n"
                    f"stdout:\n{completed.stdout}\n"
                    f"stderr:\n{completed.stderr}"
                )

            import geopandas as gpd
            import pyarrow.parquet as pq

            gdf = gpd.read_file(temp_path)
            if output_path.exists() and args.overwrite:
                output_path.unlink()
            gdf.to_parquet(
                output_path,
                index=False,
                write_covering_bbox=bool(args.write_covering_bbox),
            )
            row_count = str(pq.ParquetFile(output_path).metadata.num_rows) if output_path.exists() else ""
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except Exception:
                pass

        manifest_rows.append(
            {
                "partitionId": partition_id,
                "parentTileId": row["parentTileId"],
                "outputParquet": str(output_path),
                "rowCount": row_count,
                "minLon": row["minLon"],
                "minLat": row["minLat"],
                "maxLon": row["maxLon"],
                "maxLat": row["maxLat"],
            }
        )

    write_manifest(manifest_path, manifest_rows)
    print(
        json.dumps(
            {
                "partition_catalog_json": str(catalog_path),
                "output_root": str(output_root),
                "table": args.table,
                "selected_partition_count": len(rows),
                "manifest_path": str(manifest_path),
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
