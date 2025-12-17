# ShadowMap Project Overview

ShadowMap visualises urban building shadows and sunlight exposure. The repository contains both the React frontend (multiple Mapbox-based modes) and the TypeScript backend services.

## Demo Videos

- Demo 1: [`video_1.mp4`](ShadowMap/shadow-map-frontend/react-shadow-app/public/video/video_1.mp4)
- Demo 2: [`video_2.mp4`](ShadowMap/shadow-map-frontend/react-shadow-app/public/video/video_2.mp4)

See `DOCS_INDEX.md` first if you are new to this repository (data layout, batch compute, GeoServer/WFS runbooks).

## Feature Highlights

- **Mapbox-first experience** – Clean 3D layout built on ShadeMap + Mapbox GL.
- **Shadow analysis** – calculates building shadows and daylight hours based on date/time.
- **Multiple data sources** – WFS, cached datasets, DEM elevation tiles with fallbacks.
- **Weather-aware shading** – GFS-derived cloud attenuation with local caching.
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

See `CODEBASE_STRUCTURE.md` for detailed directory information.

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

## Current Focus

1. Keep the demo pipeline stable: GeoServer/PostGIS/WFS + backend + frontend.
2. Scale offline mobility sunlight/shadow batch compute (Python-first; canopy optional).
3. Keep docs/data/runbooks in sync as datasets and machines evolve.

See `DEVELOPMENT_PLAN.md` for the sprint plan and task status.

## Collaboration Rules

- Every new task must be recorded in the plan document and analysed (plan mode) before implementation.
- After finishing a task, update the relevant docs (`CODEBASE_STRUCTURE.md`, `DEVELOPMENT_PLAN.md`, README if needed).
- Keep branches short (`fix/...`, `feat/...`, `docs/...`) and merge only after build/tests succeed.
