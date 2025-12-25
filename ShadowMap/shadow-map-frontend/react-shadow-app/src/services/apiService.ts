import type { BuildingTileData } from '../types/index.ts';
import { advancedCacheManager } from './advancedCacheManager';

const API_BASE_URL = 'http://localhost:3500/api';

export class ApiService {
  // 正在进行的请求缓存，避免重复请求
  private static pendingRequests = new Map<string, Promise<BuildingTileData>>();
  
  // 获取建筑物瓦片数据（带高级缓存和请求去重）
  static async getBuildingTile(z: number, x: number, y: number, retryCount = 0): Promise<BuildingTileData> {
    const cacheKey = `building-${z}-${x}-${y}`;
    
    // 检查是否有正在进行的请求
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ 等待正在进行的请求: ${z}/${x}/${y}`);
      return this.pendingRequests.get(cacheKey)!;
    }
    
    // 尝试从高级缓存获取
    const cached = await advancedCacheManager.get<BuildingTileData>(cacheKey);
    if (cached) {
      console.log(`🎯 从高级缓存获取建筑物瓦片 ${z}/${x}/${y}`);
      return cached;
    }

    const maxRetries = 3;
    const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 5000); // 指数退避，最大5秒

    // 创建请求 Promise 并缓存
    const requestPromise = (async (): Promise<BuildingTileData> => {
      try {
        console.log(`📡 从API获取建筑物瓦片 ${z}/${x}/${y} (尝试 ${retryCount + 1}/${maxRetries + 1})`);
        
        const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn(`请求超时，取消瓦片 ${z}/${x}/${y} 的请求`);
        controller.abort();
      }, 20000); // 增加到20秒，匹配后端Overpass API的15秒+缓冲
      
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
          console.warn(`服务器错误，${retryDelay}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          return this.getBuildingTile(z, x, y, retryCount + 1);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // 验证数据格式
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format');
      }
      
      // 存入高级缓存
      await advancedCacheManager.set(cacheKey, data);
      
      console.log(`✅ 成功获取建筑物瓦片 ${z}/${x}/${y} (${data.features?.length || 0} 个建筑物)`);
      return data;
      
    } catch (error) {
      console.warn(`建筑物瓦片 ${z}/${x}/${y} 获取失败:`, error);
      
      // 如果是网络错误且还有重试次数，则重试
      if (retryCount < maxRetries && (
        error instanceof TypeError || // 网络错误
        (error instanceof Error && error.message.includes('fetch'))
      )) {
        console.log(`网络错误，${retryDelay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.getBuildingTile(z, x, y, retryCount + 1);
      }
      
      // 返回空的GeoJSON数据
      const emptyData: BuildingTileData = {
        type: 'FeatureCollection',
        features: [],
        bbox: [0, 0, 0, 0],
        tileInfo: { z, x, y }
      };
      
        // 短暂缓存错误结果，避免重复请求
        await advancedCacheManager.set(cacheKey, emptyData);
        
        return emptyData;
      }
    })();

    // 缓存正在进行的请求
    this.pendingRequests.set(cacheKey, requestPromise);
    
    try {
      const result = await requestPromise;
      return result;
    } finally {
      // 请求完成后移除缓存
      this.pendingRequests.delete(cacheKey);
    }
  }

  // 批量获取建筑物瓦片（优化并发控制）
  static async getBuildingTilesBatch(tiles: Array<{z: number, x: number, y: number}>): Promise<BuildingTileData[]> {
    console.log(`📦 批量获取 ${tiles.length} 个建筑物瓦片`);
    
    const startTime = Date.now();
    const maxConcurrent = 2; // 大幅减少并发数，Overpass API 有严格的速率限制
    const results: BuildingTileData[] = [];
    
    // 分批处理，避免同时发送太多请求
    for (let i = 0; i < tiles.length; i += maxConcurrent) {
      const batch = tiles.slice(i, i + maxConcurrent);
      console.log(`🔄 处理批次 ${Math.floor(i/maxConcurrent) + 1}/${Math.ceil(tiles.length/maxConcurrent)} (${batch.length} 个瓦片)`);
      
      const batchPromises = batch.map(tile => this.getBuildingTile(tile.z, tile.x, tile.y));
      const batchResults = await Promise.allSettled(batchPromises);
      
      const batchData = batchResults.map((result, batchIndex) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          const tile = batch[batchIndex];
          console.warn(`瓦片 ${tile.z}/${tile.x}/${tile.y} 获取失败:`, result.reason);
          return {
            type: 'FeatureCollection' as const,
            features: [],
            bbox: [0, 0, 0, 0] as [number, number, number, number],
            tileInfo: tile
          };
        }
      });
      
      results.push(...batchData);
      
      // 批次间较长延迟，避免触发 Overpass API 速率限制
      if (i + maxConcurrent < tiles.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 增加到1秒延迟
      }
    }
    
    const duration = Date.now() - startTime;
    const successCount = results.filter(r => r.features && r.features.length > 0).length;
    const totalFeatures = results.reduce((sum, r) => sum + (r.features?.length || 0), 0);
    
    console.log(`✅ 批量获取完成: ${successCount}/${tiles.length} 成功, ${totalFeatures} 个建筑物, 耗时 ${duration}ms`);
    
    return results;
  }

  // 预加载建筑物区域
  static async preloadBuildingsArea(bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  }, zoom: number): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/buildings/preload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bounds, zoom }),
      });
      
      if (!response.ok) {
        throw new Error(`Failed to preload buildings: ${response.statusText}`);
      }
      
      console.log(`🔄 已预加载建筑物数据，缩放级别: ${zoom}`);
    } catch (error) {
      console.warn('预加载建筑物数据失败:', error);
    }
  }

  // 获取建筑物服务信息
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
      console.warn('获取建筑物服务信息失败:', error);
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
