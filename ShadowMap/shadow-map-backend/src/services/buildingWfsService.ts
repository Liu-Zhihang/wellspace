/**
 * Building WFS service
 * Utilities for interacting with the GeoServer WFS endpoint that stores building footprints.
 */

import axios from 'axios';
import {
  resolveTilesForBounds,
  shouldRequireTileMatch
} from './tileCatalogService';

export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface WfsBuildingFeature {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
  properties: Record<string, any>;
}

export interface WfsBuildingResponse {
  type: 'FeatureCollection';
  features: WfsBuildingFeature[];
  totalFeatures?: number;
  numberMatched?: number;
  numberReturned?: number;
  axisOrderUsed?: AxisOrder;
}

type AxisOrder = 'lonlat' | 'latlon';
type AxisOrderPreference = AxisOrder | 'auto';

const BUILDING_WFS_VERSION = (process.env['BUILDING_WFS_VERSION'] ?? '1.1.0').trim();
const AXIS_ORDER_PREFERENCE: AxisOrderPreference = (() => {
  const raw = (process.env['BUILDING_WFS_AXIS_ORDER'] ?? 'auto').trim().toLowerCase();
  if (raw === 'lonlat' || raw === 'latlon') {
    return raw;
  }
  return 'auto';
})();

const DEFAULT_AXIS_ORDER: AxisOrder = ['1.1.0', '2.0.0'].includes(BUILDING_WFS_VERSION) ? 'latlon' : 'lonlat';
const RESOLVED_AXIS_ORDER: AxisOrder =
  AXIS_ORDER_PREFERENCE === 'auto' ? DEFAULT_AXIS_ORDER : AXIS_ORDER_PREFERENCE;
const FALLBACK_AXIS_ORDER: AxisOrder = RESOLVED_AXIS_ORDER === 'latlon' ? 'lonlat' : 'latlon';

const BUILDING_WFS_CONFIG = {
  baseUrl: process.env['BUILDING_WFS_BASE_URL'] ?? 'http://10.13.12.164:8080/geoserver/shadowmap/wfs',
  typeName: process.env['BUILDING_WFS_TYPE_NAME'] ?? 'shadowmap:buildings',
  version: BUILDING_WFS_VERSION,
  outputFormat: process.env['BUILDING_WFS_OUTPUT_FORMAT'] ?? 'application/json',
  srsName: process.env['BUILDING_WFS_SRS_NAME'] ?? 'EPSG:4326',
  maxFeatures: Number(process.env['BUILDING_WFS_MAX_FEATURES'] ?? 50000),
  timeout: Number(process.env['BUILDING_WFS_TIMEOUT_MS'] ?? 30_000),
  paginationDelayMs: Number(process.env['BUILDING_WFS_PAGINATION_DELAY_MS'] ?? 50),
  geometryProperty: process.env['BUILDING_WFS_GEOMETRY_PROPERTY'] ?? 'geom',
  tileIdProperty: process.env['BUILDING_WFS_TILE_ID_PROP'] ?? 'tile_id',
  tileId: process.env['BUILDING_WFS_TILE_ID'],
  axisOrderPreference: AXIS_ORDER_PREFERENCE,
  axisOrder: RESOLVED_AXIS_ORDER,
  fallbackAxisOrder: FALLBACK_AXIS_ORDER,
  useAxisFallback: AXIS_ORDER_PREFERENCE === 'auto'
};

console.log(
  `[BuildingWfs] Config axis=${BUILDING_WFS_CONFIG.axisOrder} ` +
    `fallback=${BUILDING_WFS_CONFIG.useAxisFallback ? BUILDING_WFS_CONFIG.fallbackAxisOrder : 'disabled'} ` +
    `geometry=${BUILDING_WFS_CONFIG.geometryProperty}`
);

const REQUEST_HEADERS = {
  'User-Agent': 'ShadowMap/1.0',
  Accept: 'application/json'
};

