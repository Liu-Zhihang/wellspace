# Shadow Map Frontend

## Overview

`react-shadow-app` is a Vite + React + TypeScript client that renders several map experiences (Clean 3D, Mapbox baseline, WFS demo, Leaflet legacy). The current sprint keeps all modes for regression purposes while `REQ-CLEAN-05` refactors them onto a unified Clean layout.

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
| `src/App.tsx` | Mode switcher (Clean / WFS 3D / Mapbox / Leaflet) |
| `src/components/Map/CleanShadowMap.tsx` | Clean experience with ShadeMap + weather-aware opacity |
| `src/components/Map/MapboxMapComponent.tsx` | Legacy Mapbox viewport |
| `src/components/Map/Wfs3DShadowMapFixed.tsx` | WFS showcase |
| `src/services/weatherService.ts` | Fetches cached weather snapshots from `/api/weather/current` |
| `src/store/shadowMapStore.ts` | Zustand store for map, shadow, and weather state |
| `src/components/UI` | Clean + reference toolbars, timelines, search, etc. |

## Mode Guide (temporary)

- **Clean 3D** – Default mode, uses ShadeMap with DEM + weather attenuation. Includes the left toolbar, timeline, and status toasts.
- **WFS 3D** – Proxy demo for GeoServer buildings; useful when validating tile coverage.
- **Mapbox** – Old combined viewport (to be replaced).
- **Leaflet** – Minimal legacy implementation; retained only for comparison.

During `REQ-CLEAN-05`, the goal is to retire the mode toggle, promote Clean 3D as the only viewport, and migrate shared UI pieces.

## Environment Variables

```
VITE_MAPBOX_ACCESS_TOKEN=pk.XXXX
VITE_SHADOW_SIMULATOR_API_KEY=...
VITE_BACKEND_BASE_URL=http://localhost:3001
```

If not provided, the app falls back to defaults defined in `config/runtime.ts`.

## Debug Tips

- DevTools → Console should show ShadeMap + weather logs (`☁️`, `💡` status toasts).
- Check the Network tab for `/api/weather/current` – expect 200 with `cloudCover` and `sunlightFactor`.
- Use the top-right toggle to reproduce issues specific to legacy modes before they are removed.
- `pnpm run lint` and `pnpm run typecheck` (if configured) help catch regressions during the consolidation.

## Future Work

- Collapse all map modes into the Clean layout and remove redundant components.
- Break up the monolithic Zustand store into focused slices.
- Add visual regression coverage for the Clean viewport once the mode toggle is gone.
