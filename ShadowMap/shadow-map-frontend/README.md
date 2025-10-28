# Shadow Map Frontend

## Overview

`react-shadow-app` is a Vite + React + TypeScript client that powers the Clean 3D Shadow Map experience. Legacy Mapbox/WFS/Leaflet demos have been removed as part of `REQ-CLEAN-05`, so the codebase now focuses exclusively on the Clean viewport. The next milestone (`REQ-ANALYSIS-01`) extends the upload workflow so GeoJSON polygons can be analysed for shadow coverage and sunlight hours.

## Getting Started

```bash
cd ShadowMap/shadow-map-frontend/react-shadow-app
pnpm install          # or npm install
pnpm run dev          # launches Vite on http://localhost:5173
```

Prerequisites:
- Backend running on http://localhost:3001 (`npm run dev` from `shadow-map-backend`)
- Mapbox access token configured (see `.env` or injected at runtime)
- Weather service enabled (GFS proxy in backend)

## Build & Preview

```bash
pnpm run build        # output to dist/
pnpm run preview      # serve the production bundle locally
pnpm run lint         # eslint with TypeScript + React configs
```

## Key Directories

| Path | Description |
| --- | --- |
| `src/App.tsx` | Application shell + Clean layout framing |
| `src/components/Map/ShadowMapViewport.tsx` | ShadeMap + Mapbox GL viewport with weather-aware opacity |
| `src/components/UI/CleanControlPanel.tsx` | Floating panel for time/shadow/style controls |
| `src/components/UI/LeftIconToolbar.tsx` | Quick actions (building reload, trace upload, diagnostics) |
| `src/components/UI/ReferenceInspiredTimeline.tsx` | Time scrubber + animation controls |
| `src/services/weatherService.ts` | Fetches cached weather snapshots from `/api/weather/current` |
| `src/store/shadowMapStore.ts` | Zustand store for map, shadow, and weather state |

## Clean 3D Essentials

- ShadeMap initialises automatically once the Mapbox map and building data are ready.
- Weather requests hit `/api/weather/current` and throttle to a 5 minute cache window.
- The timeline drives shadow animation via `shadowMapStore`'s time state.
- Status toasts surface success/failure for building loads, weather fetches, and ShadeMap operations.

## Environment Variables

```
VITE_MAPBOX_ACCESS_TOKEN=pk.XXXX
VITE_SHADOW_SIMULATOR_API_KEY=...
VITE_BACKEND_BASE_URL=http://localhost:3001
```

If not provided, the app falls back to defaults defined in `config/runtime.ts`. ShadeMap will refuse to load without a valid Mapbox token.

## Debug Tips

- DevTools → Console should show ShadeMap + weather logs (`☁️`, `💡` status toasts).
- Check the Network tab for `/api/weather/current` – expect 200 with `cloudCover` and `sunlightFactor`.
- `pnpm run lint` and `pnpm run typecheck` (if configured) help catch regressions during the consolidation.

## Future Work

- Break up the monolithic Zustand store into focused slices.
- Add visual regression coverage / screenshot testing for the Clean viewport.
- Document presets and mobility trace workflows in the user guide.
- Ship the geometry analysis module (merged upload UI, ShadeMap sampling, exportable summaries).
