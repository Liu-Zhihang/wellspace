# Codebase Structure

Last updated: 2025-10-19  
Maintainer: ShadowMap dev team

---

## Top-Level Layout

| Path | Purpose |
| --- | --- |
| `shadow-map-frontend/react-shadow-app/` | React + TypeScript client (Clean Mapbox viewport) |
| `shadow-map-backend/` | Express + TypeScript API (WFS proxy, DEM, weather) |
| `prototypes/` | Stand-alone HTML/JS experiments (kept for reference only) |
| `scripts/` | Maintenance and data preparation scripts |
| `Chinese documents/` | Reference notes (中文) |

---

## Frontend (react-shadow-app)

```
src/
├── App.tsx                   # Clean 3D shell + React Query setup
├── components/
│   ├── Map/                  # ShadeMap viewport + building overlays
│   ├── UI/                   # Panels, toolbars, controls
│   └── Controls/             # Timeline, cache utilities, etc.
├── hooks/                    # Shadow analysis, map state helpers
├── services/                 # Data fetchers (buildings, DEM, weather)
├── store/                    # Zustand store for map + analysis state
├── types/                    # Shared TypeScript types (geo + map)
└── utils/                    # Caching, performance, diagnostics helpers
```

Key entry points:

- `components/Map/ShadowMapViewport.tsx` – ShadeMap + Mapbox GL viewport.
- `components/UI/CleanControlPanel.tsx` – time/shadow/style controls.
- `hooks/useShadowMap.ts` – orchestrates map store, ShadeMap integration.
- `hooks/useShadowAnalysis.ts` – prototype shadow/sunlight sampling helpers.
- `components/Analysis/AnalysisPanel.tsx` – right sidebar summary for analysis output.
- `services/wfsBuildingService.ts` – helpers for the building WFS proxy.
- `services/shadowAnalysisService.ts` – deduplicated client for `POST /api/analysis/shadow`, normalises bbox/time buckets, and reuses AbortSignals.
- `services/baseMapManager.ts` – catalogues MapLibre/Mapbox styles (vector + raster fallback) and builds style specs used when Zustand switches the active basemap.
- `store/shadowMapStore.ts` – tracks `shadowServiceStatus`, cached results, and error state to power UI + overlay updates.
- `scripts/shadow-engine-prototype/service_cli.py` – Python worker that runs `pybdshadow` and streams `shadows/sunlight/heatmap` JSON back to the Node backend when `SHADOW_ENGINE_SCRIPT_PATH` is configured.

> Upcoming (`REQ-ANALYSIS-01`): extend the upload workflow so GeoJSON polygons feed the analysis hooks and panel, with exportable summaries.

Build tooling: Vite + pnpm (`pnpm run dev`, `pnpm run build`).

---

## Backend (shadow-map-backend)

```
src/
├── app.ts                    # Express app setup
├── routes/                   # REST endpoints (buildings, DEM, weather, health)
├── services/                 # DEM tiles, WFS proxy helpers, GFS integration
└── config/                   # Environment configuration
```

Key endpoints:

- `routes/buildings.ts` – serves tiles via WFS proxy.
- `routes/dem.ts` – digital elevation tiles.
- `routes/health.ts` – service health probe.
- `routes/analysis.ts` – abstracts the real-time shadow engine via `POST /api/analysis/shadow`, applying bbox+time-bucket caching, timeout/error policy, and deployment metadata by calling `services/shadowAnalysisService.ts`.
- `services/shadowAnalysisService.ts` – centralises cache/in-flight coordination, optional external engine calls, and the current pybdshadow simulator fallback (see `SHADOW_ENGINE_*` env vars in `src/config`).
- `scripts/shadow-engine-prototype/engine_core.py` – shared Python utilities (building fetch, GeoDataFrame prep, pybdshadow invocation) used by both the CLI worker and the original benchmarking script.

Build/run: `npm run dev` (nodemon), `npm run build && npm start` for prod.

---

## Shared Conventions

- TypeScript strict mode on both frontend and backend.
- Zustand store exposes map state (`src/store/shadowMapStore.ts`).
- Frontend caching utilities in `src/utils/multiLevelCache.ts`; backend目前依赖 WFS 代理与 GFS 查询。

Keep this document updated whenever directories move, major files are added, or responsibilities change.
