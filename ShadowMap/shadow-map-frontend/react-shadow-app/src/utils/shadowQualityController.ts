import type { BuildingFeature } from '../types/index.ts';

/**
 * 阴影质量控制器
 * 解决阴影"脏"和密密麻麻的问题
 */

interface ShadowQualityConfig {
  zoom: number;
  minBuildingArea: number;      // 最小建筑面积阈值
  minBuildingHeight: number;    // 最小建筑高度阈值  
  maxBuildingCount: number;     // 最大建筑数量
  shadowOpacity: number;        // 动态阴影透明度
  shadowColor: string;          // 动态阴影颜色
  shadowResolution: number;     // 阴影分辨率系数
  enableSmallBuildings: boolean; // 是否显示小建筑
}

export class ShadowQualityController {
  private readonly qualityLevels: Map<number, ShadowQualityConfig> = new Map();

  constructor() {
    this.initializeQualityLevels();
  }

  /**
   * 初始化不同zoom级别的质量配置
   */
  private initializeQualityLevels(): void {
    // 🔧 分级质量配置 - 解决密密麻麻问题
    const configs: Array<[number, ShadowQualityConfig]> = [
      // 低缩放 (10-13) - 只显示大型建筑，避免密集阴影
      [10, {
        zoom: 10,
        minBuildingArea: 1000,        // 只显示1000m²以上建筑
        minBuildingHeight: 20,        // 只显示20m以上建筑
        maxBuildingCount: 20,         // 最多20个建筑
        shadowOpacity: 0.4,           // 低透明度，避免重叠过深
        shadowColor: '#2c3e50',       // 较浅的灰蓝色
        shadowResolution: 0.5,        // 低分辨率，避免过度细节
        enableSmallBuildings: false
      }],
      
      // 中低缩放 (14-15) - 显示主要建筑，适度阴影
      [14, {
        zoom: 14,
        minBuildingArea: 200,         // 200m²以上建筑
        minBuildingHeight: 8,         // 8m以上建筑  
        maxBuildingCount: 50,         // 最多50个建筑
        shadowOpacity: 0.5,           // 中等透明度
        shadowColor: '#34495e',       // 中等深度灰色
        shadowResolution: 0.7,        // 中等分辨率
        enableSmallBuildings: false
      }],
      
      // 中缩放 (16-17) - 显示大部分建筑，清晰阴影
      [16, {
        zoom: 16,
        minBuildingArea: 50,          // 50m²以上建筑
        minBuildingHeight: 3,         // 3m以上建筑
        maxBuildingCount: 100,        // 最多100个建筑
        shadowOpacity: 0.6,           // 适中透明度
        shadowColor: '#2c3e50',       // 标准阴影色
        shadowResolution: 0.8,        // 较高分辨率
        enableSmallBuildings: true
      }],
      
      // 高缩放 (18+) - 显示所有建筑，高质量阴影
      [18, {
        zoom: 18,
        minBuildingArea: 10,          // 10m²以上建筑
        minBuildingHeight: 1,         // 1m以上建筑
        maxBuildingCount: 200,        // 最多200个建筑
        shadowOpacity: 0.65,          // 适当透明度
        shadowColor: '#1a252f',       // 深色但不过深
        shadowResolution: 1.0,        // 全分辨率
        enableSmallBuildings: true
      }]
    ];

    configs.forEach(([zoom, config]) => {
      this.qualityLevels.set(zoom, config);
    });

    console.log('🎨 阴影质量配置已初始化:', this.qualityLevels.size, '个级别');
  }

  /**
   * 获取当前zoom级别的质量配置
   */
  getQualityConfig(zoom: number): ShadowQualityConfig {
    // 找到最接近的配置级别
    const zoomLevels = Array.from(this.qualityLevels.keys()).sort((a, b) => a - b);
    
    let targetLevel = zoomLevels[0]; // 默认最低级别
    for (const level of zoomLevels) {
      if (zoom >= level) {
        targetLevel = level;
      } else {
        break;
      }
    }
    
    const config = this.qualityLevels.get(targetLevel)!;
    console.log(`🎯 zoom ${zoom} 使用质量配置: 级别${targetLevel} (最大${config.maxBuildingCount}建筑, 透明度${config.shadowOpacity})`);
    
    return config;
  }

