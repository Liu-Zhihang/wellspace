/**
 */

interface CacheItem<T> {
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
  priority: number;
  size: number;
}

interface CacheConfig {
  maxMemorySize: number;
  maxItems: number;
  defaultTTL: number;
  enablePredictive: boolean;
  compressionThreshold: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  totalMemoryUsage: number;
  itemCount: number;
  hitRate: number;
}

export class MultiLevelCache<T> {
  private cache = new Map<string, CacheItem<T>>();
  private accessPatterns = new Map<string, number[]>();
  private pendingPredictions = new Set<string>();
  
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    totalMemoryUsage: 0,
    itemCount: 0,
    hitRate: 0
  };

  private readonly config: CacheConfig = {
    maxMemorySize: 50 * 1024 * 1024, // 50MB
    maxItems: 200,
    defaultTTL: 15 * 60 * 1000,
    enablePredictive: true,
    compressionThreshold: 100 * 1024 // 100KB
  };

  constructor(config?: Partial<CacheConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
    
  }

  /**
   */
  get(key: string, maxAge?: number): T | null {
    const item = this.cache.get(key);
    
    if (!item) {
      this.stats.misses++;
      this.recordAccess(key, false);
      this.updateStats();
      return null;
    }

    const age = Date.now() - item.timestamp;
    const ttl = maxAge || this.config.defaultTTL;
    
    if (age > ttl) {
      this.cache.delete(key);
      this.stats.evictions++;
      this.stats.misses++;
      this.updateStats();
      return null;
    }

    item.accessCount++;
    item.lastAccess = Date.now();
    item.priority = this.calculatePriority(item);

    this.stats.hits++;
    this.recordAccess(key, true);
    this.updateStats();
    
    if (this.config.enablePredictive) {
      this.triggerPredictiveCache(key);
    }

    return item.data;
  }

  /**
   */
  set(key: string, data: T, _ttl?: number): void {
    const size = this.estimateSize(data);
    const now = Date.now();
    
    this.ensureSpace(size);
    
    const item: CacheItem<T> = {
      data,
      timestamp: now,
      accessCount: 1,
      lastAccess: now,
      priority: 1,
      size
    };

    if (size > this.config.compressionThreshold) {
      item.data = this.compressData(data);
    }

    this.cache.set(key, item);
    this.stats.totalMemoryUsage += size;
    this.stats.itemCount++;
    
    this.updateStats();
  }

  /**
   */
  private triggerPredictiveCache(accessedKey: string): void {
    if (this.pendingPredictions.has(accessedKey)) return;
    
    const predictions = this.predictNextAccess(accessedKey);
    
    predictions.forEach(predictedKey => {
      if (!this.cache.has(predictedKey) && !this.pendingPredictions.has(predictedKey)) {
        this.pendingPredictions.add(predictedKey);
        
        setTimeout(() => {
          this.loadPredictedData(predictedKey);
        }, 100);
      }
    });
  }

  /**
   */
  private predictNextAccess(currentKey: string): string[] {
    const predictions: string[] = [];
    
    const spatialPredictions = this.generateSpatialPredictions(currentKey);
    predictions.push(...spatialPredictions);
    
    const accessHistory = this.accessPatterns.get(currentKey) || [];
    if (accessHistory.length >= 3) {
      const temporalPredictions = this.generateTemporalPredictions(currentKey, accessHistory);
      predictions.push(...temporalPredictions);
    }
    
    return predictions.slice(0, 3);
  }

  /**
   */
  private generateSpatialPredictions(key: string): string[] {
    const parts = key.split('_');
    if (parts.length < 5) return [];
    
    const [north, south, east, west, zoom, ...rest] = parts;
    const predictions: string[] = [];
    
    try {
      const n = parseFloat(north);
      const s = parseFloat(south);
      const e = parseFloat(east);
      const w = parseFloat(west);
      const z = parseFloat(zoom);
      
      const latSpan = n - s;
      const lngSpan = e - w;
      
      const adjacentRegions = [
        [n + latSpan, n, e, w],
        [s, s - latSpan, e, w],
        [n, s, e + lngSpan, e],
        [n, s, w, w - lngSpan]
      ];
      
      adjacentRegions.forEach(([newN, newS, newE, newW]) => {
        const newKey = [newN, newS, newE, newW, z, ...rest].join('_');
        predictions.push(newKey);
      });
      
    } catch (error) {
    }
    
    return predictions;
  }

  /**
   */
  private generateTemporalPredictions(_key: string, accessHistory: number[]): string[] {
    const intervals = [];
    for (let i = 1; i < accessHistory.length; i++) {
      intervals.push(accessHistory[i] - accessHistory[i - 1]);
    }
    
    if (intervals.length === 0) {
      return [];
    }

    return [];
  }

  /**
   */
  private ensureSpace(requiredSize: number): void {
    while (
      (this.stats.totalMemoryUsage + requiredSize > this.config.maxMemorySize) ||
      (this.stats.itemCount >= this.config.maxItems)
    ) {
      const evicted = this.evictLeastUseful();
      if (!evicted) break;
    }
  }

  /**
   */
  private evictLeastUseful(): boolean {
    if (this.cache.size === 0) return false;
    
    let leastUsefulKey = '';
    let lowestPriority = Infinity;
    
    for (const [key, item] of this.cache.entries()) {
      const priority = this.calculatePriority(item);
      if (priority < lowestPriority) {
        lowestPriority = priority;
        leastUsefulKey = key;
      }
    }
    
    if (leastUsefulKey) {
      const item = this.cache.get(leastUsefulKey)!;
      this.cache.delete(leastUsefulKey);
      this.stats.totalMemoryUsage -= item.size;
      this.stats.itemCount--;
      this.stats.evictions++;
      
      return true;
    }
    
    return false;
  }

  /**
   */
  private calculatePriority(item: CacheItem<T>): number {
    const age = Date.now() - item.timestamp;
    const lastAccessAge = Date.now() - item.lastAccess;
    
    const frequency = item.accessCount / Math.max(1, age / (60 * 1000));
    const recency = 1 / Math.max(1, lastAccessAge / (60 * 1000));
    
    return frequency * 0.7 + recency * 0.3;
  }

  /**
   */
  private estimateSize(data: T): number {
    try {
      return JSON.stringify(data).length * 2;
    } catch {
      return 1024;
    }
  }

  /**
   */
  private compressData(data: T): T {
    return data;
  }

  /**
   */
  private recordAccess(key: string, hit: boolean): void {
    if (!hit) return;
    
    const history = this.accessPatterns.get(key) || [];
    history.push(Date.now());
    
    if (history.length > 10) {
      history.shift();
    }
    
    this.accessPatterns.set(key, history);
  }

  /**
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;
    let cleanedSize = 0;
    
    for (const [key, item] of this.cache.entries()) {
      const age = now - item.timestamp;
      if (age > this.config.defaultTTL) {
        this.cache.delete(key);
        this.stats.totalMemoryUsage -= item.size;
        this.stats.itemCount--;
        cleanedCount++;
        cleanedSize += item.size;
      }
    }
    
    if (cleanedCount > 0) {
      this.updateStats();
    }
  }

  /**
   */
  private updateStats(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  private async loadPredictedData(key: string): Promise<void> {
    setTimeout(() => {
      this.pendingPredictions.delete(key);
    }, 5000);
  }

  /**
   */
  getStats(): CacheStats & { config: CacheConfig } {
    return {
      ...this.stats,
      config: this.config
    };
  }

  /**
   */
  clear(): void {
    this.cache.clear();
    this.accessPatterns.clear();
    this.pendingPredictions.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalMemoryUsage: 0,
      itemCount: 0,
      hitRate: 0
    };
  }

  /**
   */
  async warmup(keys: string[], dataLoader: (key: string) => Promise<T>): Promise<void> {
    
    const promises = keys.map(async (key) => {
      try {
        if (!this.cache.has(key)) {
          const data = await dataLoader(key);
          this.set(key, data);
        }
      } catch (error) {
      }
    });
    
    await Promise.allSettled(promises);
  }
}

export const buildingCache = new MultiLevelCache({
  maxMemorySize: 30 * 1024 * 1024, // 30MB
  maxItems: 150,
  defaultTTL: 20 * 60 * 1000,
  enablePredictive: true
});

export const shadowCache = new MultiLevelCache({
  maxMemorySize: 20 * 1024 * 1024, // 20MB  
  maxItems: 100,
  defaultTTL: 15 * 60 * 1000,
  enablePredictive: true
});
