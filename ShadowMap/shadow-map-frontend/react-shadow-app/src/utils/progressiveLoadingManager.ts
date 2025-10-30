/**
 */

interface LoadingStrategy {
  zoomRange: [number, number];
  dataQuality: 'low' | 'medium' | 'high' | 'ultra';
  buildingSimplification: number;
  shadowResolution: number;
  enableBuildingData: boolean;
  enableDEM: boolean;
  maxBuildingCount: number;
  calculationDelay: number;
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
   */
  private initializeStrategies(): void {
    this.strategies = [
      {
        zoomRange: [1, 10],
        dataQuality: 'low',
        buildingSimplification: 0.9,
        shadowResolution: 0.25,
        enableBuildingData: false,
        enableDEM: false,
        maxBuildingCount: 0,
        calculationDelay: 0
      },
      
      {
        zoomRange: [11, 13],
        dataQuality: 'low',
        buildingSimplification: 0.8,
        shadowResolution: 0.5,
        enableBuildingData: true,
        enableDEM: true,
        maxBuildingCount: 50,
        calculationDelay: 100
      },
      
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
      
      {
        zoomRange: [16, 17],
        dataQuality: 'high',
        buildingSimplification: 0.2,
        shadowResolution: 1.0,
        enableBuildingData: true,
        enableDEM: true,
        maxBuildingCount: 500,
        calculationDelay: 300
      },
      
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

  }

  /**
   */
  getOptimalStrategy(context: ProgressiveContext): LoadingStrategy {
    let baseStrategy = this.strategies.find(strategy => 
      context.zoom >= strategy.zoomRange[0] && context.zoom <= strategy.zoomRange[1]
    );

    if (!baseStrategy) {
      baseStrategy = context.zoom < 11 ? this.strategies[0] : this.strategies[this.strategies.length - 1];
    }

    const adjustedStrategy = this.adjustStrategyForDevice(baseStrategy, context);

    const optimizedStrategy = this.optimizeBasedOnMetrics(adjustedStrategy, context);

    this.currentStrategy = optimizedStrategy;
    
    return optimizedStrategy;
  }

  /**
   */
  private adjustStrategyForDevice(baseStrategy: LoadingStrategy, context: ProgressiveContext): LoadingStrategy {
    const adjusted = { ...baseStrategy };

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
        if (adjusted.dataQuality === 'medium') adjusted.dataQuality = 'high';
        adjusted.shadowResolution = Math.min(1, adjusted.shadowResolution * 1.1);
        break;
    }

    if (context.networkSpeed === 'slow') {
      adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 0.6);
      adjusted.calculationDelay += 300;
    }

    const viewportArea = context.viewportSize.width * context.viewportSize.height;
    if (viewportArea > 1920 * 1080) {
      adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 1.2);
    } else if (viewportArea < 800 * 600) {
      adjusted.maxBuildingCount = Math.floor(adjusted.maxBuildingCount * 0.7);
      adjusted.shadowResolution *= 0.8;
    }

    return adjusted;
  }

  /**
   */
  private optimizeBasedOnMetrics(strategy: LoadingStrategy, _context: ProgressiveContext): LoadingStrategy {
    if (this.performanceMetrics.totalCalculations < 5) {
      return strategy;
    }

    const optimized = { ...strategy };

    if (this.performanceMetrics.averageCalculationTime > 3000) {
      optimized.shadowResolution *= 0.8;
      optimized.maxBuildingCount = Math.floor(optimized.maxBuildingCount * 0.7);
      optimized.buildingSimplification = Math.min(1, optimized.buildingSimplification + 0.1);
    }

    if (this.performanceMetrics.failureRate > 0.2) {
      optimized.enableBuildingData = optimized.zoomRange[0] >= 14;
      optimized.maxBuildingCount = Math.floor(optimized.maxBuildingCount * 0.5);
    }

    return optimized;
  }

  /**
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

      if (strategy.enableBuildingData) {
        buildings = await dataLoader.loadBuildings(strategy.maxBuildingCount, strategy.buildingSimplification);
        
        if (buildings.length > strategy.maxBuildingCount) {
          buildings = this.prioritizeBuildings(buildings, strategy.maxBuildingCount);
        }
      }

      if (strategy.enableDEM) {
        dem = await dataLoader.loadDEM(strategy.shadowResolution);
      }

      if (strategy.calculationDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, strategy.calculationDelay));
      }

      if (buildings.length > 0 || dem) {
        shadows = await dataLoader.calculateShadows(buildings, dem, strategy.dataQuality);
      }

      const loadTime = performance.now() - startTime;
      
      this.updatePerformanceMetrics(loadTime, false);

      const metrics = {
        loadTime,
        buildingCount: buildings.length,
        quality: strategy.dataQuality
      };


      return {
        buildings,
        dem,
        shadows,
        appliedStrategy: strategy,
        metrics
      };

    } catch (error) {
      this.updatePerformanceMetrics(performance.now() - startTime, true);
      
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
   */
  private prioritizeBuildings(buildings: any[], maxCount: number): any[] {
    return buildings
      .sort((a, b) => {
        const aScore = (a.properties?.height || 10) * this.calculateBuildingArea(a.geometry);
        const bScore = (b.properties?.height || 10) * this.calculateBuildingArea(b.geometry);
        return bScore - aScore;
      })
      .slice(0, maxCount);
  }

  /**
   */
  private calculateBuildingArea(geometry: any): number {
    if (geometry.type !== 'Polygon' || !geometry.coordinates[0]) return 0;
    
    const coords = geometry.coordinates[0];
    let area = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      area += coords[i][0] * coords[i + 1][1] - coords[i + 1][0] * coords[i][1];
    }
    return Math.abs(area) / 2;
  }

  /**
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
   */
  private detectDeviceCapabilities(): void {
    const hardwareConcurrency = navigator.hardwareConcurrency || 2;
    const memory = (navigator as any).deviceMemory || 4;
    
    if (hardwareConcurrency >= 8 && memory >= 8) {
    } else if (hardwareConcurrency >= 4 && memory >= 4) {
    } else {
    }
  }

  /**
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
   */
  resetMetrics(): void {
    this.performanceMetrics = {
      averageCalculationTime: 0,
      totalCalculations: 0,
      failureRate: 0
    };
  }
}

export const progressiveLoadingManager = new ProgressiveLoadingManager();
