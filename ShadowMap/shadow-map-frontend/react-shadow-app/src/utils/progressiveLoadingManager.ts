/**
 * 渐进式加载管理器
 * 针对不同zoom level使用不同的计算策略和数据源
 * 解决shademap在不同缩放级别下的性能差距
 */

interface LoadingStrategy {
  zoomRange: [number, number];
  dataQuality: 'low' | 'medium' | 'high' | 'ultra';
  buildingSimplification: number; // 建筑物简化程度 0-1
  shadowResolution: number;       // 阴影分辨率
  enableBuildingData: boolean;    // 是否加载建筑物数据
  enableDEM: boolean;             // 是否加载地形数据
  maxBuildingCount: number;       // 最大建筑物数量
  calculationDelay: number;       // 计算延迟（ms）
}

interface ProgressiveContext {
  zoom: number;
  bounds: { north: number; south: number; east: number; west: number };
  viewportSize: { width: number; height: number };
  devicePerformance: 'low' | 'medium' | 'high';
  networkSpeed: 'slow' | 'fast';
}

export class ProgressiveLoadingManager {
  private strategies: LoadingStrategy[] = [];
  private currentStrategy: LoadingStrategy | null = null;
  private performanceMetrics = {
    averageCalculationTime: 0,
    totalCalculations: 0,
    failureRate: 0
  };

  constructor() {
    this.initializeStrategies();
    this.detectDeviceCapabilities();
  }

  /**
   * 初始化加载策略
   */
  private initializeStrategies(): void {
    this.strategies = [
      // 🔍 极低缩放 (1-10) - 概览模式，仅显示基础阴影
      {
        zoomRange: [1, 10],
        dataQuality: 'low',
        buildingSimplification: 0.9,
        shadowResolution: 0.25, // 1/4分辨率
        enableBuildingData: false, // 不加载建筑物
        enableDEM: false,         // 不加载地形
        maxBuildingCount: 0,
        calculationDelay: 0
      },
      
      // 🏙️ 低缩放 (11-13) - 城市级别，简化建筑物
      {
        zoomRange: [11, 13],
        dataQuality: 'low',
        buildingSimplification: 0.8,
        shadowResolution: 0.5, // 1/2分辨率
        enableBuildingData: true,
        enableDEM: true,
        maxBuildingCount: 50,
        calculationDelay: 100
      },
      
      // 🏘️ 中缩放 (14-15) - 街区级别，中等质量
      {
        zoomRange: [14, 15],
        dataQuality: 'medium',
        buildingSimplification: 0.5,
        shadowResolution: 0.75,
        enableBuildingData: true,
        enableDEM: true,
        maxBuildingCount: 200,
        calculationDelay: 200
      },
      
      // 🏠 高缩放 (16-17) - 建筑物级别，高质量
      {
        zoomRange: [16, 17],
        dataQuality: 'high',
        buildingSimplification: 0.2,
        shadowResolution: 1.0, // 全分辨率
        enableBuildingData: true,
        enableDEM: true,
        maxBuildingCount: 500,
        calculationDelay: 300
      },
      
      // 🔬 超高缩放 (18+) - 细节级别，超高质量
      {
        zoomRange: [18, 20],
        dataQuality: 'ultra',
        buildingSimplification: 0,
        shadowResolution: 1.0,
        enableBuildingData: true,
        enableDEM: true,
        maxBuildingCount: 1000,
        calculationDelay: 500
      }
    ];

    console.log('📊 渐进式加载策略已初始化:', this.strategies.length, '个策略');
  }

  /**
   * 获取当前zoom level的最优策略
   */
  getOptimalStrategy(context: ProgressiveContext): LoadingStrategy {
    // 1. 根据zoom level找到基础策略
    let baseStrategy = this.strategies.find(strategy => 
      context.zoom >= strategy.zoomRange[0] && context.zoom <= strategy.zoomRange[1]
    );

    if (!baseStrategy) {
      // 如果没有匹配的策略，使用最接近的
      baseStrategy = context.zoom < 11 ? this.strategies[0] : this.strategies[this.strategies.length - 1];
    }

    // 2. 根据设备性能和网络状况调整策略
    const adjustedStrategy = this.adjustStrategyForDevice(baseStrategy, context);

    // 3. 根据历史性能指标微调
    const optimizedStrategy = this.optimizeBasedOnMetrics(adjustedStrategy, context);

    this.currentStrategy = optimizedStrategy;
    console.log(`🎯 选择渐进式策略: zoom=${context.zoom}, 质量=${optimizedStrategy.dataQuality}, 建筑物=${optimizedStrategy.maxBuildingCount}`);
    
    return optimizedStrategy;
  }

