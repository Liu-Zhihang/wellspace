import express from 'express';
import { getDEMTile } from '../services/demService';

const router = express.Router();

// DEM瓦片服务端点
router.get('/:z/:x/:y.png', async (req, res) => {
  try {
    const z = parseInt(req.params['z']!);
    const x = parseInt(req.params['x']!);
    const y = parseInt(req.params['y']!);

    // 验证参数
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      res.status(400).json({ 
        error: 'Invalid parameters', 
        message: 'z, x, y must be valid integers' 
      });
      return;
    }

    // 验证缩放级别
    const maxZoom = parseInt(process.env['DEM_MAX_ZOOM'] || '15');
    if (z > maxZoom || z < 0) {
      res.status(400).json({ 
        error: 'Invalid zoom level', 
        message: `Zoom level must be between 0 and ${maxZoom}` 
      });
      return;
    }

    // 生成DEM瓦片 (第一阶段使用模拟数据)
    const tileBuffer = await getDEMTile(z, x, y);

    // 设置响应头（CDN友好）
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable', // 24小时缓存，不可变
      'Access-Control-Allow-Origin': '*',
      'Content-Length': tileBuffer.length.toString(),
      'ETag': `"dem-${z}-${x}-${y}"`, // 添加ETag支持
      'X-Tile-Coordinates': `${z}/${x}/${y}`,
      'X-Content-Source': 'dem-service'
    });

    res.send(tileBuffer);
  } catch (error) {
    console.error('❌ Error generating DEM tile:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Internal server error', 
        message: 'Failed to generate DEM tile' 
      });
    }
  }
});

// DEM瓦片信息端点
router.get('/info', (req, res) => {
  res.json({
    service: 'DEM Tile Service',
    version: '1.0.0',
    tileSize: parseInt(process.env['DEM_TILE_SIZE'] || '256'),
    maxZoom: parseInt(process.env['DEM_MAX_ZOOM'] || '15'),
    format: 'PNG',
    encoding: 'Terrarium',
    elevationFormula: '(R * 256 + G + B / 256) - 32768',
    usage: {
      tileUrl: '/api/dem/{z}/{x}/{y}.png',
      example: '/api/dem/10/512/384.png'
    }
  });
});

export default router;
