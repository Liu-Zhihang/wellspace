/**
 * 优化的建筑物数据服务
 * 解决OSM API响应不稳定和获取慢的问题
 */

import { buildingCache } from '../utils/multiLevelCache';

interface BuildingTile {
  z: number;
  x: number;
  y: number;
}

interface BuildingData {
  features: any[];
  timestamp: number;
  source: 'cache' | 'mongodb' | 'osm-api';
  processingTime: number;
}

export class OptimizedBuildingService {
  private pendingRequests = new Map<string, Promise<BuildingData>>();
  private requestQueue: string[] = [];
  private isProcessingQueue = false;

  /**
   * 获取建筑物数据 - 智能缓存和队列管理
   */
  async getBuildingData(bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }, zoom: number): Promise<BuildingData> {
    const cacheKey = this.generateCacheKey(bounds, zoom);
    
    // 1. 检查多级缓存
    const cached = buildingCache.get(cacheKey) as BuildingData | null;
    if (cached) {
      console.log(`🎯 多级缓存命中: ${cacheKey}`);
      return cached;
    }

    // 2. 检查是否已有相同请求进行中
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ 等待进行中的建筑物请求: ${cacheKey}`);
      return await this.pendingRequests.get(cacheKey)!;
    }

    // 3. 创建新请求
    const requestPromise = this.fetchBuildingDataInternal(bounds, zoom, cacheKey);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      
      // 4. 存储到多级缓存
      buildingCache.set(cacheKey, result);
      
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  /**
   * 内部建筑物数据获取 - 多级fallback策略
   */
  private async fetchBuildingDataInternal(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    _cacheKey: string
  ): Promise<BuildingData> {
    const startTime = performance.now();
    
    // 如果缩放级别太低，直接返回空数据
    if (zoom < 15) {
      return {
        features: [],
        timestamp: Date.now(),
        source: 'cache',
        processingTime: performance.now() - startTime
      };
    }

    try {
      // 1. 尝试从后端MongoDB获取
      console.log(`🔄 从后端获取建筑物数据: zoom=${zoom}`);
      const mongoResult = await this.fetchFromBackend(bounds, zoom);
      
      if (mongoResult.features.length > 0) {
        return {
          ...mongoResult,
          timestamp: Date.now(),
          source: 'mongodb',
          processingTime: performance.now() - startTime
        };
      }

      console.log('📭 MongoDB无数据，尝试预加载相邻区域');
      
      // 2. 如果MongoDB无数据，预加载相邻区域以提高后续性能
      this.preloadAdjacentTiles(bounds, zoom);

      return {
        features: [],
        timestamp: Date.now(),
        source: 'mongodb',
        processingTime: performance.now() - startTime
      };

    } catch (error) {
      console.warn('❌ 建筑物数据获取失败:', error);
      
      return {
        features: [],
        timestamp: Date.now(),
        source: 'cache',
        processingTime: performance.now() - startTime
      };
    }
  }

  /**
   * 从后端获取建筑物数据
   */
  private async fetchFromBackend(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number
  ): Promise<{ features: any[] }> {
    // 计算瓦片坐标
    const tiles = this.boundsToTiles(bounds, zoom);
    const buildingPromises = tiles.map(tile => this.fetchTileFromBackend(tile));
    
    // 并发获取所有瓦片，但限制并发数
    const maxConcurrent = 4;
    const results: any[] = [];
    
    for (let i = 0; i < buildingPromises.length; i += maxConcurrent) {
      const batch = buildingPromises.slice(i, i + maxConcurrent);
      const batchResults = await Promise.allSettled(batch);
      
      batchResults.forEach(result => {
        if (result.status === 'fulfilled' && result.value.features) {
          results.push(...result.value.features);
        }
      });
    }

    return { features: results };
  }

  /**
   * 从后端获取单个瓦片
   */
  private async fetchTileFromBackend(tile: BuildingTile): Promise<{ features: any[] }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒超时

    try {
      const response = await fetch(
        `http://localhost:3500/api/buildings/${Math.floor(tile.z)}/${tile.x}/${tile.y}.json`,
        {
          signal: controller.signal,
          headers: {
            'Cache-Control': 'max-age=300', // 5分钟浏览器缓存
          }
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      console.log(`✅ 瓦片 ${tile.z}/${tile.x}/${tile.y}: ${data.features?.length || 0} 建筑物`);
      
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      console.warn(`⚠️ 瓦片 ${tile.z}/${tile.x}/${tile.y} 获取失败:`, error);
      return { features: [] };
    }
  }

  /**
   * 预加载相邻瓦片
   */
  private preloadAdjacentTiles(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number
  ): void {
    if (this.isProcessingQueue) return;

    const adjacentBounds = this.getAdjacentBounds(bounds);
    
    // 异步预加载，不阻塞当前请求
    setTimeout(() => {
      adjacentBounds.forEach(adjBounds => {
        const cacheKey = this.generateCacheKey(adjBounds, zoom);
        if (!buildingCache.get(cacheKey) && !this.pendingRequests.has(cacheKey)) {
          this.requestQueue.push(cacheKey);
        }
      });
      
      this.processQueue();
    }, 1000);
  }

  /**
   * 处理预加载队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) return;
    
    this.isProcessingQueue = true;
    console.log(`🔄 处理预加载队列: ${this.requestQueue.length} 项`);

    while (this.requestQueue.length > 0) {
      const cacheKey = this.requestQueue.shift()!;
      
      try {
        // 从缓存键恢复边界和缩放
        const { bounds, zoom } = this.parseCacheKey(cacheKey);
        await this.fetchBuildingDataInternal(bounds, zoom, cacheKey);
        
        // 限制预加载速度，避免API过载
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.warn('预加载失败:', error);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number
  ): string {
    const precision = 1000;
    return [
      Math.round(bounds.north * precision),
      Math.round(bounds.south * precision),
      Math.round(bounds.east * precision),
      Math.round(bounds.west * precision),
      Math.floor(zoom)
    ].join('_');
  }

  /**
   * 解析缓存键
   */
  private parseCacheKey(cacheKey: string): {
    bounds: { north: number; south: number; east: number; west: number };
    zoom: number;
  } {
    const parts = cacheKey.split('_').map(Number);
    const precision = 1000;
    
    return {
      bounds: {
        north: parts[0] / precision,
        south: parts[1] / precision,
        east: parts[2] / precision,
        west: parts[3] / precision
      },
      zoom: parts[4]
    };
  }

  /**
   * 边界框转瓦片坐标
   */
  private boundsToTiles(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number
  ): BuildingTile[] {
    const tiles: BuildingTile[] = [];
    const n = Math.pow(2, zoom);
    
    // 计算瓦片坐标
    let minX = Math.floor((bounds.west + 180) / 360 * n);
    let maxX = Math.floor((bounds.east + 180) / 360 * n);
    let minY = Math.floor((1 - Math.log(Math.tan(bounds.north * Math.PI/180) + 1/Math.cos(bounds.north * Math.PI/180)) / Math.PI) / 2 * n);
    let maxY = Math.floor((1 - Math.log(Math.tan(bounds.south * Math.PI/180) + 1/Math.cos(bounds.south * Math.PI/180)) / Math.PI) / 2 * n);
    
    // 🔧 关键修复：验证并约束瓦片坐标到有效范围
    const maxTileCoord = n - 1; // 最大瓦片坐标
    minX = Math.max(0, Math.min(minX, maxTileCoord));
    maxX = Math.max(0, Math.min(maxX, maxTileCoord));
    minY = Math.max(0, Math.min(minY, maxTileCoord));
    maxY = Math.max(0, Math.min(maxY, maxTileCoord));
    
    // 验证坐标合理性
    if (minX > maxX || minY > maxY) {
      console.warn(`⚠️ 无效边界框: minX=${minX}, maxX=${maxX}, minY=${minY}, maxY=${maxY}`);
      return [];
    }
    
    console.log(`🗺️ 计算瓦片范围: zoom=${zoom}, x=${minX}-${maxX}, y=${minY}-${maxY}, 最大=${maxTileCoord}`);
    
    // 限制瓦片数量，避免请求过多
    const maxTiles = 6;
    let tileCount = 0;
    
    for (let x = minX; x <= maxX && tileCount < maxTiles; x++) {
      for (let y = minY; y <= maxY && tileCount < maxTiles; y++) {
        // 再次验证每个瓦片坐标
        if (x >= 0 && x <= maxTileCoord && y >= 0 && y <= maxTileCoord) {
          tiles.push({ z: Math.floor(zoom), x, y });
          tileCount++;
        } else {
          console.warn(`⚠️ 跳过无效瓦片坐标: ${zoom}/${x}/${y} (最大: ${maxTileCoord})`);
        }
      }
    }
    
    console.log(`📊 生成 ${tiles.length} 个有效瓦片坐标`);
    return tiles;
  }

  /**
   * 获取相邻边界框
   */
  private getAdjacentBounds(
    bounds: { north: number; south: number; east: number; west: number }
  ): Array<{ north: number; south: number; east: number; west: number }> {
    const latSpan = bounds.north - bounds.south;
    const lngSpan = bounds.east - bounds.west;
    
    return [
      // 上方
      {
        north: bounds.north + latSpan,
        south: bounds.north,
        east: bounds.east,
        west: bounds.west
      },
      // 下方
      {
        north: bounds.south,
        south: bounds.south - latSpan,
        east: bounds.east,
        west: bounds.west
      },
      // 左方
      {
        north: bounds.north,
        south: bounds.south,
        east: bounds.west,
        west: bounds.west - lngSpan
      },
      // 右方
      {
        north: bounds.north,
        south: bounds.south,
        east: bounds.east + lngSpan,
        west: bounds.east
      }
    ];
  }

  /**
   * 缓存预热
   */
  async warmupCache(regions: Array<{
    bounds: { north: number; south: number; east: number; west: number };
    zoom: number;
  }>): Promise<void> {
    console.log(`🔥 开始建筑物缓存预热: ${regions.length} 个区域`);
    
    const keys = regions.map(region => this.generateCacheKey(region.bounds, region.zoom));
    
    await buildingCache.warmup(keys, async (key) => {
      const { bounds, zoom } = this.parseCacheKey(key);
      return await this.fetchBuildingDataInternal(bounds, zoom, key);
    });
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    const cacheStats = buildingCache.getStats();
    return {
      ...cacheStats,
      pendingRequests: this.pendingRequests.size,
      queueLength: this.requestQueue.length
    };
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    buildingCache.clear();
    this.pendingRequests.clear();
    this.requestQueue = [];
    console.log('🗑️ 清空建筑物缓存');
  }
}

// 创建全局实例
export const optimizedBuildingService = new OptimizedBuildingService();
