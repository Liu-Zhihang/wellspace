import { Building, IBuilding } from '../models/Building';
import { config } from '../config';
import { redisCacheService } from './redisCacheService';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { smartBuildingQuery, getLocationOptimizedParams, selectOptimalEndpoints } from './enhancedBuildingService';
import { endpointHealthMonitor } from './endpointHealthMonitor';

// 瓦片信息接口
export interface TileInfo {
  z: number;
  x: number;
  y: number;
}

// 建筑物瓦片数据接口
export interface BuildingTileData {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: {
      type: 'Polygon';
      coordinates: number[][][];
    };
    properties: {
      id: string;
      buildingType: string;
      height: number;
      levels?: number;
    };
  }>;
  bbox: [number, number, number, number];
  tileInfo: TileInfo;
  cached: boolean;
  fromDatabase: boolean;
}

/**
 * MongoDB建筑物服务类
 */
export class BuildingServiceMongoDB {
  private static instance: BuildingServiceMongoDB;
  private readonly overpassUrl: string;
  private readonly cacheDir: string;

  private constructor() {
    this.overpassUrl = config.api.overpassUrl;
    this.cacheDir = config.data.buildingsPath;
  }

  public static getInstance(): BuildingServiceMongoDB {
    if (!BuildingServiceMongoDB.instance) {
      BuildingServiceMongoDB.instance = new BuildingServiceMongoDB();
    }
    return BuildingServiceMongoDB.instance;
  }

  /**
   * 获取建筑物瓦片数据（Redis → MongoDB → OSM API 三级缓存）
   */
  public async getBuildingTile(z: number, x: number, y: number): Promise<BuildingTileData> {
    const tileInfo: TileInfo = { z, x, y };
    const startTime = Date.now();
    
    try {
      // 1. 首先尝试从Redis缓存获取（最快）
      const redisData = await redisCacheService.getBuildingTile(z, x, y);
      if (redisData && redisData.features && redisData.features.length > 0) {
        console.log(`⚡ Redis cache hit: ${z}/${x}/${y} (${redisData.features.length} buildings) - ${Date.now() - startTime}ms`);
        return redisData;
      }

      // 2. 然后尝试从MongoDB获取
      const mongoData = await this.getBuildingsFromDatabase(z, x, y);
      if (mongoData && mongoData.features.length > 0) {
        console.log(`📊 MongoDB hit: ${z}/${x}/${y} (${mongoData.features.length} buildings) - ${Date.now() - startTime}ms`);
        
        // 异步缓存到Redis，不等待结果
        redisCacheService.setBuildingTile(z, x, y, mongoData, 1800); // 30分钟TTL
        
        return mongoData;
      }

      // 3. 最后从OSM API获取
      console.log(`🌐 Fetching from OSM API: ${z}/${x}/${y}`);
      const osmData = await this.fetchFromOSMApi(z, x, y);
      
      // 4. 将获取的数据保存到MongoDB和Redis
      if (osmData.features.length > 0) {
        // 并行保存到MongoDB和Redis
        const savePromises = [
          this.saveBuildingsToDatabase(osmData.features, tileInfo),
          redisCacheService.setBuildingTile(z, x, y, osmData, 3600) // 1小时TTL
        ];
        
        await Promise.allSettled(savePromises);
        console.log(`💾 Saved ${osmData.features.length} buildings to MongoDB+Redis - ${Date.now() - startTime}ms`);
      } else {
        // 即使是空结果也缓存一小段时间，避免重复API调用
        await redisCacheService.setBuildingTile(z, x, y, osmData, 300); // 5分钟TTL
      }

      return osmData;

    } catch (error) {
      console.error(`❌ Failed to get building data ${z}/${x}/${y}:`, error);
      
      // 返回空的瓦片数据
      return this.createEmptyTileData(tileInfo);
    }
  }

  /**
   * 保存建筑物瓦片数据到数据库
   */
  public async saveBuildingTile(z: number, x: number, y: number, data: any): Promise<void> {
    const tileInfo: TileInfo = { z, x, y };
    await this.saveBuildingsToDatabase(data.features, tileInfo);
  }

  /**
   * 从MongoDB获取建筑物数据
   */
  private async getBuildingsFromDatabase(z: number, x: number, y: number): Promise<BuildingTileData | null> {
    try {
      const buildings = await Building.find({
        'tile.z': z,
        'tile.x': x,
        'tile.y': y
      }).lean();

      if (buildings.length === 0) {
        return null;
      }

      // 转换为GeoJSON格式
      const features = buildings.map(building => ({
        type: 'Feature' as const,
        geometry: building.geometry,
        properties: {
          id: building.properties.id,
          buildingType: building.properties.buildingType,
          height: building.properties.height,
          levels: building.properties.levels
        }
      }));

      // 计算边界框
      const bbox = this.calculateBoundingBox(buildings);

      return {
        type: 'FeatureCollection',
        features,
        bbox,
        tileInfo: { z, x, y },
        cached: true,
        fromDatabase: true
      };

    } catch (error) {
      console.error('❌ 从MongoDB获取建筑物数据失败:', error);
      return null;
    }
  }

