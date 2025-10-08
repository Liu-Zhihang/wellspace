/**
 * 瓦片调试API
 * 帮助诊断0建筑物问题
 */

import express, { Request, Response } from 'express';
import { debugTile, generateOptimizedOverpassQuery, tileToLatLng } from '../utils/tileDebugger';
import axios from 'axios';

const router = express.Router();

/**
 * GET /api/debug/tile/:z/:x/:y
 * 调试指定瓦片，分析0建筑物的原因
 */
router.get('/tile/:z/:x/:y', async (req, res) => {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);  
    const y = parseInt(req.params.y);
    
    // 验证参数
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      return res.status(400).json({
        error: '无效参数',
        message: 'z, x, y必须是有效整数'
      });
    }
    
    console.log(`🔍 调试瓦片: ${z}/${x}/${y}`);
    
    // 生成调试信息
    const debugInfo = debugTile(z, x, y);
    
    // 测试不同查询模式
    const testResults = await testOverpassQueries(debugInfo.coordinates, debugInfo.queries);
    
    res.json({
      tile: `${z}/${x}/${y}`,
      coordinates: debugInfo.coordinates,
      mapLinks: debugInfo.mapLinks,
      areaInfo: debugInfo.areaInfo,
      testResults,
      recommendations: debugInfo.recommendations,
      debugTime: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 瓦片调试失败:', error);
    res.status(500).json({
      error: '调试失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/debug/query-test
 * 测试自定义Overpass查询
 */
router.post('/query-test', async (req, res) => {
  try {
    const { query, timeout = 30 } = req.body;
    
    if (!query) {
      return res.status(400).json({
        error: '缺少参数',
        message: '需要提供Overpass查询语句'
      });
    }
    
    console.log('🧪 测试自定义查询:', query.substring(0, 100) + '...');
    
    const result = await testSingleQuery(query, timeout);
    
    res.json({
      query: query,
      result,
      testTime: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 查询测试失败:', error);
    res.status(500).json({
      error: '查询测试失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/debug/area-stats/:z/:x/:y
 * GET /api/debug/area-stats/:z/:x/:y/:radius
 * 分析指定瓦片周围区域的建筑物统计
 */
router.get('/area-stats/:z/:x/:y', async (req, res) => {
  await handleAreaStats(req, res, 1); // 默认半径1
});

router.get('/area-stats/:z/:x/:y/:radius', async (req, res) => {
  await handleAreaStats(req, res);
});

async function handleAreaStats(req: Request, res: Response, defaultRadius?: number) {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);
    const radius = defaultRadius || parseInt(req.params.radius || '1');
    
    if (isNaN(z) || isNaN(x) || isNaN(y) || radius > 3) {
      return res.status(400).json({
        error: '无效参数',
        message: '坐标必须是整数，半径不能超过3'
      });
    }
    
    console.log(`📊 分析区域统计: ${z}/${x}/${y} (半径${radius})`);
    
    const areaStats = await analyzeAreaStats(z, x, y, radius);
    
    res.json({
      centerTile: `${z}/${x}/${y}`,
      radius,
      totalTiles: areaStats.totalTiles,
      statistics: areaStats.stats,
      summary: areaStats.summary,
      recommendations: areaStats.recommendations,
      analyzedAt: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 区域统计分析失败:', error);
    res.status(500).json({
      error: '区域分析失败', 
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * 测试不同的Overpass查询模式
 */
async function testOverpassQueries(
  coordinates: ReturnType<typeof tileToLatLng>,
  queries: { strict: string; normal: string; loose: string; }
): Promise<{
  strict: any;
  normal: any; 
  loose: any;
}> {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  
  const results = {
    strict: await testSingleQuery(queries.strict, 15),
    normal: await testSingleQuery(queries.normal, 15), 
    loose: await testSingleQuery(queries.loose, 15)
  };
  
  return results;
}

/**
 * 测试单个查询
 */
async function testSingleQuery(query: string, timeoutSeconds: number): Promise<{
  success: boolean;
  buildingCount: number;
  processingTime: number;
  error?: string;
  endpoint?: string;
}> {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  
  const startTime = Date.now();
  
  for (const endpoint of endpoints) {
    try {
      console.log(`🔄 测试查询: ${endpoint}`);
      
      const response = await axios.post(endpoint, query, {
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': 'ShadowMap-Debug/1.0'
        },
        timeout: timeoutSeconds * 1000,
        validateStatus: (status) => status === 200
      });
      
      const processingTime = Date.now() - startTime;
      const buildingCount = response.data?.elements?.length || 0;
      
      console.log(`✅ 查询成功: ${buildingCount} 个建筑物 (${processingTime}ms)`);
      
      return {
        success: true,
        buildingCount,
        processingTime,
        endpoint
      };
      
    } catch (error) {
      console.warn(`⚠️ 端点失败 ${endpoint}:`, error instanceof Error ? error.message : error);
      continue;
    }
  }
  
  return {
    success: false,
    buildingCount: 0,
    processingTime: Date.now() - startTime,
    error: '所有端点都失败'
  };
}

/**
 * 分析区域统计
 */
async function analyzeAreaStats(centerZ: number, centerX: number, centerY: number, radius: number): Promise<{
  totalTiles: number;
  stats: {
    withBuildings: number;
    withoutBuildings: number;
    failed: number;
    totalBuildings: number;
    averageProcessingTime: number;
  };
  summary: string;
  recommendations: string[];
}> {
  const tiles = [];
  
  // 生成周围瓦片
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const x = centerX + dx;
      const y = centerY + dy;
      const n = Math.pow(2, centerZ);
      
      if (x >= 0 && x < n && y >= 0 && y < n) {
        tiles.push({ z: centerZ, x, y });
      }
    }
  }
  
  console.log(`📊 分析 ${tiles.length} 个瓦片...`);
  
  const stats = {
    withBuildings: 0,
    withoutBuildings: 0,
    failed: 0, 
    totalBuildings: 0,
    averageProcessingTime: 0
  };
  
  let totalTime = 0;
  
  // 测试每个瓦片（使用normal模式）
  for (const tile of tiles) {
    const coords = tileToLatLng(tile.x, tile.y, tile.z);
    const query = generateOptimizedOverpassQuery(coords, 'normal');
    
    const result = await testSingleQuery(query, 10);
    totalTime += result.processingTime;
    
    if (result.success) {
      if (result.buildingCount > 0) {
        stats.withBuildings++;
        stats.totalBuildings += result.buildingCount;
      } else {
        stats.withoutBuildings++;
      }
    } else {
      stats.failed++;
    }
  }
  
  stats.averageProcessingTime = totalTime / tiles.length;
  
  // 生成总结和建议
  const successRate = ((stats.withBuildings + stats.withoutBuildings) / tiles.length * 100).toFixed(1);
  const buildingDensity = stats.totalBuildings / tiles.length;
  
  let summary = `在 ${tiles.length} 个瓦片中，${stats.withBuildings} 个有建筑物，${stats.withoutBuildings} 个无建筑物`;
  summary += `，${stats.failed} 个失败。平均密度：${buildingDensity.toFixed(1)} 建筑物/瓦片`;
  
  const recommendations = [];
  
  if (stats.failed > tiles.length * 0.3) {
    recommendations.push('⚠️ 失败率过高，建议检查网络连接或增加超时时间');
  }
  
  if (stats.withoutBuildings > tiles.length * 0.8) {
    recommendations.push('📭 该区域建筑密度很低，可能是自然区域、水域或农田');
  } else if (stats.withBuildings === 0 && stats.withoutBuildings > 0) {
    recommendations.push('🔍 所有瓦片都返回0建筑物，可能是查询条件问题或OSM数据缺失');
  }
  
  if (stats.averageProcessingTime > 10000) {
    recommendations.push('⏰ 查询响应较慢，建议预处理该区域数据');
  }
  
  return {
    totalTiles: tiles.length,
    stats,
    summary,
    recommendations
  };
}

export default router;
