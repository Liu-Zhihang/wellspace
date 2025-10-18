/**
 * 本地数据优先的建筑物服务
 * 实现类似参考网站的简洁控制台效果
 * 优先使用本地预处理数据，减少网络请求
 */

import type { BoundingBox, BuildingFeature, BuildingFeatureCollection } from '../types/index.ts';

interface BuildingTile {
  z: number;
  x: number;
  y: number;
}

type BuildingDataSource = 'local-preload' | 'cache' | 'mongodb' | 'osm-api';

interface BuildingData {
  features: BuildingFeature[];
  timestamp: number;
  source: BuildingDataSource;
  processingTime: number;
}

interface LocalDataConfig {
  enableLocalFirst: boolean;     // 是否启用本地优先
  enableNetworkFallback: boolean; // 是否启用网络回退
  localDataPath: string;         // 本地数据路径
  maxLocalAge: number;          // 本地数据最大年龄(小时)
}

export class LocalFirstBuildingService {
  private config: LocalDataConfig = {
    enableLocalFirst: true,
    enableNetworkFallback: true,
    localDataPath: '/data/buildings/',
    maxLocalAge: 24 * 7 // 7天
  };

  private localCache = new Map<string, BuildingData>();
  private pendingRequests = new Map<string, Promise<BuildingData>>();

  constructor(config?: Partial<LocalDataConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    
    // 初始化时加载本地数据索引
    this.loadLocalDataIndex();
  }

