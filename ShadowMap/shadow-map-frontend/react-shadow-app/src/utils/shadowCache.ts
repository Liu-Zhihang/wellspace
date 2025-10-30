/**
 */

interface CacheItem {
  data: any;
  timestamp: number;
  viewBounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  zoom: number;
  date: {
    hour: number;
    minute: number;
    day: number;
  };
}

interface CacheStats {
  hits: number;
  misses: number;
  totalRequests: number;
  hitRate: number;
  cacheSize: number;
  lastCleanup: number;
}

export class ShadowCache {
  private cache = new Map<string, CacheItem>();
  private maxSize = 50;
  private ttl = 10 * 60 * 1000;
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    hitRate: 0,
    cacheSize: 0,
    lastCleanup: Date.now()
  };

  /**
   */
  private generateKey(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): string {
    const precision = this.getCoordinatePrecision(zoom);
    
    return [
      Math.round(bounds.north * precision) / precision,
      Math.round(bounds.south * precision) / precision,
      Math.round(bounds.east * precision) / precision,
      Math.round(bounds.west * precision) / precision,
      Math.floor(zoom),
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      Math.floor(date.getMinutes() / 15)
    ].join('_');
  }

  /**
   */
  private getCoordinatePrecision(zoom: number): number {
    if (zoom >= 18) return 100000;
    if (zoom >= 15) return 10000;
    if (zoom >= 12) return 1000;
    return 100;
  }

  /**
   */
  private isSimilarBounds(
    bounds1: { north: number; south: number; east: number; west: number },
    bounds2: { north: number; south: number; east: number; west: number },
    tolerance = 0.001
  ): boolean {
    return Math.abs(bounds1.north - bounds2.north) < tolerance &&
           Math.abs(bounds1.south - bounds2.south) < tolerance &&
           Math.abs(bounds1.east - bounds2.east) < tolerance &&
           Math.abs(bounds1.west - bounds2.west) < tolerance;
  }

  /**
   */
  get(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): any | null {
    this.stats.totalRequests++;
    
    const key = this.generateKey(bounds, zoom, date);
    const item = this.cache.get(key);

    if (!item) {
      const similarItem = this.findSimilarCache(bounds, zoom, date);
      if (similarItem) {
        this.stats.hits++;
        this.updateStats();
        return similarItem.data;
      }

      this.stats.misses++;
      this.updateStats();
      return null;
    }

    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      this.updateStats();
      return null;
    }

    this.stats.hits++;
    this.updateStats();
    return item.data;
  }

  /**
   */
  private findSimilarCache(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date
  ): CacheItem | null {
    const targetZoom = Math.floor(zoom);
    const targetHour = date.getHours();
    const targetQuarter = Math.floor(date.getMinutes() / 15);

    for (const [key, item] of this.cache.entries()) {
      if (Date.now() - item.timestamp > this.ttl) {
        this.cache.delete(key);
        continue;
      }

      if (Math.abs(item.zoom - targetZoom) > 1) continue;

      const itemQuarter = Math.floor(item.date.minute / 15);
      if (Math.abs(item.date.hour - targetHour) > 1 ||
          (item.date.hour === targetHour && Math.abs(itemQuarter - targetQuarter) > 1)) {
        continue;
      }

      if (this.isSimilarBounds(bounds, item.viewBounds, 0.002)) {
        return item;
      }
    }

    return null;
  }

  /**
   */
  set(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date,
    data: any
  ): void {
    this.cleanup();

    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    const key = this.generateKey(bounds, zoom, date);
    const item: CacheItem = {
      data,
      timestamp: Date.now(),
      viewBounds: { ...bounds },
      zoom: Math.floor(zoom),
      date: {
        hour: date.getHours(),
        minute: date.getMinutes(),
        day: date.getDate()
      }
    };

    this.cache.set(key, item);
    this.updateStats();
    
  }

  /**
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > this.ttl) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key));
    
    if (keysToDelete.length > 0) {
    }
  }

  /**
   */
  private evictOldest(): void {
    let oldestKey = '';
    let oldestTime = Date.now();

    for (const [key, item] of this.cache.entries()) {
      if (item.timestamp < oldestTime) {
        oldestTime = item.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   */
  private updateStats(): void {
    this.stats.hitRate = this.stats.totalRequests > 0 ? 
      (this.stats.hits / this.stats.totalRequests) * 100 : 0;
    this.stats.cacheSize = this.cache.size;
  }

  /**
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   */
  clear(): void {
    this.cache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      totalRequests: 0,
      hitRate: 0,
      cacheSize: 0,
      lastCleanup: Date.now()
    };
  }

  /**
   */
  async preWarm(
    regions: Array<{
      bounds: { north: number; south: number; east: number; west: number };
      zoom: number;
    }>,
    calculateShadow: (bounds: any, zoom: number, date: Date) => Promise<any>
  ): Promise<void> {
    
    const currentDate = new Date();
    const hours = [8, 12, 16, 18];
    
    for (const region of regions) {
      for (const hour of hours) {
        const date = new Date(currentDate);
        date.setHours(hour, 0, 0, 0);
        
        try {
          const shadowData = await calculateShadow(region.bounds, region.zoom, date);
          this.set(region.bounds, region.zoom, date, shadowData);
        } catch (error) {
        }
      }
    }
    
  }
}

export const shadowCache = new ShadowCache();
