/**
 * 前端TUM建筑数据服务
 * 调用后端TUM API获取建筑数据
 */

const API_BASE = 'http://localhost:3500/api';

export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface TUMBuildingResponse {
  success: boolean;
  data: {
    type: 'FeatureCollection';
    features: any[];
    metadata: {
      source: string;
      bounds?: BoundingBox;
      totalFeatures: number;
      numberMatched: number;
      numberReturned: number;
      timestamp: string;
    };
  };
  metadata?: any;
}

import { buildingCache } from '../cache/buildingCache';

/**
 * 测试TUM连接
 */
export async function testTUMConnection(): Promise<boolean> {
  try {
    console.log('🔍 测试TUM连接...');
    
    const response = await fetch(`${API_BASE}/tum-buildings/test`);
    const result = await response.json();
    
    if (result.success) {
      console.log('✅ TUM连接测试成功');
      return true;
    } else {
      console.log('❌ TUM连接测试失败:', result.message);
      return false;
    }
  } catch (error) {
    console.error('❌ TUM连接测试失败:', error);
    return false;
  }
}

/**
 * 获取指定区域的TUM建筑数据
 */
export async function getTUMBuildings(bounds: BoundingBox, maxFeatures?: number): Promise<TUMBuildingResponse> {
  try {
    console.log(`🏢 获取TUM建筑数据: ${JSON.stringify(bounds)}`);
    
    const response = await fetch(`${API_BASE}/tum-buildings/bounds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        north: bounds.north,
        south: bounds.south,
        east: bounds.east,
        west: bounds.west,
        maxFeatures: maxFeatures || 5000  // 调整为5000，减少分页次数
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ TUM建筑数据获取成功: ${result.data.features.length} 个建筑物`);
      // Add the new data to the cache
      buildingCache.add(result.data);
      // Return the entire cache content
      const allData = buildingCache.getAllAsFeatureCollection();
      result.data = {
        ...result.data,
        features: allData.features,
        totalFeatures: allData.features.length,
        numberReturned: allData.features.length,
      };
      return result;
    } else {
      throw new Error(result.message || '获取TUM建筑数据失败');
    }

  } catch (error) {
    console.error('❌ 获取TUM建筑数据失败:', error);
    throw error;
  }
}

/**
 * 获取北京区域的TUM建筑数据
 */
export async function getBeijingTUMBuildings(): Promise<TUMBuildingResponse> {
  try {
    console.log('🏙️ 获取北京区域TUM建筑数据...');
    
    const response = await fetch(`${API_BASE}/tum-buildings/beijing`);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ 北京TUM建筑数据获取成功: ${result.data.features.length} 个建筑物`);
      return result;
    } else {
      throw new Error(result.message || '获取北京TUM建筑数据失败');
    }

  } catch (error) {
    console.error('❌ 获取北京TUM建筑数据失败:', error);
    throw error;
  }
}

/**
 * 获取指定瓦片的TUM建筑数据
 */
export async function getTUMBuildingsByTile(z: number, x: number, y: number, maxFeatures?: number): Promise<TUMBuildingResponse> {
  try {
    console.log(`🗺️ 获取瓦片TUM建筑数据: z=${z} x=${x} y=${y}`);
    
    const response = await fetch(`${API_BASE}/tum-buildings/tile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        z: z,
        x: x,
        y: y,
        maxFeatures: maxFeatures || 5000  // 调整为5000，减少分页次数
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.success) {
      console.log(`✅ 瓦片TUM建筑数据获取成功: ${result.data.features.length} 个建筑物`);
      return result;
    } else {
      throw new Error(result.message || '获取瓦片TUM建筑数据失败');
    }

  } catch (error) {
    console.error('❌ 获取瓦片TUM建筑数据失败:', error);
    throw error;
  }
}

/**
 * 比较TUM和OSM建筑数据覆盖情况
 */
export async function compareBuildingCoverage(bounds: BoundingBox): Promise<{
  tum: { count: number; success: boolean; error?: string };
  osm: { count: number; success: boolean; error?: string };
}> {
  console.log('🔍 比较TUM和OSM建筑数据覆盖情况...');
  
  const result = {
    tum: { count: 0, success: false, error: undefined as string | undefined },
    osm: { count: 0, success: false, error: undefined as string | undefined }
  };

  // 测试TUM数据
  try {
    const tumResponse = await getTUMBuildings(bounds, 1000);
    result.tum.count = tumResponse.data.features.length;
    result.tum.success = true;
    console.log(`✅ TUM: ${result.tum.count} 个建筑物`);
  } catch (error) {
    result.tum.error = error instanceof Error ? error.message : 'Unknown error';
    console.log(`❌ TUM: ${result.tum.error}`);
  }

  // 测试OSM数据（通过现有API）
  try {
    const osmResponse = await fetch(`${API_BASE}/buildings/${Math.floor(bounds.north * 1000)}/${Math.floor(bounds.west * 1000)}.json`);
    if (osmResponse.ok) {
      const osmData = await osmResponse.json();
      result.osm.count = osmData.features?.length || 0;
      result.osm.success = true;
      console.log(`✅ OSM: ${result.osm.count} 个建筑物`);
    } else {
      result.osm.error = `HTTP ${osmResponse.status}`;
      console.log(`❌ OSM: ${result.osm.error}`);
    }
  } catch (error) {
    result.osm.error = error instanceof Error ? error.message : 'Unknown error';
    console.log(`❌ OSM: ${result.osm.error}`);
  }

  return result;
}

// 命名导出
export const tumBuildingService = {
  testTUMConnection,
  getTUMBuildings,
  getBeijingTUMBuildings,
  getTUMBuildingsByTile,
  compareBuildingCoverage
};

// 默认导出
export default {
  testTUMConnection,
  getTUMBuildings,
  getBeijingTUMBuildings,
  getTUMBuildingsByTile,
  compareBuildingCoverage
};
