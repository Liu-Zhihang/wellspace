/**
 * OSM建筑物数据预处理脚本
 * 批量下载热门区域的建筑物数据到MongoDB，解决实时请求超时问题
 */

import { buildingServiceMongoDB } from '../services/buildingServiceMongoDB';
import { dbManager } from '../config/database';

// 热门城市坐标配置
const POPULAR_CITIES = [
  // 中国主要城市
  { name: '北京', lat: 39.9042, lng: 116.4074, priority: 1 },
  { name: '上海', lat: 31.2304, lng: 121.4737, priority: 1 },
  { name: '广州', lat: 23.1291, lng: 113.2644, priority: 1 },
  { name: '深圳', lat: 22.5431, lng: 114.0579, priority: 1 },
  { name: '杭州', lat: 30.2741, lng: 120.1551, priority: 2 },
  { name: '南京', lat: 32.0603, lng: 118.7969, priority: 2 },
  { name: '武汉', lat: 30.5928, lng: 114.3055, priority: 2 },
  { name: '成都', lat: 30.6720, lng: 104.0633, priority: 2 },
  
  // 国际主要城市
  { name: 'New York', lat: 40.7128, lng: -74.0060, priority: 3 },
  { name: 'London', lat: 51.5074, lng: -0.1278, priority: 3 },
  { name: 'Tokyo', lat: 35.6762, lng: 139.6503, priority: 3 },
  { name: 'Paris', lat: 48.8566, lng: 2.3522, priority: 3 },
];

// 预处理配置
interface PreloadConfig {
  zoomLevels: number[];    // 需要预处理的缩放级别
  radius: number;          // 每个城市的瓦片半径
  batchSize: number;       // 批处理大小
  delayMs: number;         // 请求间隔
  maxRetries: number;      // 最大重试次数
  timeoutMs: number;       // 单个请求超时
}

const DEFAULT_CONFIG: PreloadConfig = {
  zoomLevels: [15, 16],    // 重点预处理15-16级
  radius: 3,               // 3瓦片半径 (7x7区域)
  batchSize: 5,            // 同时处理5个瓦片
  delayMs: 1000,           // 1秒间隔
  maxRetries: 3,
  timeoutMs: 30000         // 30秒超时
};

/**
 * 计算瓦片坐标
 */
function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI/180) + 1/Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * n);
  
  return { x: Math.max(0, Math.min(x, n-1)), y: Math.max(0, Math.min(y, n-1)) };
}

/**
 * 获取城市周围的瓦片列表
 */
function getCityTiles(lat: number, lng: number, zoom: number, radius: number): Array<{z: number, x: number, y: number}> {
  const center = latLngToTile(lat, lng, zoom);
  const tiles = [];
  
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const x = center.x + dx;
      const y = center.y + dy;
      const n = Math.pow(2, zoom);
      
      if (x >= 0 && x < n && y >= 0 && y < n) {
        tiles.push({ z: zoom, x, y });
      }
    }
  }
  
  return tiles;
}

/**
 * 预处理单个瓦片
 */
