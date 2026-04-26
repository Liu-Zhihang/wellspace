# Shadow Map Backend

## Quick Start

1. Install dependencies  
   ```bash
   ../scripts/ops/install_workspace_deps.sh
   ```
2. Configure the shared machine profile  
   ```bash
   cp ../.shadowmap.env.example ../.shadowmap.env
   # Fill in SHADOWMAP_DATA_ROOT and service origins once here
   ```
3. Configure backend-only overrides if needed  
   ```bash
   cp .env.example .env
   # Only keep backend-specific secrets or overrides here
   ```
4. Launch the development server  
   ```bash
   ../scripts/dev/run_backend_dev.sh
   ```
5. Smoke test the API  
   - Health check: http://localhost:3001/api/health  
   - DEM info: http://localhost:3001/api/dem/info  
   - Sample DEM tile: http://localhost:3001/api/dem/10/512/384.png  
   - Weather snapshot: http://localhost:3001/api/weather/current?lat=22.3193&lng=114.1694

## Key Services

- **DEM tiles** – Terrarium-style PNG tiles exposed from `/api/dem/:z/:x/:y.png`
- **Building tiles** – Local dataset fallback with optional WFS proxy lookup
- **Weather & cloud attenuation** – GFS-backed sunlight factor with in-memory caching
- **Health & diagnostics** – Basic and detailed health endpoints

## Available Scripts

| Command | Purpose |
| --- | --- |
| `../scripts/dev/run_backend_dev.sh` | Start the server with hot reload after loading `.shadowmap.env` and `.nvmrc` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Serve the compiled build |
| `../scripts/ops/install_workspace_deps.sh --clean` | Reinstall backend and frontend deps under the correct Node version |
| `../scripts/ops/postgis/export_tile_catalog_from_table.sh --table public.buildings_us_service --output ./config/buildingTiles.us_lod1.json` | Export a WFS tile catalogue from a PostGIS service table |
| `../scripts/ops/geoserver/publish_postgis_featuretype.sh --featuretype buildings_us_lod1 --native-name buildings_us_lod1 --bbox=-180,17.5,-64,72.5` | Publish a PostGIS table as a GeoServer WFS layer |

## Environment Variables (highlights)

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (defaults to `3001`) |
| `SHADOWMAP_FRONTEND_HOST` | Recommended Vite host when using the paired frontend launch script |
| `SHADOWMAP_FRONTEND_PORT` | Recommended Vite port when using the paired frontend launch script |
| `SHADOWMAP_ENABLE_DB` | Set to `true` only when MongoDB-backed routes are intentionally enabled |
| `MONGODB_URI` | MongoDB connection string for the legacy building cache routes |
| `SHADOWMAP_BACKEND_ORIGIN` | Canonical backend origin shared with frontend/scripts |
| `SHADOW_ENGINE_BASE_URL` | Python engine origin when using microservice mode |
| `BUILDING_WFS_TILE_CATALOG_PATH` | Path to GeoServer tile catalogue JSON (optional) |
| `BUILDING_WFS_TILE_STRATEGY` | `optional` (default) or `required` for strict tile matching |
| `BUILDING_WFS_BASE_URL` | GeoServer base URL for WFS queries |
| `BUILDING_WFS_TYPE_NAME` | Published GeoServer layer name such as `shadowmap:buildings` or `shadowmap:buildings_us_lod1` |
| `BUILDING_SOURCE` | `wfs` for service deployments, or `local` for smaller offline GeoJSON datasets |
| `BUILDING_LOCAL_GEOJSON` | Path to local buildings GeoJSON when `BUILDING_SOURCE=local` |
| `GFS_API_BASE_URL` | Upstream endpoint for weather snapshots (defaults to NOAA GFS proxy) |

(`../.shadowmap.env.example` documents the shared machine-level variables, and `.env.example` documents backend-only overrides.)

See also: `../docs/data-registry.md` for the recommended dataset layout and asset roles.

## Runtime Notes

- Use Node from `../.nvmrc` (`20`) or any `>=18.20 <21`.
- On multi-user hosts such as `wsA`, prefer `../scripts/ops/start_dev_tmux.sh` instead of ad-hoc tmux commands so the backend/frontend sessions always source the same runtime and env profile.

## WFS Tile Catalogue

Keep `./config/buildingTiles.json` in sync with GeoServer coverage. Each entry is a bounding box with metadata:

```json
[
  {
    "tileId": "e110_n20_e115_n25",
    "minLon": 110.0,
    "minLat": 20.0,
    "maxLon": 115.0,
    "maxLat": 25.0,
    "region": "East Asia"
  }
]
```

When the frontend posts a bounding box to `/api/wfs-buildings/bounds`, the service determines the intersecting tile IDs, applies `BBOX(...) AND tile_id IN (...)`, and returns both GeoJSON and metadata (including `tilesQueried`) for debugging.

For large coverages, keep the bbox-derived staging table and the published service layer separate. On `wsA`, `public.buildings_us_lod1` is the broad US AOI staging table, while `public.buildings_us_service` is the GeoServer-backed service view filtered to `region IN ('USA','PRI','VIR')`. Generate the dedicated catalogue from that service view and point `BUILDING_WFS_TILE_CATALOG_PATH` at it instead of reusing the demo `buildingTiles.json`.

## API Overview

- `GET /api/health` – Basic status check  
- `GET /api/health/detailed` – Dev-only diagnostics  
- `GET /api/dem/:z/:x/:y.png` – Height tile (Terrarium)  
- `GET /api/dem/info` – Service metadata  
- `POST /api/buildings/bounds` – Query buildings via GeoServer WFS  
- `POST /api/wfs-buildings/bounds` – GeoServer proxy with tile filtering (optional)  
- `GET /api/weather/current` – Weather snapshot (`lat`, `lng`, `timestamp` query params)

## Project Structure

```
src/
├── app.ts                  # Express wiring, middleware, static assets
├── server.ts               # Production entry point
├── routes/                 # REST endpoints (DEM, buildings, weather, health…)
├── services/               # Business logic (DEM tiles, WFS proxy, GFS integration)
└── config/                 # Environment configuration helpers
```

## Development Notes

- Helmet + compression are configured with permissive defaults; tighten CSP/CORS before public deployment.
- DEM tiles currently serve pre-generated samples; update `config/dem.json` when swapping datasets.
- Weather service pulls live cloud attenuation from NOAA GFS; consider adding caching if usage grows.
- Static assets fall back to `shadow-map-frontend` prototypes when the Vite build is missing.

## Future Work

- Replace sample DEM data with production-grade tiles + optional on-the-fly encoding.
- Add a lightweight in-memory cache for weather/building responses if usage increases.
- Harden error handling and add integration tests for WFS + weather fallbacks.
- Monitor and rate-limit heavy endpoints before exposing the API publicly.
