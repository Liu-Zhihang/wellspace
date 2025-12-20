# ShadowMap Project Overview

ShadowMap visualises urban building shadows and sunlight exposure. The repository contains both the React frontend (multiple Mapbox-based modes) and the TypeScript backend services.

## Demo Videos

- Demo 1: [`video_1.mp4`](ShadowMap/shadow-map-frontend/react-shadow-app/public/video/video_1.mp4)
- Demo 2: [`video_2.mp4`](ShadowMap/shadow-map-frontend/react-shadow-app/public/video/video_2.mp4)

See `DOCS_INDEX.md` first if you are new to this repository (data layout, batch compute, GeoServer/WFS runbooks).

## Two Main Workflows

This repo supports two primary workflows. Keep them conceptually separate:

1) **Demo / interactive (HTTP)**
   - React frontend → Express backend → WFS/DEM/weather services (GeoServer/PostGIS + ERA5).
   - Used for live 3D visualisation and ad-hoc analysis.

2) **Paper / offline batch (Python-first, recommended for research outputs)**
   - Runs locally without `node -> HTTP -> backend` to avoid network/IO bottlenecks.
   - Computes per-minute mobility sunlight/shadow directly from local buildings (GPKG/GeoJSON), canopy raster (optional), and ERA5.
   - Produces `*-sunlight.csv` outputs that are designed for downstream statistical analysis.

## Feature Highlights

- **Mapbox-first experience** – Clean 3D layout built on ShadeMap + Mapbox GL.
- **Shadow analysis** – calculates building shadows and daylight hours based on date/time.
- **Multiple data sources** – WFS, cached datasets, DEM elevation tiles with fallbacks.
- **Weather-aware shading** – ERA5-derived cloud attenuation (tcc/ssrd) with local caching.
- **Performance helpers** – multi-level cache, smart shadow scheduler, debounced updates.
- **Geometry analysis (in progress)** – upcoming ability to upload GeoJSON polygons for shadow coverage & sunlight statistics (`REQ-ANALYSIS-01`).

## Repository Layout

```
ShadowMap/                                 # workspace root (app + scripts)
├── shadow-map-frontend/react-shadow-app   # React + TypeScript client
├── shadow-map-backend                     # Express + TypeScript backend
├── scripts                                # batch compute & utilities
├── docs                                   # mobility sunlight/shadow docs
└── Chinese documents                      # operational notes (CN)
```

See `DOCS_INDEX.md` for the canonical guide; `CODEBASE_STRUCTURE.md` is kept as a short pointer.

## Getting Started

### Frontend

```bash
cd ShadowMap/shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev        # development
pnpm run build      # production build
```

The Clean 3D mode is now the sole experience; legacy Mapbox/WFS/Leaflet toggles were removed in `feature/clean-mode-consolidation`.

### Backend

```bash
cd ShadowMap/shadow-map-backend
cp .env.example .env
npm install
npm run dev         # development (nodemon)
npm run build && npm start   # production
```

Copy `.env.example` to `.env` and provide WFS credentials before starting the API.

### Offline / Batch (pure Python)

For cross-machine path consistency, copy `ShadowMap/.shadowmap.env.example` to `ShadowMap/.shadowmap.env` (gitignored) and set your local dataset paths.

Run the batched recompute runner (single Python invocation, bucket-level concurrency):

```bash
CONCURRENCY=32 bash ShadowMap/scripts/run_full_recal_batch.sh
```

### Output Quality (recommended for paper data)

Some legacy `*-sunlight.csv` outputs were produced without proper CSV quoting, which can break column alignment and downstream statistics.

Use the built-in validators before running analyses:

```bash
FINAL_OUT="$HOME/DATASET/GLAN_processed"
python3 ShadowMap/scripts/validate_sunlight_csv.py --root "$FINAL_OUT" --max-rows-per-file 5000 \
  --write-bad-list "$FINAL_OUT/_shadowmap_tasks/bad_sunlight_files.txt"

python3 ShadowMap/scripts/repair_sunlight_csv.py --root "$FINAL_OUT" \
  --bad-list "$FINAL_OUT/_shadowmap_tasks/bad_sunlight_files.txt" \
  --write
```

## Current Focus

1. Keep the demo pipeline stable: GeoServer/PostGIS/WFS + backend + frontend.
2. Scale offline mobility sunlight/shadow batch compute (Python-first; canopy optional).
3. Keep docs/data/runbooks in sync as datasets and machines evolve.

See `DOCS_INDEX.md` for the canonical workflows; `DEVELOPMENT_PLAN.md` is kept as a short pointer.

## Collaboration Rules

- Every new task must be recorded in the plan document and analysed (plan mode) before implementation.
- After finishing a task, update the relevant docs (`DOCS_INDEX.md`, README if needed; keep appendix docs in sync when they are still referenced).
- Keep branches short (`fix/...`, `feat/...`, `docs/...`) and merge only after build/tests succeed.
