import express from 'express';
import { getDEMTile } from '../services/demService';

const router: express.Router = express.Router();

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

    console.log(`🗻 DEM瓦片请求: ${z}/${x}/${y}`);
    const startTime = Date.now();

    // 获取真实DEM瓦片数据
    const tileBuffer = await getDEMTile(z, x, y);
    const processingTime = Date.now() - startTime;

    console.log(`✅ DEM瓦片响应: ${z}/${x}/${y} (${tileBuffer.length} bytes, ${processingTime}ms)`);

    // 设置响应头（CDN友好）
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable', // 24小时缓存，不可变
      'Access-Control-Allow-Origin': '*',
      'Content-Length': tileBuffer.length.toString(),
      'ETag': `"dem-${z}-${x}-${y}"`, // 添加ETag支持
      'X-Tile-Coordinates': `${z}/${x}/${y}`,
      'X-Content-Source': 'real-dem-data', // 标识为真实数据
      'X-Processing-Time': `${processingTime}ms`
    });

    res.send(tileBuffer);
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ DEM瓦片获取失败:', errorMsg);
    
    if (!res.headersSent) {
      // 根据错误类型返回不同HTTP状态码
      if (errorMsg.includes('无效DEM瓦片坐标')) {
        res.status(400).json({ 
          error: 'Invalid tile coordinates', 
          message: errorMsg,
          suggestion: '请检查瓦片坐标是否在有效范围内'
        });
      } else if (errorMsg.includes('所有数据源都失败')) {
        res.status(503).json({ 
          error: 'Service temporarily unavailable', 
          message: '暂时无法获取DEM数据',
          details: errorMsg,
          suggestion: '请稍后重试，或联系管理员预处理该区域的DEM数据',
          retryAfter: 30 // 建议30秒后重试
        });
      } else {
        res.status(500).json({ 
          error: 'Internal server error', 
          message: '获取DEM数据时发生内部错误',
          details: process.env['NODE_ENV'] === 'development' ? errorMsg : undefined
        });
      }
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
