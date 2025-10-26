# Debug Checklist (React Client)

Use this quick playbook whenever the map UI or Clean 3D controls fail.

## 1. Runtime Basics

- Vite should print `Local: http://localhost:5173/` in the terminal.
- Backend (`npm run dev` from `shadow-map-backend`) must be running on port 3001.
- `.env` (or `VITE_*` env vars) should expose a valid Mapbox token and ShadeMap API key.

## 2. Console Verification

Open DevTools → Console and look for:

- `🗺️ Initialising Mapbox GL viewport…`
- `✅ ShadeMap initialised` or `✅ Fallback ShadeMap import detected`
- Weather toasts: `☁️ Cloud cover …`

If you only see errors:

- `ShadeMap plugin not loaded` → Verify the UMD script tag or bundle.
- `Style is not done loading` → Mapbox style failed; check network panel.
- `Weather request failed` → backend GFS proxy down; try manual sunlight mode.

## 3. DOM & Styling

DevTools → Elements:

- The root `<div class="shadow-map-header">` contains the Clean 3D status chip.
- Clean toolbar buttons live under `.pointer-events-auto` within `<main>`.
- If elements exist but are hidden, inspect `z-index` and `pointer-events`.

## 4. Network Calls

Filter by `weather` and `wfs`:

- `/api/weather/current` should return 200 with `cloudCover` and `sunlightFactor`.
- `/api/wfs-buildings/bounds` should return GeoJSON; failures indicate GeoServer/downstream issues.
- ShadeMap UMD script should load without 404 (check the CDN URL).

## 5. Quick Recovery

- Click “Reload buildings” in the Left toolbar to refresh GeoJSON.
- Toggle “Auto cloud attenuation” off/on inside the Shadow panel to reset opacity.
- Refresh the page (Ctrl/Cmd + R) to remount the viewport if the canvas is blank.

## 6. When Filing an Issue

Include:

- Console log excerpt (errors + warning lines).
- Network screenshot for failing requests.
- Browser + OS details.
- Git commit hash (`git rev-parse HEAD`).
