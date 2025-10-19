# Codebase Structure

Last updated: 2025-10-19  
Maintainer: ShadowMap dev team

---

## Top-Level Layout

| Path | Purpose |
| --- | --- |
| `shadow-map-frontend/react-shadow-app/` | React + TypeScript client (Mapbox focus) |
| `shadow-map-backend/` | Express + TypeScript API services (WFS, cache, DEM) |
| `prototypes/` | Stand-alone HTML/JS experiments (kept for reference only) |
| `scripts/` | Maintenance and data preparation scripts |
| `Chinese documents/` | Reference notes (中文) |

---

## Frontend (react-shadow-app)

```
src/
├── App.tsx                   # Mode switch, map shell
├── components/
│   ├── Map/                  # Map engines (Mapbox, WFS 3D, Clean mode)
│   ├── UI/                   # Panels, toolbars, controls
│   └── Controls/             # Legacy controls (some pending cleanup)
├── hooks/                    # Shadow analysis, map state helpers
├── services/                 # Data fetchers (WFS, cache, DEM, base maps)
├── store/                    # Zustand store for map + analysis state
├── types/                    # Shared TypeScript types (geo + map)
└── utils/                    # Caching, performance, diagnostics helpers
```

Key entry points:

- `components/Map/MapboxMapComponent.tsx` – default interactive map.
- `components/Map/Wfs3DShadowMap.tsx` – WFS-driven 3D shadow renderer.
- `components/Map/CleanShadowMap.tsx` – experimental clean UI mode.
- `hooks/useShadowMap.ts` – orchestrates map store, ShadeMap integration.
- `services/wfsBuildingService.ts` – main gateway to backend WFS APIs.

Build tooling: Vite + pnpm (`pnpm run dev`, `pnpm run build`).

---

## Backend (shadow-map-backend)

```
src/
├── app.ts                    # Express app setup
├── routes/                   # REST endpoints (buildings, DEM, weather, etc.)
├── services/                 # Business logic (caching, WFS, Mongo, TUM data)
├── models/                   # TypeORM / Mongoose style models
├── scripts/                  # Data loaders
└── utils/                    # Validation, logging helpers
```

Key endpoints:

- `routes/buildings.ts` – live WFS/TUM building fetch.
- `routes/dem.ts` – digital elevation tiles.
- `routes/health.ts` – service health probe.

Build/run: `npm run dev` (nodemon), `npm run build && npm start` for prod.

---

## Shared Conventions

- TypeScript strict mode on both frontend and backend.
- Zustand store exposes map state (`src/store/shadowMapStore.ts`).
- Multi-layer caching lives in `src/utils/multiLevelCache.ts` (frontend) and `shadow-map-backend/src/services/*Cache*.ts`.

Keep this document updated whenever directories move, major files are added, or responsibilities change.
