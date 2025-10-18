/**
 * Mapbox阴影同步修复器
 * 直接解决阴影与Mapbox底图不对齐问题
 */

import mapboxgl from 'mapbox-gl';

export class MapboxShadowSync {
  private map: mapboxgl.Map;
  private shadeMap: any;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(map: mapboxgl.Map, shadeMap: any) {
    this.map = map;
    this.shadeMap = shadeMap;
  }

  /**
   * 🔧 核心修复：强制阴影模拟器与Mapbox坐标完全同步
   */
  forceSynchronization(): void {
    console.log('🎯 强制Mapbox-阴影坐标同步...');

    try {
      // 1. 获取Mapbox的当前变换矩阵
      const mapWithTransform = this.map as mapboxgl.Map & { transform: unknown };
      const mapboxTransform = mapWithTransform.transform;
      const mapboxCenter = this.map.getCenter();
      const mapboxZoom = this.map.getZoom();
      const mapboxBearing = this.map.getBearing();
      const mapboxPitch = this.map.getPitch();

      console.log(`📍 Mapbox状态: 中心(${mapboxCenter.lng.toFixed(6)}, ${mapboxCenter.lat.toFixed(6)})`);
      console.log(`📐 Mapbox参数: zoom=${mapboxZoom.toFixed(2)}, bearing=${mapboxBearing.toFixed(1)}°, pitch=${mapboxPitch.toFixed(1)}°`);

      // 2. 🔧 直接同步阴影模拟器的坐标变换
      if (this.shadeMap && typeof this.shadeMap.syncMapTransform === 'function') {
        this.shadeMap.syncMapTransform({
          center: [mapboxCenter.lng, mapboxCenter.lat],
          zoom: mapboxZoom,
          bearing: mapboxBearing,
          pitch: mapboxPitch,
          transform: mapboxTransform
        });
        console.log('✅ 阴影模拟器坐标变换已同步');
      }

      // 3. 🔧 强制设置阴影图层的地理边界与Mapbox一致
      const mapboxBounds = this.map.getBounds();
      if (this.shadeMap && typeof this.shadeMap.setBounds === 'function') {
        this.shadeMap.setBounds([
          [mapboxBounds.getWest(), mapboxBounds.getSouth()],
          [mapboxBounds.getEast(), mapboxBounds.getNorth()]
        ]);
        console.log('✅ 阴影图层边界已同步');
      }

      // 4. 🔧 同步像素坐标转换
      if (this.shadeMap && typeof this.shadeMap.setPixelRatio === 'function') {
        const pixelRatio = window.devicePixelRatio || 1;
        this.shadeMap.setPixelRatio(pixelRatio);
        console.log(`✅ 像素比例已同步: ${pixelRatio}`);
      }

      // 5. 🔧 安全地强制重新渲染
      try {
        if (typeof this.shadeMap.redraw === 'function') {
          this.shadeMap.redraw();
          console.log('✅ 阴影图层强制重绘');
        } else if (this.shadeMap && typeof this.shadeMap._draw === 'function') {
          // 🔧 检查heightMapTex是否存在再调用_draw
          if (this.shadeMap._heightMapTex || this.shadeMap.heightMapTex) {
            this.shadeMap._draw();
            console.log('✅ 阴影图层强制绘制');
          } else {
            console.warn('⚠️ heightMapTex未初始化，跳过_draw调用');
          }
        }
      } catch (drawError) {
        console.warn('⚠️ 阴影重绘失败，但继续执行:', drawError);
      }

    } catch (error) {
      console.error('❌ 坐标同步失败:', error);
    }
  }

  /**
   * 🔧 实时坐标同步监听器
   */
  enableRealtimeSync(): void {
    console.log('📡 启用Mapbox-阴影实时同步...');

    // 监听地图移动
    this.map.on('move', () => {
      this.syncOnMapChange('move');
    });

    // 监听地图缩放
    this.map.on('zoom', () => {
      this.syncOnMapChange('zoom');
    });

    // 监听地图旋转
    this.map.on('rotate', () => {
      this.syncOnMapChange('rotate');
    });

    console.log('✅ 实时同步监听器已启用');
  }

  /**
   * 地图变化时的同步处理
   */
  private syncOnMapChange(changeType: string): void {
    if (!this.shadeMap) return;

    // 防抖处理，避免过于频繁的同步
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    this.syncTimeout = setTimeout(() => {
      console.log(`🔄 同步阴影 (${changeType})`);
      this.forceSynchronization();
    }, 100); // 100ms防抖
  }

  /**
   * 🔧 验证坐标同步效果
   */
  validateSync(): {
    mapboxBounds: any;
    shadowBounds: any;
    aligned: boolean;
    offsetPixels: number;
  } {
    const mapboxBounds = this.map.getBounds();
    const mapboxCenter = this.map.getCenter();
    
    // 简单验证：检查中心点是否对齐
    let shadowBounds = null;
    let aligned = false;
    let offsetPixels = 0;

    try {
      if (this.shadeMap && typeof this.shadeMap.getBounds === 'function') {
        shadowBounds = this.shadeMap.getBounds();
        
        // 计算中心点偏移
        const shadowCenter = {
          lng: (shadowBounds.getWest() + shadowBounds.getEast()) / 2,
          lat: (shadowBounds.getNorth() + shadowBounds.getSouth()) / 2
        };
        
        const mapboxPixel = this.map.project([mapboxCenter.lng, mapboxCenter.lat]);
        const shadowPixel = this.map.project([shadowCenter.lng, shadowCenter.lat]);
        
        offsetPixels = Math.sqrt(
          Math.pow(mapboxPixel.x - shadowPixel.x, 2) + 
          Math.pow(mapboxPixel.y - shadowPixel.y, 2)
        );
        
        aligned = offsetPixels < 5; // 5像素内算对齐
        
        console.log(`🔍 同步验证: 偏移${offsetPixels.toFixed(1)}像素, ${aligned ? '✅ 对齐' : '❌ 错位'}`);
      }
    } catch (error) {
      console.warn('⚠️ 同步验证失败:', error);
    }

    return {
      mapboxBounds,
      shadowBounds,
      aligned,
      offsetPixels
    };
  }

  /**
   * 销毁同步器
   */
  destroy(): void {
    clearTimeout((this as any).syncTimeout);
    console.log('🗑️ Mapbox阴影同步器已销毁');
  }
}
