/**
 * TUM GlobalBuildingAtlas 建筑数据服务
 * 通过WFS服务获取全球建筑数据，作为OSM的替代方案
 */

import axios from 'axios';

// 本地GeoServer WFS服务配置（替换TUM服务）
const TUM_WFS_CONFIG = {
  baseUrl: 'http://10.13.12.164:8080/geoserver/shadowmap/wfs',
  typeName: 'shadowmap:buildings', // 本地建筑图层
  version: '1.1.0', // GeoServer推荐使用1.1.0
  outputFormat: 'application/json',
  srsName: 'EPSG:4326',
  maxFeatures: 50000, // 单次请求最大特征数（本地服务器可以处理更多）
  timeout: 30000, // 30秒超时
  ipv4Address: '10.13.12.164' // 工作站IP地址
};

// 建筑数据接口
export interface TUMBuildingFeature {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
  properties: {
    id: string;
    height?: number;
    area?: number;
    building_type?: string;
    source?: string;
    [key: string]: any;
  };
}

export interface TUMBuildingResponse {
  type: 'FeatureCollection';
  features: TUMBuildingFeature[];
  totalFeatures: number;
  numberMatched: number;
  numberReturned: number;
}

// 边界框接口
export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * 构建TUM WFS请求URL
 */
function buildTUMRequestUrl(bounds: BoundingBox, maxFeatures: number = TUM_WFS_CONFIG.maxFeatures): string {
  const params = new URLSearchParams({
    service: 'WFS',
    version: TUM_WFS_CONFIG.version,
    request: 'GetFeature',
    typeName: TUM_WFS_CONFIG.typeName,
    outputFormat: TUM_WFS_CONFIG.outputFormat,
    srsName: TUM_WFS_CONFIG.srsName,
    maxFeatures: maxFeatures.toString(),
    bbox: `${bounds.west},${bounds.south},${bounds.east},${bounds.north},${TUM_WFS_CONFIG.srsName}`
  });

  return `${TUM_WFS_CONFIG.baseUrl}?${params.toString()}`;
}

/**
 * 构建本地GeoServer WFS请求配置
 */
function buildTUMRequestConfig(url: string) {
  return {
    url: url,
    method: 'GET' as const,
    timeout: TUM_WFS_CONFIG.timeout,
    headers: {
      'User-Agent': 'ShadowMap/1.0',
      'Accept': 'application/json'
    }
  };
}

/**
 * 从TUM WFS获取建筑数据
 */
