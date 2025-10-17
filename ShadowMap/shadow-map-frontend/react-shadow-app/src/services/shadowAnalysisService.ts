import { getWfsBuildings } from './wfsBuildingService';
import * as SunCalc from 'suncalc';

export interface ShadowCalculationResult {
  shadows: any[];
  sunPosition: {
    altitude: number;
    azimuth: number;
  };
  calculationTime: number;
  buildingCount: number;
}

export interface ShadowBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export class ShadowAnalysisService {
  private readonly cache = new Map<string, ShadowCalculationResult>();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  async calculateRealTimeShadows(
    bounds: ShadowBounds,
    date: Date,
    zoom: number = 15
  ): Promise<ShadowCalculationResult> {
    const start = performance.now();

    if (!bounds || !date) {
      throw new Error('Bounds and date are required');
    }

    console.log('[Shadow] Calculating realtime shadows', {
      bounds,
      isoTime: date.toISOString(),
      zoom
    });

    const cacheKey = this.getCacheKey(bounds, date, zoom);
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.calculationTime < this.cacheTtlMs) {
      console.log('[Shadow] Returning cached result');
      return cached;
    }

    try {
      const buildingData = await getWfsBuildings(bounds);

      if (!buildingData.success || buildingData.data.features.length === 0) {
        throw new Error('No building features returned from WFS');
      }

      const buildings = buildingData.data.features;
      console.log(`[Shadow] Received ${buildings.length} buildings`);

      const sunPosition = this.calculateSunPosition(bounds, date);
      console.log('[Shadow] Sun position', sunPosition);

      const shadows = this.calculateShadowsForBuildings(buildings, sunPosition, date);

      const result: ShadowCalculationResult = {
        shadows,
        sunPosition,
        calculationTime: performance.now(),
        buildingCount: buildings.length
      };

      this.cache.set(cacheKey, result);

      console.log(`[Shadow] Completed shadow analysis in ${(performance.now() - start).toFixed(0)}ms`);

      return result;
    } catch (error) {
      console.error('[Shadow] Failed to calculate shadows', error);
      throw error;
    }
  }

  private calculateSunPosition(bounds: ShadowBounds, date: Date): { altitude: number; azimuth: number } {
    const latitude = (bounds.north + bounds.south) / 2;
    const longitude = (bounds.east + bounds.west) / 2;

    const sunPosition = SunCalc.getPosition(date, latitude, longitude);

    return {
      altitude: (sunPosition.altitude * 180) / Math.PI,
      azimuth: ((sunPosition.azimuth * 180) / Math.PI + 180) % 360
    };
  }

  private calculateShadowsForBuildings(
    buildings: any[],
    sunPosition: { altitude: number; azimuth: number },
    date: Date
  ): any[] {
    const shadows: any[] = [];

    buildings.forEach((building, index) => {
      try {
        const shadow = this.calculateShadowForBuilding(building, sunPosition, date);
        if (shadow) {
          shadows.push(shadow);
        }
      } catch (error) {
        console.warn(`[Shadow] Failed to compute shadow for building ${index}`, error);
      }
    });

    return shadows;
  }

  private calculateShadowForBuilding(
    building: any,
    sunPosition: { altitude: number; azimuth: number },
    date: Date
  ): any | null {
    if (!building.geometry || !building.properties) {
      return null;
    }

    const height = building.properties.height ?? 20;
    const { geometry } = building;

    if (sunPosition.altitude <= 0) {
      return null;
    }

    const shadowLength = height / Math.tan((sunPosition.altitude * Math.PI) / 180);
    const shadowDirection = (sunPosition.azimuth + 180) % 360;
    const shadowDirectionRad = (shadowDirection * Math.PI) / 180;

    const offsetX = shadowLength * Math.sin(shadowDirectionRad);
    const offsetY = shadowLength * Math.cos(shadowDirectionRad);

    let shadowGeometry;

    if (geometry.type === 'Polygon') {
      shadowGeometry = this.offsetPolygon(geometry.coordinates[0], offsetX, offsetY);
    } else if (geometry.type === 'MultiPolygon') {
      const coordinates = geometry.coordinates.map((polygon: any) =>
        polygon.map((ring: any) => this.offsetPolygon(ring, offsetX, offsetY))
      );
      shadowGeometry = {
        type: 'MultiPolygon',
        coordinates
      };
    } else {
      return null;
    }

    return {
      type: 'Feature',
      geometry: shadowGeometry,
      properties: {
        buildingId: building.properties.id ?? `building_${Date.now()}_${Math.random()}`,
        buildingHeight: height,
        shadowLength,
        sunAltitude: sunPosition.altitude,
        sunAzimuth: sunPosition.azimuth,
        calculationTime: date.toISOString(),
        source: 'wfs'
      }
    };
  }

  private offsetPolygon(coordinates: number[][], offsetX: number, offsetY: number): number[][] {
    return coordinates.map(([lng, lat]) => [lng + offsetX, lat + offsetY]);
  }

  private getCacheKey(bounds: ShadowBounds, date: Date, zoom: number): string {
    return [
      bounds.north.toFixed(6),
      bounds.south.toFixed(6),
      bounds.east.toFixed(6),
      bounds.west.toFixed(6),
      date.toISOString(),
      zoom
    ].join('|');
  }
}

export const shadowAnalysisService = new ShadowAnalysisService();

export default shadowAnalysisService;
