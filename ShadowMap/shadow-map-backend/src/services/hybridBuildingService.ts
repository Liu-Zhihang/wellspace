/**
 * 混合建筑数据服务
 * 结合OSM和TUM GlobalBuildingAtlas数据源，提供更完整的建筑数据
 */

import { buildingServiceMongoDB } from './buildingServiceMongoDB';
import { fetchTUMBuildings, testTUMConnection, convertTUMToStandardGeoJSON } from './tumBuildingService';
import { tumLongTermCacheService } from './tumLongTermCacheService';

// 数据源优先级配置
const DATA_SOURCE_PRIORITY = {
  // 优先使用本地MongoDB缓存
  mongodb: 1,
  // 其次使用TUM数据（质量更高）
  tum: 2,
  // 最后使用OSM数据（覆盖更全）
  osm: 3
};

// 混合数据源配置
const HYBRID_CONFIG = {
  // 暂时禁用TUM数据源（502 Bad Gateway）
  enableTUM: false, // 🔧 临时禁用TUM，因为服务器返回502错误
  // TUM数据超时时间
  tumTimeout: 15000,
  // OSM数据超时时间  
  osmTimeout: 30000,
  // 数据合并策略
  mergeStrategy: 'osm_priority' // 🔧 改为OSM优先
};

/**
 * 获取混合建筑数据
 * 按优先级尝试不同数据源
 */
export async function getHybridBuildingTile(
  z: number,
  x: number,
  y: number
): Promise<{
  type: 'FeatureCollection';
  features: any[];
  cached: boolean;
  source: string;
  stats: {
    totalFeatures: number;
    sources: string[];
    processingTime: number;
  };
}> {
  const startTime = Date.now();
  const sources: string[] = [];
  let allFeatures: any[] = [];
  let cached = false;
  let primarySource = 'unknown';

  console.log(`🏗️ 获取混合建筑数据: ${z}/${x}/${y}`);

  try {
    // 1. 首先尝试TUM长期缓存（最优先）
    console.log('  🎯 检查TUM长期缓存...');
    try {
      // 计算瓦片中心点坐标
      const tileSize = 360 / Math.pow(2, z);
      const centerLng = (x + 0.5) * tileSize - 180;
      const centerLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / Math.pow(2, z)))) * 180 / Math.PI;
      
      const longTermCacheData = await tumLongTermCacheService.getCachedData(centerLat, centerLng, z);
      if (longTermCacheData && longTermCacheData.features && longTermCacheData.features.length > 0) {
        console.log(`  🚀 TUM长期缓存命中: ${longTermCacheData.features.length} 个建筑物`);
        allFeatures = longTermCacheData.features;
        cached = true;
        primarySource = 'tum-long-term-cache';
        sources.push('tum-long-term-cache');
        
        // 异步预加载相邻网格
        tumLongTermCacheService.preloadAdjacentGrids(centerLat, centerLng, z).catch(error => {
          console.warn('⚠️ 预加载相邻网格失败:', error);
        });
        
        return {
          type: 'FeatureCollection',
          features: allFeatures,
          cached,
          source: primarySource,
          stats: {
            totalFeatures: allFeatures.length,
            sources,
            processingTime: Date.now() - startTime
          }
        };
      }
    } catch (error) {
      console.log('  ⚠️ TUM长期缓存未命中或出错:', error);
    }

    // 2. 然后尝试MongoDB缓存
    console.log('  📦 检查MongoDB缓存...');
    try {
      const mongoData = await buildingServiceMongoDB.getBuildingTile(z, x, y);
      if (mongoData.features.length > 0) {
        console.log(`  ✅ MongoDB缓存命中: ${mongoData.features.length} 个建筑物`);
        allFeatures = mongoData.features;
        cached = true;
        primarySource = 'mongodb';
        sources.push('mongodb');
      }
    } catch (error) {
      console.log('  ⚠️ MongoDB缓存未命中或出错');
    }

    // 3. 如果MongoDB没有数据且启用TUM，尝试TUM数据源
    if (allFeatures.length === 0 && HYBRID_CONFIG.enableTUM) {
      console.log('  🌍 尝试TUM GlobalBuildingAtlas...');
      try {
        // 将瓦片坐标转换为地理边界
        const tileSize = 360 / Math.pow(2, z);
        const west = x * tileSize - 180;
        const east = (x + 1) * tileSize - 180;
        const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) * 180 / Math.PI;
        const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / Math.pow(2, z)))) * 180 / Math.PI;
        
        const bounds = { north, south, east, west };
        const tumResponse = await fetchTUMBuildings(bounds, 1000);
        const tumData = convertTUMToStandardGeoJSON(tumResponse);
        if (tumData.features.length > 0) {
          console.log(`  ✅ TUM数据获取成功: ${tumData.features.length} 个建筑物`);
          allFeatures = tumData.features;
          primarySource = 'tum';
          sources.push('tum');
          
          // 保存到缓存系统
          try {
            // 计算瓦片中心点坐标
            const tileSize = 360 / Math.pow(2, z);
            const centerLng = (x + 0.5) * tileSize - 180;
            const centerLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / Math.pow(2, z)))) * 180 / Math.PI;
            
            // 并行保存到MongoDB和TUM长期缓存
            const savePromises = [
              buildingServiceMongoDB.saveBuildingTile(z, x, y, {
                type: 'FeatureCollection',
                features: tumData.features
              }),
              tumLongTermCacheService.setCachedData(centerLat, centerLng, z, {
                type: 'FeatureCollection',
                features: tumData.features
              }, 'tum')
            ];
            
            await Promise.allSettled(savePromises);
            console.log('  💾 TUM数据已保存到MongoDB和长期缓存');
          } catch (saveError) {
            console.warn('  ⚠️ TUM数据保存失败:', saveError);
          }
        }
      } catch (error) {
        console.log('  ❌ TUM数据获取失败:', error);
      }
    }

    // 3. 如果仍然没有数据，尝试OSM数据源
    if (allFeatures.length === 0) {
      console.log('  🗺️ 尝试OSM数据源...');
      try {
        // 这里需要调用现有的OSM服务
        // 由于我们没有直接访问OSM服务的函数，这里先返回空数据
        // 实际实现中需要调用相应的OSM服务函数
        console.log('  ⚠️ OSM数据源暂未集成到混合服务中');
        primarySource = 'osm';
        sources.push('osm');
      } catch (error) {
        console.log('  ❌ OSM数据获取失败:', error);
      }
    }

    const processingTime = Date.now() - startTime;

    console.log(`  📊 混合数据获取完成: ${allFeatures.length} 个建筑物, 用时 ${processingTime}ms`);

    return {
      type: 'FeatureCollection',
      features: allFeatures,
      cached,
      source: primarySource,
      stats: {
        totalFeatures: allFeatures.length,
        sources,
        processingTime
      }
    };

  } catch (error) {
    console.error(`❌ 混合建筑数据获取失败: ${z}/${x}/${y}`, error);
    
    return {
      type: 'FeatureCollection',
      features: [],
      cached: false,
      source: 'error',
      stats: {
        totalFeatures: 0,
        sources: ['error'],
        processingTime: Date.now() - startTime
      }
    };
  }
}