function coerceBoundingBox(bounds: BoundingBox): BoundingBox {
  return {
    north: Number(bounds.north),
    south: Number(bounds.south),
    east: Number(bounds.east),
    west: Number(bounds.west)
  };
}

function escapeCqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function formatBBox(bounds: BoundingBox, axisOrder: AxisOrder): string {
  const coerced = coerceBoundingBox(bounds);
  const south = coerced.south;
  const west = coerced.west;
  const north = coerced.north;
  const east = coerced.east;

  if (axisOrder === 'latlon') {
    return `${south},${west},${north},${east},${BUILDING_WFS_CONFIG.srsName}`;
  }

  return `${west},${south},${east},${north},${BUILDING_WFS_CONFIG.srsName}`;
}

function buildRequestUrl(
  bounds: BoundingBox,
  maxFeatures: number | undefined,
  startIndex: number | undefined,
  axisOrder: AxisOrder,
  tileIds: string[]
): string {
  const params: Record<string, string> = {
    service: 'WFS',
    version: BUILDING_WFS_CONFIG.version,
    request: 'GetFeature',
    typeName: BUILDING_WFS_CONFIG.typeName,
    outputFormat: BUILDING_WFS_CONFIG.outputFormat,
    srsName: BUILDING_WFS_CONFIG.srsName,
    maxFeatures: String(Math.min(maxFeatures ?? BUILDING_WFS_CONFIG.maxFeatures, BUILDING_WFS_CONFIG.maxFeatures))
  };

  const { west, south, east, north } = coerceBoundingBox(bounds);
  const bboxArgs =
    axisOrder === 'latlon'
      ? `${south},${west},${north},${east}`
      : `${west},${south},${east},${north}`;

  const filters: string[] = [
    `BBOX(${BUILDING_WFS_CONFIG.geometryProperty},${bboxArgs},'${BUILDING_WFS_CONFIG.srsName}')`
  ];

  if (tileIds.length > 0) {
    const sanitized = tileIds.map(escapeCqlLiteral);
    const tileFilter =
      tileIds.length === 1
        ? `${BUILDING_WFS_CONFIG.tileIdProperty}='${sanitized[0]}'`
        : `${BUILDING_WFS_CONFIG.tileIdProperty} IN (${sanitized
            .map(id => `'${id}'`)
            .join(',')})`;
    filters.push(tileFilter);
  }

  params['cql_filter'] = filters.join(' AND ');

  const query = new URLSearchParams(params);

  if (startIndex !== undefined && startIndex > 0) {
    query.set('startIndex', String(startIndex));
  }

  const url = `${BUILDING_WFS_CONFIG.baseUrl}?${query.toString()}`;
  console.log(
    `[BuildingWfs] Built WFS URL (${axisOrder}, tiles=${tileIds.length > 0 ? tileIds.join(',') : 'none'}): ${url}`
  );
  return url;
}

function estimateHeight(properties: Record<string, any>): number {
  const heightCandidate = Number(properties.height ?? properties.buildingHeight ?? properties.h);
  if (!Number.isNaN(heightCandidate) && heightCandidate > 0) {
    return heightCandidate;
  }

  const areaCandidate = Number(
    properties.area ??
      properties.footprint_area ??
      properties.geom_area ??
      properties['@area'] ??
      properties['shm_area']
  );

  if (!Number.isNaN(areaCandidate) && areaCandidate > 0) {
    // Use footprint area to approximate height; tuned for dense urban blocks.
    return Math.min(Math.max(Math.sqrt(areaCandidate) * 0.12, 5), 60);
  }

  return 12; // Default average height for mid-rise buildings.
}

