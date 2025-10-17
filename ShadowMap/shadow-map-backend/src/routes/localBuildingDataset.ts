import express from 'express';

import {
  checkLocalDatasetStatus,
  clearLocalDatasetCache,
  getLocalDatasetStats,
  loadLocalDatasets,
  queryLocalDatasets
} from '../services/localBuildingDatasetService';

const router = express.Router();

router.get('/status', async (_req, res) => {
  try {
    const [status, stats] = await Promise.all([
      checkLocalDatasetStatus(),
      getLocalDatasetStats()
    ]);

    res.json({
      success: true,
      status,
      stats,
      message: status.available ? 'Local datasets available' : 'Local datasets unavailable',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[LocalDataset] Failed to read dataset status', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read dataset status'
    });
  }
});

router.post('/load', async (_req, res) => {
  try {
    console.log('[LocalDataset] Loading GeoJSON datasets into memory');
    const result = await loadLocalDatasets();
    res.json({
      success: true,
      result,
      message: `Loaded ${result.loadedDatasets} dataset(s) with ${result.loadedFeatures} buildings`
    });
  } catch (error) {
    console.error('[LocalDataset] Failed to load datasets', error);
    res.status(500).json({
      success: false,
      error: 'Failed to load datasets'
    });
  }
});

router.post('/query', async (req, res) => {
  const { north, south, east, west, maxFeatures = 1000 } = req.body;

  if (
    [north, south, east, west].some((value) => value === undefined || value === null || value === '')
  ) {
    return res.status(400).json({
      success: false,
      error: 'Parameters north, south, east, and west are required'
    });
  }

  try {
    const bounds = {
      north: Number(north),
      south: Number(south),
      east: Number(east),
      west: Number(west)
    };

    const response = await queryLocalDatasets(bounds, Number(maxFeatures));
    res.json({
      success: true,
      data: response,
      metadata: {
        bounds,
        numberMatched: response.numberMatched,
        numberReturned: response.numberReturned,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('[LocalDataset] Query failed', error);
    res.status(500).json({
      success: false,
      error: 'Failed to query local datasets'
    });
  }
});

router.delete('/cache', (_req, res) => {
  clearLocalDatasetCache();
  res.json({
    success: true,
    message: 'In-memory cache cleared'
  });
});

router.get('/stats', async (_req, res) => {
  try {
    const stats = await getLocalDatasetStats();
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[LocalDataset] Failed to collect stats', error);
    res.status(500).json({
      success: false,
      error: 'Failed to collect dataset statistics'
    });
  }
});

router.get('/info', async (_req, res) => {
  try {
    const [status, stats] = await Promise.all([
      checkLocalDatasetStatus(),
      getLocalDatasetStats()
    ]);

    res.json({
      service: 'Local Building Dataset Service',
      description: 'Reads pre-downloaded GeoJSON tiles from disk and serves them through the API.',
      version: '1.0.0',
      status,
      stats,
      capabilities: [
        'GeoJSON tile loading',
        'In-memory caching',
        'Bounding-box filtering',
        'Customisable dataset directory'
      ],
      endpoints: {
        status: 'GET /api/local-datasets/status',
        load: 'POST /api/local-datasets/load',
        query: 'POST /api/local-datasets/query',
        stats: 'GET /api/local-datasets/stats',
        cache: 'DELETE /api/local-datasets/cache'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[LocalDataset] Failed to describe service', error);
    res.status(500).json({
      success: false,
      error: 'Failed to describe local dataset service'
    });
  }
});

export default router;
