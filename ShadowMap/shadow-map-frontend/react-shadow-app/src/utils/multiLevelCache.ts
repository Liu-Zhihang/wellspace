/**
 * 多级智能缓存系统
 * 解决相同区域重复计算的问题，实现预测性缓存
 */

interface CacheItem<T> {
  data: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
  priority: number;
  size: number; // 估算数据大小（字节）
}

interface CacheConfig {
  maxMemorySize: number;     // 最大内存使用（字节）
  maxItems: number;          // 最大缓存项数
  defaultTTL: number;        // 默认TTL（毫秒）
  enablePredictive: boolean; // 启用预测性缓存
  compressionThreshold: number; // 压缩阈值（字节）
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
  private accessPatterns = new Map<string, number[]>(); // 访问模式记录
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
    defaultTTL: 15 * 60 * 1000, // 15分钟
    enablePredictive: true,
    compressionThreshold: 100 * 1024 // 100KB
  };

  constructor(config?: Partial<CacheConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    
    // 定期清理过期数据
    setInterval(() => this.cleanup(), 5 * 60 * 1000); // 5分钟
    
    console.log('🗃️ 多级缓存系统初始化:', this.config);
  }

  /**
   * 获取缓存数据
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

    // 更新访问信息
    item.accessCount++;
    item.lastAccess = Date.now();
    item.priority = this.calculatePriority(item);

    this.stats.hits++;
    this.recordAccess(key, true);
    this.updateStats();
    
    // 触发预测性缓存
    if (this.config.enablePredictive) {
      this.triggerPredictiveCache(key);
    }

    console.log(`🎯 缓存命中: ${key} (访问${item.accessCount}次)`);
    return item.data;
  }

  /**
   * 设置缓存数据
   */
  set(key: string, data: T, _ttl?: number): void {
    const size = this.estimateSize(data);
    const now = Date.now();
    
    // 检查是否需要腾出空间
    this.ensureSpace(size);
    
    const item: CacheItem<T> = {
      data,
      timestamp: now,
      accessCount: 1,
      lastAccess: now,
      priority: 1,
      size
    };

    // 如果数据很大，考虑压缩
    if (size > this.config.compressionThreshold) {
      item.data = this.compressData(data);
      console.log(`🗜️ 压缩大数据: ${key} (${size} -> ${this.estimateSize(item.data)} bytes)`);
    }

    this.cache.set(key, item);
    this.stats.totalMemoryUsage += size;
    this.stats.itemCount++;
    
    console.log(`💾 缓存存储: ${key} (${this.formatBytes(size)})`);
    this.updateStats();
  }

  /**
   * 预测性缓存
   */
  private triggerPredictiveCache(accessedKey: string): void {
    if (this.pendingPredictions.has(accessedKey)) return;
    
    // 基于访问模式预测下一个可能访问的键
    const predictions = this.predictNextAccess(accessedKey);
    
    predictions.forEach(predictedKey => {
      if (!this.cache.has(predictedKey) && !this.pendingPredictions.has(predictedKey)) {
        this.pendingPredictions.add(predictedKey);
        
        // 异步预加载（需要外部提供数据加载函数）
        setTimeout(() => {
          this.loadPredictedData(predictedKey);
        }, 100);
      }
    });
  }

  /**
   * 预测下一个访问的键
   */
  private predictNextAccess(currentKey: string): string[] {
    const predictions: string[] = [];
    
    // 1. 空间邻近性预测（相邻区域）
    const spatialPredictions = this.generateSpatialPredictions(currentKey);
    predictions.push(...spatialPredictions);
    
    // 2. 时间模式预测（基于历史访问）
    const accessHistory = this.accessPatterns.get(currentKey) || [];
    if (accessHistory.length >= 3) {
      const temporalPredictions = this.generateTemporalPredictions(currentKey, accessHistory);
      predictions.push(...temporalPredictions);
    }
    
    return predictions.slice(0, 3); // 限制预测数量
  }

  /**
   * 生成空间相邻的缓存键
   */
  private generateSpatialPredictions(key: string): string[] {
    // 假设缓存键格式为: "bounds_zoom_date"
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
      
      // 生成相邻区域的键
      const adjacentRegions = [
        [n + latSpan, n, e, w],           // 北
        [s, s - latSpan, e, w],           // 南
        [n, s, e + lngSpan, e],           // 东
        [n, s, w, w - lngSpan]            // 西
      ];
      
      adjacentRegions.forEach(([newN, newS, newE, newW]) => {
        const newKey = [newN, newS, newE, newW, z, ...rest].join('_');
        predictions.push(newKey);
      });
      
    } catch (error) {
      console.warn('空间预测失败:', error);
    }
    
    return predictions;
  }

  /**
   * 生成时间模式预测
   */
  private generateTemporalPredictions(_key: string, accessHistory: number[]): string[] {
    // 基于访问间隔预测下一次访问时间
    const intervals = [];
    for (let i = 1; i < accessHistory.length; i++) {
      intervals.push(accessHistory[i] - accessHistory[i - 1]);
    }
    
    if (intervals.length === 0) {
      return [];
    }

    // TODO(@future): 使用平均间隔生成真正的预测键
    return [];
  }

  /**
   * 确保有足够空间
   */
  private ensureSpace(requiredSize: number): void {
    while (
      (this.stats.totalMemoryUsage + requiredSize > this.config.maxMemorySize) ||
      (this.stats.itemCount >= this.config.maxItems)
    ) {
      const evicted = this.evictLeastUseful();
      if (!evicted) break; // 无法再释放空间
    }
  }

  /**
   * 驱逐最不有用的缓存项
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
      
      console.log(`🗑️ 驱逐缓存: ${leastUsefulKey} (优先级: ${lowestPriority.toFixed(2)})`);
      return true;
    }
    
    return false;
  }

  /**
   * 计算缓存项优先级
   */
  private calculatePriority(item: CacheItem<T>): number {
    const age = Date.now() - item.timestamp;
    const lastAccessAge = Date.now() - item.lastAccess;
    
    // 优先级公式：访问频率 / (年龄 + 最后访问时间)
    const frequency = item.accessCount / Math.max(1, age / (60 * 1000)); // 每分钟访问次数
    const recency = 1 / Math.max(1, lastAccessAge / (60 * 1000)); // 最近访问的倒数
    
    return frequency * 0.7 + recency * 0.3;
  }

  /**
   * 估算数据大小
   */
  private estimateSize(data: T): number {
    try {
      return JSON.stringify(data).length * 2; // 粗略估算（UTF-16）
    } catch {
      return 1024; // 默认1KB
    }
  }

  /**
   * 压缩数据（简单实现）
   */
  private compressData(data: T): T {
    // 这里可以实现实际的压缩逻辑
    // 目前返回原数据
    return data;
  }

  /**
   * 记录访问模式
   */
  private recordAccess(key: string, hit: boolean): void {
    if (!hit) return; // 只记录命中的访问
    
    const history = this.accessPatterns.get(key) || [];
    history.push(Date.now());
    
    // 只保留最近10次访问记录
    if (history.length > 10) {
      history.shift();
    }
    
    this.accessPatterns.set(key, history);
  }

  /**
   * 清理过期数据
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
      console.log(`🧹 清理过期缓存: ${cleanedCount} 项 (${this.formatBytes(cleanedSize)})`);
      this.updateStats();
    }
  }

  /**
   * 更新统计信息
   */
  private updateStats(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 外部数据加载接口
   */
  private async loadPredictedData(key: string): Promise<void> {
    // 这需要外部提供数据加载函数
    // 目前只是清理预测标记
    setTimeout(() => {
      this.pendingPredictions.delete(key);
    }, 5000);
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats & { config: CacheConfig } {
    return {
      ...this.stats,
      config: this.config
    };
  }

  /**
   * 清空缓存
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
    console.log('🗑️ 清空多级缓存');
  }

  /**
   * 预热缓存
   */
  async warmup(keys: string[], dataLoader: (key: string) => Promise<T>): Promise<void> {
    console.log(`🔥 开始缓存预热: ${keys.length} 项`);
    
    const promises = keys.map(async (key) => {
      try {
        if (!this.cache.has(key)) {
          const data = await dataLoader(key);
          this.set(key, data);
        }
      } catch (error) {
        console.warn(`预热失败: ${key}`, error);
      }
    });
    
    await Promise.allSettled(promises);
    console.log('✅ 缓存预热完成');
  }
}

// 导出全局实例
export const buildingCache = new MultiLevelCache({
  maxMemorySize: 30 * 1024 * 1024, // 30MB
  maxItems: 150,
  defaultTTL: 20 * 60 * 1000,     // 20分钟
  enablePredictive: true
});

export const shadowCache = new MultiLevelCache({
  maxMemorySize: 20 * 1024 * 1024, // 20MB  
  maxItems: 100,
  defaultTTL: 15 * 60 * 1000,      // 15分钟
  enablePredictive: true
});
