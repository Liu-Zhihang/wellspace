/**
 * 性能优化工具类 - 用于阴影计算优化
 */

// 防抖函数 - 用于频繁的用户交互
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  immediate = false
): (...args: Parameters<T>) => void {
  let timeout: number | null = null;
  
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      if (!immediate) func(...args);
    };
    
    const callNow = immediate && !timeout;
    
    if (timeout !== null) {
      window.clearTimeout(timeout);
    }
    timeout = window.setTimeout(later, wait);
    
    if (callNow) func(...args);
  };
}

// 节流函数 - 用于控制更新频率
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      window.setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

// 智能节流 - 根据操作类型调整延迟
export function smartThrottle<T extends (...args: any[]) => any>(
  func: T,
  options: {
    move?: number;      // 地图移动延迟
    zoom?: number;      // 缩放延迟
    resize?: number;    // 窗口调整延迟
    default?: number;   // 默认延迟
  }
): {
  onMove: (...args: Parameters<T>) => void;
  onZoom: (...args: Parameters<T>) => void;
  onResize: (...args: Parameters<T>) => void;
  onDefault: (...args: Parameters<T>) => void;
} {
  return {
    onMove: throttle(func, options.move || 150),
    onZoom: throttle(func, options.zoom || 300),
    onResize: throttle(func, options.resize || 500),
    onDefault: throttle(func, options.default || 200),
  };
}

// 缓存管理器
export class ShadowCache {
  private cache = new Map<string, any>();
  private maxSize = 50; // 最大缓存项数
  private ttl = 5 * 60 * 1000; // 5分钟TTL

  // 生成缓存键
  generateKey(lat: number, lng: number, zoom: number, date: Date): string {
    return `${lat.toFixed(3)}_${lng.toFixed(3)}_${Math.floor(zoom)}_${date.getHours()}_${Math.floor(date.getMinutes()/30)}`;
  }

  // 获取缓存
  get(key: string): any | null {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  // 设置缓存
  set(key: string, data: any): void {
    // 清理旧缓存
    if (this.cache.size >= this.maxSize) {
      const oldestEntry = this.cache.keys().next().value as string | undefined;
      if (oldestEntry !== undefined) {
        this.cache.delete(oldestEntry);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  // 清空缓存
  clear(): void {
    this.cache.clear();
  }

  // 获取缓存统计
  getStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0 // TODO: 实现命中率统计
    };
  }
}

// 性能监控器
export class PerformanceMonitor {
  private metrics: Array<{
    operation: string;
    duration: number;
    timestamp: number;
  }> = [];

  private maxHistory = 100;

  // 开始计时
  start(): { end: (operation: string) => number } {
    const startTime = performance.now();
    
    return {
      end: (operation: string) => {
        const duration = performance.now() - startTime;
        
        this.metrics.push({
          operation,
          duration,
          timestamp: Date.now()
        });

        // 保持历史记录大小
        if (this.metrics.length > this.maxHistory) {
          this.metrics.shift();
        }

        return duration;
      }
    };
  }

  // 获取性能统计
  getStats(): {
    averageDuration: number;
    maxDuration: number;
    minDuration: number;
    recentOperations: number;
  } {
    if (this.metrics.length === 0) {
      return {
        averageDuration: 0,
        maxDuration: 0,
        minDuration: 0,
        recentOperations: 0
      };
    }

    const durations = this.metrics.map(m => m.duration);
    const recentMetrics = this.metrics.filter(
      m => Date.now() - m.timestamp < 60000 // 最近1分钟
    );

    return {
      averageDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxDuration: Math.max(...durations),
      minDuration: Math.min(...durations),
      recentOperations: recentMetrics.length
    };
  }

  // 清空统计
  clear(): void {
    this.metrics = [];
  }
}

// 创建全局实例
export const shadowCache = new ShadowCache();
export const performanceMonitor = new PerformanceMonitor();

// 优化建议函数
export function getOptimizationSuggestions(stats: {
  averageDuration: number;
  buildingCount: number;
  zoomLevel: number;
}): string[] {
  const suggestions: string[] = [];

  if (stats.averageDuration > 1000) {
    suggestions.push('Consider reducing building detail level');
    suggestions.push('Enable shadow caching');
  }

  if (stats.buildingCount > 500) {
    suggestions.push('Too many buildings - consider filtering by importance');
  }

  if (stats.zoomLevel < 14) {
    suggestions.push('Shadow calculation disabled at low zoom levels for performance');
  }

  return suggestions;
}
