# ShadowMap Project Overview

ShadowMap visualises urban building shadows and sunlight exposure. The repository contains both the React frontend (multiple Mapbox-based modes) and the TypeScript backend services.

## Feature Highlights

- **Mapbox-first experience** – Clean 3D layout built on ShadeMap + Mapbox GL.
- **Shadow analysis** – calculates building shadows and daylight hours based on date/time.
- **Multiple data sources** – WFS, cached datasets, DEM elevation tiles with fallbacks.
- **Weather-aware shading** – GFS-derived cloud attenuation with local caching.
- **Performance helpers** – multi-level cache, smart shadow scheduler, debounced updates.

## Repository Layout

```
ShadowMap/
├── shadow-map-frontend/react-shadow-app  # React + TypeScript client
├── shadow-map-backend                    # Express + TypeScript backend
├── prototypes                            # Standalone experimental pages
├── scripts                               # Data utilities
└── Chinese documents                     # Reference notes (CN)
```

See `CODEBASE_STRUCTURE.md` for detailed directory information.

## Getting Started

### Frontend

```bash
cd shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev        # development
pnpm run build      # production build
```

The Clean 3D mode is now the sole experience; legacy Mapbox/WFS/Leaflet toggles were removed in `feature/clean-mode-consolidation`.

### Backend

```bash
cd shadow-map-backend
npm install
npm run dev         # development (nodemon)
npm run build && npm start   # production
```

Copy `.env.example` to `.env` and provide WFS credentials before starting the API.

## Current Focus

1. Fix the remaining TypeScript errors in the frontend and restore a clean build.
2. Maintain the Clean-only viewport and continue polishing the consolidated UI.
3. Keep structure/plan/docs up to date to make collaboration predictable.

See `DEVELOPMENT_PLAN.md` for the sprint plan and task status.

## Collaboration Rules

- Every new task must be recorded in the plan document and analysed (plan mode) before implementation.
- After finishing a task, update the relevant docs (`CODEBASE_STRUCTURE.md`, `DEVELOPMENT_PLAN.md`, README if needed).
- Keep branches short (`fix/...`, `feat/...`, `docs/...`) and merge only after build/tests succeed.
