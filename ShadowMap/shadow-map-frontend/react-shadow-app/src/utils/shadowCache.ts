/**
 * 阴影计算智能缓存系统
 * 解决相同区域重复计算问题
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
  private maxSize = 50;           // 最大缓存项数
  private ttl = 10 * 60 * 1000;   // 10分钟TTL
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    totalRequests: 0,
    hitRate: 0,
    cacheSize: 0,
    lastCleanup: Date.now()
  };

  /**
   * 生成缓存键 - 基于地理位置、缩放级别和时间
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
      Math.floor(date.getMinutes() / 15) // 15分钟精度
    ].join('_');
  }

  /**
   * 根据缩放级别确定坐标精度
   */
  private getCoordinatePrecision(zoom: number): number {
    if (zoom >= 18) return 100000;      // 5位小数
    if (zoom >= 15) return 10000;       // 4位小数
    if (zoom >= 12) return 1000;        // 3位小数
    return 100;                         // 2位小数
  }

  /**
   * 检查两个边界框是否相似
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
   * 获取缓存数据
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
      // 尝试查找相似的缓存项
      const similarItem = this.findSimilarCache(bounds, zoom, date);
      if (similarItem) {
        console.log('🎯 找到相似缓存项');
        this.stats.hits++;
        this.updateStats();
        return similarItem.data;
      }

      this.stats.misses++;
      this.updateStats();
      return null;
    }

    // 检查TTL
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      this.updateStats();
      return null;
    }

    console.log(`🎯 缓存命中: ${key}`);
    this.stats.hits++;
    this.updateStats();
    return item.data;
  }

  /**
   * 查找相似的缓存项
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
      // 检查时间是否在有效范围内
      if (Date.now() - item.timestamp > this.ttl) {
        this.cache.delete(key);
        continue;
      }

      // 检查缩放级别
      if (Math.abs(item.zoom - targetZoom) > 1) continue;

      // 检查时间相似性（±15分钟）
      const itemQuarter = Math.floor(item.date.minute / 15);
      if (Math.abs(item.date.hour - targetHour) > 1 ||
          (item.date.hour === targetHour && Math.abs(itemQuarter - targetQuarter) > 1)) {
        continue;
      }

      // 检查地理边界相似性
      if (this.isSimilarBounds(bounds, item.viewBounds, 0.002)) {
        return item;
      }
    }

    return null;
  }

  /**
   * 设置缓存数据
   */
  set(
    bounds: { north: number; south: number; east: number; west: number },
    zoom: number,
    date: Date,
    data: any
  ): void {
    // 清理过期缓存
    this.cleanup();

    // 检查缓存大小
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
    
    console.log(`💾 缓存阴影数据: ${key} (size: ${this.cache.size})`);
  }

  /**
   * 清理过期缓存
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
      console.log(`🗑️ 清理过期缓存: ${keysToDelete.length} 项`);
    }
  }

  /**
   * 清理最旧的缓存项
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
      console.log(`♻️ 清理最旧缓存: ${oldestKey}`);
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(): void {
    this.stats.hitRate = this.stats.totalRequests > 0 ? 
      (this.stats.hits / this.stats.totalRequests) * 100 : 0;
    this.stats.cacheSize = this.cache.size;
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * 清空所有缓存
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
    console.log('🗑️ 清空阴影缓存');
  }

  /**
   * 预热缓存 - 预先计算常用区域
   */
  async preWarm(
    regions: Array<{
      bounds: { north: number; south: number; east: number; west: number };
      zoom: number;
    }>,
    calculateShadow: (bounds: any, zoom: number, date: Date) => Promise<any>
  ): Promise<void> {
    console.log(`🔥 开始预热缓存: ${regions.length} 个区域`);
    
    const currentDate = new Date();
    const hours = [8, 12, 16, 18]; // 常用时间点
    
    for (const region of regions) {
      for (const hour of hours) {
        const date = new Date(currentDate);
        date.setHours(hour, 0, 0, 0);
        
        try {
          const shadowData = await calculateShadow(region.bounds, region.zoom, date);
          this.set(region.bounds, region.zoom, date, shadowData);
        } catch (error) {
          console.warn('预热缓存失败:', error);
        }
      }
    }
    
    console.log('✅ 缓存预热完成');
  }
}

// 创建全局缓存实例
export const shadowCache = new ShadowCache();
