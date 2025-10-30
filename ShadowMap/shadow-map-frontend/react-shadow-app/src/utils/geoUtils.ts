import * as SunCalc from 'suncalc';
import type { SunPosition } from '../types/index.ts';

export class GeoUtils {
  /**
   */
  static getSunPosition(date: Date, lat: number, lng: number): SunPosition {
    const sunPosition = SunCalc.getPosition(date, lat, lng);
    return {
      altitude: (sunPosition.altitude * 180) / Math.PI,
      azimuth: ((sunPosition.azimuth * 180) / Math.PI) + 180,
    };
  }

  /**
   */
  static latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    return { x, y };
  }

  /**
   */
  static tileToBounds(x: number, y: number, zoom: number): {
    north: number;
    south: number;
    east: number;
    west: number;
  } {
    const n = Math.pow(2, zoom);
    const west = (x / n) * 360 - 180;
    const east = ((x + 1) / n) * 360 - 180;
    const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
    const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
    
    return { north, south, east, west };
  }

  /**
   */
  static getTilesInBounds(bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }, zoom: number): Array<{ z: number; x: number; y: number }> {
    const nw = this.latLngToTile(bounds.north, bounds.west, zoom);
    const se = this.latLngToTile(bounds.south, bounds.east, zoom);
    
    const tiles: Array<{ z: number; x: number; y: number }> = [];
    
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        tiles.push({ z: zoom, x, y });
      }
    }
    
    return tiles.slice(0, 20);
  }

  /**
   */
  static calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   */
  static formatCoordinate(value: number, isLatitude: boolean): string {
    const direction = isLatitude 
      ? (value >= 0 ? 'N' : 'S')
      : (value >= 0 ? 'E' : 'W');
    return `${Math.abs(value).toFixed(4)}°${direction}`;
  }

  /**
   */
  static categorizeShadeLevel(shadowPercent: number): string {
    if (shadowPercent < 10) return 'No Shadow';
    if (shadowPercent < 25) return 'Light Shadow';
    if (shadowPercent < 50) return 'Moderate Shadow';
    if (shadowPercent < 75) return 'Heavy Shadow';
    return 'Extreme Shadow';
  }
}
