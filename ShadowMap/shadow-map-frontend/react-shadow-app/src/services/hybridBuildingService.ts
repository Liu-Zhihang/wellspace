import { BoundingBox, BuildingServiceResponse, getWfsBuildings } from './wfsBuildingService';

const API_BASE = 'http://localhost:3500/api';

export interface HybridBuildingResponse {
  success: boolean;
  data: {
    type: 'FeatureCollection';
    features: any[];
    metadata: {
      source: 'DATABASE' | 'WFS' | 'MIXED';
      bounds: BoundingBox;
      totalFeatures: number;
      databaseFeatures: number;
      wfsFeatures: number;
      timestamp: string;
    };
  };
}

async function getDatabaseBuildings(
  bounds: BoundingBox,
  maxFeatures: number = 1000
): Promise<{ success: boolean; features: any[]; count: number; error?: string }> {
  try {
    console.log('[Hybrid] Fetching buildings from local database cache');

    const zoom = 16;
    const tiles = calculateTilesInBounds(bounds, zoom);
    const features: any[] = [];
    let successfulTiles = 0;

    for (const tile of tiles) {
      try {
        const response = await fetch(`${API_BASE}/buildings/${tile.z}/${tile.x}/${tile.y}.json`);
        if (response.ok) {
          const data = await response.json();
          if (data.features && data.features.length > 0) {
            features.push(...data.features);
            successfulTiles += 1;
          }
        }
      } catch (error) {
        console.warn(`[Hybrid] Failed to read cached tile ${tile.z}/${tile.x}/${tile.y}`, error);
      }

      if (features.length >= maxFeatures) {
        break;
      }
    }

    console.log(`[Hybrid] Local cache yielded ${features.length} features (${successfulTiles}/${tiles.length} tiles)`);

    return {
      success: features.length > 0,
      features: features.slice(0, maxFeatures),
      count: features.length
    };
  } catch (error) {
    console.error('[Hybrid] Local cache lookup failed', error);
    return {
      success: false,
      features: [],
      count: 0,
      error: error instanceof Error ? error.message : 'Database query failed'
    };
  }
}

function calculateTilesInBounds(bounds: BoundingBox, zoom: number): Array<{ z: number; x: number; y: number }> {
  const tiles: Array<{ z: number; x: number; y: number }> = [];

  const northWest = latLngToTile(bounds.north, bounds.west, zoom);
  const southEast = latLngToTile(bounds.south, bounds.east, zoom);

  const minX = Math.min(northWest.x, southEast.x);
  const maxX = Math.max(northWest.x, southEast.x);
  const minY = Math.min(northWest.y, southEast.y);
  const maxY = Math.max(northWest.y, southEast.y);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ z: zoom, x, y });
    }
  }

  return tiles.slice(0, 20);
}

function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n
  );
  return { x, y };
}

export async function getHybridBuildings(
  bounds: BoundingBox,
  maxFeatures: number = 1000
): Promise<HybridBuildingResponse> {
  console.log('[Hybrid] Starting hybrid fetch');

  const start = Date.now();
  const dbResult = await getDatabaseBuildings(bounds, maxFeatures);

  let combinedFeatures = [...dbResult.features];
  let source: 'DATABASE' | 'WFS' | 'MIXED' = 'DATABASE';

  if (dbResult.count < maxFeatures * 0.5) {
    console.log('[Hybrid] Local cache insufficient, querying WFS');

    try {
      const wfsResult = await getWfsBuildings(bounds, maxFeatures - dbResult.count);

      if (wfsResult.success && wfsResult.data.features.length > 0) {
        const existingIds = new Set(
          combinedFeatures.map(feature => feature.properties?.id).filter(Boolean) as string[]
        );

        const newFeatures = wfsResult.data.features.filter(
          feature => !feature.properties?.id || !existingIds.has(feature.properties.id)
        );

        combinedFeatures = [...combinedFeatures, ...newFeatures];
        source = dbResult.count > 0 ? 'MIXED' : 'WFS';

        console.log(`[Hybrid] WFS contributed ${newFeatures.length} features`);
      }
    } catch (error) {
      console.warn('[Hybrid] WFS backfill failed', error);
    }
  }

  const duration = Date.now() - start;
  console.log(`[Hybrid] Completed hybrid fetch: ${combinedFeatures.length} features in ${duration}ms (source=${source})`);

  return {
    success: combinedFeatures.length > 0,
    data: {
      type: 'FeatureCollection',
      features: combinedFeatures.slice(0, maxFeatures),
      metadata: {
        source,
        bounds,
        totalFeatures: combinedFeatures.length,
        databaseFeatures: dbResult.count,
        wfsFeatures: Math.max(0, combinedFeatures.length - dbResult.count),
        timestamp: new Date().toISOString()
      }
    }
  };
}

export async function checkDataCoverage(bounds: BoundingBox): Promise<{
  database: { available: boolean; count: number; coverage: number };
  wfs: { available: boolean; count: number };
  recommendation: 'DATABASE' | 'WFS' | 'MIXED';
}> {
  console.log('[Hybrid] Evaluating coverage');

  const [dbResult, wfsResult] = await Promise.allSettled([
    getDatabaseBuildings(bounds, 100),
    getWfsBuildings(bounds, 100)
  ]);

  const database = {
    available: dbResult.status === 'fulfilled' && dbResult.value.success,
    count: dbResult.status === 'fulfilled' ? dbResult.value.count : 0,
    coverage: 0
  };

  const wfs = {
    available: wfsResult.status === 'fulfilled' && wfsResult.value.success,
    count: wfsResult.status === 'fulfilled' ? wfsResult.value.data.features.length : 0
  };

  if (database.available && wfs.available && wfs.count > 0) {
    database.coverage = Math.min(100, (database.count / wfs.count) * 100);
  }

  let recommendation: 'DATABASE' | 'WFS' | 'MIXED';
  if (database.coverage >= 80) {
    recommendation = 'DATABASE';
  } else if (database.coverage >= 20) {
    recommendation = 'MIXED';
  } else {
    recommendation = 'WFS';
  }

  console.log(
    `[Hybrid] Coverage analysis: db=${database.count} (${database.coverage.toFixed(1)}%), wfs=${wfs.count}, recommendation=${recommendation}`
  );

  return { database, wfs, recommendation };
}

export const hybridBuildingService = {
  getHybridBuildings,
  checkDataCoverage,
  getDatabaseBuildings
};

export default hybridBuildingService;
