# Shadow Map Backend

## Quick Start

1. Install dependencies  
   ```bash
   npm install
   ```
2. Configure environment variables  
   ```bash
   cp .env.example .env
   # Populate WFS, MongoDB/cache, and optional weather service credentials
   ```
3. Launch the development server  
   ```bash
   npm run dev
   ```
4. Smoke test the API  
   - Health check: http://localhost:3001/api/health  
   - DEM info: http://localhost:3001/api/dem/info  
   - Sample DEM tile: http://localhost:3001/api/dem/10/512/384.png  
   - Weather snapshot: http://localhost:3001/api/weather/current?lat=22.3193&lng=114.1694

## Key Services

- **DEM tiles** – Terrarium-style PNG tiles exposed from `/api/dem/:z/:x/:y.png`
- **Building tile/catalog APIs** – Local datasets, WFS proxies, and cache warmers
- **Weather & cloud attenuation** – GFS-backed sunlight factor with in-memory caching
- **Health & diagnostics** – Basic and detailed health endpoints

## Available Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the server with hot reload (ts-node / nodemon) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Serve the compiled build |
| `npm run lint` | Lint the TypeScript sources |

## Environment Variables (highlights)

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (defaults to `3001`) |
| `BUILDING_WFS_TILE_CATALOG_PATH` | Path to GeoServer tile catalogue JSON |
| `BUILDING_WFS_TILE_STRATEGY` | `optional` (default) or `required` for strict tile matching |
| `BUILDING_WFS_BASE_URL` | GeoServer base URL for WFS queries |
| `GFS_API_BASE_URL` | Upstream endpoint for weather snapshots (defaults to NOAA GFS proxy) |
| `WEATHER_CACHE_TTL_MINUTES` | Cache window for weather responses |

(`.env.example` documents the full list.)

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

## API Overview

- `GET /api/health` – Basic status check  
- `GET /api/health/detailed` – Dev-only diagnostics  
- `GET /api/dem/:z/:x/:y.png` – Height tile (Terrarium)  
- `GET /api/dem/info` – Service metadata  
- `POST /api/buildings/bounds` – Query buildings for a bounding box  
- `POST /api/wfs-buildings/bounds` – GeoServer proxy with tile filtering  
- `GET /api/weather/current` – Weather snapshot (`lat`, `lng`, `timestamp` query params)

## Project Structure

```
src/
├── app.ts                  # Express wiring, middleware, static assets
├── server.ts               # Production entry point
├── routes/                 # REST endpoints (DEM, buildings, weather, health…)
├── services/               # Business logic (GFS, caches, local datasets, WFS proxy)
├── utils/                  # Shared helpers (logging, bounds math, tiling)
└── config/                 # Typed configuration loaders
```

## Development Notes

- Helmet + compression are configured with permissive defaults; tighten CSP/CORS before public deployment.
- DEM tiles currently serve pre-generated samples; update `config/dem.json` when swapping datasets.
- Weather service caches responses per `(lat, lng, hour)` bucket; adjust TTL via env vars if needed.
- Static assets fall back to `shadow-map-frontend` prototypes when the Vite build is missing.

## Future Work

- Replace sample DEM data with production-grade tiles + optional on-the-fly encoding.
- Introduce a persistent cache layer (Redis/Upstash) for weather + building responses.
- Harden error handling and add integration tests for WFS + weather fallbacks.
- Monitor and rate-limit heavy endpoints before exposing the API publicly.
