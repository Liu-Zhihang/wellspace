import { buildingCache } from '../cache/buildingCache';
import type {
  BoundingBox,
  BuildingFeatureCollection,
  BuildingServiceMetadata,
  BuildingServiceResponse,
} from '../types/index.ts';

const API_BASE = 'http://localhost:3500/api';

type RawBuildingServiceResponse = BuildingServiceResponse & {
  data: BuildingFeatureCollection & {
    metadata?: BuildingServiceMetadata & {
      numberMatched?: number;
      numberReturned?: number;
    };
  };
};

export async function testWfsConnection(): Promise<boolean> {
  try {
    console.log('[WFS] Testing connectivity');
    const response = await fetch(`${API_BASE}/wfs-buildings/test`);
    const result = await response.json();

    if (result.success) {
      console.log('[WFS] Connectivity verified');
      return true;
    }

    console.warn('[WFS] Service reachable but returned no data', result.message);
    return false;
  } catch (error) {
    console.error('[WFS] Connectivity test failed', error);
    return false;
  }
}

export async function getWfsBuildings(
  bounds: BoundingBox,
  maxFeatures?: number
): Promise<BuildingServiceResponse> {
  try {
    const payload = {
      north: bounds.north,
      south: bounds.south,
      east: bounds.east,
      west: bounds.west,
      maxFeatures: maxFeatures ?? 5000
    };

    console.log('[WFS] Requesting buildings by bounds', payload);

    const response = await fetch(`${API_BASE}/wfs-buildings/bounds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as RawBuildingServiceResponse;

    if (!result.success) {
      throw new Error(result?.message ?? 'WFS bounds request failed');
    }

    buildingCache.add(result.data);
    const aggregated = buildingCache.getAllAsFeatureCollection() as BuildingFeatureCollection;

    const metadata: BuildingServiceMetadata = {
      ...(result.data.metadata ?? {}),
      totalFeatures: aggregated.features.length,
      numberReturned: aggregated.features.length,
    };

    return {
      ...result,
      data: {
        ...aggregated,
        metadata,
      },
    };
  } catch (error) {
    console.error('[WFS] Failed to fetch buildings by bounds', error);
    throw error;
  }
}

export async function getBeijingSampleBuildings(): Promise<BuildingServiceResponse> {
  try {
    console.log('[WFS] Requesting Beijing sample dataset');

    const response = await fetch(`${API_BASE}/wfs-buildings/sample/beijing`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as BuildingServiceResponse;

    if (!result.success) {
      throw new Error(result?.message ?? 'WFS sample request failed');
    }

    return result;
  } catch (error) {
    console.error('[WFS] Failed to fetch Beijing sample', error);
    throw error;
  }
}

export async function getWfsBuildingsByTile(
  z: number,
  x: number,
  y: number,
  maxFeatures?: number
): Promise<BuildingServiceResponse> {
  try {
    const payload = {
      z,
      x,
      y,
      maxFeatures: maxFeatures ?? 5000
    };

    console.log('[WFS] Requesting buildings by tile', payload);

    const response = await fetch(`${API_BASE}/wfs-buildings/tile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const result = (await response.json()) as BuildingServiceResponse;

    if (!result.success) {
      throw new Error(result?.message ?? 'WFS tile request failed');
    }

    return result;
  } catch (error) {
    console.error('[WFS] Failed to fetch buildings by tile', error);
    throw error;
  }
}

export const wfsBuildingService = {
  testWfsConnection,
  getWfsBuildings,
  getBeijingSampleBuildings,
  getWfsBuildingsByTile
};

export default wfsBuildingService;
