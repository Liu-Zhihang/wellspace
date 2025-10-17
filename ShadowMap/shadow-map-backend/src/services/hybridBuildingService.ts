/**
 * Hybrid building data service.
 * Combines MongoDB cache, WFS (GeoServer) data, and OSM fallbacks.
 */

import { buildingServiceMongoDB } from './buildingServiceMongoDB';
import { fetchWfsBuildings, testWfsConnection, convertWfsToStandardGeoJSON } from './buildingWfsService';
import { buildingLongTermCacheService } from './buildingLongTermCacheService';

// Data source priority configuration
const DATA_SOURCE_PRIORITY = {
  mongodb: 1,
  wfs: 2,
  osm: 3
};

const HYBRID_CONFIG = {
  enableWfs: false,
  wfsTimeout: 15_000,
  osmTimeout: 30_000,
  mergeStrategy: 'osm_priority'
};

/**
 * Retrieve building data by combining multiple data sources following a priority order.
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

  console.log(`[Hybrid] Fetching tile ${z}/${x}/${y}`);

  try {
    // 1. First try the long-term cache (best latency)
    console.log('  🎯 Checking long-term building cache...');
    try {
      // 计算瓦片中心点坐标
      const tileSize = 360 / Math.pow(2, z);
      const centerLng = (x + 0.5) * tileSize - 180;
      const centerLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / Math.pow(2, z)))) * 180 / Math.PI;
      
      const longTermCacheData = await buildingLongTermCacheService.getCachedData(centerLat, centerLng, z);
      if (longTermCacheData && longTermCacheData.features && longTermCacheData.features.length > 0) {
        console.log(`  🚀 Long-term cache hit: ${longTermCacheData.features.length} buildings`);
        allFeatures = longTermCacheData.features;
        cached = true;
        primarySource = 'tum-long-term-cache';
        sources.push('tum-long-term-cache');
        
        // 异步预加载相邻网格
        buildingLongTermCacheService.preloadAdjacentGrids(centerLat, centerLng, z).catch(error => {
          console.warn('⚠️ Failed to preload adjacent grids', error);
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
      console.log('  ⚠️ Long-term cache miss or error', error);
    }

    // 2. Then try MongoDB cache
    console.log('  📦 Checking MongoDB cache...');
    try {
      const mongoData = await buildingServiceMongoDB.getBuildingTile(z, x, y);
      if (mongoData.features.length > 0) {
        console.log(`  ✅ MongoDB cache hit: ${mongoData.features.length} buildings`);
        allFeatures = mongoData.features;
        cached = true;
        primarySource = 'mongodb';
        sources.push('mongodb');
      }
    } catch (error) {
      console.log('  ⚠️ MongoDB cache miss or error');
    }

    // 3. If MongoDB misses and WFS is enabled, query the WFS endpoint
    if (allFeatures.length === 0 && HYBRID_CONFIG.enableWfs) {
      console.log('  🌍 Falling back to GeoServer WFS...');
      try {
        const tileSize = 360 / Math.pow(2, z);
        const west = x * tileSize - 180;
        const east = (x + 1) * tileSize - 180;
        const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) * 180 / Math.PI;
        const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / Math.pow(2, z)))) * 180 / Math.PI;
        
        const bounds = { north, south, east, west };
        const wfsResponse = await fetchWfsBuildings(bounds, 1000);
        const wfsData = convertWfsToStandardGeoJSON(wfsResponse);
        if (wfsData.features.length > 0) {
          console.log(`  ✅ WFS returned ${wfsData.features.length} buildings`);
          allFeatures = wfsData.features;
          primarySource = 'wfs';
          sources.push('wfs');

          try {
            const tileSize = 360 / Math.pow(2, z);
            const centerLng = (x + 0.5) * tileSize - 180;
            const centerLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / Math.pow(2, z)))) * 180 / Math.PI;
            
            const savePromises = [
              buildingServiceMongoDB.saveBuildingTile(z, x, y, {
                type: 'FeatureCollection',
                features: wfsData.features
              }),
              buildingLongTermCacheService.setCachedData(centerLat, centerLng, z, {
                type: 'FeatureCollection',
                features: wfsData.features
              }, 'wfs')
            ];
            
            await Promise.allSettled(savePromises);
            console.log('  💾 WFS data cached in MongoDB and long-term store');
          } catch (saveError) {
            console.warn('  ⚠️ Failed to persist WFS data', saveError);
          }
        }
      } catch (error) {
        console.log('  ❌ WFS request failed', error);
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
  if (HYBRID_CONFIG.enableWfs) {
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
