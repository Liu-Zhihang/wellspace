import fs from 'fs/promises';
import path from 'path';
import type { BoundingBox } from './buildingWfsService';

interface GeoJsonFeature {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  };
  properties: Record<string, any>;
}

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

interface LocalQueryResult {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  metadata: {
    source: 'local';
    totalFeatures: number;
    numberReturned: number;
  };
}

let cachedCollection: GeoJsonFeatureCollection | null = null;
let cachedPath: string | null = null;

async function loadLocalGeojson(filePath: string): Promise<GeoJsonFeatureCollection> {
  const normalized = path.resolve(filePath);
  let geojsonPath = normalized;
  const extension = path.extname(normalized).toLowerCase();

  if (extension && extension !== '.geojson' && extension !== '.json') {
    const fallbackPath = `${normalized.slice(0, -extension.length)}.geojson`;
    try {
      await fs.access(fallbackPath);
      geojsonPath = fallbackPath;
    } catch {
      throw new Error(
        `BUILDING_LOCAL_GEOJSON must point to a GeoJSON file. Received "${filePath}" and no sibling GeoJSON was found at "${fallbackPath}".`,
      );
    }
  }

  if (cachedCollection && cachedPath === geojsonPath) {
    return cachedCollection;
  }

  let raw: string;
  try {
    raw = await fs.readFile(geojsonPath, 'utf8');
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ERR_FS_FILE_TOO_LARGE') {
      throw new Error(
        `Local building GeoJSON is too large for the Node backend: "${geojsonPath}". Use BUILDING_SOURCE="wfs" for service deployments, or point BUILDING_LOCAL_GEOJSON to a smaller clipped GeoJSON.`,
      );
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as GeoJsonFeatureCollection;
  cachedCollection = parsed;
  cachedPath = geojsonPath;
  return parsed;
}

function geometryBBox(geom: GeoJsonFeature['geometry']): BoundingBox | null {
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  const track = (coords: number[][]) => {
    for (const coord of coords) {
      const lon = coord[0];
      const lat = coord[1];
      if (lon === undefined || lat === undefined) {
        continue;
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  };

  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates as number[][][]) {
      track(ring);
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates as number[][][][]) {
      for (const ring of poly) {
        track(ring);
      }
    }
  } else {
    return null;
  }

  if (!Number.isFinite(minLat) || !Number.isFinite(minLon) || !Number.isFinite(maxLat) || !Number.isFinite(maxLon)) {
    return null;
  }

  return {
    west: minLon,
    south: minLat,
    east: maxLon,
    north: maxLat
  };
}

function bboxIntersects(a: BoundingBox, b: BoundingBox): boolean {
  return !(a.west > b.east || a.east < b.west || a.south > b.north || a.north < b.south);
}

export async function queryLocalBuildings(
  filePath: string,
  bounds: BoundingBox,
  maxFeatures: number
): Promise<LocalQueryResult> {
  const collection = await loadLocalGeojson(filePath);
  const matched: GeoJsonFeature[] = [];

  for (const feature of collection.features) {
    const geomBounds = feature.geometry ? geometryBBox(feature.geometry) : null;
    if (!geomBounds) continue;
    if (!bboxIntersects(bounds, geomBounds)) continue;
    matched.push(feature);
    if (matched.length >= maxFeatures) break;
  }

  return {
    type: 'FeatureCollection',
    features: matched,
    metadata: {
      source: 'local',
      totalFeatures: collection.features.length,
      numberReturned: matched.length
    }
  };
}