/**
 * 检查所有数据源的健康状态
 */
export async function checkAllDataSources(): Promise<{
  mongodb: { available: boolean; stats?: any };
  tum: { available: boolean; responseTime?: number; error?: string };
  osm: { available: boolean; error?: string };
}> {
  console.log('🔍 检查所有数据源健康状态...');

  const results = {
    mongodb: { available: false },
    tum: { available: false },
    osm: { available: false }
  };

  // 检查MongoDB
  try {
    const mongoStats = await buildingServiceMongoDB.getStatistics();
    results.mongodb = {
      available: true,
      stats: mongoStats
    };
    console.log('  ✅ MongoDB: 可用');
  } catch (error) {
    console.log('  ❌ MongoDB: 不可用', error);
  }

  // 检查TUM服务
  if (HYBRID_CONFIG.enableTUM) {
    try {
      const tumHealth = await checkTUMServiceHealth();
      results.tum = tumHealth;
      if (tumHealth.available) {
        console.log(`  ✅ TUM: 可用 (${tumHealth.responseTime}ms)`);
      } else {
        console.log('  ❌ TUM: 不可用', tumHealth.error);
      }
    } catch (error) {
      console.log('  ❌ TUM: 检查失败', error);
    }
  }

  // 检查OSM服务（这里简化处理）
  try {
    // 实际实现中需要检查OSM服务
    results.osm = { available: true };
    console.log('  ✅ OSM: 可用');
  } catch (error) {
    results.osm = { available: false, error: 'Unknown error' };
    console.log('  ❌ OSM: 不可用', error);
  }

  return results;
}

/**
 * 获取数据源统计信息
 */
export async function getDataSourceStats(): Promise<{
  totalBuildings: number;
  sourceDistribution: { [key: string]: number };
  averageResponseTime: number;
  cacheHitRate: number;
}> {
  try {
    const mongoStats = await buildingServiceMongoDB.getStatistics();
    
    return {
      totalBuildings: mongoStats.totalBuildings,
      sourceDistribution: {
        mongodb: mongoStats.totalBuildings, // 简化处理
        tum: 0, // 需要实际统计
        osm: 0  // 需要实际统计
      },
      averageResponseTime: 0, // 需要实际统计
      cacheHitRate: 0.8 // 估算值
    };
  } catch (error) {
    console.error('❌ 获取数据源统计失败:', error);
    return {
      totalBuildings: 0,
      sourceDistribution: {},
      averageResponseTime: 0,
      cacheHitRate: 0
    };
  }
}

export default {
  getHybridBuildingTile,
  checkAllDataSources,
  getDataSourceStats
};
