/**
 * 建筑物查询优化API
 * 提供端点健康检查和查询策略优化
 */

import express from 'express';
import { getLocationOptimizedParams, selectOptimalEndpoints, OSM_BUILDING_CATEGORIES, QUERY_STRATEGIES, smartBuildingQuery } from '../services/enhancedBuildingService';
import { endpointHealthMonitor } from '../services/endpointHealthMonitor';
import axios from 'axios';

const router = express.Router();

/**
 * GET /api/building-opt/endpoints
 * 获取所有Overpass端点的健康状态
 */
router.get('/endpoints', async (req, res) => {
  try {
    console.log('🔍 检查Overpass端点健康状态...');
    
    const allEndpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter', 
      'https://overpass.openstreetmap.ru/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ];
    
    const healthChecks = await Promise.allSettled(
      allEndpoints.map(endpoint => checkEndpointHealth(endpoint))
    );
    
    const results = allEndpoints.map((endpoint, index) => {
      const result = healthChecks[index];
      
      if (result.status === 'fulfilled') {
        return {
          endpoint,
          ...result.value,
          region: getEndpointRegion(endpoint)
        };
      } else {
        return {
          endpoint,
          healthy: false,
          responseTime: -1,
          error: result.reason?.message || 'Unknown error',
          region: getEndpointRegion(endpoint)
        };
      }
    });
    
    // 按健康状态和响应时间排序
    results.sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1; // 健康的优先
      }
      return a.responseTime - b.responseTime; // 响应时间快的优先
    });
    
    const healthyCount = results.filter(r => r.healthy).length;
    
    res.json({
      timestamp: new Date().toISOString(),
      totalEndpoints: results.length,
      healthyEndpoints: healthyCount,
      healthRate: `${(healthyCount / results.length * 100).toFixed(1)}%`,
      endpoints: results,
      recommendations: generateEndpointRecommendations(results)
    });
    
  } catch (error) {
    console.error('❌ 端点健康检查失败:', error);
    res.status(500).json({
      error: '端点健康检查失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/building-opt/monitor
 * 获取实时端点健康监控数据
 */
router.get('/monitor', async (req, res) => {
  try {
    console.log('📊 获取实时端点监控数据...');
    
    const monitorData = endpointHealthMonitor.getDetailedStats();
    
    res.json({
      timestamp: new Date().toISOString(),
      monitoring: {
        ...monitorData.summary,
        note: '基于实际查询结果的实时统计'
      },
      endpoints: monitorData.endpoints.map(endpoint => ({
        region: endpoint.region,
        url: endpoint.url,
        healthy: endpoint.lastHealthy,
        avgResponseTime: Math.round(endpoint.avgResponseTime),
        reliability: `${(endpoint.reliability * 100).toFixed(1)}%`,
        successCount: endpoint.successCount,
        failureCount: endpoint.failureCount,
        score: Math.round(endpoint.score),
        lastChecked: new Date(endpoint.lastChecked).toLocaleString(),
        recentTrend: endpoint.recentResponseTimes.slice(-3) // 最近3次响应时间
      })),
      recommendations: generateMonitorRecommendations(monitorData),
      performanceHistory: '基于用户实际使用数据动态更新'
    });
    
  } catch (error) {
    console.error('❌ 获取监控数据失败:', error);
    res.status(500).json({
      error: '获取监控数据失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/building-opt/categories
 * 获取支持的建筑物类别和查询策略
 */
router.get('/categories', (req, res) => {
  const categoryStats = Object.entries(OSM_BUILDING_CATEGORIES).map(([category, types]) => ({
    category,
    typeCount: types.length,
    types: types,
    examples: types.slice(0, 5) // 只显示前5个示例
  }));
  
  const totalTypes = Object.values(OSM_BUILDING_CATEGORIES).flat().length;
  
  res.json({
    summary: {
      totalCategories: Object.keys(OSM_BUILDING_CATEGORIES).length,
      totalBuildingTypes: totalTypes,
      note: '这是基于OSM Wiki官方文档的完整building标签分类'
    },
    categories: categoryStats,
    queryStrategies: Object.entries(QUERY_STRATEGIES).map(([name, config]) => ({
      strategy: name,
      categories: config.categories,
      timeout: config.timeout,
      priority: config.priority,
      buildingTypeCount: config.categories.flatMap(cat => OSM_BUILDING_CATEGORIES[cat]).length
    })),
    improvements: [
      '✅ 从8种类型扩展到60+种建筑类型',
      '✅ 分级查询策略：fast → standard → complete',
      '✅ 地域化端点选择，减少网络延迟',
      '✅ 智能重试机制，提高成功率'
    ]
  });
});

/**
 * POST /api/building-opt/test-query
 * 测试指定区域的建筑物查询效果
 */
router.post('/test-query', async (req, res) => {
  try {
    const { lat, lng, zoom = 16, strategy = 'standard' } = req.body;
    
    // 验证参数
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({
        error: '无效参数',
        message: 'lat和lng必须是有效数字'
      });
    }
    
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({
        error: '坐标超出范围',
        message: 'lat必须在[-90,90]，lng必须在[-180,180]'
      });
    }
    
    console.log(`🧪 测试查询: (${lat}, ${lng}) zoom=${zoom} strategy=${strategy}`);
    
    // 计算测试区域的边界框 (小范围测试)
    const offset = 0.01; // 约1km范围
    const bbox = {
      north: lat + offset,
      south: lat - offset,
      east: lng + offset, 
      west: lng - offset
    };
    
    // 获取优化参数
    const params = getLocationOptimizedParams(lat, lng);
    
    // 执行智能查询
    const result = await smartBuildingQuery(bbox, lat, lng);
    
    res.json({
      testLocation: { lat, lng, zoom },
      bbox,
      locationOptimization: params,
      queryResult: {
        success: result.success,
        buildingCount: result.buildings.length,
        strategy: result.strategy,
        endpoint: result.endpoint,
        processingTime: result.processingTime,
        totalRetries: result.totalRetries
      },
      buildingSample: result.buildings.slice(0, 3).map(building => ({
        type: building.properties?.buildingType,
        height: building.properties?.height,
        levels: building.properties?.levels,
        name: building.properties?.name
      })),
      recommendations: [
        result.success ? '✅ 查询成功，建议使用此策略' : '❌ 查询失败，建议预处理该区域',
        `📊 该位置预期建筑密度: ${params.buildingDensityExpected}`,
        `🌍 使用了${params.endpoints.length}个地域优化端点`
      ].concat(params.specialConditions),
      testedAt: new Date().toISOString()
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
 * 端点健康检查
 */
async function checkEndpointHealth(endpoint: string): Promise<{
  healthy: boolean;
  responseTime: number;
  region: string;
  status?: string;
}> {
  const startTime = Date.now();
  
  try {
    // 使用非常简单的查询测试端点
    const testQuery = '[out:json][timeout:3]; way["building"="yes"](bbox:39.9,116.4,39.901,116.401); out count;';
    
    const response = await axios.post(endpoint, testQuery, {
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': 'ShadowMap-HealthCheck/1.0'
      },
      timeout: 5000,
      validateStatus: (status) => status < 400
    });
    
    const responseTime = Date.now() - startTime;
    
    if (response.status === 200) {
      return {
        healthy: true,
        responseTime,
        region: getEndpointRegion(endpoint),
        status: 'OK'
      };
    } else {
      return {
        healthy: false,
        responseTime,
        region: getEndpointRegion(endpoint),
        status: `HTTP ${response.status}`
      };
    }
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    return {
      healthy: false,
      responseTime,
      region: getEndpointRegion(endpoint),
      status: errorMsg.includes('timeout') ? 'TIMEOUT' : 'ERROR'
    };
  }
}

/**
 * 获取端点所属地区
 */
function getEndpointRegion(endpoint: string): string {
  if (endpoint.includes('overpass-api.de')) return '德国';
  if (endpoint.includes('kumi.systems')) return '瑞士'; 
  if (endpoint.includes('openstreetmap.ru')) return '俄罗斯';
  if (endpoint.includes('maps.mail.ru')) return '俄罗斯Mail.ru';
  return '未知';
}

/**
 * 生成端点使用建议
 */
function generateEndpointRecommendations(results: any[]): string[] {
  const recommendations: string[] = [];
  
  const healthyEndpoints = results.filter(r => r.healthy);
  const fastestEndpoint = healthyEndpoints.sort((a, b) => a.responseTime - b.responseTime)[0];
  
  if (healthyEndpoints.length === 0) {
    recommendations.push('❌ 所有端点都不健康，建议稍后重试或使用预处理数据');
  } else if (healthyEndpoints.length < results.length * 0.5) {
    recommendations.push('⚠️ 超过50%端点不健康，建议主要使用健康端点');
  } else {
    recommendations.push('✅ 大部分端点健康，可以正常使用');
  }
  
  if (fastestEndpoint) {
    recommendations.push(`🚀 最快端点: ${fastestEndpoint.region} (${fastestEndpoint.responseTime}ms)`);
  }
  
  const slowEndpoints = results.filter(r => r.healthy && r.responseTime > 3000);
  if (slowEndpoints.length > 0) {
    recommendations.push(`🐌 慢速端点: ${slowEndpoints.map(e => e.region).join(', ')} - 建议避免使用`);
  }
  
  return recommendations;
}

/**
 * 生成监控建议
 */
function generateMonitorRecommendations(monitorData: any): string[] {
  const recommendations: string[] = [];
  const { endpoints, summary } = monitorData;
  
  const healthyEndpoints = endpoints.filter((ep: any) => ep.lastHealthy);
  const bestEndpoint = healthyEndpoints[0]; // 已按分数排序
  
  if (summary.healthyEndpoints === 0) {
    recommendations.push('🚨 所有端点都不健康，建议检查网络连接或稍后重试');
  } else if (summary.healthyEndpoints < 2) {
    recommendations.push('⚠️ 健康端点过少，建议监控网络状况');
  } else {
    recommendations.push(`✅ ${summary.healthyEndpoints}个健康端点，系统运行正常`);
  }
  
  if (bestEndpoint) {
    const bestScore = bestEndpoint.score || 999999;
    recommendations.push(`🚀 当前最优端点: ${bestEndpoint.region} (${bestEndpoint.avgResponseTime}ms)`);
    
    if (bestEndpoint.avgResponseTime > 3000) {
      recommendations.push('🐌 最优端点响应较慢，建议考虑数据预处理');
    }
  }
  
  const unreliableEndpoints = endpoints.filter((ep: any) => ep.reliability < 0.8);
  if (unreliableEndpoints.length > 0) {
    const unreliableNames = unreliableEndpoints.map((ep: any) => ep.region).join(', ');
    recommendations.push(`⚠️ 不稳定端点: ${unreliableNames} - 可靠性 < 80%`);
  }
  
  return recommendations;
}

export default router;
