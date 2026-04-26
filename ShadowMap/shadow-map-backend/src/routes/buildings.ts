import express from 'express';
import type { Request, Response } from 'express';
import {
  fetchWfsBuildingsPaginated,
  fetchWfsBuildings,
  convertWfsToStandardGeoJSON,
  type BoundingBox
} from '../services/buildingWfsService';
import { resolveTilesForBounds } from '../services/tileCatalogService';
import { queryLocalBuildings } from '../services/localBuildingService';

const router: express.Router = express.Router();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const BUILDING_SOURCE = (process.env['BUILDING_SOURCE'] ?? 'wfs').toLowerCase();
const LOCAL_BUILDING_FILE = process.env['BUILDING_LOCAL_GEOJSON'];

function tileToBounds(z: number, x: number, y: number): BoundingBox {
  const safeZ = clamp(Math.floor(z), 0, 22);
  const n = Math.pow(2, safeZ);
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;

  const tileToLat = (ty: number) => {
    const rad = Math.PI - (2 * Math.PI * ty) / n;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(rad) - Math.exp(-rad)));
  };

  const south = tileToLat(y + 1);
  const north = tileToLat(y);

  return {
    west,
    south,
    east,
    north,
  };
}

router.get('/:z/:x/:y.json', async (req: Request, res: Response) => {
  const z = Number.parseInt(req.params['z'] ?? '', 10);
  const x = Number.parseInt(req.params['x'] ?? '', 10);
  const y = Number.parseInt(req.params['y'] ?? '', 10);

  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).json({
      error: 'Invalid parameters',
      message: 'z, x, y must be integers',
    });
    return;
  }

  try {
    const bounds = tileToBounds(z, x, y);
    const maxFeatures = 2000;

    if (BUILDING_SOURCE === 'local' && LOCAL_BUILDING_FILE) {
      const local = await queryLocalBuildings(LOCAL_BUILDING_FILE, bounds, maxFeatures);
      const bbox: [number, number, number, number] = [bounds.west, bounds.south, bounds.east, bounds.north];

      res.set({
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120',
        'X-Building-Count': local.features.length.toString(),
        'X-Data-Source': 'local',
      });

      res.json({
        type: 'FeatureCollection',
        features: local.features,
        bbox,
        tileInfo: { z, x, y },
        metadata: {
          source: 'local',
          totalFeatures: local.metadata.totalFeatures,
          numberReturned: local.metadata.numberReturned,
        },
      });
      return;
    }

    const wfsResponse = await fetchWfsBuildingsPaginated(bounds, maxFeatures);
    const normalized = convertWfsToStandardGeoJSON(wfsResponse);

    const bbox: [number, number, number, number] = [bounds.west, bounds.south, bounds.east, bounds.north];

    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120',
      'X-Building-Count': normalized.features.length.toString(),
      'X-Data-Source': 'wfs',
    });

    res.json({
      type: 'FeatureCollection',
      features: normalized.features,
      bbox,
      tileInfo: { z, x, y },
      metadata: {
        source: 'wfs',
        totalFeatures: normalized.metadata.totalFeatures,
        numberReturned: normalized.metadata.numberReturned,
      },
    });
  } catch (error) {
    console.error('[Buildings] Failed to serve tile', z, x, y, error);
    res.status(502).json({
      error: 'UpstreamUnavailable',
      message: 'Failed to retrieve buildings from WFS',
    });
  }
});

router.post('/bounds', async (req: Request, res: Response) => {
  const { west, south, east, north, maxFeatures } = req.body ?? {};

  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north)
  ) {
    res.status(400).json({
      success: false,
      message: 'west, south, east, north are required numeric values',
    });
    return;
  }

  const bounds: BoundingBox = {
    west,
    south,
    east,
    north,
  };

  try {
    const limit = Number(maxFeatures) || 5000;

    if (BUILDING_SOURCE === 'local' && LOCAL_BUILDING_FILE) {
      const local = await queryLocalBuildings(LOCAL_BUILDING_FILE, bounds, limit);
      res.json({
        success: true,
        data: {
          type: 'FeatureCollection',
          features: local.features,
          metadata: local.metadata,
        },
        metadata: {
          source: 'local',
          bounds,
          tilesQueried: resolveTilesForBounds(bounds).tileIds,
          totalFeatures: local.metadata.totalFeatures,
        },
      });
      return;
    }

    const wfsResponse = await fetchWfsBuildings(bounds, limit);
    const normalized = convertWfsToStandardGeoJSON(wfsResponse);

    res.json({
      success: true,
      data: {
        type: 'FeatureCollection',
        features: normalized.features,
        metadata: normalized.metadata,
      },
      metadata: {
        source: 'wfs',
        bounds,
        tilesQueried: resolveTilesForBounds(bounds).tileIds,
        totalFeatures: normalized.metadata.totalFeatures,
      },
    });
  } catch (error) {
    console.error('[Buildings] Failed to query bounds', error);
    res.status(502).json({
      success: false,
      message: 'Failed to query buildings from WFS',
    });
  }
});

router.get('/info', async (_req: Request, res: Response) => {
  try {
    res.json({
      service: 'Building WFS proxy',
      description: 'Serves GeoServer building footprints via WFS',
      timestamp: new Date().toISOString(),
      endpoints: {
        tile: '/api/buildings/{z}/{x}/{y}.json',
        bounds: '/api/buildings/bounds',
        wfsBounds: '/api/wfs-buildings/bounds',
      },
    });
  } catch (error) {
    console.error('[Buildings] Failed to produce info', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to load building service info',
    });
  }
});

export default router;