async function preloadTile(z: number, x: number, y: number, retries: number = 0): Promise<{
  success: boolean;
  buildingCount: number;
  fromCache: boolean;
  processingTime: number;
  error?: string;
}> {
  const startTime = Date.now();
  
  try {
    console.log(`🔄 预处理瓦片: ${z}/${x}/${y} (尝试 ${retries + 1})`);
    
    const tileData = await buildingServiceMongoDB.getBuildingTile(z, x, y);
    const processingTime = Date.now() - startTime;
    
    const result = {
      success: true,
      buildingCount: tileData.features.length,
      fromCache: tileData.cached,
      processingTime
    };
    
    if (tileData.features.length > 0) {
      console.log(`✅ 瓦片预处理成功: ${z}/${x}/${y} - ${tileData.features.length}建筑物 (${processingTime}ms)`);
    } else {
      console.log(`📭 瓦片无建筑物: ${z}/${x}/${y} (${processingTime}ms)`);
    }
    
    return result;
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    
    console.error(`❌ 瓦片预处理失败: ${z}/${x}/${y} - ${errorMsg} (${processingTime}ms)`);
    
    if (retries < DEFAULT_CONFIG.maxRetries) {
      console.log(`🔄 重试瓦片: ${z}/${x}/${y} (${retries + 1}/${DEFAULT_CONFIG.maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, (retries + 1) * 2000)); // 递增延迟
      return await preloadTile(z, x, y, retries + 1);
    }
    
    return {
      success: false,
      buildingCount: 0,
      fromCache: false,
      processingTime,
      error: errorMsg
    };
  }
}

/**
 * 批量预处理瓦片
 */
async function preloadTileBatch(tiles: Array<{z: number, x: number, y: number}>): Promise<{
  total: number;
  success: number;
  failed: number;
  totalBuildings: number;
  totalTime: number;
  fromCache: number;
}> {
  console.log(`📦 开始批量预处理: ${tiles.length} 个瓦片`);
  
  const startTime = Date.now();
  const results = {
    total: tiles.length,
    success: 0,
    failed: 0,
    totalBuildings: 0,
    totalTime: 0,
    fromCache: 0
  };
  
  // 分批处理，避免同时发起太多请求
  for (let i = 0; i < tiles.length; i += DEFAULT_CONFIG.batchSize) {
    const batch = tiles.slice(i, i + DEFAULT_CONFIG.batchSize);
    
    console.log(`📊 处理批次 ${Math.floor(i / DEFAULT_CONFIG.batchSize) + 1}/${Math.ceil(tiles.length / DEFAULT_CONFIG.batchSize)} (${batch.length} 个瓦片)`);
    
    const batchPromises = batch.map(tile => preloadTile(tile.z, tile.x, tile.y));
    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result) => {
      if (result.status === 'fulfilled') {
        const tileResult = result.value;
        if (tileResult.success) {
          results.success++;
          results.totalBuildings += tileResult.buildingCount;
          if (tileResult.fromCache) results.fromCache++;
        } else {
          results.failed++;
        }
        results.totalTime += tileResult.processingTime;
      } else {
        results.failed++;
        console.error('❌ 批处理Promise失败:', result.reason);
      }
    });
    
    // 批次间延迟
    if (i + DEFAULT_CONFIG.batchSize < tiles.length) {
      console.log(`⏸️ 批次间延迟: ${DEFAULT_CONFIG.delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.delayMs));
    }
  }
  
  const totalTime = Date.now() - startTime;
  results.totalTime = totalTime;
  
  console.log(`📊 批量预处理完成:`);
  console.log(`   总瓦片数: ${results.total}`);
  console.log(`   成功: ${results.success} (${(results.success/results.total*100).toFixed(1)}%)`);
  console.log(`   失败: ${results.failed}`);
  console.log(`   缓存命中: ${results.fromCache}`);
  console.log(`   建筑物总数: ${results.totalBuildings}`);
  console.log(`   平均用时: ${(results.totalTime/results.total).toFixed(0)}ms/瓦片`);
  console.log(`   总用时: ${(totalTime/1000).toFixed(1)}秒`);
  
  return results;
}

/**
 * 预处理单个城市
 */
