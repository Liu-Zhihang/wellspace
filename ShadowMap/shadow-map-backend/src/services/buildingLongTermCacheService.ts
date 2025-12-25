/**
 * Long-term building cache service.
 * Provides tile-level caching with configurable TTL tiers.
 */

import { dbManager } from '../config/database';
import { redisCacheService } from './redisCacheService';

// 长期缓存配置
const LONG_TERM_CACHE_CONFIG = {
  // 缓存TTL配置
  LONG_TERM_TTL: 60 * 60 * 24 * 90, // 90天 (3个月)
  MEDIUM_TERM_TTL: 60 * 60 * 24 * 60, // 60天 (2个月)
  SHORT_TERM_TTL: 60 * 60 * 24 * 30, // 30天 (1个月)
  
  // 网格化缓存配置
  GRID_SIZE: 0.01, // 经纬度网格大小 (约1km)
  MAX_GRID_CACHE: 10000, // 最大缓存网格数量
  
  // 预加载配置
  PRELOAD_RADIUS: 2, // 预加载半径 (网格数)
  PRELOAD_BATCH_SIZE: 5, // 批量预加载大小
};

const CACHE_COLLECTION = 'building_long_term_cache';

// 网格坐标接口
interface GridCoordinate {
  gridX: number;
  gridY: number;
  level: number; // 缓存级别 (zoom level)
}

// 缓存项接口
interface CacheItem {
  gridCoord: GridCoordinate;
  data: any;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  dataSource: 'wfs' | 'osm' | 'hybrid';
  expiresAt: number;
}

// 缓存统计接口
interface CacheStats {
  totalGrids: number;
  primaryDataGrids: number;
  osmDataGrids: number;
  hybridDataGrids: number;
  cacheHitRate: number;
  averageAge: number; // 平均缓存年龄（天）
  storageSize: number; // 存储大小（MB）
}

export class LongTermCacheService {
  private static instance: LongTermCacheService;

  private constructor() {}

  public static getInstance(): LongTermCacheService {
    if (!LongTermCacheService.instance) {
      LongTermCacheService.instance = new LongTermCacheService();
    }
    return LongTermCacheService.instance;
  }

  /**
   * 将地理坐标转换为网格坐标
   */
  private coordToGrid(lat: number, lng: number, zoom: number): GridCoordinate {
    const gridX = Math.floor(lng / LONG_TERM_CACHE_CONFIG.GRID_SIZE);
    const gridY = Math.floor(lat / LONG_TERM_CACHE_CONFIG.GRID_SIZE);
    return { gridX, gridY, level: zoom };
  }

  /**
   * 将网格坐标转换为地理边界
   */
  private gridToBounds(grid: GridCoordinate): { west: number; south: number; east: number; north: number } {
    const west = grid.gridX * LONG_TERM_CACHE_CONFIG.GRID_SIZE;
    const south = grid.gridY * LONG_TERM_CACHE_CONFIG.GRID_SIZE;
    const east = west + LONG_TERM_CACHE_CONFIG.GRID_SIZE;
    const north = south + LONG_TERM_CACHE_CONFIG.GRID_SIZE;
    return { west, south, east, north };
  }

  /**
   * 生成网格缓存键
   */
  private getGridCacheKey(grid: GridCoordinate): string {
    return `building_cache_grid:${grid.level}:${grid.gridX}:${grid.gridY}`;
  }

  /**
   * 确定缓存TTL（基于数据源和访问模式）
   */
  private determineCacheTTL(dataSource: 'wfs' | 'osm' | 'hybrid', accessCount: number): number {
    if (dataSource === 'wfs') {
      // Primary dataset: apply long-term TTL
      return accessCount > 10 ? LONG_TERM_CACHE_CONFIG.LONG_TERM_TTL : LONG_TERM_CACHE_CONFIG.MEDIUM_TERM_TTL;
    } else if (dataSource === 'hybrid') {
      // Hybrid data: medium-term TTL
      return LONG_TERM_CACHE_CONFIG.MEDIUM_TERM_TTL;
    } else {
      // OSM data: short-term TTL
      return LONG_TERM_CACHE_CONFIG.SHORT_TERM_TTL;
    }
  }

