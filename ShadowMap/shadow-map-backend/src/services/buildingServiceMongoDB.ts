import { Building, IBuilding } from '../models/Building';
import { config } from '../config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

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
   * 获取建筑物瓦片数据（优先从MongoDB，fallback到OSM API）
   */
  public async getBuildingTile(z: number, x: number, y: number): Promise<BuildingTileData> {
    const tileInfo: TileInfo = { z, x, y };
    
    try {
      // 1. 首先尝试从MongoDB获取
      const cachedData = await this.getBuildingsFromDatabase(z, x, y);
      if (cachedData && cachedData.features.length > 0) {
        console.log(`📊 从MongoDB获取建筑物数据: ${z}/${x}/${y} (${cachedData.features.length} buildings)`);
        return cachedData;
      }

      // 2. 如果MongoDB中没有数据，从OSM API获取
      console.log(`🌐 从OSM API获取建筑物数据: ${z}/${x}/${y}`);
      const osmData = await this.fetchFromOSMApi(z, x, y);
      
      // 3. 将获取的数据保存到MongoDB
      if (osmData.features.length > 0) {
        await this.saveBuildingsToDatabase(osmData.features, tileInfo);
        console.log(`💾 已保存 ${osmData.features.length} 个建筑物到MongoDB`);
      }

      return osmData;

    } catch (error) {
      console.error(`❌ 获取建筑物数据失败 ${z}/${x}/${y}:`, error);
      
      // 返回空的瓦片数据
      return this.createEmptyTileData(tileInfo);
    }
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
   * 从OSM API获取建筑物数据
   */
  private async fetchFromOSMApi(z: number, x: number, y: number): Promise<BuildingTileData> {
    const bbox = this.tileToBoundingBox(x, y, z);
    const overpassQuery = this.buildOverpassQuery(bbox);

    try {
      const response = await axios.post(this.overpassUrl, overpassQuery, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 30000
      });

      const osmData = response.data;
      const features = this.convertOSMToGeoJSON(osmData);

      return {
        type: 'FeatureCollection',
        features,
        bbox: [bbox.west, bbox.south, bbox.east, bbox.north],
        tileInfo: { z, x, y },
        cached: false,
        fromDatabase: false
      };

    } catch (error) {
      console.error('❌ OSM API请求失败:', error);
      throw error;
    }
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
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
    const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
    
    return { west, south, east, north };
  }

  private buildOverpassQuery(bbox: { west: number; south: number; east: number; north: number }): string {
    return `
      [out:json][timeout:25];
      (
        way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        relation["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      );
      out geom;
    `;
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
}

// 导出单例实例
export const buildingServiceMongoDB = BuildingServiceMongoDB.getInstance();