function normalizeFeature(feature: WfsBuildingFeature, index: number) {
  const height = estimateHeight(feature.properties);

  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      id: feature.properties.id ?? feature.properties.objectid ?? `building_${index}`,
      height,
      levels: Math.max(1, Math.round(height / 3)),
      area:
        Number(
          feature.properties.area ??
            feature.properties.footprint_area ??
            feature.properties.geom_area
        ) || 0,
      source: 'shadowmap-wfs',
      buildingType: feature.properties.building_type ?? feature.properties.function ?? 'building',
      rawProperties: feature.properties
    }
  };
}

async function fetchWfsBuildingsOnce(
  bounds: BoundingBox,
  maxFeatures: number | undefined,
  axisOrder: AxisOrder,
  tileIds: string[]
): Promise<WfsBuildingResponse> {
  const url = buildRequestUrl(bounds, maxFeatures, undefined, axisOrder, tileIds);
  console.log(
    `[BuildingWfs] Requesting buildings with axis=${axisOrder} tiles=${tileIds.join(',') || 'none'} bbox=${formatBBox(bounds, axisOrder)} maxFeatures=${maxFeatures ?? BUILDING_WFS_CONFIG.maxFeatures}`
  );

  try {
    const response = await axios.get<WfsBuildingResponse>(url, {
      timeout: BUILDING_WFS_CONFIG.timeout,
      headers: REQUEST_HEADERS
    });

    if (response.status !== 200) {
      throw new Error(`Unexpected status code ${response.status}`);
    }

    const payload = response.data ?? { type: 'FeatureCollection', features: [] };
    const featureCount = payload.features?.length ?? 0;
    console.log(
      `[BuildingWfs] Received ${featureCount} features (reported total=${payload.totalFeatures ?? payload.numberMatched ?? 'n/a'}) using axis=${axisOrder}`
    );
    if (featureCount === 0) {
      console.warn('[BuildingWfs] Empty feature collection returned.', {
        hasFeaturesArray: Array.isArray(payload.features),
        rawKeys: Object.keys(payload ?? {}),
        axisOrder
      });
      try {
        const preview = JSON.stringify(payload).slice(0, 600);
        console.warn('[BuildingWfs] Response preview (truncated to 600 chars):', preview);
      } catch {
        console.warn('[BuildingWfs] Response preview unavailable (non-serializable payload).');
      }
    }

    return {
      type: 'FeatureCollection',
      features: payload.features ?? [],
      totalFeatures: payload.totalFeatures ?? payload.numberMatched ?? featureCount,
      numberMatched: payload.numberMatched ?? payload.totalFeatures ?? featureCount,
      numberReturned: featureCount,
      axisOrderUsed: axisOrder
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error(
          `[BuildingWfs] Request failed with status=${error.response.status} (axis=${axisOrder})`,
          error.response.data
        );
      } else if (error.request) {
        console.error('[BuildingWfs] Request was sent but no response was received', error.message);
      } else {
        console.error('[BuildingWfs] Failed to prepare request', error.message);
      }
    } else {
      console.error('[BuildingWfs] Unexpected error while fetching data', error);
    }

    throw error;
  }
}

