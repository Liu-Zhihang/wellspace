import type { BuildingTileData } from '../types/index.ts';
import { advancedCacheManager } from './advancedCacheManager';

export const API_BASE_URL = 'http://localhost:3500/api';

export class ApiService {
  // Cache in-flight requests to avoid duplicates
  private static pendingRequests = new Map<string, Promise<BuildingTileData>>();
  
  // Fetch building tiles with caching & de-duplication
  static async getBuildingTile(z: number, x: number, y: number, retryCount = 0): Promise<BuildingTileData> {
    const cacheKey = `building-${z}-${x}-${y}`;
    
    // Return existing promise if one is already running
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ Awaiting in-flight request: ${z}/${x}/${y}`);
      return this.pendingRequests.get(cacheKey)!;
    }
    
    // Try advanced cache first
    const cached = await advancedCacheManager.get<BuildingTileData>(cacheKey);
    if (cached) {
      console.log(`🎯 Served building tile ${z}/${x}/${y} from cache`);
      return cached;
    }

    const maxRetries = 3;
    const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 5000); // Exponential backoff up to 5s

    // Create request promise and cache it
    const requestPromise = (async (): Promise<BuildingTileData> => {
      try {
        console.log(`📡 Fetching building tile ${z}/${x}/${y} (attempt ${retryCount + 1}/${maxRetries + 1})`);
        
        const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn(`Request timed out; aborting tile ${z}/${x}/${y}`);
        controller.abort();
      }, 20000); // 20s timeout to match backend latency
      
      const response = await fetch(`${API_BASE_URL}/buildings/${z}/${x}/${y}.json`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        if (response.status === 500 && retryCount < maxRetries) {
          console.warn(`Server error; retrying in ${retryDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return this.getBuildingTile(z, x, y, retryCount + 1);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format');
      }

      if (!data.tileInfo) {
        data.tileInfo = { z, x, y };
      }
      if (!data.bbox) {
        const n = Math.pow(2, z);
        const west = (x / n) * 360 - 180;
        const east = ((x + 1) / n) * 360 - 180;
        const tileToLat = (ty: number) => {
          const rad = Math.PI - (2 * Math.PI * ty) / n;
          return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(rad) - Math.exp(-rad)));
        };
        const south = tileToLat(y + 1);
        const north = tileToLat(y);
        data.bbox = [west, south, east, north];
      }
      
      // Persist in advanced cache
      await advancedCacheManager.set(cacheKey, data);
      
      console.log(`✅ Fetched building tile ${z}/${x}/${y} (${data.features?.length || 0} buildings)`);
      return data;
      
    } catch (error) {
      console.warn(`Building tile ${z}/${x}/${y} failed:`, error);
      
      // Retry network errors while attempts remain
      if (retryCount < maxRetries && (
        error instanceof TypeError ||
        (error instanceof Error && error.message.includes('fetch'))
      )) {
        console.log(`Network error; retrying in ${retryDelay}ms`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.getBuildingTile(z, x, y, retryCount + 1);
      }
      
      // Return empty GeoJSON if all retries fail
      const emptyData: BuildingTileData = {
        type: 'FeatureCollection',
        features: [],
        bbox: [0, 0, 0, 0],
        tileInfo: { z, x, y }
      };
      
        // Cache empty result briefly to avoid repeat fetches
        await advancedCacheManager.set(cacheKey, emptyData);
        
        return emptyData;
      }
    })();

    // Store pending request
    this.pendingRequests.set(cacheKey, requestPromise);
    
    try {
      const result = await requestPromise;
      return result;
    } finally {
      // Remove pending request after completion
      this.pendingRequests.delete(cacheKey);
    }
  }

  // Batch building tile fetch with concurrency control
  static async getBuildingTilesBatch(tiles: Array<{z: number, x: number, y: number}>): Promise<BuildingTileData[]> {
    console.log(`📦 Fetching batch of ${tiles.length} building tiles`);
    
    const startTime = Date.now();
    const maxConcurrent = 2; // Limit concurrency for Overpass rate limits
    const results: BuildingTileData[] = [];
    
    // Process tiles in small batches
    for (let i = 0; i < tiles.length; i += maxConcurrent) {
      const batch = tiles.slice(i, i + maxConcurrent);
      console.log(`🔄 Processing batch ${Math.floor(i/maxConcurrent) + 1}/${Math.ceil(tiles.length/maxConcurrent)} (${batch.length} tiles)`);
      
      const batchPromises = batch.map(tile => this.getBuildingTile(tile.z, tile.x, tile.y));
      const batchResults = await Promise.allSettled(batchPromises);
      
      const batchData = batchResults.map((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          const tile = batch[batchIndex];
          console.warn(`Tile ${tile.z}/${tile.x}/${tile.y} failed:`, result.reason);
          return {
            type: 'FeatureCollection' as const,
            features: [],
            bbox: [0, 0, 0, 0] as [number, number, number, number],
            tileInfo: tile
          };
        }
      });
      
      results.push(...batchData);
      
      // Delay between batches to respect Overpass limits
      if (i + maxConcurrent < tiles.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1s pause between batches
      }
    }
    
    const duration = Date.now() - startTime;
    const successCount = results.filter(r => r.features && r.features.length > 0).length;
    const totalFeatures = results.reduce((sum, r) => sum + (r.features?.length || 0), 0);
    
    console.log(`✅ Batch complete: ${successCount}/${tiles.length} success, ${totalFeatures} buildings, ${duration}ms`);
    
    return results;
  }

  // Preload building area (noop when proxied)
  static async preloadBuildingsArea(_bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }, _zoom: number): Promise<void> {
    console.log('🔄 preloadBuildingsArea noop (WFS proxy mode)');
  }

  // Retrieve building service metadata
  static async getBuildingServiceInfo(): Promise<any> {
    const cacheKey = 'building-service-info';
    const cached = await advancedCacheManager.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/buildings/info`);
      if (!response.ok) {
        throw new Error(`Failed to fetch building service info: ${response.statusText}`);
      }
      
      const data = await response.json();
      await advancedCacheManager.set(cacheKey, data);
      
      return data;
    } catch (error) {
      console.warn('Failed to fetch building service info:', error);
      return { status: 'unavailable' };
    }
  }

  static getDEMTileUrl(z: number, x: number, y: number): string {
    return `${API_BASE_URL}/dem/${z}/${x}/${y}.png`;
  }

  static async checkBackendHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