  /**
   * 将建筑物数据保存到MongoDB
   */
  private async saveBuildingsToDatabase(features: any[], tileInfo: TileInfo): Promise<void> {
    try {
      const buildings = features.map(feature => {
        const height = this.estimateHeight(feature.properties);
        const bbox = this.calculateFeatureBoundingBox(feature.geometry);
        
        return {
          geometry: feature.geometry,
          properties: {
            id: feature.properties.id || `${tileInfo.z}_${tileInfo.x}_${tileInfo.y}_${Math.random().toString(36).substr(2, 9)}`,
            buildingType: feature.properties.buildingType || 'building',
            height: height,
            levels: feature.properties.levels,
            osm_id: feature.properties.osm_id
          },
          tile: tileInfo,
          bbox: bbox,
          last_updated: new Date(),
          created_at: new Date()
        };
      });

      // 使用批量插入，忽略重复项
      await Building.insertMany(buildings, { 
        ordered: false,
        lean: true 
      }).catch(error => {
        // 忽略重复键错误
        if (error.code !== 11000) {
          throw error;
        }
      });

    } catch (error) {
      console.error('❌ 保存建筑物数据到MongoDB失败:', error);
      throw error;
    }
  }

  /**
   * 从OSM API获取建筑物数据（增强版本 - 智能分级查询和地域优化）
   */
  private async fetchFromOSMApi(z: number, x: number, y: number): Promise<BuildingTileData> {
    // 限制最小缩放级别，避免请求过大区域
    if (z < 15) {
      console.log(`⚠️ 缩放级别 ${z} 太低，不请求OSM数据（建议15+级别）`);
      return this.createEmptyTileData({ z, x, y });
    }

    try {
      const bbox = this.tileToBoundingBox(x, y, z);
      const centerLat = (bbox.north + bbox.south) / 2;
      const centerLng = (bbox.east + bbox.west) / 2;
      
      console.log(`🏗️ 启动智能建筑物查询: ${z}/${x}/${y} (${centerLat.toFixed(4)}, ${centerLng.toFixed(4)})`);
      
      // 🔧 使用增强的智能查询系统
      const result = await smartBuildingQuery(bbox, centerLat, centerLng);
      
      if (result.success) {
        console.log(`✅ 智能查询成功: ${result.buildings.length} 个建筑物 (${result.strategy}策略, ${result.totalRetries}次重试, ${result.processingTime}ms)`);
        
        return {
          type: 'FeatureCollection',
          features: result.buildings,
          bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
          tileInfo: { z, x, y },
          cached: false,
          fromDatabase: false
        };
      } else {
        console.warn(`⚠️ 智能查询失败: ${z}/${x}/${y} (${result.totalRetries}次重试, ${result.processingTime}ms)`);
        
        // 📊 记录失败统计，用于后续优化
        this.recordQueryFailure(z, x, y, centerLat, centerLng, result);
        
        return this.createEmptyTileData({ z, x, y });
      }

    } catch (error) {
      console.error(`❌ OSM智能查询系统错误:`, error);
      return this.createEmptyTileData({ z, x, y });
    }
  }