  /**
   * 获取建筑物数据 - 本地优先策略
   */
  async getBuildingData(bounds: BoundingBox, zoom: number): Promise<BuildingData> {
    const tiles = this.boundsToTiles(bounds, zoom);
    const cacheKey = this.generateCacheKey(bounds, zoom);
    
    // 1. 检查内存缓存
    if (this.localCache.has(cacheKey)) {
      const cached = this.localCache.get(cacheKey)!;
      if (this.isDataFresh(cached.timestamp)) {
        console.log(`🎯 内存缓存命中: ${cacheKey} (${cached.features.length} 建筑物)`);
        return cached;
      }
    }

    // 2. 检查进行中的请求
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ 等待进行中的请求: ${cacheKey}`);
      return await this.pendingRequests.get(cacheKey)!;
    }

    // 3. 创建新请求
    const requestPromise = this.fetchBuildingDataWithFallback(tiles, cacheKey);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      this.localCache.set(cacheKey, result);
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  /**
   * 带回退策略的数据获取
   */
  private async fetchBuildingDataWithFallback(
    tiles: BuildingTile[], 
    cacheKey: string
  ): Promise<BuildingData> {
    const startTime = Date.now();

    // 1. 优先尝试本地预处理数据
    if (this.config.enableLocalFirst) {
      try {
        const localFeatures = await this.fetchLocalPreloadedData(tiles);
        if (localFeatures && localFeatures.length > 0) {
          const processingTime = Date.now() - startTime;
          console.log(`✅ 本地预处理数据: ${cacheKey} (${localFeatures.length} 建筑物, ${processingTime}ms)`);

          return {
            features: localFeatures,
            timestamp: Date.now(),
            source: 'local-preload',
            processingTime
          };
        }
      } catch (error) {
        console.warn(`⚠️ 本地数据获取失败: ${cacheKey}`, error);
      }
    }

    // 2. 回退到后端缓存
    if (this.config.enableNetworkFallback) {
      try {
        const backendFeatures = await this.fetchFromBackend(tiles);
        if (backendFeatures && backendFeatures.length > 0) {
          const processingTime = Date.now() - startTime;
          console.log(`🔄 后端缓存数据: ${cacheKey} (${backendFeatures.length} 建筑物, ${processingTime}ms)`);
          
          return {
            features: backendFeatures,
            timestamp: Date.now(),
            source: 'mongodb',
            processingTime
          };
        }
      } catch (error) {
        console.warn(`⚠️ 后端数据获取失败: ${cacheKey}`, error);
      }
    }

    // 3. 最后回退到OSM API (仅在必要时)
    console.warn(`⚠️ 使用OSM API回退: ${cacheKey} (性能可能较慢)`);
    const osmData = await this.fetchFromOSMApi(tiles);
    const processingTime = Date.now() - startTime;
    
    return {
      features: osmData.features,
      timestamp: Date.now(),
      source: 'osm-api',
      processingTime
    };
  }

  /**
   * 获取本地预处理数据
   */
  private async fetchLocalPreloadedData(tiles: BuildingTile[]): Promise<BuildingFeature[] | null> {
    // 尝试从本地文件系统获取预处理数据
    // 这里可以实现从本地JSON文件或IndexedDB获取数据
    
    for (const tile of tiles) {
      const tileKey = `${tile.z}_${tile.x}_${tile.y}`;
      const localFilePath = `${this.config.localDataPath}${tileKey}.json`;
      
      try {
        // 尝试从public目录获取本地文件
        const response = await fetch(localFilePath);
        if (response.ok) {
          const data = (await response.json()) as BuildingFeatureCollection;
          if (data.features && data.features.length > 0) {
            return data.features as BuildingFeature[];
          }
        }
      } catch (error) {
        // 本地文件不存在，继续尝试下一个
        continue;
      }
    }
    
    return null;
  }

  /**
   * 从后端获取数据
   */
  private async fetchFromBackend(tiles: BuildingTile[]): Promise<BuildingFeature[] | null> {
    const promises = tiles.map(tile => 
      this.fetchTileFromBackend(tile.z, tile.x, tile.y)
    );
    
    const results = await Promise.allSettled(promises);
    const allFeatures: BuildingFeature[] = [];
    
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        allFeatures.push(...result.value);
      }
    }
    
    return allFeatures.length > 0 ? allFeatures : null;
  }

  /**
   * 从后端获取单个瓦片
   */
  private async fetchTileFromBackend(z: number, x: number, y: number): Promise<BuildingFeature[] | null> {
    try {
      const response = await fetch(`http://localhost:3500/api/buildings/${Math.floor(z)}/${x}/${y}.json`);
      if (response.ok) {
        const data = (await response.json()) as BuildingFeatureCollection;
        return (data.features as BuildingFeature[]) || [];
      }
    } catch (error) {
      console.warn(`⚠️ 后端瓦片请求失败: ${z}/${x}/${y}`, error);
    }
    return null;
  }

  /**
   * 从OSM API获取数据 (最后回退)
   */
  private async fetchFromOSMApi(_tiles: BuildingTile[]): Promise<BuildingData> {
    // 这里实现OSM API调用逻辑
    // 为了简洁，返回空数据
    return {
      features: [] as BuildingFeature[],
      timestamp: Date.now(),
      source: 'osm-api',
      processingTime: 0
    };
  }

  /**
   * 边界转瓦片坐标
   */
  private boundsToTiles(bounds: BoundingBox, zoom: number): BuildingTile[] {
    const tiles: BuildingTile[] = [];
    const safeZoom = Math.floor(Math.max(0, Math.min(zoom, 18)));
    
    // 计算边界对应的瓦片范围
    const minTileX = Math.floor((bounds.west + 180) / 360 * Math.pow(2, safeZoom));
    const maxTileX = Math.floor((bounds.east + 180) / 360 * Math.pow(2, safeZoom));
    const minTileY = Math.floor((1 - Math.log(Math.tan(bounds.north * Math.PI / 180) + 1 / Math.cos(bounds.north * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, safeZoom));
    const maxTileY = Math.floor((1 - Math.log(Math.tan(bounds.south * Math.PI / 180) + 1 / Math.cos(bounds.south * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, safeZoom));
    
    // 生成瓦片列表
    for (let x = minTileX; x <= maxTileX; x++) {
      for (let y = minTileY; y <= maxTileY; y++) {
        tiles.push({ z: safeZoom, x, y });
      }
    }
    
    return tiles;
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(bounds: BoundingBox, zoom: number): string {
    const precision = 4;
    return `${zoom}_${bounds.north.toFixed(precision)}_${bounds.south.toFixed(precision)}_${bounds.east.toFixed(precision)}_${bounds.west.toFixed(precision)}`;
  }

  /**
   * 检查数据是否新鲜
   */
  private isDataFresh(timestamp: number): boolean {
    const ageHours = (Date.now() - timestamp) / (1000 * 60 * 60);
    return ageHours < this.config.maxLocalAge;
  }

  /**
   * 加载本地数据索引
   */
  private async loadLocalDataIndex(): Promise<void> {
    try {
      // 尝试加载本地数据索引文件
      const response = await fetch('/data/buildings/index.json');
      if (response.ok) {
        const index = await response.json();
        console.log(`📁 加载本地数据索引: ${index.tiles || 0} 个瓦片`);
      }
    } catch (error) {
      console.log('📁 未找到本地数据索引，将使用网络回退');
    }
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return {
      localCacheSize: this.localCache.size,
      pendingRequests: this.pendingRequests.size,
      config: this.config
    };
  }

  /**
   * 清理缓存
   */
  clearCache(): void {
    this.localCache.clear();
    console.log('🗑️ 本地缓存已清理');
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<LocalDataConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('⚙️ 配置已更新:', this.config);
  }
}

// 导出单例实例
export const localFirstBuildingService = new LocalFirstBuildingService();