  /**
   * 从长期缓存获取数据
   */
  public async getCachedData(lat: number, lng: number, zoom: number): Promise<any | null> {
    const grid = this.coordToGrid(lat, lng, zoom);
    const cacheKey = this.getGridCacheKey(grid);
    
    try {
      // 1. 首先尝试从Redis获取（最快）
      const redisData = await redisCacheService.get(cacheKey);
      if (redisData) {
        const cacheItem: CacheItem = JSON.parse(redisData);
        
        // 检查是否过期
        if (cacheItem.expiresAt > Date.now()) {
          console.log(`⚡ Long-term cache hit (Redis): Grid ${grid.gridX},${grid.gridY} (${cacheItem.dataSource})`);
          
          // 更新访问统计
          cacheItem.lastAccessed = Date.now();
          cacheItem.accessCount++;
          
          // 异步更新访问统计
          this.updateAccessStats(cacheKey, cacheItem);
          
          return cacheItem.data;
        }
      }

      // 2. 然后尝试从MongoDB获取
      const mongoData = await this.getFromMongoDB(grid);
      if (mongoData) {
        console.log(`📊 Long-term cache hit (MongoDB): Grid ${grid.gridX},${grid.gridY}`);
        
        // 异步缓存到Redis
        this.saveToRedis(cacheKey, mongoData);
        
        return mongoData.data;
      }

      return null;
    } catch (error) {
      console.warn('⚠️ Long-term cache retrieval failed:', error);
      return null;
    }
  }

  /**
   * 缓存数据到长期存储
   */
  public async setCachedData(
    lat: number, 
    lng: number, 
    zoom: number, 
    data: any, 
    dataSource: 'wfs' | 'osm' | 'hybrid'
  ): Promise<void> {
    const grid = this.coordToGrid(lat, lng, zoom);
    const cacheKey = this.getGridCacheKey(grid);
    const now = Date.now();
    
    const cacheItem: CacheItem = {
      gridCoord: grid,
      data,
      timestamp: now,
      lastAccessed: now,
      accessCount: 1,
      dataSource,
      expiresAt: now + this.determineCacheTTL(dataSource, 1)
    };

    try {
      // 并行保存到Redis和MongoDB
      const savePromises = [
        this.saveToRedis(cacheKey, cacheItem),
        this.saveToMongoDB(cacheItem)
      ];

      await Promise.allSettled(savePromises);
      console.log(`💾 Cached building data: Grid ${grid.gridX},${grid.gridY} (${dataSource}, TTL: ${Math.round((cacheItem.expiresAt - now) / 86400000)}天)`);
      
    } catch (error) {
      console.warn('⚠️ Long-term cache persistence failed:', error);
    }
  }

  /**
   * 智能预加载相邻网格
   */
  public async preloadAdjacentGrids(centerLat: number, centerLng: number, zoom: number): Promise<void> {
    const centerGrid = this.coordToGrid(centerLat, centerLng, zoom);
    const preloadTasks: Promise<void>[] = [];

    console.log(`🔄 开始预加载相邻网格: 中心(${centerGrid.gridX}, ${centerGrid.gridY}), 半径${LONG_TERM_CACHE_CONFIG.PRELOAD_RADIUS}`);

    for (let dx = -LONG_TERM_CACHE_CONFIG.PRELOAD_RADIUS; dx <= LONG_TERM_CACHE_CONFIG.PRELOAD_RADIUS; dx++) {
      for (let dy = -LONG_TERM_CACHE_CONFIG.PRELOAD_RADIUS; dy <= LONG_TERM_CACHE_CONFIG.PRELOAD_RADIUS; dy++) {
        if (dx === 0 && dy === 0) continue; // 跳过中心网格

        const targetGrid: GridCoordinate = {
          gridX: centerGrid.gridX + dx,
          gridY: centerGrid.gridY + dy,
          level: zoom
        };

        // 检查是否已缓存
        const cacheKey = this.getGridCacheKey(targetGrid);
        const existsInCache = await this.checkCacheExists(cacheKey);
        
        if (!existsInCache) {
          const bounds = this.gridToBounds(targetGrid);
          const centerLat = (bounds.north + bounds.south) / 2;
          const centerLng = (bounds.east + bounds.west) / 2;
          
          preloadTasks.push(this.preloadSingleGrid(centerLat, centerLng, zoom));
        }

        // 批量处理，避免过多并发
        if (preloadTasks.length >= LONG_TERM_CACHE_CONFIG.PRELOAD_BATCH_SIZE) {
          await Promise.allSettled(preloadTasks);
          preloadTasks.length = 0; // 清空数组
        }
      }
    }

    // 处理剩余任务
    if (preloadTasks.length > 0) {
      await Promise.allSettled(preloadTasks);
    }

    console.log(`✅ 相邻网格预加载完成`);
  }

