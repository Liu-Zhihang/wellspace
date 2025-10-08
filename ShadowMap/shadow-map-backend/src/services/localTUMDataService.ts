/**
 * 本地TUM数据服务
 * 从本地下载的TUM GlobalBuildingAtlas数据中查询建筑物
 */

import fs from 'fs/promises';
import path from 'path';
import { BoundingBox, TUMBuildingResponse, TUMBuildingFeature } from './tumBuildingService';

// 本地数据配置
const LOCAL_DATA_CONFIG = {
  dataDir: path.join(__dirname, '../../data/tum-buildings'),
  // 元数据文件（索引）
  lod1MetaFile: 'metadata/lod1.geojson',
  heightMetaFile: 'metadata/height_zip.geojson',
  // 实际数据文件 - 支持多个区域
  dataSources: [
    {
      name: 'munich',
      region: 'Europe/Munich',
      lod1File: 'sample/examples/LoD1/europe/e010_n50_e015_n45.geojson',
      heightDir: 'sample/examples/Height/europe/e010_n50_e015_n45',
      bounds: {
        west: 10.0, east: 15.0,
        south: 45.0, north: 50.0
      },
      priority: 1 // 优先级：1=最高（当前可用的数据）
    },
    {
      name: 'hongkong',
      region: 'Asia/Hong Kong',
      lod1File: 'hongkong/LoD1/e110_n25_e115_n20.geojson',
      heightDir: 'hongkong/Height/e110_n25_e115_n20',
      bounds: {
        west: 113.8, east: 114.5,
        south: 22.1, north: 22.6
      },
      priority: 2 // 暂时不可用，等待数据获取解决方案
    }
  ],
  cacheEnabled: true,
  maxFeaturesPerQuery: 10000
};

// 内存缓存 - 支持多区域
let cachedRegionData: Map<string, any> = new Map();
let dataLoadTime: number = 0;

/**
 * 检查本地TUM数据是否存在
 */
export async function checkLocalTUMData(): Promise<{
  available: boolean;
  regions: Array<{
    name: string;
    region: string;
    available: boolean;
    lod1Exists: boolean;
    heightExists: boolean;
    fileSize?: number;
    priority: number;
  }>;
  metadata: {
    lod1Meta: boolean;
    heightMeta: boolean;
  };
}> {
  try {
    // 检查元数据文件
    const lod1MetaPath = path.join(LOCAL_DATA_CONFIG.dataDir, LOCAL_DATA_CONFIG.lod1MetaFile);
    const heightMetaPath = path.join(LOCAL_DATA_CONFIG.dataDir, LOCAL_DATA_CONFIG.heightMetaFile);
    
    const [lod1MetaExists, heightMetaExists] = await Promise.all([
      fs.access(lod1MetaPath).then(() => true).catch(() => false),
      fs.access(heightMetaPath).then(() => true).catch(() => false)
    ]);
    
    // 检查各个区域的数据
    const regionChecks = await Promise.all(
      LOCAL_DATA_CONFIG.dataSources.map(async (source) => {
        const lod1Path = path.join(LOCAL_DATA_CONFIG.dataDir, source.lod1File);
        const heightPath = path.join(LOCAL_DATA_CONFIG.dataDir, source.heightDir);
        
        const [lod1Exists, heightExists] = await Promise.all([
          fs.access(lod1Path).then(() => true).catch(() => false),
          fs.access(heightPath).then(() => true).catch(() => false)
        ]);
        
        let fileSize = 0;
        if (lod1Exists) {
          try {
            const stat = await fs.stat(lod1Path);
            fileSize = stat.size;
          } catch {}
        }
        
        return {
          name: source.name,
          region: source.region,
          available: lod1Exists || heightExists,
          lod1Exists,
          heightExists,
          fileSize,
          priority: source.priority
        };
      })
    );
    
    const hasAnyData = regionChecks.some(r => r.available) || lod1MetaExists;
    
    return {
      available: hasAnyData,
      regions: regionChecks.sort((a, b) => a.priority - b.priority),
      metadata: {
        lod1Meta: lod1MetaExists,
        heightMeta: heightMetaExists
      }
    };
    
  } catch (error) {
    console.error('❌ 检查本地TUM数据失败:', error);
    return {
      available: false,
      regions: [],
      metadata: {
        lod1Meta: false,
        heightMeta: false
      }
    };
  }
}

/**
 * 加载本地TUM数据到内存
 */