export async function fetchWfsBuildings(bounds: BoundingBox, maxFeatures?: number): Promise<WfsBuildingResponse> {
  const primaryAxis = BUILDING_WFS_CONFIG.axisOrder;
  const fallbackAxis = BUILDING_WFS_CONFIG.fallbackAxisOrder;
  const { tileIds } = resolveTilesForBounds(bounds);

  if (tileIds.length === 0 && shouldRequireTileMatch()) {
    console.warn(
      '[BuildingWfs] Tile match is required but no tiles matched bounds; returning empty response',
      { bounds }
    );
    return {
      type: 'FeatureCollection',
      features: [],
      totalFeatures: 0,
      numberMatched: 0,
      numberReturned: 0,
      axisOrderUsed: primaryAxis
    };
  }

  try {
    const primaryResult = await fetchWfsBuildingsOnce(bounds, maxFeatures, primaryAxis, tileIds);
    if (
      BUILDING_WFS_CONFIG.useAxisFallback &&
      primaryResult.numberReturned === 0
    ) {
      console.warn(
        `[BuildingWfs] Axis order ${primaryAxis} returned zero features; retrying with ${fallbackAxis}`
      );
      const fallbackResult = await fetchWfsBuildingsOnce(bounds, maxFeatures, fallbackAxis, tileIds);
      return fallbackResult.numberReturned && fallbackResult.numberReturned > 0 ? fallbackResult : primaryResult;
    }

    return primaryResult;
  } catch (primaryError) {
    if (!BUILDING_WFS_CONFIG.useAxisFallback) {
      throw primaryError;
    }

    console.warn(
      `[BuildingWfs] Primary axis order ${primaryAxis} failed (${primaryError instanceof Error ? primaryError.message : 'unknown error'}); retrying with ${fallbackAxis}`
    );
    const fallbackResult = await fetchWfsBuildingsOnce(bounds, maxFeatures, fallbackAxis, tileIds);
    return fallbackResult;
  }
}

