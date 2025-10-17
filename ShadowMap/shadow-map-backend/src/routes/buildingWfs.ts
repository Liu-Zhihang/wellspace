import express from 'express';
import {
  fetchWfsBuildings,
  fetchWfsBuildingsPaginated,
  convertWfsToStandardGeoJSON,
  testWfsConnection
} from '../services/buildingWfsService';
import { resolveTilesForBounds } from '../services/tileCatalogService';

const router = express.Router();

router.get('/test', async (_req, res) => {
  try {
    const isConnected = await testWfsConnection();

    if (isConnected) {
      res.json({
        success: true,
        message: 'WFS connection succeeded',
        timestamp: new Date().toISOString()
      });
      return;
    }

    res.status(503).json({
      success: false,
      message: 'WFS service is reachable but returned no data',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[BuildingWfs] Connectivity test failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify WFS connectivity',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.post('/bounds', async (req, res) => {
  try {
    const { north, south, east, west, maxFeatures } = req.body ?? {};

    if (
      north === undefined ||
      south === undefined ||
      east === undefined ||
      west === undefined
    ) {
      res.status(400).json({
        success: false,
        message: 'Missing parameters: north, south, east, west are required',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const bounds = {
      north: Number(north),
      south: Number(south),
      east: Number(east),
      west: Number(west)
    };

    console.log('[BuildingWfs] Bounds query', { bounds, maxFeatures });

    const tileResolution = resolveTilesForBounds(bounds);

    const rawData = await fetchWfsBuildingsPaginated(bounds, Number(maxFeatures) || undefined);
    const geoJson = convertWfsToStandardGeoJSON(rawData);

    res.json({
      success: true,
      data: geoJson,
      metadata: {
        source: 'shadowmap-wfs',
        bounds,
        tilesQueried: tileResolution.tileIds,
        totalFeatures: rawData.totalFeatures,
        numberMatched: rawData.numberMatched,
        numberReturned: rawData.numberReturned,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[BuildingWfs] Failed to fetch buildings by bounds', error);
    res.status(500).json({
      success: false,
      message: 'Failed to query buildings from WFS',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/sample/beijing', async (_req, res) => {
  try {
    const sampleBounds = {
      north: 40.2,
      south: 39.4,
      east: 117.4,
      west: 115.7
    };

    console.log('[BuildingWfs] Sample request for Beijing bounds');

    const rawData = await fetchWfsBuildings(sampleBounds, 5000);
    const geoJson = convertWfsToStandardGeoJSON(rawData);

    res.json({
      success: true,
      data: geoJson,
      metadata: {
        source: 'shadowmap-wfs',
        region: 'Beijing',
        bounds: sampleBounds,
        totalFeatures: rawData.totalFeatures,
        numberMatched: rawData.numberMatched,
        numberReturned: rawData.numberReturned,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[BuildingWfs] Sample Beijing request failed', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sample Beijing data',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.post('/tile', async (req, res) => {
  try {
    const { z, x, y, maxFeatures } = req.body ?? {};

    if (z === undefined || x === undefined || y === undefined) {
      res.status(400).json({
        success: false,
        message: 'Missing parameters: z, x, y are required',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const zoom = Number(z);
    const tileX = Number(x);
    const tileY = Number(y);

    if ([zoom, tileX, tileY].some(value => Number.isNaN(value))) {
      res.status(400).json({
        success: false,
        message: 'Parameters z, x, y must be valid numbers',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const bounds = tileToBounds(zoom, tileX, tileY);
    console.log('[BuildingWfs] Tile query', { zoom, tileX, tileY, bounds, maxFeatures });

    const rawData = await fetchWfsBuildingsPaginated(bounds, Number(maxFeatures) || 10_000);
    const geoJson = convertWfsToStandardGeoJSON(rawData);

    res.json({
      success: true,
      data: geoJson,
      metadata: {
        source: 'shadowmap-wfs',
        tile: { z: zoom, x: tileX, y: tileY },
        bounds,
        totalFeatures: rawData.totalFeatures,
        numberMatched: rawData.numberMatched,
        numberReturned: rawData.numberReturned,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[BuildingWfs] Failed to fetch buildings by tile', error);
    res.status(500).json({
      success: false,
      message: 'Failed to query tile from WFS',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

function tileToBounds(z: number, x: number, y: number) {
  const n = Math.pow(2, z);
  const lon_deg = x / n * 360.0 - 180.0;
  const lat_rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat_deg = lat_rad * 180.0 / Math.PI;
  
  const lon_deg_next = (x + 1) / n * 360.0 - 180.0;
  const lat_rad_next = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n)));
  const lat_deg_next = lat_rad_next * 180.0 / Math.PI;

  return {
    north: Math.max(lat_deg, lat_deg_next),
    south: Math.min(lat_deg, lat_deg_next),
    east: Math.max(lon_deg, lon_deg_next),
    west: Math.min(lon_deg, lon_deg_next)
  };
}

export default router;
