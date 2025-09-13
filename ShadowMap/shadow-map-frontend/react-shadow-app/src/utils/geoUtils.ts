import * as SunCalc from 'suncalc';
import type { SunPosition } from '../types';

export class GeoUtils {
  /**
   * 计算指定时间和位置的太阳位置
   */
  static getSunPosition(date: Date, lat: number, lng: number): SunPosition {
    const sunPosition = SunCalc.getPosition(date, lat, lng);
    return {
      altitude: (sunPosition.altitude * 180) / Math.PI,
      azimuth: ((sunPosition.azimuth * 180) / Math.PI) + 180,
    };
  }

  /**
   * 将经纬度转换为瓦片坐标
   */
  static latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    return { x, y };
  }

  /**
   * 将瓦片坐标转换为经纬度范围
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
   * 计算边界框内的瓦片列表
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
    
    // 限制最大瓦片数量防止过多请求
    return tiles.slice(0, 20);
  }

  /**
   * 计算两点之间的距离（米）
   */
  static calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // 地球半径（米）
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
   * 格式化坐标显示
   */
  static formatCoordinate(value: number, isLatitude: boolean): string {
    const direction = isLatitude 
      ? (value >= 0 ? 'N' : 'S')
      : (value >= 0 ? 'E' : 'W');
    return `${Math.abs(value).toFixed(4)}°${direction}`;
  }

  /**
   * 计算阴影覆盖等级分布
   */
  static categorizeShadeLevel(shadowPercent: number): string {
    if (shadowPercent < 10) return '无阴影';
    if (shadowPercent < 25) return '轻微阴影';
    if (shadowPercent < 50) return '中等阴影';
    if (shadowPercent < 75) return '重度阴影';
    return '极重阴影';
  }
}
