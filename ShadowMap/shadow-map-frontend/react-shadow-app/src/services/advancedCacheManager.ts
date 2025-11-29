import type { BuildingTileData } from '../types/index.ts';

const RUNTIME_BACKEND = (import.meta.env.VITE_BACKEND_BASE_URL as string | undefined) ?? 'http://localhost:3500';
const API_BASE_URL = `${RUNTIME_BACKEND.replace(/\/$/, '')}/api`;

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
  maxMemorySize: number;     // Maximum in-memory items
  maxStorageSize: number;    // Maximum persisted items
  memoryTTL: number;         // In-memory TTL
  storageTTL: number;        // Persistent TTL
  preloadDistance: number;   // Preload distance in tiles
  compressionEnabled: boolean; // Enable compression
}

const CACHE_CONFIG: CacheConfig = {
  maxMemorySize: 500,        // 500 tiles in memory
  maxStorageSize: 2000,      // 2000 tiles persisted
  memoryTTL: 10 * 60 * 1000, // 10 minutes in memory
  storageTTL: 24 * 60 * 60 * 1000, // 24 hours on disk
  preloadDistance: 2,        // Preload two surrounding rings
  compressionEnabled: true,  // 
};

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiry: number;
  size: number;              // （）
  compressed?: boolean;      // 
  accessCount: number;       // 
  lastAccess: number;        // 
}

class AdvancedCacheManager {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private storageCache = new Map<string, CacheEntry<any>>();
  private accessOrder = new Map<string, number>(); // LRU
  private hitCount = 0;
  private missCount = 0;
  private totalSize = 0;
  private config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    this.loadFromLocalStorage();
  }

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

    if (this.config.compressionEnabled && size > 10000) {
      entry.data = this.compress(data);
      entry.compressed = true;
    }

    if (forceMemory || this.memoryCache.size < this.config.maxMemorySize) {
      this.setMemoryCache(key, entry);
    } else {
      this.evictLRU();
      this.setMemoryCache(key, entry);
    }

    this.setStorageCache(key, entry);
  }

  async get<T>(key: string): Promise<T | null> {
    let entry = this.memoryCache.get(key);
    if (entry && !this.isExpired(entry)) {
      this.updateAccess(key, entry);
      this.hitCount++;
      return this.getData<T>(entry);
    }

    entry = this.storageCache.get(key);
    if (entry && !this.isExpired(entry)) {
      this.promoteToMemory(key, entry);
      this.hitCount++;
      return this.getData<T>(entry);
    }

    this.missCount++;
    return null;
  }

  async preloadTiles(centerZ: number, centerX: number, centerY: number): Promise<void> {
    const tilesToPreload = this.getTilesInRadius(centerZ, centerX, centerY, this.config.preloadDistance);
    
    console.log(`🔄  ${tilesToPreload.length} `);
    
    const preloadPromises = tilesToPreload.map(async (tile) => {
      const key = `building-${tile.z}-${tile.x}-${tile.y}`;
      if (!this.get(key)) {
        try {
          const data = await this.fetchBuildingTile(tile.z, tile.x, tile.y);
          this.set(key, data, this.config.storageTTL);
        } catch (error) {
          console.warn(` ${tile.z}/${tile.x}/${tile.y} :`, error);
        }
      }
    });

    await Promise.allSettled(preloadPromises);
  }

  cleanup(): number {
    const initialMemorySize = this.memoryCache.size;
    const initialStorageSize = this.storageCache.size;
    
    const memoryKeys = Array.from(this.memoryCache.keys());
    const storageKeys = Array.from(this.storageCache.keys());

    memoryKeys.forEach(key => {
      const entry = this.memoryCache.get(key);
      if (entry && this.isExpired(entry)) {
        this.memoryCache.delete(key);
        this.accessOrder.delete(key);
        this.totalSize -= entry.size;
      }
    });

    storageKeys.forEach(key => {
      const entry = this.storageCache.get(key);
      if (entry && this.isExpired(entry)) {
        this.storageCache.delete(key);
      }
    });

    this.saveToLocalStorage();
    const removedCount = (initialMemorySize - this.memoryCache.size) + (initialStorageSize - this.storageCache.size);
    console.log(`🧹 ，: ${this.memoryCache.size}, : ${this.storageCache.size}， ${removedCount} `);
    return removedCount;
  }

  clearAll(): void {
    this.memoryCache.clear();
    this.storageCache.clear();
    this.accessOrder.clear();
    this.totalSize = 0;
    this.hitCount = 0;
    this.missCount = 0;
    
    try {
      localStorage.removeItem('shadow-cache-data');
      localStorage.removeItem('shadow-cache-meta');
    } catch (error) {
      console.warn('localStorage:', error);
    }
    
    console.log('🗑️ ');
  }

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

  async clear(): Promise<void> {
    this.clearAll();
  }

  private setMemoryCache<T>(key: string, entry: CacheEntry<T>): void {
    this.memoryCache.set(key, entry);
    this.accessOrder.set(key, Date.now());
    this.totalSize += entry.size;
  }

  private setStorageCache<T>(key: string, entry: CacheEntry<T>): void {
    if (this.storageCache.size >= this.config.maxStorageSize) {
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
    return JSON.stringify(data);
  }

  private decompress(data: any): any {
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
        console.log(`📦  ${this.storageCache.size} `);
      }
    } catch (error) {
      console.warn(':', error);
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
      console.warn(':', error);
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

const advancedCacheManager = new AdvancedCacheManager(CACHE_CONFIG);

setInterval(() => {
  advancedCacheManager.cleanup();
}, 5 * 60 * 1000); // 5

export { advancedCacheManager };
