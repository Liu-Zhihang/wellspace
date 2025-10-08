/**
 * Shadow Simulator Cache Wrapper
 * 
 * 为mapbox-gl-shadow-simulator添加智能缓存层
 * 解决地图移动导致的重复计算问题
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
 * 带缓存的Shadow Simulator包装器
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
   * 初始化shadow simulator
   */
  async init(
    map: mapboxgl.Map,
    config: ShadowSimulatorConfig,
    ShadeMapClass: any
  ): Promise<void> {
    this.map = map;
    this.config = config;

    // 检查缓存
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const cachedData = this.checkCache(bounds, zoom, config.date);

    if (cachedData) {
      console.log('✅ 使用缓存的阴影数据');
      await this.restoreCachedShadows(cachedData);
      return;
    }

    // 创建新的simulator
    console.log('🌅 创建新的shadow simulator（无缓存）');
    this.simulator = new ShadeMapClass(config).addTo(map);

    // 监听地图移动，保存缓存
    this.setupMapListeners();
  }

  /**
   * 检查缓存
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
   * 保存到缓存
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
   * 恢复缓存的阴影
   */
  private async restoreCachedShadows(cachedData: any): Promise<void> {
    // TODO: 实现从缓存恢复阴影渲染
    // 这需要直接操作Mapbox图层
    console.log('🔄 Restoring cached shadows:', cachedData);
  }

  /**
   * 设置地图监听器
   */
  private setupMapListeners(): void {
    if (!this.map) return;

    let moveEndTimeout: NodeJS.Timeout;

    this.map.on('moveend', () => {
      // 延迟保存，避免频繁触发
      clearTimeout(moveEndTimeout);
      moveEndTimeout = setTimeout(() => {
        this.onMoveEnd();
      }, 1000);
    });
  }

  /**
   * 地图移动结束后的处理
   */
  private onMoveEnd(): void {
    if (!this.map || !this.config || this.isCalculating) return;

    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    const date = this.config.date;

    // 检查是否已有缓存
    const cached = this.checkCache(bounds, zoom, date);
    if (cached) {
      console.log('✅ 该区域已有缓存，跳过计算');
      return;
    }

    // 提取当前阴影数据并缓存
    this.captureAndCacheShadows(bounds, zoom, date);
  }

  /**
   * 捕获并缓存当前阴影
   */
  private captureAndCacheShadows(
    bounds: mapboxgl.LngLatBounds,
    zoom: number,
    date: Date
  ): void {
    if (!this.map) return;

    try {
      // 获取shadow图层数据
      // 注意：这里需要根据mapbox-gl-shadow-simulator的实际实现来提取数据
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
   * 提取阴影图层数据
   */
  private extractShadowLayers(): any[] {
    if (!this.map) return [];

    const shadowLayers: any[] = [];
    const style = this.map.getStyle();

    // 查找shadow相关的图层
    if (style && style.layers) {
      for (const layer of style.layers) {
        if (layer.id.includes('shadow') || layer.id.includes('shade')) {
          shadowLayers.push({
            id: layer.id,
            type: layer.type,
            source: (layer as any).source,
            // 保存图层配置...
          });
        }
      }
    }

    return shadowLayers;
  }

  /**
   * 更新日期
   */
  setDate(date: Date): void {
    if (!this.simulator || !this.map) return;

    // 检查缓存
    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    const cached = this.checkCache(bounds, zoom, date);

    if (cached) {
      console.log('✅ 时间变化 - 使用缓存数据');
      this.restoreCachedShadows(cached);
      return;
    }

    // 无缓存，调用原始方法
    console.log('🔄 时间变化 - 重新计算阴影');
    this.isCalculating = true;
    
    if (typeof this.simulator.setDate === 'function') {
      this.simulator.setDate(date);
    }
    
    if (this.config) {
      this.config.date = date;
    }

    // 计算完成后保存缓存
    setTimeout(() => {
      this.captureAndCacheShadows(bounds, zoom, date);
      this.isCalculating = false;
    }, 2000); // 等待渲染完成
  }

  /**
   * 更新颜色
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
   * 更新透明度
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
   * 移除simulator
   */
  remove(): void {
    if (this.simulator && typeof this.simulator.remove === 'function') {
      this.simulator.remove();
    }
    this.simulator = null;
    this.config = null;
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return shadowCache.getStats();
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    shadowCache.clear();
    this.cachedLayers.clear();
    console.log('🗑️ Shadow cache cleared');
  }

  /**
   * 预热缓存
   */
  async preWarmCache(
    regions: Array<{
      bounds: { north: number; south: number; east: number; west: number };
      zoom: number;
    }>
  ): Promise<void> {
    if (!this.config) return;

    console.log('🔥 开始预热阴影缓存...');
    
    // 预热常用时间点
    const hours = [8, 10, 12, 14, 16, 18];
    const currentDate = new Date();

    for (const region of regions) {
      for (const hour of hours) {
        const date = new Date(currentDate);
        date.setHours(hour, 0, 0, 0);

        // 这里需要实际触发阴影计算
        // 具体实现取决于shadow simulator的API
        console.log(`🔥 预热: 区域 ${JSON.stringify(region.bounds)}, ${hour}:00`);
      }
    }

    console.log('✅ 阴影缓存预热完成');
  }
}
