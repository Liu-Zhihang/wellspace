/**
 * 本地TUM数据管理API路由
 */

import express from 'express';
import { 
  checkLocalTUMData, 
  loadLocalTUMData, 
  queryLocalTUMBuildings, 
  getLocalTUMStats,
  clearLocalTUMCache 
} from '../services/localTUMDataService';

const router = express.Router();

/**
 * GET /api/local-tum/status
 * 检查本地TUM数据状态
 */
router.get('/status', async (req, res) => {
  try {
    const [dataCheck, stats] = await Promise.all([
      checkLocalTUMData(),
      getLocalTUMStats()
    ]);
    
    res.json({
      success: true,
      localData: dataCheck,
      memoryStats: stats,
      message: dataCheck.available ? '本地TUM数据可用' : '本地TUM数据不可用',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 获取本地TUM状态失败:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: '获取本地数据状态失败'
    });
  }
});

/**
 * POST /api/local-tum/load
 * 加载本地TUM数据到内存
 */
router.post('/load', async (req, res) => {
  try {
    console.log('🔄 开始加载本地TUM数据...');
    
    const result = await loadLocalTUMData();
    
    if (result.success) {
      res.json({
        success: true,
        result,
        message: `数据加载成功: LOD1(${result.lod1Features}) + 高度(${result.heightFeatures}), 耗时${result.loadTime}ms`,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        result,
        message: '数据加载失败',
        timestamp: new Date().toISOString()
      });
    }
    
  } catch (error) {
    console.error('❌ 加载本地TUM数据失败:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: '加载本地数据失败'
    });
  }
});

/**
 * POST /api/local-tum/query
 * 查询本地TUM建筑数据
 */
router.post('/query', async (req, res) => {
  try {
    const { north, south, east, west, maxFeatures = 1000 } = req.body;
    
    // 验证参数
    if (!north || !south || !east || !west) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数: north, south, east, west',
        timestamp: new Date().toISOString()
      });
    }

    const bounds = {
      north: parseFloat(north),
      south: parseFloat(south),
      east: parseFloat(east),
      west: parseFloat(west)
    };

    console.log(`🔍 查询本地TUM数据: ${JSON.stringify(bounds)}, maxFeatures: ${maxFeatures}`);

    const result = await queryLocalTUMBuildings(bounds, maxFeatures);
    
    res.json({
      success: true,
      data: result,
      metadata: {
        source: 'TUM_Local',
        bounds: bounds,
        totalFeatures: result.totalFeatures,
        numberMatched: result.numberMatched,
        numberReturned: result.numberReturned,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ 查询本地TUM数据失败:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: '查询本地数据失败'
    });
  }
});

/**
 * DELETE /api/local-tum/cache
 * 清除内存缓存
 */
router.delete('/cache', async (req, res) => {
  try {
    clearLocalTUMCache();
    
    res.json({
      success: true,
      message: '内存缓存已清除',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 清除缓存失败:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: '清除缓存失败'
    });
  }
});

/**
 * GET /api/local-tum/stats
 * 获取详细统计信息
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getLocalTUMStats();
    
    res.json({
      success: true,
      stats,
      message: '统计信息获取成功',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 获取统计信息失败:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: '获取统计信息失败'
    });
  }
});

/**
 * GET /api/local-tum/info
 * 获取本地TUM数据服务信息
 */
router.get('/info', async (req, res) => {
  try {
    const [dataCheck, stats] = await Promise.all([
      checkLocalTUMData(),
      getLocalTUMStats()
    ]);
    
    res.json({
      service: 'Local TUM Building Data Service',
      version: '1.0.0',
      description: '基于本地下载的TUM GlobalBuildingAtlas数据的建筑物查询服务',
      localData: dataCheck,
      memoryStats: stats,
      features: [
        '本地GeoJSON文件加载',
        '内存缓存优化',
        '空间查询支持',
        '建筑高度信息',
        '快速响应（无网络依赖）'
      ],
      endpoints: {
        status: 'GET /api/local-tum/status - 检查数据状态',
        load: 'POST /api/local-tum/load - 加载数据到内存',
        query: 'POST /api/local-tum/query - 查询建筑数据',
        stats: 'GET /api/local-tum/stats - 获取统计信息',
        cache: 'DELETE /api/local-tum/cache - 清除缓存'
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 获取服务信息失败:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: '获取服务信息失败'
    });
  }
});

export default router;


