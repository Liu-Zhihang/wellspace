# Clean 3D Mode Guide

## Overview

Clean 3D is the primary Shadow Map experience. It combines the new ShadeMap viewport, weather-aware shadow attenuation, and a minimal UI inspired by the prototype build. Other modes remain available only for comparison while we execute `REQ-CLEAN-05`.

## Feature Highlights

- **Shared viewport** – ShadeMap + Mapbox GL with DEM tiles served from the backend.
- **Weather integration** – Auto-refreshes sunlight factor via `/api/weather/current`.
- **Status toasts** – Inline feedback for building loads, weather pulls, and simulator updates.
- **Compact controls** – Left toolbar (uploads, quick toggles) and bottom timeline for animation.

## How to Launch

```bash
cd ShadowMap/shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev
```

1. Confirm the backend (`npm run dev` in `shadow-map-backend`) is running.
2. Open http://localhost:5173 (Clean 3D loads automatically).
3. Wait for the logs: `🗺️ Initialising Mapbox GL viewport…`, `✅ ShadeMap initialised`, `☁️ Cloud cover …`.

## UI Walkthrough

| Area | Description |
| --- | --- |
| Top banner | Mode toggle + status chip (shows “Clean 3D”). |
| Left toolbar | Quick tests (reload buildings, trigger WFS checks, upload mobility traces). |
| Bottom timeline | Time scrubber + play controls; syncs with `shadowMapStore`. |
| Status toasts | Appear in the lower-right corner with emoji prefixes for success/warnings/errors. |

## Weather & Shadows

- Fetch cadence is throttled (5 min TTL per `(lat, lng, hour)`).
- Auto mode uses the sunlight factor to scale shadow opacity while ensuring a minimum darkness.
- Disable auto attenuation in the Shadow panel to switch to manual control.
- Cloud overlay appears as a subtle global tint when opacity > 0; the layer is only added after the Mapbox style finishes loading.

## Troubleshooting

1. **ShadeMap plugin missing** – Confirm the UMD script is loaded (see console error). The app logs `✅ ShadeMap (window) available` on success.
2. **Buildings not visible** – Use the quick actions to reload buildings; inspect `/api/wfs-buildings/bounds` responses.
3. **Weather failures** – Backend log will show GFS errors; the frontend falls back to manual sunlight (100%).
4. **Map re-renders repeatedly** – Ensure only one Clean viewport is mounted (legacy modes should be inactive).

## Development Tips

- `shadowMapStore` keeps weather, shadows, and map settings in sync; prefer selectors rather than direct state mutation.
- `weatherService` caches aggressively; call `weatherService.clearCache()` in tests to avoid stale data.
- Wrap ShadeMap manipulations with guards (methods are optional on older builds).
- Use `pnpm run lint` and `pnpm run typecheck` before opening a PR; ESLint is configured for strict React + TS rules.

## Next Steps for REQ-CLEAN-05

1. Replace the header mode toggle with variant styling (Clean-only).
2. Fold Mapbox-specific logic into reusable hooks/services.
3. Update docs and screenshots once the single-mode layout ships.
