import express from 'express';
import { config } from '../config';
import { getBuildingWfsConfigSummary } from '../services/buildingWfsService';
import {
  getTileCatalog,
  getTileCatalogLoadError,
  getTileCatalogPath,
  getTileStrategy
} from '../services/tileCatalogService';

const router: express.Router = express.Router();

// 健康检查端点
router.get('/', (req, res) => {
  const tileCatalog = getTileCatalog();
  const tileCatalogError = getTileCatalogLoadError();
  const wfs = getBuildingWfsConfigSummary();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env['NODE_ENV'] || 'development',
    version: '1.0.0',
    services: {
      api: 'healthy',
      database: config.database.enabled ? 'configured' : 'disabled',
      dem_service: 'healthy',
      building_service: 'healthy',
      wfs: wfs.baseUrl ? 'configured' : 'disabled'
    },
    wfs: {
      ...wfs,
      tileCatalogPath: getTileCatalogPath(),
      tileCatalogStrategy: getTileStrategy(),
      tileCatalogCount: tileCatalog.length,
      tileCatalogError: tileCatalogError?.message ?? null
    },
    endpoints: {
      health: '/api/health',
      dem: '/api/dem/{z}/{x}/{y}.png',
      buildings: '/api/buildings/{z}/{x}/{y}.json',
      buildingInfo: '/api/buildings/info'
    }
  });
});

// 详细系统信息 (开发环境专用)
router.get('/detailed', (req, res) => {
  if (process.env['NODE_ENV'] === 'production') {
    res.status(403).json({ error: 'Forbidden in production' });
    return;
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage()
    },
    environment: process.env
  });
});

export default router;