async function preloadCity(city: { name: string; lat: number; lng: number; priority: number }): Promise<void> {
  console.log(`\n🏙️ 开始预处理城市: ${city.name} (${city.lat}, ${city.lng})`);
  
  const cityStats = {
    totalTiles: 0,
    totalBuildings: 0,
    totalTime: 0,
    successRate: 0
  };
  
  for (const zoom of DEFAULT_CONFIG.zoomLevels) {
    console.log(`\n🔍 缩放级别 ${zoom}:`);
    
    const tiles = getCityTiles(city.lat, city.lng, zoom, DEFAULT_CONFIG.radius);
    console.log(`📍 生成瓦片: ${tiles.length} 个 (${DEFAULT_CONFIG.radius}瓦片半径)`);
    
    const result = await preloadTileBatch(tiles);
    
    cityStats.totalTiles += result.total;
    cityStats.totalBuildings += result.totalBuildings;
    cityStats.totalTime += result.totalTime;
    cityStats.successRate = (cityStats.successRate + result.success / result.total) / 2; // 平均成功率
  }
  
  console.log(`\n🎉 城市 ${city.name} 预处理完成:`);
  console.log(`   总瓦片数: ${cityStats.totalTiles}`);
  console.log(`   总建筑物: ${cityStats.totalBuildings}`);
  console.log(`   成功率: ${(cityStats.successRate * 100).toFixed(1)}%`);
  console.log(`   总用时: ${(cityStats.totalTime/1000).toFixed(1)}秒`);
}

/**
 * 预处理所有热门城市
 */
async function preloadAllCities(): Promise<void> {
  console.log('🌍 开始预处理所有热门城市的建筑物数据...\n');
  console.log('📋 预处理配置:');
  console.log(`   缩放级别: [${DEFAULT_CONFIG.zoomLevels.join(', ')}]`);
  console.log(`   瓦片半径: ${DEFAULT_CONFIG.radius}`);
  console.log(`   批处理大小: ${DEFAULT_CONFIG.batchSize}`);
  console.log(`   请求间隔: ${DEFAULT_CONFIG.delayMs}ms`);
  
  // 连接数据库
  await dbManager.connect();
  console.log('✅ 数据库连接成功');
  
  // 按优先级排序城市
  const sortedCities = [...POPULAR_CITIES].sort((a, b) => a.priority - b.priority);
  
  const globalStartTime = Date.now();
  let totalCitiesProcessed = 0;
  
  for (const city of sortedCities) {
    try {
      await preloadCity(city);
      totalCitiesProcessed++;
      
      // 城市间延迟
      if (totalCitiesProcessed < sortedCities.length) {
        console.log(`\n⏸️ 城市间延迟: ${DEFAULT_CONFIG.delayMs * 2}ms\n`);
        await new Promise(resolve => setTimeout(resolve, DEFAULT_CONFIG.delayMs * 2));
      }
      
    } catch (error) {
      console.error(`❌ 城市 ${city.name} 预处理失败:`, error);
      // 继续处理下一个城市
    }
  }
  
  const globalTotalTime = Date.now() - globalStartTime;
  
  console.log('\n🎉 全球热门城市建筑物数据预处理完成!');
  console.log(`📊 处理统计:`);
  console.log(`   城市总数: ${POPULAR_CITIES.length}`);
  console.log(`   成功处理: ${totalCitiesProcessed}`);
  console.log(`   总用时: ${(globalTotalTime/1000/60).toFixed(1)}分钟`);
  console.log(`\n💡 现在用户访问这些热门区域时，建筑物数据将从MongoDB缓存中快速加载！`);
}

/**
 * 快速预处理当前用户位置
 */
export async function preloadUserLocation(lat: number, lng: number, zoom: number = 16): Promise<void> {
  console.log(`📍 预处理用户当前位置: ${lat.toFixed(4)}, ${lng.toFixed(4)} (zoom ${zoom})`);
  
  try {
    await dbManager.connect();
    
    const tiles = getCityTiles(lat, lng, zoom, 2); // 2瓦片半径
    const result = await preloadTileBatch(tiles);
    
    if (result.success > 0) {
      console.log(`✅ 用户位置预处理完成: ${result.totalBuildings} 个建筑物`);
    } else {
      console.log(`📭 用户位置暂无建筑物数据`);
    }
    
  } catch (error) {
    console.error(`❌ 用户位置预处理失败:`, error);
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  preloadAllCities().catch(console.error);
}

export { preloadAllCities, preloadCity };
