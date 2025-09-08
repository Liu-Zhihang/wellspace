import express from 'express';

const router = express.Router();

// 健康检查端点
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env['NODE_ENV'] || 'development',
    version: '1.0.0',
    services: {
      api: 'healthy',
      database: 'not_connected', // TODO: 添加数据库健康检查
      dem_service: 'healthy',
      building_service: 'healthy'
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