export async function fetchTUMBuildings(bounds: BoundingBox, maxFeatures?: number): Promise<TUMBuildingResponse> {
  try {
    console.log(`🏢 从TUM WFS获取建筑数据: ${JSON.stringify(bounds)}`);
    
    const url = buildTUMRequestUrl(bounds, maxFeatures);
    console.log(`📡 TUM WFS请求URL: ${url}`);

    const config = buildTUMRequestConfig(url);
    const response = await axios(config);

    if (response.status === 200) {
      const data = response.data;
      console.log(`✅ TUM数据获取成功: ${data.features?.length || 0} 个建筑物`);
      console.log(`📊 总特征数: ${data.totalFeatures || 0}, 匹配: ${data.numberMatched || 0}, 返回: ${data.numberReturned || 0}`);
      
      return data;
    } else {
      throw new Error(`TUM WFS请求失败: ${response.status} ${response.statusText}`);
    }

  } catch (error) {
    console.error('❌ TUM建筑数据获取失败:', error);
    
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error(`   状态码: ${error.response.status}`);
        console.error(`   响应数据: ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        console.error(`   网络请求失败: ${error.message}`);
      } else {
        console.error(`   请求配置错误: ${error.message}`);
      }
    }
    
    throw error;
  }
}

/**
 * 将TUM建筑数据转换为标准GeoJSON格式
 */
export function convertTUMToStandardGeoJSON(tumData: TUMBuildingResponse): any {
  console.log(`🔄 转换TUM数据为标准GeoJSON格式...`);
  
  const standardFeatures = tumData.features.map((feature, index) => {
    // 计算建筑高度（如果TUM数据中没有，使用默认值）
    let height = 10; // 默认高度
    if (feature.properties.height && feature.properties.height > 0) {
      height = feature.properties.height;
    } else if (feature.properties.area) {
      // 根据面积估算高度
      height = Math.min(Math.max(Math.sqrt(feature.properties.area) * 0.1, 5), 50);
    }

    return {
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        id: feature.properties.id || `tum_building_${index}`,
        height: height,
        area: feature.properties.area || 0,
        buildingType: feature.properties.building_type || 'building',
        source: 'TUM',
        levels: Math.round(height / 3),
        // 保留原始TUM属性
        tumProperties: feature.properties
      }
    };
  });

  const result = {
    type: 'FeatureCollection',
    features: standardFeatures,
    metadata: {
      source: 'TUM GlobalBuildingAtlas',
      totalFeatures: tumData.totalFeatures,
      numberMatched: tumData.numberMatched,
      numberReturned: tumData.numberReturned,
      convertedAt: new Date().toISOString()
    }
  };

  console.log(`✅ 转换完成: ${result.features.length} 个建筑物`);
  return result;
}

/**
 * 分页获取大范围TUM建筑数据
 */
export async function fetchTUMBuildingsPaginated(
  bounds: BoundingBox, 
  maxFeaturesPerRequest: number = 5000  // 调整为5000，减少分页次数
): Promise<any> {
  console.log(`🔄 分页获取TUM建筑数据: ${JSON.stringify(bounds)}`);
  
  let allFeatures: any[] = [];
  let startIndex = 0;
  let hasMore = true;
  let totalFeatures = 0;

  while (hasMore) {
    try {
      console.log(`📄 获取第 ${Math.floor(startIndex / maxFeaturesPerRequest) + 1} 页 (startIndex: ${startIndex})`);
      
      // 构建分页请求URL
      const params = new URLSearchParams({
        service: 'WFS',
        version: TUM_WFS_CONFIG.version,
        request: 'GetFeature',
        typeName: TUM_WFS_CONFIG.typeName,
        outputFormat: TUM_WFS_CONFIG.outputFormat,
        srsName: TUM_WFS_CONFIG.srsName,
        maxFeatures: maxFeaturesPerRequest.toString(), // 使用传入的参数
        startIndex: startIndex.toString(),
        bbox: `${bounds.west},${bounds.south},${bounds.east},${bounds.north},${TUM_WFS_CONFIG.srsName}`
      });

      const url = `${TUM_WFS_CONFIG.baseUrl}?${params.toString()}`;
      
      const response = await axios.get(url, {
        timeout: TUM_WFS_CONFIG.timeout,
        headers: {
          'User-Agent': 'ShadowMap/1.0',
          'Accept': 'application/json'
        }
      });

      if (response.status === 200) {
        const data = response.data;
        const features = data.features || [];
        
        console.log(`  ✅ 获取到 ${features.length} 个建筑物`);
        
        allFeatures = allFeatures.concat(features);
        totalFeatures = data.totalFeatures || 0;
        
        // 检查是否还有更多数据
        if (features.length < maxFeaturesPerRequest) { // 使用传入的参数
          hasMore = false;
        }

        // 安全阀：如果获取到的建筑数量超过一个非常大的阈值，则停止
        if (allFeatures.length > 100000) {
          console.warn(`⚠️ 获取到的建筑物数量超过限制（${allFeatures.length}），停止获取`);
          hasMore = false;
        }
        
        startIndex += maxFeaturesPerRequest;
        
        // 请求间延迟，避免过于频繁
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      } else {
        console.error(`❌ 分页请求失败: ${response.status}`);
        hasMore = false;
      }

    } catch (error) {
      console.error(`❌ 分页获取失败:`, error);
      hasMore = false;
    }
  }

  console.log(`📊 分页获取完成: 总计 ${allFeatures.length} 个建筑物`);
  
  return {
    type: 'FeatureCollection',
    features: allFeatures,
    totalFeatures: totalFeatures,
    numberMatched: totalFeatures,
    numberReturned: allFeatures.length
  };
}

/**
 * 测试TUM WFS连接
 */
export async function testTUMConnection(): Promise<boolean> {
  try {
    console.log('🔍 测试TUM WFS连接...');
    
    // 使用慕尼黑市中心作为测试区域（与本地数据匹配）
    const testBounds: BoundingBox = {
      north: 48.15,
      south: 48.13,
      east: 11.59,
      west: 11.57
    };
    
    const data = await fetchTUMBuildings(testBounds, 10);
    
    if (data.features && data.features.length > 0) {
      console.log('✅ TUM WFS连接测试成功');
      console.log(`   测试区域建筑数量: ${data.features.length}`);
      return true;
    } else {
      console.log('⚠️ TUM WFS连接成功，但测试区域无建筑数据');
      return true;
    }
    
  } catch (error) {
    console.error('❌ TUM WFS连接测试失败:', error);
    return false;
  }
}

export default {
  fetchTUMBuildings,
  convertTUMToStandardGeoJSON,
  fetchTUMBuildingsPaginated,
  testTUMConnection
};
