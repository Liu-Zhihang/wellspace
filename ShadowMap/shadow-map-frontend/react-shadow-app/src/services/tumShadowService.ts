import { getTUMBuildings } from './tumBuildingService';
import * as SunCalc from 'suncalc';

export interface TUMShadowCalculationResult {
  shadows: any[];
  sunPosition: {
    altitude: number;
    azimuth: number;
  };
  calculationTime: number;
  buildingCount: number;
}

export interface ShadowBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export class TUMShadowService {
  private shadowCache = new Map<string, TUMShadowCalculationResult>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

  /**
   * 基于TUM数据计算实时阴影
   */
  async calculateRealTimeShadows(
    bounds: ShadowBounds,
    date: Date,
    zoom: number = 15
  ): Promise<TUMShadowCalculationResult> {
    const startTime = performance.now();
    
    // 验证输入参数
    if (!bounds || !date) {
      throw new Error('Invalid parameters: bounds and date are required');
    }
    
    console.log('🌅 开始TUM阴影计算，参数:', { bounds, date: date.toISOString(), zoom });
    
    // 生成缓存键
    const cacheKey = this.generateCacheKey(bounds, date, zoom);
    
    // 检查缓存
    const cached = this.shadowCache.get(cacheKey);
    if (cached && Date.now() - cached.calculationTime < this.CACHE_TTL) {
      console.log('🎯 使用缓存的TUM阴影数据');
      return cached;
    }

    try {
      console.log('🌅 开始基于TUM数据计算实时阴影...');
      
      // 1. 获取TUM建筑物数据
      const buildingData = await getTUMBuildings(bounds);
      
      if (!buildingData.success || !buildingData.data.features.length) {
        throw new Error('未获取到TUM建筑物数据');
      }

      const buildings = buildingData.data.features;
      console.log(`🏢 获取到 ${buildings.length} 个TUM建筑物`);

      // 2. 计算太阳位置
      const sunPosition = this.calculateSunPosition(bounds, date);
      console.log(`☀️ 太阳位置: 高度角 ${sunPosition.altitude.toFixed(1)}°, 方位角 ${sunPosition.azimuth.toFixed(1)}°`);

      // 3. 计算每个建筑物的阴影
      const shadows = this.calculateBuildingShadows(buildings, sunPosition, date);

      const calculationTime = performance.now() - startTime;
      
      const result: TUMShadowCalculationResult = {
        shadows,
        sunPosition,
        calculationTime,
        buildingCount: buildings.length
      };

      // 缓存结果
      this.shadowCache.set(cacheKey, result);
      
      console.log(`✅ TUM阴影计算完成: ${shadows.length} 个阴影, 用时 ${calculationTime.toFixed(0)}ms`);
      
      return result;

    } catch (error) {
      console.error('❌ TUM阴影计算失败:', error);
      throw error;
    }
  }

  /**
   * 计算太阳位置
   */
  private calculateSunPosition(bounds: ShadowBounds, date: Date): { altitude: number; azimuth: number } {
    // 使用边界中心点计算太阳位置
    const lat = (bounds.north + bounds.south) / 2;
    const lng = (bounds.east + bounds.west) / 2;
    
    const sunPosition = SunCalc.getPosition(date, lat, lng);
    
    return {
      altitude: (sunPosition.altitude * 180) / Math.PI, // 转换为度
      azimuth: ((sunPosition.azimuth * 180) / Math.PI + 180) % 360 // 转换为度并调整
    };
  }

  /**
   * 计算建筑物阴影
   */
  private calculateBuildingShadows(
    buildings: any[],
    sunPosition: { altitude: number; azimuth: number },
    date: Date
  ): any[] {
    const shadows: any[] = [];
    
    buildings.forEach((building, index) => {
      try {
        const shadow = this.calculateSingleBuildingShadow(building, sunPosition, date);
        if (shadow) {
          shadows.push(shadow);
        }
      } catch (error) {
        console.warn(`⚠️ 建筑物 ${index} 阴影计算失败:`, error);
      }
    });

    return shadows;
  }

