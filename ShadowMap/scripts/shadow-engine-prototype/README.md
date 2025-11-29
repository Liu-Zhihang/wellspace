# Shadow Engine Prototype

This directory contains a self‑contained prototype for evaluating
[`pybdshadow`](https://pypi.org/project/pybdshadow/) as a replacement for
the current ShadeMap based sampling workflow.

The prototype performs three steps:

1. **Fetch building footprints** from the existing WFS proxy in the backend
   (`/api/buildings/bounds`).
2. **Convert** the GeoJSON response into a `GeoDataFrame` with height
   attributes that `pybdshadow` can consume.
3. **Generate shadow polygons** for a given timestamp using
   `pybdshadow.shadow.sunlight_shadow` and export the result as GeoJSON.

The script is designed to run locally or inside a notebook so that we can
benchmark both performance and numerical accuracy before wiring it into a
permanent service.

## Usage

```bash
python prototype.py \
  --west 114.154 \
  --south 22.278 \
  --east 114.174 \
  --north 22.291 \
  --timestamp "2024-06-21T09:00:00" \
  --output-dir ./outputs
```

Arguments:

- `--west/--south/--east/--north` – Bounding box in WGS84 matching the
  existing `/api/buildings/bounds` contract.
- `--timestamp` – ISO 8601 timestamp (assumed local Hong Kong time unless a
  `--timezone` override is supplied).
- `--backend-url` – Optional override for the backend origin. Defaults to
  `http://localhost:3500` for local testing.
- `--output-dir` – Directory used to persist the resulting
  `buildings.geojson` and `shadows.geojson` files for inspection.

## Requirements

Install the Python dependencies within a virtual environment. On Windows, keep
the directory path short (for example `C:\shadow_proto`) to avoid hitting the
OS path-length limit:

```bash
REM create a short working directory (adjust if needed)
mkdir C:\shadow_proto
xcopy /E /I ShadowMap\scripts\shadow-engine-prototype C:\shadow_proto

REM create & activate venv inside the short path
cd /d C:\shadow_proto
python -m venv .venv
.venv\Scripts\activate

REM optional: shorten temp dir for this session
set TMP=C:\shadow_proto\tmp
set TEMP=C:\shadow_proto\tmp

REM install dependencies
pip install --upgrade pip
pip install -r requirements.txt
```

## Local CLI Worker

`service_cli.py` exposes the same logic via STDIN/STDOUT so the Node backend
can spawn it for each `/api/analysis/shadow` request. Requirements:

1. Prepare the virtual environment as described above (`pip install -r requirements.txt`).
2. Point the backend to the script by updating `.env`:

```
SHADOW_ENGINE_SCRIPT_PATH=../scripts/shadow-engine-prototype/service_cli.py
SHADOW_ENGINE_PYTHON_PATH=python  # or python3
SHADOW_ENGINE_BACKEND_URL=http://localhost:3500
SHADOW_ENGINE_TIMEZONE=Asia/Hong_Kong
```

3. Restart the backend (`pnpm run dev`). When `SHADOW_ENGINE_BASE_URL` is empty,
   the service will stream payloads into the CLI script instead of using the
   built-in simulator.

You can also run the script manually for debugging:

```bash
cat payload.json | python service_cli.py
```

Where `payload.json` matches the structure documented in the script docstring.

## Notes

- The prototype expects the backend to expose building footprints with a
  `height` attribute. If the upstream service uses a different field, adjust
  the mapping inside `prototype.py` (`extract_building_height`).
- `pybdshadow` (currently tested with v0.3.5 because the USTC/Tsinghua mirror has
  not published newer releases) relies on `suncalc-py` for solar position. Ensure
  the machine running the prototype has the `tzdata` package available if
  you execute it inside a container.
- At this stage the script is intended for exploration. Integration into the
  production backend will require additional work (API surface, caching,
  security, monitoring).
