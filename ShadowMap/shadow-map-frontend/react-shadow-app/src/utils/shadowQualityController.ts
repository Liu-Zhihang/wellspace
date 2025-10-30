import type { BuildingFeature } from '../types/index.ts';

/**
 */

interface ShadowQualityConfig {
  zoom: number;
  minBuildingArea: number;
  minBuildingHeight: number;
  maxBuildingCount: number;
  shadowOpacity: number;
  shadowColor: string;
  shadowResolution: number;
  enableSmallBuildings: boolean;
}

export class ShadowQualityController {
  private readonly qualityLevels: Map<number, ShadowQualityConfig> = new Map();

  constructor() {
    this.initializeQualityLevels();
  }

  /**
   */
  private initializeQualityLevels(): void {
    const configs: Array<[number, ShadowQualityConfig]> = [
      [10, {
        zoom: 10,
        minBuildingArea: 1000,
        minBuildingHeight: 20,
        maxBuildingCount: 20,
        shadowOpacity: 0.4,
        shadowColor: '#2c3e50',
        shadowResolution: 0.5,
        enableSmallBuildings: false
      }],
      
      [14, {
        zoom: 14,
        minBuildingArea: 200,
        minBuildingHeight: 8,
        maxBuildingCount: 50,
        shadowOpacity: 0.5,
        shadowColor: '#34495e',
        shadowResolution: 0.7,
        enableSmallBuildings: false
      }],
      
      [16, {
        zoom: 16,
        minBuildingArea: 50,
        minBuildingHeight: 3,
        maxBuildingCount: 100,
        shadowOpacity: 0.6,
        shadowColor: '#2c3e50',
        shadowResolution: 0.8,
        enableSmallBuildings: true
      }],
      
      [18, {
        zoom: 18,
        minBuildingArea: 10,
        minBuildingHeight: 1,
        maxBuildingCount: 200,
        shadowOpacity: 0.65,
        shadowColor: '#1a252f',
        shadowResolution: 1.0,
        enableSmallBuildings: true
      }]
    ];

    configs.forEach(([zoom, config]) => {
      this.qualityLevels.set(zoom, config);
    });

  }

  /**
   */
  getQualityConfig(zoom: number): ShadowQualityConfig {
    const zoomLevels = Array.from(this.qualityLevels.keys()).sort((a, b) => a - b);
    
    let targetLevel = zoomLevels[0];
    for (const level of zoomLevels) {
      if (zoom >= level) {
        targetLevel = level;
      } else {
        break;
      }
    }
    
    const config = this.qualityLevels.get(targetLevel)!;
    
    return config;
  }

  /**
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

    enrichedBuildings.sort((a, b) => (b.properties.importance || 0) - (a.properties.importance || 0));

    const filtered = enrichedBuildings.filter((building, index) => {
      if (index >= config.maxBuildingCount) {
        return false;
      }
      
      const propsRecord = building.properties as Record<string, unknown>;
      const area = typeof propsRecord.area === 'number' ? propsRecord.area : 0;

      if (area < config.minBuildingArea) {
        stats.removedSmall++;
        return false;
      }
      
      const calculatedHeight = typeof propsRecord.calculatedHeight === 'number'
        ? propsRecord.calculatedHeight
        : 0;

      if (calculatedHeight < config.minBuildingHeight) {
        stats.removedLow++;
        return false;
      }
      
      if (!config.enableSmallBuildings && area < 100) {
        stats.removedSmall++;
        return false;
      }
      
      stats.keptLarge++;
      return true;
    });

    stats.filtered = filtered.length;

    
    return { filtered, stats };
  }

  /**
   */
  private calculateBuildingArea(geometry: any): number {
    if (geometry.type !== 'Polygon' || !geometry.coordinates[0]) return 0;
    
    const coords = geometry.coordinates[0];
    let area = 0;
    
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      area += x1 * y2 - x2 * y1;
    }
    
    const areaDegrees = Math.abs(area) / 2;
    const areaMeters = areaDegrees * 111000 * 111000;
    
    return areaMeters;
  }

  /**
   */
  private calculateBuildingImportance(building: BuildingFeature, area: number, height: number): number {
    let importance = 0;
    
    importance += Math.sqrt(area) * height * 0.1;
    
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
    
    if (building.properties?.name) {
      importance *= 1.5;
    }
    
    return importance;
  }

  /**
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
      blendMode: zoom < 16 ? 'multiply' : 'normal',
      antiAliasing: zoom >= 16
    };
  }

  /**
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
    
    if (buildingCount > 150) {
      issues.push(` (${buildingCount})`);
      recommendations.push('，');
    }
    
    if (averageBuildingArea < 50) {
      issues.push('，');
      recommendations.push('');
    }
    
    if (zoom > 17 && buildingCount > 100) {
      issues.push('');
      recommendations.push('zoom');
    }
    
    if (zoom < 15 && buildingCount > 50) {
      issues.push('');
      recommendations.push('zoom');
    }
    
    const suggestedSettings = {
      opacity: zoom > 16 ? 0.5 : 0.6,
      color: zoom > 16 ? '#2c3e50' : '#34495e',
      maxBuildings: zoom > 16 ? 100 : zoom > 14 ? 50 : 20
    };
    
    return { issues, recommendations, suggestedSettings };
  }
}

export const shadowQualityController = new ShadowQualityController();
