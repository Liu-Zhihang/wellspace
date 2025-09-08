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

export interface MapSettings {
  shadowColor: string;
  shadowOpacity: number;
  showShadowLayer: boolean;
  showBuildingLayer: boolean;
  showDEMLayer: boolean;
  showCacheStats: boolean;
}

export interface ShadowSettings {
  shadowResolution: number;
  shadowOpacity: number;
  buildingHeightMultiplier: number;
  enableSunPath: boolean;
  shadowColor: string;
  shadowBlur: number;
  enableShadowAnimation: boolean;
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
