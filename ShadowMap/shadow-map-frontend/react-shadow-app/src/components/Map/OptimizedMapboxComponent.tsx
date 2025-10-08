import React, { useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { useSmartShadowUpdate } from '../../hooks/useSmartShadowUpdate';
import { shadowCache } from '../../utils/shadowCache';
import { optimizedBuildingService } from '../../services/optimizedBuildingService';

// 导入mapbox-gl-shadow-simulator
declare global {
  interface Window {
    ShadeMap: any;
  }
}

interface OptimizedMapboxComponentProps {
  className?: string;
}

export const OptimizedMapboxComponent: React.FC<OptimizedMapboxComponentProps> = ({ 
  className = '' 
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shadeMapRef = useRef<any>(null);
  const isInitializedRef = useRef(false);

  const {
    mapSettings,
    currentDate,
    addStatusMessage,
  } = useShadowMapStore();

  // 优化的阴影计算函数
  const performShadowCalculation = useCallback(async () => {
    if (!mapRef.current || !shadeMapRef.current) return;

    const startTime = performance.now();
    const map = mapRef.current;
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const center = map.getCenter();

    console.log(`🔄 开始优化阴影计算 (zoom: ${zoom.toFixed(1)})`);

    try {
      // 1. 检查阴影缓存
      const cacheKey = shadowCache.generateKey(
        { 
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        },
        zoom,
        currentDate
      );

      let cachedShadow = shadowCache.get(
        {
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        },
        zoom,
        currentDate
      );

      if (cachedShadow) {
        console.log('🎯 使用缓存的阴影数据');
        
        // 应用缓存的阴影（这里需要根据具体的shadow simulator API调整）
        if (typeof shadeMapRef.current.applyCachedShadow === 'function') {
          shadeMapRef.current.applyCachedShadow(cachedShadow);
        }
        
        const totalTime = performance.now() - startTime;
        console.log(`✅ 阴影更新完成 (缓存, ${totalTime.toFixed(0)}ms)`);
        return;
      }

      // 2. 获取建筑物数据
      const buildingStartTime = performance.now();
      const buildingData = await optimizedBuildingService.getBuildingData(
        {
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        },
        zoom
      );
      
      const buildingTime = performance.now() - buildingStartTime;
      console.log(`🏗️ 建筑物数据获取: ${buildingData.features.length} 个 (${buildingTime.toFixed(0)}ms, ${buildingData.source})`);

      // 3. 执行阴影计算
      const shadowStartTime = performance.now();
      
      // 更新建筑物数据
      if (typeof shadeMapRef.current.updateBuildings === 'function') {
        shadeMapRef.current.updateBuildings(buildingData.features);
      } else if (typeof shadeMapRef.current.setData === 'function') {
        shadeMapRef.current.setData({
          type: 'FeatureCollection',
          features: buildingData.features
        });
      }

      // 更新时间
      if (typeof shadeMapRef.current.setDate === 'function') {
        shadeMapRef.current.setDate(currentDate);
      }

      // 执行阴影计算
      if (typeof shadeMapRef.current._draw === 'function') {
        shadeMapRef.current._draw();
      }

      const shadowTime = performance.now() - shadowStartTime;
      const totalTime = performance.now() - startTime;

      // 4. 缓存结果
      if (buildingData.features.length > 0) {
        const shadowResult = {
          buildings: buildingData.features,
          timestamp: Date.now(),
          processingTime: totalTime
        };
        
        shadowCache.set(
          {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
          },
          zoom,
          currentDate,
          shadowResult
        );
      }

      console.log(`✅ 阴影计算完成: 总计 ${totalTime.toFixed(0)}ms (建筑物: ${buildingTime.toFixed(0)}ms, 阴影: ${shadowTime.toFixed(0)}ms)`);

      // 5. 性能警告
      if (totalTime > 2000) {
        console.warn(`⚠️ 阴影计算较慢 (${totalTime.toFixed(0)}ms)，考虑优化`);
        addStatusMessage(`Shadow calculation slow: ${totalTime.toFixed(0)}ms`, 'warning');
      } else if (totalTime < 500) {
        console.log(`⚡ 高性能阴影计算: ${totalTime.toFixed(0)}ms`);
      }

    } catch (error) {
      const totalTime = performance.now() - startTime;
      console.error(`❌ 阴影计算失败 (${totalTime.toFixed(0)}ms):`, error);
      addStatusMessage(`Shadow calculation failed: ${error.message}`, 'error');
    }
  }, [currentDate, addStatusMessage]);

  // 使用智能更新Hook
  const {
    onMapMove,
    onMapZoom,
    onTimeChange,
    immediateUpdate,
    isInteracting
  } = useSmartShadowUpdate(performShadowCalculation, {
    moveDelay: 300,
    zoomDelay: 500,
    timeDelay: 100,
    minZoom: 15
  });

  // 初始化地图
  useEffect(() => {
    if (!mapContainerRef.current || isInitializedRef.current) return;

    console.log('🗺️ 初始化优化版Mapbox地图...');

    // 设置Mapbox访问令牌
    mapboxgl.accessToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [116.4074, 39.9042], // 北京
      zoom: 15,
      pitch: 0,
      bearing: 0,
      antialias: true,
      optimizeForTerrain: true,
      preserveDrawingBuffer: true // 用于截图和导出
    });

    mapRef.current = map;

    map.on('load', async () => {
      console.log('✅ Mapbox地图加载完成');

      try {
        // 初始化阴影模拟器
        if (window.ShadeMap) {
          const shadeMap = new window.ShadeMap({
            date: currentDate,
            color: mapSettings.shadowColor,
            opacity: mapSettings.shadowOpacity,
            apikey: mapboxgl.accessToken,
            terrainSource: {
              tileSize: 256,
              url: 'http://localhost:3001/api/dem/{z}/{x}/{y}.png'
            },
            getBuildingData: async function () {
              const bounds = map.getBounds();
              const zoom = map.getZoom();
              
              const buildingData = await optimizedBuildingService.getBuildingData(
                {
                  north: bounds.getNorth(),
                  south: bounds.getSouth(),
                  east: bounds.getEast(),
                  west: bounds.getWest()
                },
                zoom
              );
              
              return buildingData.features;
            },
            debug: (msg: string) => {
              console.log('🔧 Shadow Simulator:', msg);
            },
          });

          shadeMap.addTo(map);
          shadeMapRef.current = shadeMap;

          console.log('✅ 优化版阴影模拟器初始化成功');
          addStatusMessage('✅ 优化版阴影模拟器就绪', 'success');

          // 立即计算一次阴影
          immediateUpdate();

        } else {
          console.error('❌ ShadeMap库未加载');
          addStatusMessage('❌ 阴影模拟器库未加载', 'error');
        }

      } catch (error) {
        console.error('❌ 阴影模拟器初始化失败:', error);
        addStatusMessage('❌ 阴影模拟器初始化失败', 'error');
      }
    });

    // 地图事件监听
    map.on('moveend', () => {
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      const center = map.getCenter();
      
      onMapMove(zoom, { lat: center.lat, lng: center.lng });
    });

    map.on('zoomend', () => {
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      const center = map.getCenter();
      
      onMapZoom(zoom, { lat: center.lat, lng: center.lng });
    });

    isInitializedRef.current = true;

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      if (shadeMapRef.current) {
        shadeMapRef.current = null;
      }
      isInitializedRef.current = false;
    };
  }, [onMapMove, onMapZoom, immediateUpdate, currentDate, mapSettings.shadowColor, mapSettings.shadowOpacity, addStatusMessage]);

  // 监听时间变化
  useEffect(() => {
    if (mapRef.current) {
      const zoom = mapRef.current.getZoom();
      onTimeChange(zoom, currentDate.getTime());
    }
  }, [currentDate, onTimeChange]);

  // 监听阴影设置变化
  useEffect(() => {
    if (!shadeMapRef.current) return;

    try {
      if (mapSettings.showShadowLayer) {
        if (typeof shadeMapRef.current.setOpacity === 'function') {
          shadeMapRef.current.setOpacity(mapSettings.shadowOpacity);
        }
        if (typeof shadeMapRef.current.setColor === 'function') {
          shadeMapRef.current.setColor(mapSettings.shadowColor);
        }
      } else {
        if (typeof shadeMapRef.current.setOpacity === 'function') {
          shadeMapRef.current.setOpacity(0);
        }
      }
    } catch (error) {
      console.warn('⚠️ 阴影设置更新失败:', error);
    }
  }, [mapSettings.shadowColor, mapSettings.shadowOpacity, mapSettings.showShadowLayer]);

  // 显示性能信息
  useEffect(() => {
    const interval = setInterval(() => {
      if (process.env.NODE_ENV === 'development') {
        const cacheStats = shadowCache.getStats();
        const buildingStats = optimizedBuildingService.getCacheStats();
        
        console.log('📊 性能统计:', {
          shadowCache: `${cacheStats.hits}/${cacheStats.totalRequests} (${cacheStats.hitRate.toFixed(1)}%)`,
          buildingCache: `${buildingStats.size}/${buildingStats.maxSize}`,
          isInteracting: isInteracting()
        });
      }
    }, 30000); // 每30秒显示一次

    return () => clearInterval(interval);
  }, [isInteracting]);

  return (
    <div className={`w-full h-full relative ${className}`}>
      <div ref={mapContainerRef} className="w-full h-full" />
      
      {/* 性能指示器 */}
      {isInteracting() && (
        <div className="absolute top-4 left-4 bg-yellow-100 text-yellow-800 px-3 py-2 rounded-lg shadow-lg z-10">
          🔄 Calculating shadows...
        </div>
      )}
    </div>
  );
};