export async function loadLocalTUMData(): Promise<{
  success: boolean;
  lod1Features: number;
  heightFeatures: number;
  loadTime: number;
}> {
  const startTime = Date.now();
  
  try {
    console.log('📥 开始加载本地TUM数据到内存...');
    
    const exampleLod1Path = path.join(LOCAL_DATA_CONFIG.dataDir, LOCAL_DATA_CONFIG.exampleLod1File);
    const lod1MetaPath = path.join(LOCAL_DATA_CONFIG.dataDir, LOCAL_DATA_CONFIG.lod1MetaFile);
    
    const loadPromises: Promise<any>[] = [];
    
    // 优先加载实际建筑数据（慕尼黑示例）
    try {
      await fs.access(exampleLod1Path);
      loadPromises.push(
        fs.readFile(exampleLod1Path, 'utf-8').then(data => {
          cachedLOD1Data = JSON.parse(data);
          console.log(`✅ 慕尼黑建筑数据加载成功: ${cachedLOD1Data.features?.length || 0} 个建筑物`);
          return cachedLOD1Data;
        })
      );
    } catch {
      console.log('⚠️ 慕尼黑示例数据不存在，尝试加载元数据...');
      
      // 如果示例数据不存在，尝试加载元数据
      try {
        await fs.access(lod1MetaPath);
        loadPromises.push(
          fs.readFile(lod1MetaPath, 'utf-8').then(data => {
            const metaData = JSON.parse(data);
            console.log(`⚠️ 仅加载了元数据: ${metaData.features?.length || 0} 个瓦片索引`);
            // 元数据不能直接用于建筑渲染，但可以用于查找数据瓦片
            return null;
          })
        );
      } catch {
        console.log('❌ 没有找到任何TUM数据文件');
        loadPromises.push(Promise.resolve(null));
      }
    }
    
    await Promise.all(loadPromises);
    
    dataLoadTime = Date.now();
    const loadTime = dataLoadTime - startTime;
    
    console.log(`🚀 本地TUM数据加载完成，耗时 ${loadTime}ms`);
    
    return {
      success: true,
      lod1Features: cachedLOD1Data?.features?.length || 0,
      heightFeatures: cachedHeightData?.features?.length || 0,
      loadTime
    };
    
  } catch (error) {
    console.error('❌ 加载本地TUM数据失败:', error);
    return {
      success: false,
      lod1Features: 0,
      heightFeatures: 0,
      loadTime: Date.now() - startTime
    };
  }
}

/**
 * 从本地数据查询建筑物
 */
export async function queryLocalTUMBuildings(
  bounds: BoundingBox,
  maxFeatures: number = 1000
): Promise<TUMBuildingResponse> {
  const startTime = Date.now();
  
  try {
    // 如果数据未加载，先加载
    if (!cachedLOD1Data && !cachedHeightData) {
      console.log('💾 数据未加载，开始加载本地TUM数据...');
      await loadLocalTUMData();
    }
    
    if (!cachedLOD1Data) {
      console.log('⚠️ 没有可用的本地TUM数据');
      return {
        type: 'FeatureCollection',
        features: [],
        totalFeatures: 0,
        numberMatched: 0,
        numberReturned: 0
      };
    }
    
    // 空间查询：过滤在边界框内的建筑物
    const filteredFeatures = cachedLOD1Data.features.filter((feature: any) => {
      if (!feature.geometry || !feature.geometry.coordinates) return false;
      
      // 简单的边界框检查（可以优化为更精确的空间查询）
      const coords = feature.geometry.coordinates[0]; // 假设是Polygon
      if (!coords || !Array.isArray(coords)) return false;
      
      // 检查是否有任何坐标点在边界框内
      return coords.some((coord: number[]) => {
        const [lng, lat] = coord;
        return lng >= bounds.west && lng <= bounds.east && 
               lat >= bounds.south && lat <= bounds.north;
      });
    });
    
    // 限制返回数量
    const limitedFeatures = filteredFeatures.slice(0, maxFeatures);
    
    // 转换为TUM格式
    const tumFeatures: TUMBuildingFeature[] = limitedFeatures.map((feature: any) => ({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        id: feature.properties?.id || `local_${Math.random().toString(36).substr(2, 9)}`,
        height: feature.properties?.height || feature.properties?.HEIGHT || 10, // 默认高度
        area: feature.properties?.area || feature.properties?.AREA,
        building_type: feature.properties?.building_type || 'building',
        source: 'TUM_Local',
        ...feature.properties
      }
    }));
    
    const queryTime = Date.now() - startTime;
    console.log(`🔍 本地TUM查询完成: ${tumFeatures.length}/${filteredFeatures.length} 建筑物, 耗时 ${queryTime}ms`);
    
    return {
      type: 'FeatureCollection',
      features: tumFeatures,
      totalFeatures: cachedLOD1Data.features.length,
      numberMatched: filteredFeatures.length,
      numberReturned: tumFeatures.length
    };
    
  } catch (error) {
    console.error('❌ 本地TUM数据查询失败:', error);
    return {
      type: 'FeatureCollection',
      features: [],
      totalFeatures: 0,
      numberMatched: 0,
      numberReturned: 0
    };
  }
}

/**
 * 获取本地数据统计信息
 */
export async function getLocalTUMStats(): Promise<{
  dataLoaded: boolean;
  loadTime: number;
  memoryUsage: {
    lod1: number;
    height: number;
    total: number;
  };
  featureCounts: {
    lod1: number;
    height: number;
  };
  dataAge: number; // 数据年龄（小时）
}> {
  const memoryUsage = {
    lod1: cachedLOD1Data ? JSON.stringify(cachedLOD1Data).length : 0,
    height: cachedHeightData ? JSON.stringify(cachedHeightData).length : 0,
    total: 0
  };
  memoryUsage.total = memoryUsage.lod1 + memoryUsage.height;
  
  const dataAge = dataLoadTime > 0 ? (Date.now() - dataLoadTime) / (1000 * 60 * 60) : 0;
  
  return {
    dataLoaded: !!(cachedLOD1Data || cachedHeightData),
    loadTime: dataLoadTime,
    memoryUsage,
    featureCounts: {
      lod1: cachedLOD1Data?.features?.length || 0,
      height: cachedHeightData?.features?.length || 0
    },
    dataAge
  };
}

/**
 * 清除内存缓存
 */
export function clearLocalTUMCache(): void {
  cachedLOD1Data = null;
  cachedHeightData = null;
  dataLoadTime = 0;
  console.log('🗑️ 本地TUM数据缓存已清除');
}

export default {
  checkLocalTUMData,
  loadLocalTUMData,
  queryLocalTUMBuildings,
  getLocalTUMStats,
  clearLocalTUMCache
};