  /**
   * 记录查询失败统计
   */
  private recordQueryFailure(
    z: number, x: number, y: number, 
    lat: number, lng: number, 
    result: any
  ): void {
    // 这里可以实现失败统计记录，用于优化查询策略
    console.log(`📊 记录查询失败: ${z}/${x}/${y} (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
    console.log(`   总重试次数: ${result.totalRetries}`);
    console.log(`   处理时间: ${result.processingTime}ms`);
    console.log(`   💡 建议: 考虑预处理该区域的建筑物数据`);
  }

  /**
   * 批量预加载建筑物数据
   */
  public async preloadBuildingData(tiles: TileInfo[]): Promise<{
    success: number;
    failed: number;
    details: Array<{ tile: TileInfo; status: 'success' | 'failed'; error?: string }>;
  }> {
    const results = {
      success: 0,
      failed: 0,
      details: [] as Array<{ tile: TileInfo; status: 'success' | 'failed'; error?: string }>
    };

    for (const tile of tiles) {
      try {
        const data = await this.getBuildingTile(tile.z, tile.x, tile.y);
        results.success++;
        results.details.push({
          tile,
          status: 'success'
        });
        
        // 添加延迟以避免API限制
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        results.failed++;
        results.details.push({
          tile,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return results;
  }

  /**
   * 清理过期的建筑物数据
   */
  public async cleanupExpiredData(maxAge: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const cutoffDate = new Date(Date.now() - maxAge);
      const result = await Building.deleteMany({
        last_updated: { $lt: cutoffDate }
      });

      console.log(`🧹 清理了 ${result.deletedCount} 个过期的建筑物记录`);
      return result.deletedCount || 0;

    } catch (error) {
      console.error('❌ 清理过期数据失败:', error);
      throw error;
    }
  }

  /**
   * 获取数据库统计信息
   */
  public async getStatistics(): Promise<{
    totalBuildings: number;
    totalTiles: number;
    dataSize: number;
    oldestRecord: Date | null;
    newestRecord: Date | null;
    buildingTypeDistribution: Array<{ type: string; count: number }>;
  }> {
    try {
      const [
        totalBuildings,
        tileCount,
        oldestRecord,
        newestRecord,
        typeDistribution
      ] = await Promise.all([
        Building.countDocuments(),
        Building.distinct('tile').then(tiles => tiles.length),
        Building.findOne({}, {}, { sort: { created_at: 1 } }),
        Building.findOne({}, {}, { sort: { created_at: -1 } }),
        Building.aggregate([
          { $group: { _id: '$properties.buildingType', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 }
        ])
      ]);

      // 估算数据大小（粗略计算）
      const avgDocumentSize = 2000; // 估算每个文档2KB
      const dataSize = totalBuildings * avgDocumentSize;

      return {
        totalBuildings,
        totalTiles: tileCount,
        dataSize,
        oldestRecord: oldestRecord?.created_at || null,
        newestRecord: newestRecord?.created_at || null,
        buildingTypeDistribution: typeDistribution.map((item: any) => ({
          type: item._id,
          count: item.count
        }))
      };

    } catch (error) {
      console.error('❌ 获取统计信息失败:', error);
      throw error;
    }
  }

  // === 私有辅助方法 ===

  private tileToBoundingBox(x: number, y: number, z: number) {
    const n = Math.pow(2, z);
    
    // 验证瓦片坐标有效性
    if (x < 0 || x >= n || y < 0 || y >= n) {
      console.error(`❌ 无效瓦片坐标: ${z}/${x}/${y} (最大: ${n-1}/${n-1})`);
      throw new Error(`Invalid tile coordinates: ${z}/${x}/${y}`);
    }
    
    // Web Mercator 投影的标准坐标转换
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    
    // 纬度计算使用标准Web Mercator公式
    const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
    const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
    
    // 验证边界框合理性
    if (Math.abs(west) > 180 || Math.abs(east) > 180 || 
        Math.abs(north) > 85.0511 || Math.abs(south) > 85.0511) {
      console.error(`❌ 计算的边界框超出有效范围: [${west}, ${south}, ${east}, ${north}]`);
      throw new Error(`Invalid bounding box calculated for tile ${z}/${x}/${y}`);
    }
    
    console.log(`🗺️ 瓦片 ${z}/${x}/${y} -> 边界框: [${west.toFixed(6)}, ${south.toFixed(6)}, ${east.toFixed(6)}, ${north.toFixed(6)}]`);
    
    return { west, south, east, north };
  }

  /**
   * 检查端点健康状态
   */
  private async checkEndpointHealth(endpoint: string): Promise<{ healthy: boolean; responseTime: number }> {
    const startTime = Date.now();
    
    try {
      // 简单的健康检查查询
      const healthQuery = '[out:json][timeout:5]; way["building"="yes"](bbox:39.9,116.4,39.901,116.401); out count;';
      
      const response = await axios.post(endpoint, healthQuery, {
        headers: { 'Content-Type': 'text/plain', 'User-Agent': 'ShadowMap-HealthCheck/1.0' },
        timeout: 5000,
        validateStatus: (status) => status === 200
      });
      
      const responseTime = Date.now() - startTime;
      
      if (response.data && typeof response.data === 'object') {
        console.log(`✅ 端点健康: ${endpoint} (${responseTime}ms)`);
        return { healthy: true, responseTime };
      } else {
        console.warn(`⚠️ 端点响应异常: ${endpoint}`);
        return { healthy: false, responseTime };
      }
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      console.warn(`❌ 端点不健康: ${endpoint} (${responseTime}ms)`);
      return { healthy: false, responseTime };
    }
  }

  private convertOSMToGeoJSON(osmData: any): any[] {
    const features: any[] = [];
    
    if (!osmData.elements) return features;

    osmData.elements.forEach((element: any) => {
      if (element.type === 'way' && element.geometry) {
        const coordinates = element.geometry.map((node: any) => [node.lon, node.lat]);
        
        if (coordinates.length < 3) return;
        
        // 确保多边形闭合
        if (coordinates[0][0] !== coordinates[coordinates.length - 1][0] || 
            coordinates[0][1] !== coordinates[coordinates.length - 1][1]) {
          coordinates.push(coordinates[0]);
        }

        features.push({
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [coordinates]
          },
          properties: {
            id: `way_${element.id}`,
            buildingType: element.tags?.building || 'building',
            height: parseFloat(element.tags?.height) || undefined,
            levels: parseInt(element.tags?.['building:levels']) || undefined,
            osm_id: element.id
          }
        });
      }
    });

    return features;
  }

  private estimateHeight(properties: any): number {
    // 如果有明确的高度信息
    if (properties.height && !isNaN(properties.height)) {
      return Math.max(3, Math.min(300, properties.height));
    }
    
    // 根据楼层数估算
    if (properties.levels && !isNaN(properties.levels)) {
      return Math.max(3, Math.min(300, properties.levels * 3.5));
    }
    
    // 根据建筑类型估算
    const buildingType = properties.buildingType || 'building';
    const heightMap: { [key: string]: number } = {
      'house': 6,
      'residential': 12,
      'apartments': 20,
      'commercial': 15,
      'retail': 8,
      'office': 25,
      'industrial': 10,
      'warehouse': 8,
      'hospital': 15,
      'school': 10,
      'church': 12,
      'tower': 50,
      'skyscraper': 100
    };
    
    return heightMap[buildingType] || 8;
  }

  private calculateBoundingBox(buildings: any[]): [number, number, number, number] {
    if (buildings.length === 0) {
      return [0, 0, 0, 0];
    }

    let minLng = Infinity, minLat = Infinity;
    let maxLng = -Infinity, maxLat = -Infinity;

    buildings.forEach(building => {
      const bbox = building.bbox;
      minLng = Math.min(minLng, bbox[0]);
      minLat = Math.min(minLat, bbox[1]);
      maxLng = Math.max(maxLng, bbox[2]);
      maxLat = Math.max(maxLat, bbox[3]);
    });

    return [minLng, minLat, maxLng, maxLat];
  }

  private calculateFeatureBoundingBox(geometry: any): [number, number, number, number] {
    let minLng = Infinity, minLat = Infinity;
    let maxLng = -Infinity, maxLat = -Infinity;

    const coordinates = geometry.coordinates[0];
    coordinates.forEach((coord: number[]) => {
      minLng = Math.min(minLng, coord[0]);
      maxLng = Math.max(maxLng, coord[0]);
      minLat = Math.min(minLat, coord[1]);
      maxLat = Math.max(maxLat, coord[1]);
    });

    return [minLng, minLat, maxLng, maxLat];
  }

  private createEmptyTileData(tileInfo: TileInfo): BuildingTileData {
    return {
      type: 'FeatureCollection',
      features: [],
      bbox: [0, 0, 0, 0],
      tileInfo,
      cached: false,
      fromDatabase: false
    };
  }

  /**
   * 数组随机化 - 实现负载均衡
   */
  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * 计算动态超时时间
   */
  private calculateTimeout(attemptIndex: number, retryIndex: number, zoom: number): number {
    // 基础超时时间
    let baseTimeout = 10000; // 10秒
    
    // 根据缩放级别调整 - 高缩放级别数据更多，需要更长时间
    if (zoom >= 17) {
      baseTimeout = 15000;
    } else if (zoom >= 16) {
      baseTimeout = 12000;
    }
    
    // 根据尝试次数增加超时时间
    const attemptMultiplier = 1 + (attemptIndex * 0.2);
    const retryMultiplier = 1 + (retryIndex * 0.5);
    
    return Math.min(baseTimeout * attemptMultiplier * retryMultiplier, 30000); // 最大30秒
  }

  /**
   * 计算退避延迟
   */
  private calculateBackoffDelay(retryIndex: number, baseDelay: number): number {
    // 指数退避 + 随机抖动
    const exponentialDelay = baseDelay * Math.pow(2, retryIndex);
    const jitter = Math.random() * 0.1 * exponentialDelay; // 10%随机抖动
    
    return Math.min(exponentialDelay + jitter, 10000); // 最大10秒
  }
}

// 导出单例实例
export const buildingServiceMongoDB = BuildingServiceMongoDB.getInstance();