  /**
   * 根据设备能力调整策略
   */
  private adjustStrategyForDevice(baseStrategy: LoadingStrategy, context: ProgressiveContext): LoadingStrategy {
    const adjusted = { ...baseStrategy };

    // 根据设备性能调整
    switch (context.devicePerformance) {
      case 'low':
        adjusted.shadowResolution *= 0.7;
        adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 0.5);
        adjusted.buildingSimplification = Math.min(1, adjusted.buildingSimplification + 0.2);
        adjusted.calculationDelay += 200;
        break;
        
      case 'medium':
        adjusted.shadowResolution *= 0.85;
        adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 0.75);
        adjusted.calculationDelay += 100;
        break;
        
      case 'high':
        // 高性能设备可以使用更高质量
        if (adjusted.dataQuality === 'medium') adjusted.dataQuality = 'high';
        adjusted.shadowResolution = Math.min(1, adjusted.shadowResolution * 1.1);
        break;
    }

    // 根据网络速度调整
    if (context.networkSpeed === 'slow') {
      adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 0.6);
      adjusted.calculationDelay += 300;
    }

    // 根据视口大小调整
    const viewportArea = context.viewportSize.width * context.viewportSize.height;
    if (viewportArea > 1920 * 1080) {
      // 大屏幕，可以显示更多细节
      adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 1.2);
    } else if (viewportArea < 800 * 600) {
      // 小屏幕，减少详细程度
      adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 0.7);
      adjusted.shadowResolution *= 0.8;
    }

    return adjusted;
  }

  /**
   * 基于性能指标优化策略
   */
  private optimizeBasedOnMetrics(strategy: LoadingStrategy, _context: ProgressiveContext): LoadingStrategy {
    if (this.performanceMetrics.totalCalculations < 5) {
      return strategy; // 数据不足，不进行优化
    }

    const optimized = { ...strategy };

    // 如果平均计算时间过长，降低质量
    if (this.performanceMetrics.averageCalculationTime > 3000) {
      console.log('⚡ 检测到性能问题，降低质量');
      optimized.shadowResolution *= 0.8;
      optimized.maxBuildingCount = Math.floor(optimized.maxBuildingCount * 0.7);
      optimized.buildingSimplification = Math.min(1, optimized.buildingSimplification + 0.1);
    }

    // 如果失败率过高，使用更保守的策略
    if (this.performanceMetrics.failureRate > 0.2) {
      console.log('🛡️ 检测到高失败率，使用保守策略');
      optimized.enableBuildingData = optimized.zoomRange[0] >= 14; // 只在高缩放启用建筑物
      optimized.maxBuildingCount = Math.floor(optimized.maxBuildingCount * 0.5);
    }

    return optimized;
  }

  /**
   * 应用策略到数据加载
   */
  async applyStrategy(
    strategy: LoadingStrategy,
    dataLoader: {
      loadBuildings: (maxCount: number, simplification: number) => Promise<any[]>;
      loadDEM: (resolution: number) => Promise<any>;
      calculateShadows: (buildings: any[], dem: any, quality: string) => Promise<any>;
    }
  ): Promise<{
    buildings: any[];
    dem: any;
    shadows: any;
    appliedStrategy: LoadingStrategy;
    metrics: { loadTime: number; buildingCount: number; quality: string };
  }> {
    const startTime = performance.now();
    let buildings: any[] = [];
    let dem: any = null;
    let shadows: any = null;

    try {
      console.log(`🚀 应用渐进式加载策略: ${strategy.dataQuality} 质量`);

      // 1. 根据策略加载建筑物数据
      if (strategy.enableBuildingData) {
        console.log(`🏗️ 加载建筑物: 最大${strategy.maxBuildingCount}个, 简化${strategy.buildingSimplification}`);
        buildings = await dataLoader.loadBuildings(strategy.maxBuildingCount, strategy.buildingSimplification);
        
        // 应用建筑物数量限制
        if (buildings.length > strategy.maxBuildingCount) {
          buildings = this.prioritizeBuildings(buildings, strategy.maxBuildingCount);
        }
      }

      // 2. 根据策略加载地形数据
      if (strategy.enableDEM) {
        console.log(`🗻 加载地形数据: 分辨率${strategy.shadowResolution}`);
        dem = await dataLoader.loadDEM(strategy.shadowResolution);
      }

      // 3. 添加策略延迟
      if (strategy.calculationDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, strategy.calculationDelay));
      }

      // 4. 计算阴影
      if (buildings.length > 0 || dem) {
        console.log(`🌅 计算阴影: ${strategy.dataQuality} 质量`);
        shadows = await dataLoader.calculateShadows(buildings, dem, strategy.dataQuality);
      }

      const loadTime = performance.now() - startTime;
      
      // 更新性能指标
      this.updatePerformanceMetrics(loadTime, false);

      const metrics = {
        loadTime,
        buildingCount: buildings.length,
        quality: strategy.dataQuality
      };

      console.log(`✅ 渐进式加载完成: ${loadTime.toFixed(0)}ms, ${buildings.length} 建筑物, ${strategy.dataQuality} 质量`);

      return {
        buildings,
        dem,
        shadows,
        appliedStrategy: strategy,
        metrics
      };

    } catch (error) {
      console.error('❌ 渐进式加载失败:', error);
      this.updatePerformanceMetrics(performance.now() - startTime, true);
      
      // 返回降级结果
      return {
        buildings: [],
        dem: null,
        shadows: null,
        appliedStrategy: strategy,
        metrics: {
          loadTime: performance.now() - startTime,
          buildingCount: 0,
          quality: 'low'
        }
      };
    }
  }

  /**
   * 建筑物优先级排序
   */
  private prioritizeBuildings(buildings: any[], maxCount: number): any[] {
    // 按建筑物大小和高度排序，优先显示重要建筑物
    return buildings
      .sort((a, b) => {
        const aScore = (a.properties?.height || 10) * this.calculateBuildingArea(a.geometry);
        const bScore = (b.properties?.height || 10) * this.calculateBuildingArea(b.geometry);
        return bScore - aScore;
      })
      .slice(0, maxCount);
  }

  /**
   * 计算建筑物面积
   */
  private calculateBuildingArea(geometry: any): number {
    if (geometry.type !== 'Polygon' || !geometry.coordinates[0]) return 0;
    
    // 简单的多边形面积计算
    const coords = geometry.coordinates[0];
    let area = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      area += coords[i][0] * coords[i + 1][1] - coords[i + 1][0] * coords[i][1];
    }
    return Math.abs(area) / 2;
  }

  /**
   * 更新性能指标
   */
  private updatePerformanceMetrics(calculationTime: number, failed: boolean): void {
    this.performanceMetrics.totalCalculations++;
    
    if (failed) {
      this.performanceMetrics.failureRate = 
        (this.performanceMetrics.failureRate * (this.performanceMetrics.totalCalculations - 1) + 1) / 
        this.performanceMetrics.totalCalculations;
    } else {
      this.performanceMetrics.averageCalculationTime = 
        (this.performanceMetrics.averageCalculationTime * (this.performanceMetrics.totalCalculations - 1) + calculationTime) / 
        this.performanceMetrics.totalCalculations;
    }
  }

  /**
   * 检测设备能力
   */
  private detectDeviceCapabilities(): void {
    // 这里可以实现设备性能检测逻辑
    // 目前使用简单的启发式方法
    const hardwareConcurrency = navigator.hardwareConcurrency || 2;
    const memory = (navigator as any).deviceMemory || 4;
    
    if (hardwareConcurrency >= 8 && memory >= 8) {
      console.log('🚀 检测到高性能设备');
    } else if (hardwareConcurrency >= 4 && memory >= 4) {
      console.log('⚡ 检测到中等性能设备');
    } else {
      console.log('🐌 检测到低性能设备');
    }
  }

  /**
   * 获取性能统计
   */
  getPerformanceStats(): {
    averageCalculationTime: number;
    totalCalculations: number;
    failureRate: number;
    currentStrategy: LoadingStrategy | null;
  } {
    return {
      ...this.performanceMetrics,
      currentStrategy: this.currentStrategy
    };
  }

  /**
   * 重置性能指标
   */
  resetMetrics(): void {
    this.performanceMetrics = {
      averageCalculationTime: 0,
      totalCalculations: 0,
      failureRate: 0
    };
    console.log('🔄 性能指标已重置');
  }
}

// 导出全局实例
export const progressiveLoadingManager = new ProgressiveLoadingManager();