  /**
   * 智能过滤建筑物 - 解决密密麻麻问题
   */
  filterBuildings(buildings: BuildingFeature[], zoom: number): {
    filtered: BuildingFeature[];
    stats: {
      original: number;
      filtered: number;
      removedSmall: number;
      removedLow: number;
      keptLarge: number;
    };
  } {
    const config = this.getQualityConfig(zoom);
    
    const stats = {
      original: buildings.length,
      filtered: 0,
      removedSmall: 0,
      removedLow: 0,
      keptLarge: 0
    };

    // 1. 计算建筑物面积和优先级
    const enrichedBuildings = buildings.map(building => {
      const area = this.calculateBuildingArea(building.geometry);
      const height = typeof building.properties?.height === 'number'
        ? building.properties.height
        : building.properties?.levels
          ? building.properties.levels * 3.5
          : 8;
      const importance = this.calculateBuildingImportance(building, area, height);

      const properties = {
        ...building.properties,
        area,
        calculatedHeight: height,
        importance,
      } as BuildingFeature['properties'] & {
        area: number;
        calculatedHeight: number;
        importance: number;
      };

      return {
        ...building,
        properties,
      };
    });

    // 2. 按重要性排序
    enrichedBuildings.sort((a, b) => (b.properties.importance || 0) - (a.properties.importance || 0));

    // 3. 应用过滤条件
    const filtered = enrichedBuildings.filter((building, index) => {
      // 数量限制
      if (index >= config.maxBuildingCount) {
        return false;
      }
      
      // 面积过滤
      const propsRecord = building.properties as Record<string, unknown>;
      const area = typeof propsRecord.area === 'number' ? propsRecord.area : 0;

      if (area < config.minBuildingArea) {
        stats.removedSmall++;
        return false;
      }
      
      // 高度过滤
      const calculatedHeight = typeof propsRecord.calculatedHeight === 'number'
        ? propsRecord.calculatedHeight
        : 0;

      if (calculatedHeight < config.minBuildingHeight) {
        stats.removedLow++;
        return false;
      }
      
      // 小建筑物控制
      if (!config.enableSmallBuildings && area < 100) {
        stats.removedSmall++;
        return false;
      }
      
      stats.keptLarge++;
      return true;
    });

    stats.filtered = filtered.length;

    console.log(`🔧 建筑物过滤完成: ${stats.original} → ${stats.filtered} (移除${stats.removedSmall}小型, ${stats.removedLow}低矮)`);
    
    return { filtered, stats };
  }

  /**
   * 计算建筑物面积
   */
  private calculateBuildingArea(geometry: any): number {
    if (geometry.type !== 'Polygon' || !geometry.coordinates[0]) return 0;
    
    // 使用鞋带公式计算多边形面积
    const coords = geometry.coordinates[0];
    let area = 0;
    
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      area += x1 * y2 - x2 * y1;
    }
    
    // 转换为平方米（粗略估算）
    const areaDegrees = Math.abs(area) / 2;
    const areaMeters = areaDegrees * 111000 * 111000; // 1度约111km
    
    return areaMeters;
  }

  /**
   * 计算建筑物重要性评分
   */
  private calculateBuildingImportance(building: BuildingFeature, area: number, height: number): number {
    let importance = 0;
    
    // 1. 基础评分：面积 × 高度
    importance += Math.sqrt(area) * height * 0.1;
    
    // 2. 建筑类型加权
    const buildingType = building.properties?.buildingType || 'building';
    const typeWeights: { [key: string]: number } = {
      'tower': 10,
      'skyscraper': 10, 
      'office': 5,
      'commercial': 4,
      'hospital': 4,
      'school': 3,
      'residential': 2,
      'apartments': 2,
      'house': 1,
      'garage': 0.5,
      'shed': 0.2
    };
    
    importance *= typeWeights[buildingType] || 1;
    
    // 3. 名称加权（有名称的建筑通常更重要）
    if (building.properties?.name) {
      importance *= 1.5;
    }
    
    return importance;
  }

  /**
   * 生成优化的阴影配置
   */
  getOptimizedShadowSettings(zoom: number): {
    color: string;
    opacity: number;
    resolution: number;
    blendMode?: string;
    antiAliasing: boolean;
  } {
    const config = this.getQualityConfig(zoom);
    
    return {
      color: config.shadowColor,
      opacity: config.shadowOpacity,
      resolution: config.shadowResolution,
      blendMode: zoom < 16 ? 'multiply' : 'normal', // 低zoom使用混合模式柔化
      antiAliasing: zoom >= 16 // 高zoom启用抗锯齿
    };
  }

  /**
   * 诊断阴影质量问题
   */
  diagnoseShadowQuality(
    zoom: number, 
    buildingCount: number, 
    averageBuildingArea: number
  ): {
    issues: string[];
    recommendations: string[];
    suggestedSettings: {
      opacity: number;
      color: string;
      maxBuildings: number;
    };
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    // 诊断建筑物密度问题
    if (buildingCount > 150) {
      issues.push(`建筑物数量过多 (${buildingCount}个)`);
      recommendations.push('建议启用建筑物过滤，只显示重要建筑');
    }
    
    if (averageBuildingArea < 50) {
      issues.push('建筑物平均面积过小，产生碎片化阴影');
      recommendations.push('建议增加最小建筑面积阈值');
    }
    
    // 诊断zoom级别问题
    if (zoom > 17 && buildingCount > 100) {
      issues.push('高缩放级别下建筑密度过高');
      recommendations.push('建议在高zoom下降低阴影透明度');
    }
    
    if (zoom < 15 && buildingCount > 50) {
      issues.push('低缩放级别显示过多建筑细节');
      recommendations.push('建议在低zoom下只显示大型建筑');
    }
    
    // 生成建议设置
    const suggestedSettings = {
      opacity: zoom > 16 ? 0.5 : 0.6,
      color: zoom > 16 ? '#2c3e50' : '#34495e',
      maxBuildings: zoom > 16 ? 100 : zoom > 14 ? 50 : 20
    };
    
    return { issues, recommendations, suggestedSettings };
  }
}

// 导出全局实例
export const shadowQualityController = new ShadowQualityController();
