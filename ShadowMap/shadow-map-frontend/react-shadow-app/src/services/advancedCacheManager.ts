import type { BuildingTileData } from '../types/index.ts';

const API_BASE_URL = 'http://localhost:3500/api';

// 缓存配置
export interface CacheStats {
  memorySize: number;
  storageSize: number;
  maxMemorySize: number;
  maxStorageSize: number;
  hitRate: number;
  totalHits: number;
  totalMisses: number;
  memoryUsage: string;
}

interface CacheConfig {
  maxMemorySize: number;     // 内存缓存最大条目数
  maxStorageSize: number;    // 本地存储最大条目数
  memoryTTL: number;         // 内存缓存TTL
  storageTTL: number;        // 本地存储TTL
  preloadDistance: number;   // 预加载距离（瓦片数量）
  compressionEnabled: boolean; // 是否启用压缩
}

const CACHE_CONFIG: CacheConfig = {
  maxMemorySize: 500,        // 内存缓存500个瓦片
  maxStorageSize: 2000,      // 本地存储2000个瓦片
  memoryTTL: 10 * 60 * 1000, // 内存缓存10分钟
  storageTTL: 24 * 60 * 60 * 1000, // 本地存储24小时
  preloadDistance: 2,        // 预加载周围2圈瓦片
  compressionEnabled: true,  // 启用数据压缩
};

// 缓存条目接口
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiry: number;
  size: number;              // 数据大小（字节）
  compressed?: boolean;      // 是否压缩
  accessCount: number;       // 访问次数
  lastAccess: number;        // 最后访问时间
}

