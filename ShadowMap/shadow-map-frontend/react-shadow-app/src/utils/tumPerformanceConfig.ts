/**
 * TUM数据性能优化配置
 * 针对不同缩放级别和场景优化数据获取和渲染性能
 */

export interface TUMPerformanceConfig {
  // 数据获取配置
  dataFetching: {
    maxFeatures: number;
    cacheTimeout: number;
    retryAttempts: number;
    requestTimeout: number;
  };
  
  // 渲染配置
  rendering: {
    enableLOD: boolean; // 细节层次
    minZoomForBuildings: number;
    minZoomForShadows: number;
    maxBuildingsPerTile: number;
    shadowQuality: 'low' | 'medium' | 'high';
  };
  
  // 缓存配置
  caching: {
    enableMemoryCache: boolean;
    enableLocalStorage: boolean;
    maxCacheSize: number;
    cacheExpiry: number;
  };
  
  // 阴影计算配置
  shadowCalculation: {
    enableCaching: boolean;
    cachePrecision: number; // 米
    maxShadowDistance: number; // 米
    shadowUpdateInterval: number; // 毫秒
  };
}

// 默认性能配置
export const defaultTUMPerformanceConfig: TUMPerformanceConfig = {
  dataFetching: {
    maxFeatures: 5000,  // 调整为5000，减少分页次数
    cacheTimeout: 30000, // 30秒
    retryAttempts: 3,
    requestTimeout: 10000, // 10秒
  },
  
  rendering: {
    enableLOD: true,
    minZoomForBuildings: 14,
    minZoomForShadows: 15,
    maxBuildingsPerTile: 500,
    shadowQuality: 'medium',
  },
  
  caching: {
    enableMemoryCache: true,
    enableLocalStorage: true,
    maxCacheSize: 50, // MB
    cacheExpiry: 5 * 60 * 1000, // 5分钟
  },
  
  shadowCalculation: {
    enableCaching: true,
    cachePrecision: 10, // 10米精度
    maxShadowDistance: 200, // 200米最大阴影距离
    shadowUpdateInterval: 1000, // 1秒更新间隔
  },
};

// 根据缩放级别获取优化配置
export function getOptimizedConfigForZoom(zoom: number): Partial<TUMPerformanceConfig> {
  if (zoom < 12) {
    // 低缩放级别 - 性能优先
    return {
      dataFetching: {
        maxFeatures: 100,
        cacheTimeout: 60000,
        retryAttempts: 2,
        requestTimeout: 5000,
      },
      rendering: {
        enableLOD: true,
        minZoomForBuildings: 14,
        minZoomForShadows: 16,
        maxBuildingsPerTile: 50,
        shadowQuality: 'low',
      },
    };
  } else if (zoom < 15) {
    // 中等缩放级别 - 平衡
    return {
      dataFetching: {
        maxFeatures: 500,
        cacheTimeout: 30000,
        retryAttempts: 3,
        requestTimeout: 8000,
      },
      rendering: {
        enableLOD: true,
        minZoomForBuildings: 14,
        minZoomForShadows: 15,
        maxBuildingsPerTile: 200,
        shadowQuality: 'medium',
      },
    };
  } else {
    // 高缩放级别 - 质量优先
    return {
      dataFetching: {
        maxFeatures: 2000,
        cacheTimeout: 15000,
        retryAttempts: 3,
        requestTimeout: 12000,
      },
      rendering: {
        enableLOD: false,
        minZoomForBuildings: 14,
        minZoomForShadows: 15,
        maxBuildingsPerTile: 1000,
        shadowQuality: 'high',
      },
    };
  }
}

// 根据设备性能调整配置
export function getDeviceOptimizedConfig(): Partial<TUMPerformanceConfig> {
  const isLowEndDevice = navigator.hardwareConcurrency <= 2 || 
                        navigator.deviceMemory <= 4 ||
                        /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  if (isLowEndDevice) {
    return {
      dataFetching: {
        maxFeatures: 200,
        cacheTimeout: 60000,
        retryAttempts: 2,
        requestTimeout: 8000,
      },
      rendering: {
        enableLOD: true,
        minZoomForBuildings: 15,
        minZoomForShadows: 16,
        maxBuildingsPerTile: 100,
        shadowQuality: 'low',
      },
      caching: {
        enableMemoryCache: true,
        enableLocalStorage: false,
        maxCacheSize: 10,
        cacheExpiry: 2 * 60 * 1000,
      },
    };
  }

  return defaultTUMPerformanceConfig;
}

// 性能监控工具
export class TUMPerformanceMonitor {
  private metrics: Map<string, number[]> = new Map();
  private startTimes: Map<string, number> = new Map();

  startTiming(operation: string): void {
    this.startTimes.set(operation, performance.now());
  }

  endTiming(operation: string): number {
    const startTime = this.startTimes.get(operation);
    if (!startTime) return 0;

    const duration = performance.now() - startTime;
    this.startTimes.delete(operation);

    // 记录指标
    if (!this.metrics.has(operation)) {
      this.metrics.set(operation, []);
    }
    this.metrics.get(operation)!.push(duration);

    // 只保留最近100次记录
    const records = this.metrics.get(operation)!;
    if (records.length > 100) {
      records.splice(0, records.length - 100);
    }

    return duration;
  }

  getAverageTime(operation: string): number {
    const records = this.metrics.get(operation);
    if (!records || records.length === 0) return 0;

    return records.reduce((sum, time) => sum + time, 0) / records.length;
  }

  getMetrics(): { [operation: string]: { average: number; count: number; latest: number } } {
    const result: { [operation: string]: { average: number; count: number; latest: number } } = {};
    
    for (const [operation, records] of this.metrics.entries()) {
      result[operation] = {
        average: this.getAverageTime(operation),
        count: records.length,
        latest: records[records.length - 1] || 0,
      };
    }

    return result;
  }

  clearMetrics(): void {
    this.metrics.clear();
    this.startTimes.clear();
  }
}

// 导出性能监控单例
export const tumPerformanceMonitor = new TUMPerformanceMonitor();
