/**
 */

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

export function smartThrottle<T extends (...args: any[]) => any>(
  func: T,
  options: {
    move?: number;      //
    zoom?: number;      //
    resize?: number;    //
    default?: number;   //
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

export class ShadowCache {
  private cache = new Map<string, any>();
  private maxSize = 50; //
  private ttl = 5 * 60 * 1000; // 5TTL

  generateKey(lat: number, lng: number, zoom: number, date: Date): string {
    return `${lat.toFixed(3)}_${lng.toFixed(3)}_${Math.floor(zoom)}_${date.getHours()}_${Math.floor(date.getMinutes()/30)}`;
  }

  get(key: string): any | null {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  set(key: string, data: any): void {
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

  clear(): void {
    this.cache.clear();
  }

  getStats(): {
    size: number;
    maxSize: number;
    hitRate: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0 // TODO:
    };
  }
}

export class PerformanceMonitor {
  private metrics: Array<{
    operation: string;
    duration: number;
    timestamp: number;
  }> = [];

  private maxHistory = 100;

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

        if (this.metrics.length > this.maxHistory) {
          this.metrics.shift();
        }

        return duration;
      }
    };
  }

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
      m => Date.now() - m.timestamp < 60000 // 1
    );

    return {
      averageDuration: durations.reduce((a, b) => a + b, 0) / durations.length,
      maxDuration: Math.max(...durations),
      minDuration: Math.min(...durations),
      recentOperations: recentMetrics.length
    };
  }

  clear(): void {
    this.metrics = [];
  }
}

export const shadowCache = new ShadowCache();
export const performanceMonitor = new PerformanceMonitor();

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