// LRU缓存管理器
class AdvancedCacheManager {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private storageCache = new Map<string, CacheEntry<any>>();
  private accessOrder = new Map<string, number>(); // LRU跟踪
  private hitCount = 0;
  private missCount = 0;
  private totalSize = 0;
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    this.loadFromLocalStorage();
  }

  // 设置缓存数据
  async set<T>(key: string, data: T, ttl?: number, forceMemory = false): Promise<void> {
    const size = this.estimateSize(data);
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      expiry: Date.now() + (ttl || this.config.memoryTTL),
      size,
      accessCount: 0,
      lastAccess: Date.now(),
    };

    // 压缩大数据
    if (this.config.compressionEnabled && size > 10000) {
      entry.data = this.compress(data);
      entry.compressed = true;
    }

    // 优先存储到内存缓存
    if (forceMemory || this.memoryCache.size < this.config.maxMemorySize) {
      this.setMemoryCache(key, entry);
    } else {
      // 内存满了，使用LRU策略
      this.evictLRU();
      this.setMemoryCache(key, entry);
    }

    // 同时存储到本地缓存（异步）
    this.setStorageCache(key, entry);
  }

  // 获取缓存数据
  async get<T>(key: string): Promise<T | null> {
    // 1. 首先检查内存缓存
    let entry = this.memoryCache.get(key);
    if (entry && !this.isExpired(entry)) {
      this.updateAccess(key, entry);
      this.hitCount++;
      return this.getData<T>(entry);
    }

    // 2. 检查本地存储缓存
    entry = this.storageCache.get(key);
    if (entry && !this.isExpired(entry)) {
      // 提升到内存缓存
      this.promoteToMemory(key, entry);
      this.hitCount++;
      return this.getData<T>(entry);
    }

    this.missCount++;
    return null;
  }

  // 预加载瓦片数据
  async preloadTiles(centerZ: number, centerX: number, centerY: number): Promise<void> {
    const tilesToPreload = this.getTilesInRadius(centerZ, centerX, centerY, this.config.preloadDistance);
    
    console.log(`🔄 预加载 ${tilesToPreload.length} 个瓦片`);
    
    const preloadPromises = tilesToPreload.map(async (tile) => {
      const key = `building-${tile.z}-${tile.x}-${tile.y}`;
      if (!this.get(key)) {
        try {
          const data = await this.fetchBuildingTile(tile.z, tile.x, tile.y);
          this.set(key, data, this.config.storageTTL);
        } catch (error) {
          console.warn(`预加载瓦片 ${tile.z}/${tile.x}/${tile.y} 失败:`, error);
        }
      }
    });

    await Promise.allSettled(preloadPromises);
  }

  // 智能清理过期数据
  cleanup(): number {
    const initialMemorySize = this.memoryCache.size;
    const initialStorageSize = this.storageCache.size;
    
    const memoryKeys = Array.from(this.memoryCache.keys());
    const storageKeys = Array.from(this.storageCache.keys());

    // 清理内存缓存
    memoryKeys.forEach(key => {
      const entry = this.memoryCache.get(key);
      if (entry && this.isExpired(entry)) {
        this.memoryCache.delete(key);
        this.accessOrder.delete(key);
        this.totalSize -= entry.size;
      }
    });

    // 清理本地存储缓存
    storageKeys.forEach(key => {
      const entry = this.storageCache.get(key);
      if (entry && this.isExpired(entry)) {
        this.storageCache.delete(key);
      }
    });

    this.saveToLocalStorage();
    const removedCount = (initialMemorySize - this.memoryCache.size) + (initialStorageSize - this.storageCache.size);
    console.log(`🧹 缓存清理完成，内存: ${this.memoryCache.size}, 存储: ${this.storageCache.size}，清理了 ${removedCount} 项`);
    return removedCount;
  }

  // 清空所有缓存
  clearAll(): void {
    this.memoryCache.clear();
    this.storageCache.clear();
    this.accessOrder.clear();
    this.totalSize = 0;
    this.hitCount = 0;
    this.missCount = 0;
    
    // 清空localStorage
    try {
      localStorage.removeItem('shadow-cache-data');
      localStorage.removeItem('shadow-cache-meta');
    } catch (error) {
      console.warn('无法清空localStorage缓存:', error);
    }
    
    console.log('🗑️ 所有缓存已清空');
  }

  // 获取缓存统计信息
  getStats(): CacheStats {
    const total = this.hitCount + this.missCount;
    const hitRate = total > 0 ? (this.hitCount / total) * 100 : 0;
    
    return {
      memorySize: this.memoryCache.size,
      storageSize: this.storageCache.size,
      maxMemorySize: this.config.maxMemorySize,
      maxStorageSize: this.config.maxStorageSize,
      hitRate,
      totalHits: this.hitCount,
      totalMisses: this.missCount,
      memoryUsage: this.formatBytes(this.totalSize),
    };
  }

  // 清空所有缓存
  async clear(): Promise<void> {
    this.clearAll();
  }

  // 私有方法
  private setMemoryCache<T>(key: string, entry: CacheEntry<T>): void {
    this.memoryCache.set(key, entry);
    this.accessOrder.set(key, Date.now());
    this.totalSize += entry.size;
  }

  private setStorageCache<T>(key: string, entry: CacheEntry<T>): void {
    if (this.storageCache.size >= this.config.maxStorageSize) {
      // 删除最旧的条目
      const oldestKey = this.getOldestStorageKey();
      if (oldestKey) {
        this.storageCache.delete(oldestKey);
      }
    }
    
    this.storageCache.set(key, {
      ...entry,
      expiry: Date.now() + this.config.storageTTL,
    });
  }

  private evictLRU(): void {
    if (this.accessOrder.size === 0) return;
    
    // 找到最久未访问的key
    let oldestKey = '';
    let oldestTime = Date.now();
    
    this.accessOrder.forEach((time, key) => {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      const entry = this.memoryCache.get(oldestKey);
      if (entry) {
        this.totalSize -= entry.size;
      }
      this.memoryCache.delete(oldestKey);
      this.accessOrder.delete(oldestKey);
    }
  }

  private promoteToMemory<T>(key: string, entry: CacheEntry<T>): void {
    if (this.memoryCache.size >= this.config.maxMemorySize) {
      this.evictLRU();
    }
    this.setMemoryCache(key, entry);
  }

  private updateAccess<T>(key: string, entry: CacheEntry<T>): void {
    entry.accessCount++;
    entry.lastAccess = Date.now();
    this.accessOrder.set(key, Date.now());
  }

  private getData<T>(entry: CacheEntry<T>): T {
    if (entry.compressed) {
      return this.decompress(entry.data);
    }
    return entry.data;
  }

  private isExpired<T>(entry: CacheEntry<T>): boolean {
    return Date.now() > entry.expiry;
  }

  private compress(data: any): any {
    // 简单的JSON压缩（实际应用中可以使用pako等库）
    return JSON.stringify(data);
  }

  private decompress(data: any): any {
    // 解压缩
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return data;
      }
    }
    return data;
  }

  private estimateSize(data: any): number {
    return new Blob([JSON.stringify(data)]).size;
  }

  private getTilesInRadius(centerZ: number, centerX: number, centerY: number, radius: number) {
    const tiles = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        tiles.push({
          z: centerZ,
          x: centerX + dx,
          y: centerY + dy,
        });
      }
    }
    return tiles;
  }

  private getOldestStorageKey(): string | null {
    let oldestKey = null;
    let oldestTime = Date.now();
    
    this.storageCache.forEach((entry, key) => {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    });
    
    return oldestKey;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private loadFromLocalStorage(): void {
    try {
      const stored = localStorage.getItem('shadowmap-cache');
      if (stored) {
        const data = JSON.parse(stored);
        this.storageCache = new Map(data.storageCache || []);
        console.log(`📦 从本地存储加载 ${this.storageCache.size} 个缓存条目`);
      }
    } catch (error) {
      console.warn('加载本地缓存失败:', error);
    }
  }

  private saveToLocalStorage(): void {
    try {
      const data = {
        storageCache: Array.from(this.storageCache.entries()),
        timestamp: Date.now(),
      };
      localStorage.setItem('shadowmap-cache', JSON.stringify(data));
    } catch (error) {
      console.warn('保存本地缓存失败:', error);
    }
  }

  private async fetchBuildingTile(z: number, x: number, y: number): Promise<BuildingTileData> {
    const response = await fetch(`${API_BASE_URL}/buildings/${z}/${x}/${y}.json`);
    if (!response.ok) {
      throw new Error(`Failed to fetch building tile: ${response.statusText}`);
    }
    return response.json();
  }
}

// 创建高级缓存管理器实例
const advancedCacheManager = new AdvancedCacheManager(CACHE_CONFIG);

// 定期清理缓存
setInterval(() => {
  advancedCacheManager.cleanup();
}, 5 * 60 * 1000); // 每5分钟清理一次

export { advancedCacheManager };
