/**
 * 数据预处理API路由
 * 提供手动触发数据预处理的接口
 */

import express from 'express';
import { preloadAllCities, preloadUserLocation } from '../scripts/preloadBuildingData';
import { buildingServiceMongoDB } from '../services/buildingServiceMongoDB';

const router = express.Router();

/**
 * POST /api/preload/cities
 * 预处理所有热门城市的建筑物数据
 */
router.post('/cities', async (req, res) => {
  try {
    console.log('🌍 开始热门城市数据预处理...');
    
    // 异步执行预处理，立即返回响应
    preloadAllCities().then(() => {
      console.log('🎉 热门城市数据预处理完成');
    }).catch((error) => {
      console.error('❌ 热门城市数据预处理失败:', error);
    });
    
    res.json({
      message: '热门城市建筑物数据预处理已开始',
      status: 'processing',
      estimatedTime: '30-60分钟',
      cities: 12,
      zoomLevels: [15, 16]
    });
    
  } catch (error) {
    console.error('❌ 预处理启动失败:', error);
    res.status(500).json({
      error: '预处理启动失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/preload/location
 * 预处理指定位置的建筑物数据
 */
router.post('/location', async (req, res) => {
  try {
    const { lat, lng, zoom = 16 } = req.body;
    
    // 验证参数
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({
        error: '无效参数',
        message: 'lat和lng必须是有效的数字'
      });
    }
    
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({
        error: '坐标超出范围',
        message: 'lat必须在[-90,90]，lng必须在[-180,180]'
      });
    }
    
    console.log(`📍 开始预处理位置: ${lat}, ${lng} (zoom ${zoom})`);
    
    // 异步执行位置预处理
    preloadUserLocation(lat, lng, zoom).then(() => {
      console.log(`✅ 位置预处理完成: ${lat}, ${lng}`);
    }).catch((error) => {
      console.error(`❌ 位置预处理失败: ${lat}, ${lng}:`, error);
    });
    
    res.json({
      message: '位置建筑物数据预处理已开始',
      location: { lat, lng, zoom },
      status: 'processing',
      estimatedTime: '1-5分钟'
    });
    
  } catch (error) {
    console.error('❌ 位置预处理启动失败:', error);
    res.status(500).json({
      error: '位置预处理启动失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/preload/status
 * 获取数据预处理状态和统计信息
 */
router.get('/status', async (req, res) => {
  try {
    const stats = await buildingServiceMongoDB.getStatistics();
    
    res.json({
      database: {
        totalBuildings: stats.totalBuildings,
        totalTiles: stats.totalTiles,
        dataSize: `${(stats.dataSize / 1024 / 1024).toFixed(2)} MB`,
        oldestRecord: stats.oldestRecord,
        newestRecord: stats.newestRecord
      },
      buildingTypes: stats.buildingTypeDistribution,
      recommendations: {
        lowData: stats.totalBuildings < 10000 ? '建议运行城市数据预处理' : null,
        oldData: stats.oldestRecord && (Date.now() - stats.oldestRecord.getTime()) > 7 * 24 * 60 * 60 * 1000 ? '部分数据较旧，建议更新' : null
      }
    });
    
  } catch (error) {
    console.error('❌ 获取预处理状态失败:', error);
    res.status(500).json({
      error: '获取状态失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/preload/cleanup
 * 清理过期的建筑物数据
 */
router.post('/cleanup', async (req, res) => {
  try {
    const { maxAgeDays = 30 } = req.body;
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000; // 转换为毫秒
    
    console.log(`🧹 开始清理 ${maxAgeDays} 天前的建筑物数据...`);
    
    const deletedCount = await buildingServiceMongoDB.cleanupExpiredData(maxAge);
    
    res.json({
      message: '数据清理完成',
      deletedRecords: deletedCount,
      maxAgeDays: maxAgeDays,
      cleanupTime: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 数据清理失败:', error);
    res.status(500).json({
      error: '数据清理失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/preload/cities
 * 获取支持预处理的城市列表
 */
router.get('/cities', (req, res) => {
  const cities = [
    // 中国主要城市
    { name: '北京', lat: 39.9042, lng: 116.4074, priority: 1, country: 'China' },
    { name: '上海', lat: 31.2304, lng: 121.4737, priority: 1, country: 'China' },
    { name: '广州', lat: 23.1291, lng: 113.2644, priority: 1, country: 'China' },
    { name: '深圳', lat: 22.5431, lng: 114.0579, priority: 1, country: 'China' },
    { name: '杭州', lat: 30.2741, lng: 120.1551, priority: 2, country: 'China' },
    { name: '南京', lat: 32.0603, lng: 118.7969, priority: 2, country: 'China' },
    { name: '武汉', lat: 30.5928, lng: 114.3055, priority: 2, country: 'China' },
    { name: '成都', lat: 30.6720, lng: 104.0633, priority: 2, country: 'China' },
    
    // 国际主要城市
    { name: 'New York', lat: 40.7128, lng: -74.0060, priority: 3, country: 'USA' },
    { name: 'London', lat: 51.5074, lng: -0.1278, priority: 3, country: 'UK' },
    { name: 'Tokyo', lat: 35.6762, lng: 139.6503, priority: 3, country: 'Japan' },
    { name: 'Paris', lat: 48.8566, lng: 2.3522, priority: 3, country: 'France' },
  ];
  
  res.json({
    cities: cities,
    totalCities: cities.length,
    zoomLevels: [15, 16],
    tileRadius: 3,
    estimatedDataSize: '500-1000 MB',
    note: '预处理完成后，这些城市的阴影计算将显著加速'
  });
});

export default router;