export function convertWfsToStandardGeoJSON(wfsResponse: WfsBuildingResponse) {
  const normalizedFeatures = (wfsResponse.features ?? []).map(normalizeFeature);

  return {
    type: 'FeatureCollection' as const,
    features: normalizedFeatures,
    metadata: {
      source: 'shadowmap-wfs',
      totalFeatures: wfsResponse.totalFeatures ?? normalizedFeatures.length,
      numberMatched: wfsResponse.numberMatched ?? normalizedFeatures.length,
      numberReturned: normalizedFeatures.length,
      generatedAt: new Date().toISOString()
    }
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWfsBuildingsPaginatedOnce(
  bounds: BoundingBox,
  maxFeaturesPerRequest: number,
  axisOrder: AxisOrder,
  tileIds: string[]
): Promise<WfsBuildingResponse> {
  const safeMax = Math.max(1, Math.min(maxFeaturesPerRequest, BUILDING_WFS_CONFIG.maxFeatures));
  const aggregated: WfsBuildingFeature[] = [];
  let startIndex = 0;
  let reportedTotal = 0;

  console.log(
    `[BuildingWfs] Paging buildings with axis=${axisOrder} tiles=${tileIds.join(',') || 'none'} bbox=${formatBBox(bounds, axisOrder)} pageSize=${safeMax}`
  );

  while (aggregated.length < BUILDING_WFS_CONFIG.maxFeatures) {
    const url = buildRequestUrl(bounds, safeMax, startIndex, axisOrder, tileIds);

    try {
      const response = await axios.get<WfsBuildingResponse>(url, {
        timeout: BUILDING_WFS_CONFIG.timeout,
        headers: REQUEST_HEADERS
      });

      if (response.status !== 200) {
        console.error(
          `[BuildingWfs] Pagination stopped due to HTTP ${response.status} (axis=${axisOrder})`
        );
        break;
      }

      const page = response.data ?? { type: 'FeatureCollection', features: [] };
      const pageFeatures = page.features ?? [];

      if (pageFeatures.length === 0) {
        console.log('[BuildingWfs] No more features returned; stopping pagination.', { axisOrder });
        try {
          const preview = JSON.stringify(page).slice(0, 600);
          console.warn('[BuildingWfs] Pagination response preview (truncated to 600 chars):', preview);
        } catch {
          console.warn('[BuildingWfs] Pagination response preview unavailable (non-serializable payload).');
        }
        break;
      }

      aggregated.push(...pageFeatures);
      reportedTotal = page.totalFeatures ?? page.numberMatched ?? reportedTotal;

      console.log(
        `[BuildingWfs] Page startIndex=${startIndex} returned ${pageFeatures.length} features (accumulated=${aggregated.length}) axis=${axisOrder}`
      );

      if (pageFeatures.length < safeMax) {
        break;
      }

      startIndex += safeMax;
      await sleep(BUILDING_WFS_CONFIG.paginationDelayMs);
    } catch (error) {
      console.error('[BuildingWfs] Pagination request failed', error);
      throw error;
    }
  }

  return {
    type: 'FeatureCollection',
    features: aggregated,
    totalFeatures: reportedTotal || aggregated.length,
    numberMatched: reportedTotal || aggregated.length,
    numberReturned: aggregated.length,
    axisOrderUsed: axisOrder
  };
}

export async function fetchWfsBuildingsPaginated(
  bounds: BoundingBox,
  maxFeaturesPerRequest: number = 5000
): Promise<WfsBuildingResponse> {
  const primaryAxis = BUILDING_WFS_CONFIG.axisOrder;
  const fallbackAxis = BUILDING_WFS_CONFIG.fallbackAxisOrder;
  const { tileIds } = resolveTilesForBounds(bounds);

  if (tileIds.length === 0 && shouldRequireTileMatch()) {
    console.warn(
      '[BuildingWfs] Tile match is required but no tiles matched bounds (paginated); returning empty response',
      { bounds }
    );
    return {
      type: 'FeatureCollection',
      features: [],
      totalFeatures: 0,
      numberMatched: 0,
      numberReturned: 0,
      axisOrderUsed: primaryAxis
    };
  }

  try {
    const primaryResult = await fetchWfsBuildingsPaginatedOnce(bounds, maxFeaturesPerRequest, primaryAxis, tileIds);
    if (
      BUILDING_WFS_CONFIG.useAxisFallback &&
      primaryResult.numberReturned === 0
    ) {
      console.warn(
        `[BuildingWfs] Paginated query with axis ${primaryAxis} returned zero features; retrying with ${fallbackAxis}`
      );
      const fallbackResult = await fetchWfsBuildingsPaginatedOnce(bounds, maxFeaturesPerRequest, fallbackAxis, tileIds);
      return fallbackResult.numberReturned && fallbackResult.numberReturned > 0 ? fallbackResult : primaryResult;
    }

    return primaryResult;
  } catch (primaryError) {
    if (!BUILDING_WFS_CONFIG.useAxisFallback) {
      throw primaryError;
    }

    console.warn(
      `[BuildingWfs] Paginated query failed with axis ${primaryAxis} (${primaryError instanceof Error ? primaryError.message : 'unknown error'}); retrying with ${fallbackAxis}`
    );
    const fallbackResult = await fetchWfsBuildingsPaginatedOnce(bounds, maxFeaturesPerRequest, fallbackAxis, tileIds);
    return fallbackResult;
  }
}

export async function testWfsConnection(): Promise<boolean> {
  const diagnosticBounds: BoundingBox = {
    north: 22.34,
    south: 22.31,
    east: 114.20,
    west: 114.14
  };

  try {
    const response = await fetchWfsBuildings(diagnosticBounds, 10);
    const featureCount = response.features?.length ?? 0;

    if (featureCount > 0) {
      console.log(`[BuildingWfs] Connectivity check succeeded with ${featureCount} sample features.`);
      return true;
    }

    console.warn('[BuildingWfs] Connectivity check returned zero features; verify dataset coverage.');
    return true;
  } catch (error) {
    console.error('[BuildingWfs] Connectivity check failed', error);
    return false;
  }
}

export type TUMBuildingFeature = WfsBuildingFeature;
export type TUMBuildingResponse = WfsBuildingResponse;

export const fetchTUMBuildings = fetchWfsBuildings;
export const fetchTUMBuildingsPaginated = fetchWfsBuildingsPaginated;
export const convertTUMToStandardGeoJSON = convertWfsToStandardGeoJSON;
export const testTUMConnection = testWfsConnection;

export default {
  fetchWfsBuildings,
  fetchWfsBuildingsPaginated,
  convertWfsToStandardGeoJSON,
  testWfsConnection
};