  /**
   * 计算单个建筑物的阴影
   */
  private calculateSingleBuildingShadow(
    building: any,
    sunPosition: { altitude: number; azimuth: number },
    date: Date
  ): any | null {
    if (!building.geometry || !building.properties) return null;

    const height = building.properties.height || 20;
    const geometry = building.geometry;
    
    // 太阳高度角太低，不产生阴影
    if (sunPosition.altitude <= 0) return null;

    // 计算阴影长度
    const shadowLength = height / Math.tan((sunPosition.altitude * Math.PI) / 180);
    
    // 计算阴影方向（方位角）
    const shadowDirection = (sunPosition.azimuth + 180) % 360;
    const shadowDirectionRad = (shadowDirection * Math.PI) / 180;

    // 计算阴影偏移
    const offsetX = shadowLength * Math.sin(shadowDirectionRad);
    const offsetY = shadowLength * Math.cos(shadowDirectionRad);

    // 根据几何类型处理阴影
    let shadowGeometry;
    
    if (geometry.type === 'Polygon') {
      shadowGeometry = this.calculatePolygonShadow(geometry.coordinates[0], offsetX, offsetY);
    } else if (geometry.type === 'MultiPolygon') {
      const shadowCoordinates = geometry.coordinates.map((polygon: any) => 
        polygon.map((ring: any) => 
          this.calculatePolygonShadow(ring, offsetX, offsetY)
        )
      );
      shadowGeometry = {
        type: 'MultiPolygon',
        coordinates: shadowCoordinates
      };
    } else {
      return null; // 不支持其他几何类型
    }

    return {
      type: 'Feature',
      geometry: shadowGeometry,
      properties: {
        buildingId: building.properties.id || `building_${Date.now()}_${Math.random()}`,
        buildingHeight: height,
        shadowLength: shadowLength,
        sunAltitude: sunPosition.altitude,
        sunAzimuth: sunPosition.azimuth,
        calculationTime: date.toISOString(),
        source: 'TUM'
      }
    };
  }

  /**
   * 计算多边形阴影
   */
  private calculatePolygonShadow(
    coordinates: number[][],
    offsetX: number,
    offsetY: number
  ): number[][] {
    return coordinates.map(coord => [
      coord[0] + offsetX,
      coord[1] + offsetY
    ]);
  }

  /**
   * 生成缓存键
   */
  private generateCacheKey(bounds: ShadowBounds, date: Date, zoom: number): string {
    // 添加防护性检查
    if (!bounds || typeof bounds.north !== 'number' || typeof bounds.south !== 'number' || 
        typeof bounds.east !== 'number' || typeof bounds.west !== 'number') {
      console.error('❌ 无效的边界数据:', bounds);
      throw new Error('Invalid bounds data for cache key generation');
    }
    
    if (!date || !(date instanceof Date)) {
      console.error('❌ 无效的日期数据:', date);
      throw new Error('Invalid date data for cache key generation');
    }
    
    const timeKey = Math.floor(date.getTime() / (15 * 60 * 1000)); // 15分钟精度
    return `${bounds.north.toFixed(4)}_${bounds.south.toFixed(4)}_${bounds.east.toFixed(4)}_${bounds.west.toFixed(4)}_${timeKey}_${zoom}`;
  }

  /**
   * 清理过期缓存
   */
  clearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.shadowCache.entries()) {
      if (now - value.calculationTime > this.CACHE_TTL) {
        this.shadowCache.delete(key);
      }
    }
    console.log(`🧹 清理过期缓存，剩余 ${this.shadowCache.size} 个缓存项`);
  }

  /**
   * 清空所有缓存
   */
  clearAllCache(): void {
    this.shadowCache.clear();
    console.log('🧹 已清空所有TUM阴影缓存');
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; ttl: number } {
    return {
      size: this.shadowCache.size,
      ttl: this.CACHE_TTL
    };
  }
}

// 导出单例实例
export const tumShadowService = new TUMShadowService();
