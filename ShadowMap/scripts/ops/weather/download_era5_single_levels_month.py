#!/usr/bin/env python3
"""Download one monthly ERA5 single-level NetCDF for local offline runs.

This helper is intentionally narrow:
- default variables are exactly what the offline mobility pipeline uses today:
  total_cloud_cover (`tcc`) and surface_solar_radiation_downwards (`ssrd`)
- output naming follows the project's canonical local layout

Requirements:
- a CDS account and accepted dataset licence
- ~/.cdsapirc configured for `cdsapi`
- Python package: `cdsapi`

References:
- https://confluence.ecmwf.int/display/CKB/How%20to%20download%20ERA5
- https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels
"""

from __future__ import annotations

import argparse
import calendar
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable, List, Optional


DEFAULT_VARIABLES = [
    "total_cloud_cover",
    "surface_solar_radiation_downwards",
]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", required=True, type=int, help="UTC year, e.g. 2019")
    parser.add_argument("--month", required=True, type=int, help="UTC month, 1-12")
    parser.add_argument(
        "--dataset",
        default="reanalysis-era5-single-levels",
        help="CDS dataset name. Default: reanalysis-era5-single-levels",
    )
    parser.add_argument(
        "--variables",
        nargs="+",
        default=DEFAULT_VARIABLES,
        help="ERA5 single-level variables to request. Defaults to tcc + ssrd equivalents.",
    )
    parser.add_argument(
        "--area",
        default="",
        help="Optional subregion as north/west/south/east, e.g. 49/-125/24/-66",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Explicit output path. Defaults to $SHADOWMAP_DATA_ROOT/infra/weather/era5/global/era5_%Y%m.nc",
    )
    parser.add_argument(
        "--output-dir",
        default="",
        help="Directory override when --output is not provided.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow overwriting an existing target file.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resolved request and target path without downloading.",
    )
    return parser.parse_args()


def _days_in_month(year: int, month: int) -> List[str]:
    _, last_day = calendar.monthrange(year, month)
    return [f"{day:02d}" for day in range(1, last_day + 1)]


def _hours() -> List[str]:
    return [f"{hour:02d}:00" for hour in range(24)]


def _resolve_output(args: argparse.Namespace) -> Path:
    if args.output:
        return Path(args.output).expanduser().resolve()

    data_root = Path(
        os.environ.get("SHADOWMAP_DATA_ROOT", str(Path.home() / "datasets" / "wellspace_v2" / "shadowmap"))
    ).expanduser()
    output_dir = Path(args.output_dir).expanduser() if args.output_dir else data_root / "infra" / "weather" / "era5" / "global"
    output_dir = output_dir.resolve()
    return output_dir / f"era5_{args.year}{args.month:02d}.nc"


def _parse_area(raw: str) -> Optional[List[float]]:
    value = str(raw or "").strip()
    if not value:
        return None
    parts = [part.strip() for part in value.split("/")]
    if len(parts) != 4:
        raise ValueError(f"Invalid --area '{raw}'. Expected north/west/south/east.")
    return [float(part) for part in parts]


def _build_request(args: argparse.Namespace) -> dict:
    request = {
        "product_type": "reanalysis",
        "variable": list(args.variables),
        "year": f"{args.year:04d}",
        "month": f"{args.month:02d}",
        "day": _days_in_month(args.year, args.month),
        "time": _hours(),
        "format": "netcdf",
    }
    area = _parse_area(args.area)
    if area is not None:
        request["area"] = area
    return request


def _print_request(request: dict, target: Path) -> None:
    print(f"target={target}")
    for key in ("product_type", "variable", "year", "month", "day", "time", "area", "format"):
        if key in request:
            print(f"{key}={request[key]}")


def _open_dataset_with_fallback(file_path: Path):
    try:
        import xarray as xr  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "ZIP-normalized ERA5 downloads require xarray in the active Python environment."
        ) from exc

    last_exc: Optional[Exception] = None
    for engine in ("netcdf4", "h5netcdf", "scipy"):
        try:
            return xr.open_dataset(file_path, engine=engine), engine
        except Exception as exc:
            last_exc = exc
    raise RuntimeError(f"Unable to open extracted ERA5 member: {file_path} ({last_exc})")


def _normalize_downloaded_target(target: Path) -> None:
    if not zipfile.is_zipfile(target):
        return

    temp_dir = Path(tempfile.mkdtemp(prefix="era5_zip_normalize_"))
    temp_target = target.with_name(f"{target.name}.tmp")
    backup_zip = target.with_suffix(target.suffix + ".zip")
    datasets = []
    merged = None

    try:
        with zipfile.ZipFile(target, "r") as archive:
            members = [name for name in archive.namelist() if name.lower().endswith(".nc")]
            if not members:
                raise RuntimeError(f"ZIP download contains no .nc members: {target}")
            for member in members:
                archive.extract(member, temp_dir)

        for member in members:
            extracted = temp_dir / member
            ds, _engine = _open_dataset_with_fallback(extracted)
            datasets.append(ds)

        try:
            import xarray as xr  # type: ignore
        except Exception as exc:
            raise RuntimeError(
                "ZIP-normalized ERA5 downloads require xarray in the active Python environment."
            ) from exc

        merged = xr.merge(datasets, compat="override", join="exact")
        if temp_target.exists():
            temp_target.unlink()
        merged.to_netcdf(temp_target)

        if backup_zip.exists():
            backup_zip.unlink()
        os.replace(target, backup_zip)
        os.replace(temp_target, target)
        print(f"[Info] normalized ZIP ERA5 download -> {target}")
        print(f"[Info] original ZIP preserved at {backup_zip}")
    finally:
        for ds in datasets:
            try:
                ds.close()
            except Exception:
                pass
        if merged is not None:
            try:
                merged.close()
            except Exception:
                pass
        if temp_target.exists():
            try:
                temp_target.unlink()
            except Exception:
                pass
        shutil.rmtree(temp_dir, ignore_errors=True)


def main() -> int:
    args = _parse_args()
    if args.month < 1 or args.month > 12:
        raise SystemExit("--month must be in 1..12")

    target = _resolve_output(args)
    request = _build_request(args)

    if target.exists() and not args.overwrite:
        raise SystemExit(f"Target already exists: {target}. Pass --overwrite to replace it.")

    target.parent.mkdir(parents=True, exist_ok=True)

    if args.dry_run:
        _print_request(request, target)
        return 0

    try:
        import cdsapi  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise SystemExit(
            "Missing dependency 'cdsapi'. Install it in the active Python environment and configure ~/.cdsapirc."
        ) from exc

    print(f"[Info] dataset={args.dataset}")
    print(f"[Info] target={target}")
    client = cdsapi.Client()
    client.retrieve(args.dataset, request, str(target))
    _normalize_downloaded_target(target)
    print(f"[Done] downloaded {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
