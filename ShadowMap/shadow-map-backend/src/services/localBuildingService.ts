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
  if (cachedCollection && cachedPath === normalized) {
    return cachedCollection;
  }

  const raw = await fs.readFile(normalized, 'utf8');
  const parsed = JSON.parse(raw) as GeoJsonFeatureCollection;
  cachedCollection = parsed;
  cachedPath = normalized;
  return parsed;
}

function geometryBBox(geom: GeoJsonFeature['geometry']): BoundingBox | null {
  let minLat = Number.POSITIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  const track = (coords: number[][]) => {
    for (const [lon, lat] of coords) {
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
