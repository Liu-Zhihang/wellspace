import type { Feature, FeatureCollection, Geometry } from 'geojson';

export type BoundingBox = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type BuildingProperties = {
  id?: string;
  buildingType?: string;
  height?: number;
  levels?: number;
  name?: string;
  render_height?: number;
  [key: string]: unknown;
};

export type BuildingFeature = Feature<Geometry, BuildingProperties>;

export type BuildingFeatureCollection = FeatureCollection<Geometry, BuildingProperties>;

export type BuildingServiceMetadata = {
  source?: string;
  bounds?: BoundingBox;
  totalFeatures?: number;
  numberMatched?: number;
  numberReturned?: number;
  timestamp?: string;
  [key: string]: unknown;
};

export type BuildingServiceResponse = {
  success: boolean;
  data: BuildingFeatureCollection & {
    metadata?: BuildingServiceMetadata;
  };
  metadata?: Record<string, unknown>;
  message?: string;
};

export type ShadowAnalysisPoint = {
  lat: number;
  lng: number;
  hoursOfSun: number;
  shadowPercent: number;
};

export type SunPosition = {
  altitude: number;
  azimuth: number;
};

export type ShadowAnalysisResult = {
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
};

export type ShadowSettings = {
  shadowResolution: number;
  shadowOpacity: number;
  buildingHeightMultiplier: number;
  enableSunPath: boolean;
  shadowColor: string;
  shadowBlur: number;
  enableShadowAnimation: boolean;
  showSunExposure: boolean;
  autoCloudAttenuation: boolean;
  manualSunlightFactor: number;
};

export type DataLayerType = 'shadows' | 'sunlight_hours' | 'annual_sunlight' | 'buildings' | 'terrain';

export type DataLayer = {
  id: DataLayerType;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  opacity: number;
  color?: string;
  renderMode: 'overlay' | 'heatmap' | 'vector';
};

export type MapSettings = {
  shadowColor: string;
  shadowOpacity: number;
  showShadowLayer: boolean;
  showBuildingLayer: boolean;
  showDEMLayer: boolean;
  showCacheStats: boolean;
  showSunExposure: boolean;
  enableBuildingFilter: boolean;
  enableDynamicQuality: boolean;
  autoOptimize?: boolean;
  dataLayers: { [K in DataLayerType]: DataLayer };
  activeDataLayer: DataLayerType;
};

export type TerrainSource = {
  tileSize: number;
  maxZoom: number;
  getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => string;
  getElevation: ({ r, g, b, a }: { r: number; g: number; b: number; a: number }) => number;
};

export type BuildingTileInfo = {
  z: number;
  x: number;
  y: number;
};

export type BuildingTileData = BuildingFeatureCollection & {
  bbox?: [number, number, number, number];
  tileInfo?: BuildingTileInfo;
  metadata?: Record<string, unknown>;
};

export type WeatherMetrics = {
  temperature: number;
  humidity: number;
  cloud_cover: number;
  uv_index: number;
  wind_speed: number;
  wind_direction: number;
  visibility: number;
  precipitation: number;
  pressure: number;
};

export type WeatherApiResponse = {
  location: {
    latitude: number;
    longitude: number;
  };
  timestamp: string;
  weather: WeatherMetrics;
  units: Record<string, string>;
};

export type WeatherSnapshot = {
  cloudCover: number | null;
  sunlightFactor: number;
  fetchedAt: Date | null;
  source?: string;
  raw?: WeatherMetrics | null;
};

export type UploadedGeometry = {
  id: string;
  name: string;
  feature: Feature<Geometry>;
  bbox: [number, number, number, number];
  area?: number;
  uploadedAt: Date;
  sourceFile?: string;
};

export type GeometryAnalysisSample = {
  lat: number;
  lng: number;
  shadowPercent: number;
  hoursOfSun: number;
};

export type GeometryAnalysisStats = {
  shadedRatio: number;
  avgSunlightHours: number;
  sampleCount: number;
  generatedAt: Date;
  notes?: string;
};

export type GeometryAnalysis = {
  geometryId: string;
  stats: GeometryAnalysisStats;
  samples?: GeometryAnalysisSample[];
};
