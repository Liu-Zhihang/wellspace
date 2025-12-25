import express from 'express';
import { buildingServiceMongoDB } from '../services/buildingServiceMongoDB';
import { dbManager } from '../config/database';

const router = express.Router();

/**
 * GET /api/buildings/:z/:x/:y.json
 * 获取建筑物瓦片数据
 */
router.get('/:z/:x/:y.json', async (req, res) => {
  try {
    const { z, x, y } = req.params;
    const zNum = parseInt(z, 10);
    const xNum = parseInt(x, 10);
    const yNum = parseInt(y, 10);

    // 验证参数
    if (isNaN(zNum) || isNaN(xNum) || isNaN(yNum)) {
      return res.status(400).json({
        error: 'Invalid tile coordinates',
        message: 'z, x, y must be valid integers'
      });
    }

    if (zNum < 0 || zNum > 20) {
      return res.status(400).json({
        error: 'Invalid zoom level',
        message: 'Zoom level must be between 0 and 20'
      });
    }

    console.log(`🏢 请求建筑物瓦片: ${z}/${x}/${y}`);
    const startTime = Date.now();

    // 获取建筑物数据
    const tileData = await buildingServiceMongoDB.getBuildingTile(zNum, xNum, yNum);
    
    const processingTime = Date.now() - startTime;
    console.log(`⏱️  处理时间: ${processingTime}ms, 建筑物数量: ${tileData.features.length}`);

    // 设置响应头
    res.set({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // 1小时缓存
      'X-Processing-Time': `${processingTime}ms`,
      'X-Building-Count': tileData.features.length.toString(),
      'X-Data-Source': tileData.fromDatabase ? 'mongodb' : 'osm-api',
      'X-Cached': tileData.cached.toString()
    });

    res.json(tileData);

  } catch (error) {
    console.error('❌ 获取建筑物瓦片失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch building tile data',
      details: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

/**
 * GET /api/buildings/info
 * 获取建筑物服务信息和统计
 */
router.get('/info', async (req, res) => {
  try {
    // 检查数据库连接状态
    const connectionStatus = dbManager.getConnectionStatus();
    
    if (!connectionStatus.isConnected || connectionStatus.readyState !== 1) {
      // 数据库未连接时返回基本信息
      return res.json({
        service: 'Building Service with MongoDB',
        version: '2.0.0',
        status: 'initializing',
        database: {
          status: 'connecting',
          connection: connectionStatus,
          message: 'Database is still connecting, please wait...'
        },
        statistics: {
          status: 'unavailable',
          reason: 'Database connection not ready'
        },
        features: [
          'MongoDB integration',
          'OSM Overpass API fallback',
          'Intelligent caching',
          'Building height estimation',
          'Batch data preloading'
        ],
        endpoints: {
          tile: '/api/buildings/{z}/{x}/{y}.json',
          info: '/api/buildings/info',
          preload: '/api/buildings/preload',
          stats: '/api/buildings/stats',
          cleanup: '/api/buildings/cleanup'
        }
      });
    }

    // 数据库已连接，获取完整信息
    const [dbStatus, stats] = await Promise.all([
      dbManager.healthCheck().catch(err => ({ 
        status: 'unhealthy', 
        details: { error: err.message } 
      })),
      buildingServiceMongoDB.getStatistics().catch(err => ({
        error: 'Statistics unavailable',
        reason: err.message,
        totalBuildings: 0,
        totalTiles: 0
      }))
    ]);

    res.json({
      service: 'Building Service with MongoDB',
      version: '2.0.0',
      status: 'operational',
      database: {
        status: dbStatus.status,
        connection: connectionStatus
      },
      statistics: stats,
      features: [
        'MongoDB integration',
        'OSM Overpass API fallback',
        'Intelligent caching',
        'Building height estimation',
        'Batch data preloading'
      ],
      endpoints: {
        tile: '/api/buildings/{z}/{x}/{y}.json',
        info: '/api/buildings/info',
        preload: '/api/buildings/preload',
        stats: '/api/buildings/stats',
        cleanup: '/api/buildings/cleanup'
      }
    });

  } catch (error) {
    console.error('❌ 获取服务信息失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get service information',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/buildings/preload
 * 批量预加载建筑物数据
 */
router.post('/preload', async (req, res) => {
  try {
    const { tiles } = req.body;
    
    if (!Array.isArray(tiles) || tiles.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'tiles array is required and cannot be empty'
      });
    }

    // 验证瓦片格式
    const validTiles = tiles.filter(tile => 
      tile && 
      typeof tile.z === 'number' && 
      typeof tile.x === 'number' && 
      typeof tile.y === 'number' &&
      tile.z >= 0 && tile.z <= 20
    );

    if (validTiles.length === 0) {
      return res.status(400).json({
        error: 'Invalid tiles',
        message: 'No valid tiles found in request'
      });
    }

    console.log(`🔄 开始预加载 ${validTiles.length} 个建筑物瓦片...`);
    const startTime = Date.now();

    const results = await buildingServiceMongoDB.preloadBuildingData(validTiles);
    
    const totalTime = Date.now() - startTime;
    console.log(`✅ 预加载完成: ${results.success} 成功, ${results.failed} 失败, 耗时 ${totalTime}ms`);

    res.json({
      message: 'Preload completed',
      results: {
        total: validTiles.length,
        success: results.success,
        failed: results.failed,
        processingTime: totalTime
      },
      details: results.details
    });

  } catch (error) {
    console.error('❌ 预加载失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to preload building data'
    });
  }
});

/**
 * GET /api/buildings/stats
 * 获取详细的统计信息
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await buildingServiceMongoDB.getStatistics();
    
    res.json({
      timestamp: new Date().toISOString(),
      statistics: stats,
      performance: {
        totalBuildings: stats.totalBuildings,
        totalTiles: stats.totalTiles,
        averageBuildingsPerTile: Math.round(stats.totalBuildings / Math.max(stats.totalTiles, 1)),
        estimatedDataSize: `${Math.round(stats.dataSize / 1024 / 1024 * 100) / 100} MB`
      }
    });

  } catch (error) {
    console.error('❌ 获取统计信息失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get statistics'
    });
  }
});

/**
 * DELETE /api/buildings/cleanup
 * 清理过期的建筑物数据
 */
router.delete('/cleanup', async (req, res) => {
  try {
    const { maxAge } = req.query;
    const maxAgeMs = maxAge ? parseInt(maxAge as string, 10) : 30 * 24 * 60 * 60 * 1000; // 默认30天
    
    if (isNaN(maxAgeMs) || maxAgeMs < 0) {
      return res.status(400).json({
        error: 'Invalid maxAge parameter',
        message: 'maxAge must be a positive number (milliseconds)'
      });
    }

    console.log(`🧹 开始清理超过 ${Math.round(maxAgeMs / 1000 / 60 / 60 / 24)} 天的过期数据...`);
    
    const deletedCount = await buildingServiceMongoDB.cleanupExpiredData(maxAgeMs);
    
    res.json({
      message: 'Cleanup completed',
      deletedRecords: deletedCount,
      maxAge: `${Math.round(maxAgeMs / 1000 / 60 / 60 / 24)} days`
    });

  } catch (error) {
    console.error('❌ 清理过期数据失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to cleanup expired data'
    });
  }
});

/**
 * GET /api/buildings/health
 * 健康检查端点
 */
router.get('/health', async (req, res) => {
  try {
    const dbHealth = await dbManager.healthCheck();
    
    res.json({
      status: dbHealth.status === 'healthy' ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database: dbHealth,
      service: 'MongoDB Building Service'
    });

  } catch (error) {
    console.error('❌ 健康检查失败:', error);
    
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

export default router;