  /**
   * 预加载单个网格
   */
  private async preloadSingleGrid(lat: number, lng: number, zoom: number): Promise<void> {
    try {
      // 这里可以调用实际的数据获取服务
      // 例如：hybridBuildingService.getHybridBuildingTile()
      console.log(`🔄 预加载网格: (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
      
      // 模拟预加载逻辑
      // const data = await this.fetchDataForGrid(lat, lng, zoom);
      // await this.setCachedData(lat, lng, zoom, data, 'wfs');
      
    } catch (error) {
      console.warn(`⚠️ 网格预加载失败 (${lat.toFixed(4)}, ${lng.toFixed(4)}):`, error);
    }
  }

  /**
   * 获取缓存统计信息
   */
  public async getCacheStats(): Promise<CacheStats> {
    try {
      const db = dbManager.getDatabase();
      if (!db) {
        throw new Error('Database not connected');
      }

      const collection = db.collection(CACHE_COLLECTION);
      
      // 聚合查询获取统计信息
      const stats = await collection.aggregate([
        {
          $group: {
            _id: '$dataSource',
            count: { $sum: 1 },
            totalSize: { $sum: { $bsonSize: '$data' } },
            avgAge: { $avg: { $subtract: [new Date(), '$timestamp'] } },
            avgAccessCount: { $avg: '$accessCount' }
          }
        }
      ]).toArray();

      // 计算总体统计
      let totalGrids = 0;
      let primaryDataGrids = 0;
      let osmDataGrids = 0;
      let hybridDataGrids = 0;
      let totalSize = 0;
      let totalAge = 0;

      stats.forEach(stat => {
        totalGrids += stat.count;
        totalSize += stat.totalSize;
        totalAge += stat.avgAge * stat.count;

        switch (stat._id) {
          case 'wfs':
            primaryDataGrids = stat.count;
            break;
          case 'osm':
            osmDataGrids = stat.count;
            break;
          case 'hybrid':
            hybridDataGrids = stat.count;
            break;
        }
      });

      return {
        totalGrids,
        primaryDataGrids,
        osmDataGrids,
        hybridDataGrids,
        cacheHitRate: 0, // 需要额外计算
        averageAge: totalGrids > 0 ? totalAge / totalGrids / 86400000 : 0, // 转换为天
        storageSize: Math.round(totalSize / 1024 / 1024 * 100) / 100 // 转换为MB
      };

    } catch (error) {
      console.warn('⚠️ 获取缓存统计失败:', error);
      return {
        totalGrids: 0,
        primaryDataGrids: 0,
        osmDataGrids: 0,
        hybridDataGrids: 0,
        cacheHitRate: 0,
        averageAge: 0,
        storageSize: 0
      };
    }
  }

  /**
   * 清理过期缓存
   */
  public async cleanupExpiredCache(): Promise<{ deletedCount: number; freedSize: number }> {
    try {
      const db = dbManager.getDatabase();
      if (!db) {
        throw new Error('Database not connected');
      }

      const collection = db.collection(CACHE_COLLECTION);
      const now = Date.now();

      // 查找过期项
      const expiredItems = await collection.find({
        expiresAt: { $lt: now }
      }).toArray();

      if (expiredItems.length === 0) {
        console.log('✅ 没有过期的缓存项');
        return { deletedCount: 0, freedSize: 0 };
      }

      // 计算释放的存储空间
      const freedSize = expiredItems.reduce((total, item) => {
        return total + JSON.stringify(item.data).length;
      }, 0);

      // 删除过期项
      const deleteResult = await collection.deleteMany({
        expiresAt: { $lt: now }
      });

      console.log(`🗑️ 清理过期缓存: 删除${deleteResult.deletedCount}项, 释放${Math.round(freedSize / 1024 / 1024 * 100) / 100}MB`);

      return {
        deletedCount: deleteResult.deletedCount,
        freedSize: Math.round(freedSize / 1024 / 1024 * 100) / 100
      };

    } catch (error) {
      console.warn('⚠️ 清理过期缓存失败:', error);
      return { deletedCount: 0, freedSize: 0 };
    }
  }

  // 私有辅助方法

  private async saveToRedis(cacheKey: string, cacheItem: CacheItem): Promise<void> {
    const ttlSeconds = Math.round((cacheItem.expiresAt - Date.now()) / 1000);
    await redisCacheService.setWithTTL(cacheKey, JSON.stringify(cacheItem), ttlSeconds);
  }

  private async saveToMongoDB(cacheItem: CacheItem): Promise<void> {
    const db = dbManager.getDatabase();
    if (!db) return;

    const collection = db.collection(CACHE_COLLECTION);
    
    await collection.replaceOne(
      {
        'gridCoord.gridX': cacheItem.gridCoord.gridX,
        'gridCoord.gridY': cacheItem.gridCoord.gridY,
        'gridCoord.level': cacheItem.gridCoord.level
      },
      cacheItem,
      { upsert: true }
    );
  }

  private async getFromMongoDB(grid: GridCoordinate): Promise<CacheItem | null> {
    const db = dbManager.getDatabase();
    if (!db) return null;

    const collection = db.collection(CACHE_COLLECTION);
    
    const result = await collection.findOne({
      'gridCoord.gridX': grid.gridX,
      'gridCoord.gridY': grid.gridY,
      'gridCoord.level': grid.level,
      expiresAt: { $gt: Date.now() }
    });

    return result as CacheItem | null;
  }

  private async updateAccessStats(cacheKey: string, cacheItem: CacheItem): Promise<void> {
    // 异步更新Redis
    redisCacheService.setWithTTL(
      cacheKey, 
      JSON.stringify(cacheItem), 
      Math.round((cacheItem.expiresAt - Date.now()) / 1000)
    );

    // 异步更新MongoDB
    const db = dbManager.getDatabase();
    if (db) {
      const collection = db.collection(CACHE_COLLECTION);
      collection.updateOne(
        {
          'gridCoord.gridX': cacheItem.gridCoord.gridX,
          'gridCoord.gridY': cacheItem.gridCoord.gridY,
          'gridCoord.level': cacheItem.gridCoord.level
        },
        {
          $set: {
            lastAccessed: cacheItem.lastAccessed,
            accessCount: cacheItem.accessCount
          }
        }
      );
    }
  }

  private async checkCacheExists(cacheKey: string): Promise<boolean> {
    // 首先检查Redis
    const redisExists = await redisCacheService.get(cacheKey);
    if (redisExists) return true;

    // 然后检查MongoDB
    const db = dbManager.getDatabase();
    if (!db) return false;

    const collection = db.collection(CACHE_COLLECTION);
    const count = await collection.countDocuments({
      cacheKey,
      expiresAt: { $gt: Date.now() }
    });

    return count > 0;
  }
}

// Export singleton instance
export const buildingLongTermCacheService = LongTermCacheService.getInstance();
