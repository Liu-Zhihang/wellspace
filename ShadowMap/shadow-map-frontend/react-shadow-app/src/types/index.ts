export interface Building {
  type: 'Feature';
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
  properties: {
    id: string;
    buildingType: string;
    height: number;
    levels?: number;
  };
}

export interface BuildingTileData {
  type: 'FeatureCollection';
  features: Building[];
  bbox: [number, number, number, number];
  tileInfo: {
    z: number;
    x: number;
    y: number;
  };
}

export interface ShadowAnalysisPoint {
  lat: number;
  lng: number;
  hoursOfSun: number;
  shadowPercent: number;
}

export interface ShadowAnalysisResult {
  center: [number, number];
  radius: number;
  samplePoints: ShadowAnalysisPoint[];
  buildingCount?: number;
  averageHeight?: number;
  maxHeight?: number;
  minHeight?: number;
  stats: {
    avgHoursOfSun: number;
    avgShadowPercent: number;
    maxShadowPercent: number;
    minShadowPercent: number;
    stdDev: number;
    shadowLevels: {
      无阴影: number;
      轻微阴影: number;
      中等阴影: number;
      重度阴影: number;
      极重阴影: number;
    };
  };
  metadata: {
    date: Date;
    sampleCount: number;
  };
}

// 数据层类型枚举
export type DataLayerType = 'shadows' | 'sunlight_hours' | 'annual_sunlight' | 'buildings' | 'terrain';

// 数据层配置接口
export interface DataLayer {
  id: DataLayerType;
  name: string;
  description: string;
  icon: string; // 图标URL或emoji
  enabled: boolean;
  opacity: number;
  color?: string;
  renderMode: 'overlay' | 'heatmap' | 'vector';
}

export interface MapSettings {
  // 传统设置（保持兼容性）
  shadowColor: string;
  shadowOpacity: number;
  showShadowLayer: boolean;
  showBuildingLayer: boolean;
  showDEMLayer: boolean;
  showCacheStats: boolean;
  showSunExposure: boolean;
  // 🔧 新增：建筑物筛选控制
  enableBuildingFilter: boolean;
  // 🔧 新增：动态质量控制
  enableDynamicQuality: boolean;
  
  // 新的数据层系统
  dataLayers: {
    [K in DataLayerType]: DataLayer;
  };
  
  // 当前活跃的数据层
  activeDataLayer: DataLayerType;
}

export interface ShadowSettings {
  shadowResolution: number;
  shadowOpacity: number;
  buildingHeightMultiplier: number;
  enableSunPath: boolean;
  shadowColor: string;
  shadowBlur: number;
  enableShadowAnimation: boolean;
  showSunExposure: boolean; // 太阳曝光热力图开关
}

export interface SunPosition {
  altitude: number;
  azimuth: number;
}

export interface TerrainSource {
  tileSize: number;
  maxZoom: number;
  getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => string;
  getElevation: ({ r, g, b, a }: { r: number; g: number; b: number; a: number }) => number;
}
