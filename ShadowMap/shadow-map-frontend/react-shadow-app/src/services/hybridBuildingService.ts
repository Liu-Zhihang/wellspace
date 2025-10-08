/**
 * 混合建筑数据服务
 * 优先使用本地数据库，回退到TUM WFS服务
 */

import { BoundingBox, TUMBuildingResponse, getTUMBuildings } from './tumBuildingService';

const API_BASE = 'http://localhost:3001/api';

export interface HybridBuildingResponse {
  success: boolean;
  data: {
    type: 'FeatureCollection';
    features: any[];
    metadata: {
      source: 'DATABASE' | 'TUM_WFS' | 'MIXED';
      bounds: BoundingBox;
      totalFeatures: number;
      databaseFeatures: number;
      wfsFeatures: number;
      timestamp: string;
    };
  };
}

/**
 * 获取本地数据库中的建筑数据
 */
async function getDatabaseBuildings(bounds: BoundingBox, maxFeatures: number = 1000): Promise<{
  success: boolean;
  features: any[];
  count: number;
  error?: string;
}> {
  try {
    console.log('🏗️ 尝试从本地数据库获取建筑数据...');
    
    // 计算瓦片坐标范围（缩放级别16）
    const zoom = 16;
    const tiles = calculateTilesInBounds(bounds, zoom);
    
    const allFeatures: any[] = [];
    let successCount = 0;
    
    for (const tile of tiles) {
      try {
        const response = await fetch(`${API_BASE}/buildings/${tile.z}/${tile.x}/${tile.y}.json`);
        if (response.ok) {
          const data = await response.json();
          if (data.features && data.features.length > 0) {
            allFeatures.push(...data.features);
            successCount++;
          }
        }
      } catch (error) {
        console.warn(`获取瓦片 ${tile.z}/${tile.x}/${tile.y} 失败:`, error);
      }
      
      // 限制最大特征数
      if (allFeatures.length >= maxFeatures) {
        break;
      }
    }
    
    console.log(`✅ 从数据库获取了 ${allFeatures.length} 个建筑物 (${successCount}/${tiles.length} 瓦片成功)`);
    
    return {
      success: allFeatures.length > 0,
      features: allFeatures.slice(0, maxFeatures),
      count: allFeatures.length
    };
    
  } catch (error) {
    console.error('❌ 数据库查询失败:', error);
    return {
      success: false,
      features: [],
      count: 0,
      error: error instanceof Error ? error.message : 'Database query failed'
    };
  }
}

/**
 * 计算边界框内的瓦片
 */
function calculateTilesInBounds(bounds: BoundingBox, zoom: number): Array<{z: number, x: number, y: number}> {
  const tiles: Array<{z: number, x: number, y: number}> = [];
  
  // 将经纬度转换为瓦片坐标
  const nwTile = latLngToTile(bounds.north, bounds.west, zoom);
  const seTile = latLngToTile(bounds.south, bounds.east, zoom);
  
  const minX = Math.min(nwTile.x, seTile.x);
  const maxX = Math.max(nwTile.x, seTile.x);
  const minY = Math.min(nwTile.y, seTile.y);
  const maxY = Math.max(nwTile.y, seTile.y);
  
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  
  // 限制瓦片数量，避免请求过多
  return tiles.slice(0, 20);
}

/**
 * 经纬度转瓦片坐标
 */
function latLngToTile(lat: number, lng: number, zoom: number): {x: number, y: number} {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * 混合数据源获取建筑数据
 * 策略：优先数据库，数据不足时补充WFS数据
 */
export async function getHybridBuildings(bounds: BoundingBox, maxFeatures: number = 1000): Promise<HybridBuildingResponse> {
  console.log('🔄 开始混合数据源建筑数据获取...');
  
  const startTime = Date.now();
  
  // 第一步：尝试从数据库获取
  const dbResult = await getDatabaseBuildings(bounds, maxFeatures);
  
  let finalFeatures = [...dbResult.features];
  let source: 'DATABASE' | 'TUM_WFS' | 'MIXED' = 'DATABASE';
  
  // 第二步：如果数据库数据不足，补充WFS数据
  if (dbResult.count < maxFeatures * 0.5) { // 如果数据库数据少于期望的50%
    console.log('📡 数据库数据不足，尝试从TUM WFS获取补充数据...');
    
    try {
      const wfsResult = await getTUMBuildings(bounds, maxFeatures - dbResult.count);
      
      if (wfsResult.success && wfsResult.data.features.length > 0) {
        // 合并数据，去重
        const existingIds = new Set(finalFeatures.map(f => f.properties?.id).filter(Boolean));
        const newWfsFeatures = wfsResult.data.features.filter(f => 
          !f.properties?.id || !existingIds.has(f.properties.id)
        );
        
        finalFeatures.push(...newWfsFeatures);
        source = dbResult.count > 0 ? 'MIXED' : 'TUM_WFS';
        
        console.log(`✅ 从WFS补充了 ${newWfsFeatures.length} 个建筑物`);
      }
    } catch (wfsError) {
      console.warn('⚠️ WFS补充数据失败:', wfsError);
      // 即使WFS失败，也返回数据库中的数据
    }
  }
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  console.log(`🎯 混合数据获取完成: ${finalFeatures.length} 个建筑物 (耗时: ${duration}ms, 来源: ${source})`);
  
  return {
    success: finalFeatures.length > 0,
    data: {
      type: 'FeatureCollection',
      features: finalFeatures.slice(0, maxFeatures),
      metadata: {
        source,
        bounds,
        totalFeatures: finalFeatures.length,
        databaseFeatures: dbResult.count,
        wfsFeatures: finalFeatures.length - dbResult.count,
        timestamp: new Date().toISOString()
      }
    }
  };
}

/**
 * 检查数据覆盖情况
 */
export async function checkDataCoverage(bounds: BoundingBox): Promise<{
  database: { available: boolean; count: number; coverage: number };
  wfs: { available: boolean; count: number };
  recommendation: 'DATABASE' | 'WFS' | 'MIXED';
}> {
  console.log('🔍 检查数据覆盖情况...');
  
  const [dbResult, wfsAvailable] = await Promise.allSettled([
    getDatabaseBuildings(bounds, 100), // 小样本检查
    getTUMBuildings(bounds, 100)
  ]);
  
  const database = {
    available: dbResult.status === 'fulfilled' && dbResult.value.success,
    count: dbResult.status === 'fulfilled' ? dbResult.value.count : 0,
    coverage: 0
  };
  
  const wfs = {
    available: wfsAvailable.status === 'fulfilled' && wfsAvailable.value.success,
    count: wfsAvailable.status === 'fulfilled' ? wfsAvailable.value.data.features.length : 0
  };
  
  // 计算数据库覆盖率
  if (database.available && wfs.available && wfs.count > 0) {
    database.coverage = Math.min(100, (database.count / wfs.count) * 100);
  }
  
  // 推荐策略
  let recommendation: 'DATABASE' | 'WFS' | 'MIXED';
  if (database.coverage >= 80) {
    recommendation = 'DATABASE';
  } else if (database.coverage >= 20) {
    recommendation = 'MIXED';
  } else {
    recommendation = 'WFS';
  }
  
  console.log(`📊 数据覆盖分析: DB=${database.count} (${database.coverage.toFixed(1)}%), WFS=${wfs.count}, 推荐=${recommendation}`);
  
  return { database, wfs, recommendation };
}

// 导出混合建筑数据服务
export const hybridBuildingService = {
  getHybridBuildings,
  checkDataCoverage,
  getDatabaseBuildings
};

export default hybridBuildingService;
