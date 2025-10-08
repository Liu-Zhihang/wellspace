/**
 * TUM建筑数据API路由
 * 提供TUM GlobalBuildingAtlas建筑数据的RESTful接口
 */

import express from 'express';
import { fetchTUMBuildings, fetchTUMBuildingsPaginated, convertTUMToStandardGeoJSON, testTUMConnection } from '../services/tumBuildingService';

const router = express.Router();

// 测试TUM连接
router.get('/test', async (req, res) => {
  try {
    console.log('🔍 测试TUM WFS连接...');
    
    const isConnected = await testTUMConnection();
    
    if (isConnected) {
      res.json({
        success: true,
        message: 'TUM WFS连接正常',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({ // 503 Service Unavailable 更准确
        success: false,
        message: 'TUM WFS服务器暂时不可用 (502 Bad Gateway)',
        suggestion: '建议下载TUM完整数据集进行本地部署',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('❌ TUM连接测试失败:', error);
    res.status(500).json({
      success: false,
      message: 'TUM连接测试失败',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// 获取指定区域的TUM建筑数据
router.post('/bounds', async (req, res) => {
  try {
    const { north, south, east, west, maxFeatures } = req.body;
    
    // 验证参数
    if (!north || !south || !east || !west) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数: north, south, east, west',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`🏢 获取TUM建筑数据: ${JSON.stringify({ north, south, east, west, maxFeatures })}`);

    // 构建边界框
    const bounds = {
      north: parseFloat(north),
      south: parseFloat(south),
      east: parseFloat(east),
      west: parseFloat(west)
    };

    // 获取TUM数据（使用分页获取更多数据）
    const tumData = await fetchTUMBuildingsPaginated(bounds, maxFeatures || 5000);  // 调整为5000
    
    // 转换为标准GeoJSON格式
    const standardData = convertTUMToStandardGeoJSON(tumData);

    res.json({
      success: true,
      data: standardData,
      metadata: {
        source: 'TUM GlobalBuildingAtlas',
        bounds: bounds,
        totalFeatures: tumData.totalFeatures,
        numberMatched: tumData.numberMatched,
        numberReturned: tumData.numberReturned,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ 获取TUM建筑数据失败:', error);
    res.status(500).json({
      success: false,
      message: '获取TUM建筑数据失败',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// 获取北京区域的TUM建筑数据
router.get('/beijing', async (req, res) => {
  try {
    console.log('🏙️ 获取北京区域TUM建筑数据...');
    
    // 北京区域边界
    const beijingBounds = {
      north: 40.2,
      south: 39.4,
      east: 117.4,
      west: 115.7
    };

    // 获取TUM数据
    const tumData = await fetchTUMBuildings(beijingBounds, 5000);
    
    // 转换为标准GeoJSON格式
    const standardData = convertTUMToStandardGeoJSON(tumData);

    res.json({
      success: true,
      data: standardData,
      metadata: {
        source: 'TUM GlobalBuildingAtlas',
        region: 'Beijing',
        bounds: beijingBounds,
        totalFeatures: tumData.totalFeatures,
        numberMatched: tumData.numberMatched,
        numberReturned: tumData.numberReturned,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ 获取北京TUM建筑数据失败:', error);
    res.status(500).json({
      success: false,
      message: '获取北京TUM建筑数据失败',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

// 获取指定瓦片的TUM建筑数据
router.post('/tile', async (req, res) => {
  try {
    const { z, x, y, maxFeatures } = req.body;
    
    // 验证参数
    if (z === undefined || x === undefined || y === undefined) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数: z, x, y',
        timestamp: new Date().toISOString()
      });
    }

    console.log(`🗺️ 获取瓦片TUM建筑数据: z=${z} x=${x} y=${y}`);

    // 将瓦片坐标转换为地理边界
    const bounds = tileToBounds(parseInt(z), parseInt(x), parseInt(y));

    // 获取TUM数据（使用分页获取更多数据）
    const tumData = await fetchTUMBuildingsPaginated(bounds, maxFeatures || 10000);
    
    // 转换为标准GeoJSON格式
    const standardData = convertTUMToStandardGeoJSON(tumData);

    res.json({
      success: true,
      data: standardData,
      metadata: {
        source: 'TUM GlobalBuildingAtlas',
        tile: { z, x, y },
        bounds: bounds,
        totalFeatures: tumData.totalFeatures,
        numberMatched: tumData.numberMatched,
        numberReturned: tumData.numberReturned,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ 获取瓦片TUM建筑数据失败:', error);
    res.status(500).json({
      success: false,
      message: '获取瓦片TUM建筑数据失败',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * 将瓦片坐标转换为地理边界
 */
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
