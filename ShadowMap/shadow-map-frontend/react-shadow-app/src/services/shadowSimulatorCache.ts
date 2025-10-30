/**
 * Shadow Simulator Cache Wrapper
 * 
 */

import { shadowCache } from '../utils/shadowCache';
import type mapboxgl from 'mapbox-gl';

interface ShadowSimulatorConfig {
  date: Date;
  color: string;
  opacity: number;
  apiKey: string;
  terrainSource: any;
  getFeatures: () => any[];
  debug?: (msg: string) => void;
}

interface CachedShadowLayer {
  layerId: string;
  sourceId: string;
  timestamp: number;
  bounds: mapboxgl.LngLatBounds;
  zoom: number;
  date: Date;
}

/**
 */
export class CachedShadowSimulator {
  private simulator: any = null;
  private map: mapboxgl.Map | null = null;
  private config: ShadowSimulatorConfig | null = null;
  private cachedLayers: Map<string, CachedShadowLayer> = new Map();
  private isCalculating = false;
  
  constructor() {
    console.log('🎯 CachedShadowSimulator initialized');
  }

  /**
   */
  async init(
    map: mapboxgl.Map,
    config: ShadowSimulatorConfig,
    ShadeMapClass: any
  ): Promise<void> {
    this.map = map;
    this.config = config;

    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const cachedData = this.checkCache(bounds, zoom, config.date);

    if (cachedData) {
      await this.restoreCachedShadows(cachedData);
      return;
    }

    this.simulator = new ShadeMapClass(config).addTo(map);

    this.setupMapListeners();
  }

  /**
   */
  private checkCache(
    bounds: mapboxgl.LngLatBounds,
    zoom: number,
    date: Date
  ): any | null {
    const boundsObj = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest()
    };

    const cached = shadowCache.get(boundsObj, zoom, date);
    
    if (cached) {
      console.log('🎯 Shadow cache hit!', {
        bounds: boundsObj,
        zoom: Math.floor(zoom),
        time: `${date.getHours()}:${date.getMinutes()}`
      });
    }

    return cached;
  }

  /**
   */
  private saveToCache(
    bounds: mapboxgl.LngLatBounds,
    zoom: number,
    date: Date,
    shadowData: any
  ): void {
    const boundsObj = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest()
    };

    shadowCache.set(boundsObj, zoom, date, shadowData);
    
    console.log('💾 Saved shadow to cache', {
      bounds: boundsObj,
      zoom: Math.floor(zoom),
      time: `${date.getHours()}:${date.getMinutes()}`
    });
  }

  /**
   */
  private async restoreCachedShadows(cachedData: any): Promise<void> {
    console.log('🔄 Restoring cached shadows:', cachedData);
  }

  /**
   */
  private setupMapListeners(): void {
    if (!this.map) return;

    let moveEndTimeout: NodeJS.Timeout;

    this.map.on('moveend', () => {
      clearTimeout(moveEndTimeout);
      moveEndTimeout = setTimeout(() => {
        this.onMoveEnd();
      }, 1000);
    });
  }

  /**
   */
  private onMoveEnd(): void {
    if (!this.map || !this.config || this.isCalculating) return;

    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    const date = this.config.date;

    const cached = this.checkCache(bounds, zoom, date);
    if (cached) {
      return;
    }

    this.captureAndCacheShadows(bounds, zoom, date);
  }

  /**
   */
  private captureAndCacheShadows(
    bounds: mapboxgl.LngLatBounds,
    zoom: number,
    date: Date
  ): void {
    if (!this.map) return;

    try {
      const shadowLayers = this.extractShadowLayers();
      
      if (shadowLayers && shadowLayers.length > 0) {
        this.saveToCache(bounds, zoom, date, {
          layers: shadowLayers,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.warn('⚠️ Failed to capture shadow data:', error);
    }
  }

  /**
   */
  private extractShadowLayers(): any[] {
    if (!this.map) return [];

    const shadowLayers: any[] = [];
    const style = this.map.getStyle();

    if (style && style.layers) {
      for (const layer of style.layers) {
        if (layer.id.includes('shadow') || layer.id.includes('shade')) {
          shadowLayers.push({
            id: layer.id,
            type: layer.type,
            source: (layer as any).source,
          });
        }
      }
    }

    return shadowLayers;
  }

  /**
   */
  setDate(date: Date): void {
    if (!this.simulator || !this.map) return;

    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    const cached = this.checkCache(bounds, zoom, date);

    if (cached) {
      this.restoreCachedShadows(cached);
      return;
    }

    this.isCalculating = true;
    
    if (typeof this.simulator.setDate === 'function') {
      this.simulator.setDate(date);
    }
    
    if (this.config) {
      this.config.date = date;
    }

    setTimeout(() => {
      this.captureAndCacheShadows(bounds, zoom, date);
      this.isCalculating = false;
    }, 2000);
  }

  /**
   */
  setColor(color: string): void {
    if (this.simulator && typeof this.simulator.setColor === 'function') {
      this.simulator.setColor(color);
    }
    if (this.config) {
      this.config.color = color;
    }
  }

  /**
   */
  setOpacity(opacity: number): void {
    if (this.simulator && typeof this.simulator.setOpacity === 'function') {
      this.simulator.setOpacity(opacity);
    }
    if (this.config) {
      this.config.opacity = opacity;
    }
  }

  /**
   */
  remove(): void {
    if (this.simulator && typeof this.simulator.remove === 'function') {
      this.simulator.remove();
    }
    this.simulator = null;
    this.config = null;
  }

  /**
   */
  getCacheStats() {
    return shadowCache.getStats();
  }

  /**
   */
  clearCache(): void {
    shadowCache.clear();
    this.cachedLayers.clear();
    console.log('🗑️ Shadow cache cleared');
  }

  /**
   */
  async preWarmCache(
    regions: Array<{
      bounds: { north: number; south: number; east: number; west: number };
      zoom: number;
    }>
  ): Promise<void> {
    if (!this.config) return;

    
    const hours = [8, 10, 12, 14, 16, 18];
    const currentDate = new Date();

    // Reserved for future cache pre-warming logic
    void regions; // suppress unused warning until implemented
    void hours;
    void currentDate;

  }
}
