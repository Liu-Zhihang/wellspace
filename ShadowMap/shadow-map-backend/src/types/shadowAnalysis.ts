type GeoJsonGeometry = {
  type:
    | 'Point'
    | 'MultiPoint'
    | 'LineString'
    | 'MultiLineString'
    | 'Polygon'
    | 'MultiPolygon'
    | 'GeometryCollection';
  coordinates: unknown;
  geometries?: GeoJsonGeometry[];
};

type GeoJsonFeature = {
  type: 'Feature';
  geometry: GeoJsonGeometry;
  properties?: Record<string, unknown>;
};

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

export type BoundingBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type ShadowAnalysisRequestBody = {
  bbox: BoundingBox;
  timestamp: string;
  timeGranularityMinutes?: number;
  geometry?: GeoJsonFeature | GeoJsonFeatureCollection;
  outputs?: {
    shadowPolygons?: boolean;
    sunlightGrid?: boolean;
    heatmap?: boolean;
  };
  forceRefresh?: boolean;
  metadata?: Record<string, unknown>;
};

export type ShadowAnalysisLayer = ShadowFeatureCollection;
export type ShadowGeometry = GeoJsonGeometry;
export type ShadowFeature = GeoJsonFeature;
export type ShadowFeatureCollection = GeoJsonFeatureCollection & {
  metadata?: Record<string, unknown>;
};

export type ShadowCacheDescriptor = {
  key: string;
  hit: boolean;
  expiresAt?: string;
  bucketStart: string;
  bucketSizeMinutes: number;
  dimensions: string[];
};

export type ShadowAnalysisResponse = {
  requestId: string;
  bbox: BoundingBox;
  timestamp: string;
  bucketStart: string;
  bucketEnd: string;
  timeGranularityMinutes: number;
  cache: ShadowCacheDescriptor;
  metrics: {
    sampleCount: number;
    avgShadowPercent: number;
    avgSunlightHours: number;
    engineLatencyMs: number;
    engineVersion: string;
    source: 'cache' | 'engine';
    shadowAreaSqm?: number;
    bboxAreaSqm?: number;
    coverageSource?: 'area' | 'sample';
  };
  data: {
    shadows?: ShadowAnalysisLayer;
    sunlight?: ShadowAnalysisLayer;
    heatmap?: ShadowAnalysisLayer;
  };
  warnings?: string[];
  metadata?: Record<string, unknown>;
};

export type NormalizedShadowRequest = ShadowAnalysisRequestBody & {
  outputs: {
    shadowPolygons: boolean;
    sunlightGrid: boolean;
    heatmap: boolean;
  };
  timestampDate: Date;
  bucketStart: Date;
  bucketEnd: Date;
  timeGranularityMinutes: number;
  geometryHash: string | null;
};

export class ShadowAnalysisError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'ShadowAnalysisError';
    this.statusCode = statusCode;
    this.details = details;
  }
}
