import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { getWfsBuildings } from '../../services/wfsBuildingService';

// 声明全局ShadeMap类型
declare global {
  interface Window {
    ShadeMap: any;
  }
}

interface TUM3DShadowMapProps {
  className?: string;
}

export const TUM3DShadowMapFixed: React.FC<TUM3DShadowMapProps> = ({ className = '' }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shadeMapRef = useRef<any>(null);
  const [is3D, setIs3D] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [buildingsLoaded, setBuildingsLoaded] = useState(false);
  const [shadowInitRetries, setShadowInitRetries] = useState(0);
  
  const {
    mapSettings,
    currentDate,
    addStatusMessage,
    setMapView,
  } = useShadowMapStore();

  // 加载mapbox-gl-shadow-simulator
  useEffect(() => {
    const loadShadowSimulator = () => {
      return new Promise((resolve, reject) => {
        if (window.ShadeMap) {
          resolve(window.ShadeMap);
          return;
        }

        const script = document.createElement('script');
        script.src = 'https://unpkg.com/mapbox-gl-shadow-simulator/dist/mapbox-gl-shadow-simulator.umd.min.js';
        script.onload = () => {
          if (window.ShadeMap) {
            resolve(window.ShadeMap);
          } else {
            reject(new Error('ShadeMap not loaded'));
          }
        };
        script.onerror = () => reject(new Error('Failed to load ShadeMap'));
        document.head.appendChild(script);
      });
    };

    loadShadowSimulator().catch(console.error);
  }, []);

  // 初始化地图
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    console.log('🗺️ 初始化TUM 3D阴影地图...');

    mapboxgl.accessToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v11',
      center: [116.4074, 39.9042],
      zoom: 15,
      pitch: 60, // 默认3D俯仰角
      bearing: -17.6, // 默认3D方位角
      hash: true,
      antialias: true,
    });

    mapRef.current = map;

    map.on('load', () => {
      console.log('✅ TUM 3D阴影地图加载完成');
      loadWfsBuildings();
      
      map.on('click', handleMapClick);
      map.on('moveend', handleMapMove);
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // 加载TUM建筑物数据（只加载一次）
  const loadWfsBuildings = useCallback(async () => {
    if (!mapRef.current || buildingsLoaded) return;

    setIsLoading(true);
    try {
      const mapBounds = mapRef.current.getBounds();
      const buildingData = await getWfsBuildings({
        north: mapBounds.getNorth(),
        south: mapBounds.getSouth(),
        east: mapBounds.getEast(),
        west: mapBounds.getWest()
      });

      if (buildingData.success && buildingData.data.features.length > 0) {
        addBuildingsToMap(buildingData.data);
        addStatusMessage(`Loaded ${buildingData.data.features.length} buildings from WFS`, 'info');
        setBuildingsLoaded(true);
        
        // 建筑物加载完成后初始化阴影模拟器
        setTimeout(() => {
          initShadowSimulator();
        }, 2000); // 增加延迟时间确保数据完全加载
      } else {
        addStatusMessage('No building data returned from WFS', 'warning');
      }
    } catch (error) {
      console.error('[ShadowMapFixed] Failed to load WFS buildings', error);
      addStatusMessage(`Failed to load WFS buildings: ${error}`, 'error');
    } finally {
      setIsLoading(false);
    }
  }, [buildingsLoaded, addStatusMessage]);

  // 将建筑物添加到地图
  const addBuildingsToMap = (buildingData: any) => {
    if (!mapRef.current) return;

    const map = mapRef.current;
    const sourceId = 'tum-buildings';
    const fillLayerId = 'tum-buildings-fill';
    const outlineLayerId = 'tum-buildings-outline';
    const extrusionLayerId = 'tum-buildings-extrusion';

    // 移除现有图层
    [fillLayerId, outlineLayerId, extrusionLayerId].forEach(layerId => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    });
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    // 处理建筑物数据
    const processedFeatures = buildingData.features.map((feature: any) => {
      if (!feature.properties) feature.properties = {};
      
      if (!feature.properties.height) {
        feature.properties.height = feature.properties.levels ? 
          feature.properties.levels * 3.5 : 
          estimateBuildingHeight(feature.properties.buildingType || 'building');
      }
      
      return feature;
    });

    // 添加数据源
    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: processedFeatures
      }
    });

    // 添加2D填充图层
    map.addLayer({
      id: fillLayerId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': '#D3D3D3',
        'fill-opacity': 0.8
      }
    });

    // 添加轮廓图层
    map.addLayer({
      id: outlineLayerId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#A0A0A0',
        'line-width': 1,
        'line-opacity': 0.9
      }
    });

    // 添加3D挤出图层
    map.addLayer({
      id: extrusionLayerId,
      type: 'fill-extrusion',
      source: sourceId,
      paint: {
        'fill-extrusion-color': '#D3D3D3',
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['get', 'height'],
          0, 0,
          100, ['get', 'height']
        ],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.8
      }
    });

    // 初始时显示3D图层（默认3D模式）
    map.setLayoutProperty(extrusionLayerId, 'visibility', 'visible');
    map.setLayoutProperty(fillLayerId, 'visibility', 'none');
    map.setLayoutProperty(outlineLayerId, 'visibility', 'none');
    
    console.log('🏗️ 建筑物图层初始化完成，当前模式: 3D');
  };

  // 初始化阴影模拟器
  const initShadowSimulator = () => {
    if (!mapRef.current || !window.ShadeMap) {
      console.error('❌ 地图或ShadeMap未就绪');
      return;
    }

    // 检查建筑物数据是否已加载
    const buildingSource = mapRef.current.getSource('tum-buildings');
    if (!buildingSource || !(buildingSource as any)._data || !(buildingSource as any)._data.features.length) {
      if (shadowInitRetries < 5) {
        console.log(`⚠️ 建筑物数据未就绪，延迟初始化阴影模拟器 (重试 ${shadowInitRetries + 1}/5)`);
        setShadowInitRetries(prev => prev + 1);
        setTimeout(() => {
          initShadowSimulator();
        }, 1000);
        return;
      } else {
        console.error('❌ 阴影模拟器初始化失败：建筑物数据加载超时');
        addStatusMessage('阴影模拟器初始化失败：建筑物数据未加载', 'error');
        return;
      }
    }

    try {
      console.log('🌅 初始化阴影模拟器...');
      
      // 移除现有阴影模拟器
      if (shadeMapRef.current) {
        shadeMapRef.current.remove();
        shadeMapRef.current = null;
      }

      // 获取建筑物数据
      const buildings = (buildingSource as any)._data.features;
      console.log(`🏢 准备为阴影模拟器提供 ${buildings.length} 个建筑物`);

      // 创建新的阴影模拟器
      shadeMapRef.current = new window.ShadeMap({
        date: currentDate,
        color: '#404040', // 深灰色阴影
        opacity: 0.6,
        apiKey: mapboxgl.accessToken, // 使用Mapbox的access token作为apiKey
        getFeatures: () => {
          // 确保返回最新的建筑物数据
          const currentSource = mapRef.current?.getSource('tum-buildings');
          if (currentSource && (currentSource as any)._data) {
            const currentBuildings = (currentSource as any)._data.features;
            console.log(`🏢 为阴影模拟器提供 ${currentBuildings.length} 个建筑物`);
            return currentBuildings;
          }
          console.warn('⚠️ 无法获取建筑物数据，返回空数组');
          return [];
        },
        debug: (msg: string) => {
          console.log('🌅 ShadeMap:', msg);
        }
      }).addTo(mapRef.current);

      console.log('✅ 阴影模拟器初始化成功');
      addStatusMessage('阴影模拟器已启动', 'info');
      setShadowInitRetries(0); // 重置重试计数器

    } catch (error) {
      console.error('❌ 阴影模拟器初始化失败:', error);
      addStatusMessage(`阴影模拟器初始化失败: ${error}`, 'error');
    }
  };

  // 估算建筑物高度
  const estimateBuildingHeight = (buildingType: string): number => {
    const heightMap: { [key: string]: number } = {
      'residential': 20,
      'commercial': 30,
      'office': 40,
      'industrial': 15,
      'school': 15,
      'hospital': 25,
      'hotel': 35,
      'retail': 12,
      'warehouse': 8,
      'building': 20
    };
    return heightMap[buildingType] || 20;
  };

  // 切换2D/3D模式
  const toggle2D3D = () => {
    if (!mapRef.current) return;

    const map = mapRef.current;
    const extrusionLayerId = 'tum-buildings-extrusion';
    const fillLayerId = 'tum-buildings-fill';
    const outlineLayerId = 'tum-buildings-outline';

    console.log(`🔄 切换模式: ${is3D ? '3D' : '2D'} → ${!is3D ? '3D' : '2D'}`);

    setIs3D(!is3D);

    if (!is3D) {
      // 切换到3D模式
      console.log('🏗️ 切换到3D模式...');
      
      if (map.getLayer(extrusionLayerId)) {
        map.setLayoutProperty(extrusionLayerId, 'visibility', 'visible');
        console.log('✅ 3D挤出图层已显示');
      }
      
      if (map.getLayer(fillLayerId)) {
        map.setLayoutProperty(fillLayerId, 'visibility', 'none');
        console.log('✅ 2D填充图层已隐藏');
      }
      
      if (map.getLayer(outlineLayerId)) {
        map.setLayoutProperty(outlineLayerId, 'visibility', 'none');
        console.log('✅ 2D轮廓图层已隐藏');
      }
      
      map.easeTo({
        pitch: 60,
        bearing: -17.6,
        duration: 1000
      });
      
      addStatusMessage('已切换到3D模式', 'info');
    } else {
      // 切换到2D模式
      console.log('📐 切换到2D模式...');
      
      if (map.getLayer(extrusionLayerId)) {
        map.setLayoutProperty(extrusionLayerId, 'visibility', 'none');
        console.log('✅ 3D挤出图层已隐藏');
      }
      
      if (map.getLayer(fillLayerId)) {
        map.setLayoutProperty(fillLayerId, 'visibility', 'visible');
        console.log('✅ 2D填充图层已显示');
      }
      
      if (map.getLayer(outlineLayerId)) {
        map.setLayoutProperty(outlineLayerId, 'visibility', 'visible');
        console.log('✅ 2D轮廓图层已显示');
      }
      
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 1000
      });
      
      addStatusMessage('已切换到2D模式', 'info');
    }
  };

  // 处理地图移动（优化：减少重复加载）
  const handleMapMove = () => {
    if (!mapRef.current) return;
    
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    setMapView([center.lat, center.lng], zoom);
    
    // 只有在缩放级别变化较大时才重新加载
    if (zoom < 14 && buildingsLoaded) {
      console.log('📊 缩放级别过低，隐藏建筑物');
      const map = mapRef.current;
      ['tum-buildings-fill', 'tum-buildings-outline', 'tum-buildings-extrusion'].forEach(layerId => {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', 'none');
        }
      });
    } else if (zoom >= 14 && buildingsLoaded) {
      console.log('📊 缩放级别足够，显示建筑物');
      const map = mapRef.current;
      const extrusionLayerId = 'tum-buildings-extrusion';
      const fillLayerId = 'tum-buildings-fill';
      const outlineLayerId = 'tum-buildings-outline';
      
      if (is3D) {
        if (map.getLayer(extrusionLayerId)) {
          map.setLayoutProperty(extrusionLayerId, 'visibility', 'visible');
        }
        if (map.getLayer(fillLayerId)) {
          map.setLayoutProperty(fillLayerId, 'visibility', 'none');
        }
        if (map.getLayer(outlineLayerId)) {
          map.setLayoutProperty(outlineLayerId, 'visibility', 'none');
        }
      } else {
        if (map.getLayer(extrusionLayerId)) {
          map.setLayoutProperty(extrusionLayerId, 'visibility', 'none');
        }
        if (map.getLayer(fillLayerId)) {
          map.setLayoutProperty(fillLayerId, 'visibility', 'visible');
        }
        if (map.getLayer(outlineLayerId)) {
          map.setLayoutProperty(outlineLayerId, 'visibility', 'visible');
        }
      }
    }
  };

  // 处理地图点击
  const handleMapClick = (e: mapboxgl.MapMouseEvent) => {
    if (!mapRef.current) return;

    const features = mapRef.current.queryRenderedFeatures(e.point, {
      layers: ['tum-buildings-fill', 'tum-buildings-extrusion']
    });

    if (features.length > 0) {
      const feature = features[0];
      const props = feature.properties;
      
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="min-w-48">
            <h4 class="font-bold text-gray-800 mb-2">🏢 TUM建筑物信息</h4>
            <p><strong>类型:</strong> ${props.buildingType || '未知'}</p>
            <p><strong>高度:</strong> ${props.height || '未知'}m</p>
            <p><strong>楼层:</strong> ${props.levels || '未知'}</p>
            <p><strong>数据源:</strong> TUM GlobalBuildingAtlas</p>
          </div>
        `)
        .addTo(mapRef.current);
    }
  };

  // 更新时间
  useEffect(() => {
    if (shadeMapRef.current && typeof shadeMapRef.current.setDate === 'function') {
      shadeMapRef.current.setDate(currentDate);
      console.log('🕐 阴影时间已更新:', currentDate.toISOString());
    }
  }, [currentDate]);

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* 地图容器 */}
      <div ref={mapContainerRef} className="w-full h-full" />
      
      {/* 控制面板 */}
      <div className="absolute top-4 right-4 z-[9999] space-y-2">
        {/* 2D/3D切换按钮 */}
        <button
          onClick={toggle2D3D}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded shadow-lg"
          disabled={isLoading}
        >
          {isLoading ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
              加载中...
            </>
          ) : is3D ? (
            <>
              <span>📐</span>
              切换到2D
            </>
          ) : (
            <>
              <span>🏗️</span>
              切换到3D
            </>
          )}
        </button>

        {/* 重新初始化阴影按钮 */}
        <button
          onClick={() => {
            if (window.ShadeMap) {
              initShadowSimulator();
            } else {
              addStatusMessage('阴影模拟器未加载', 'error');
            }
          }}
          className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded shadow-lg"
        >
          <span>🌅</span>
          重新计算阴影
        </button>
      </div>

      {/* 加载状态指示器 */}
      {isLoading && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-20">
          <div className="bg-white bg-opacity-90 rounded-lg p-4 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              <span className="text-gray-700">正在加载TUM建筑物数据...</span>
            </div>
          </div>
        </div>
      )}

      {/* 状态信息 */}
      <div className="absolute bottom-4 left-4 z-[9999]">
        <div className="bg-white bg-opacity-90 rounded px-3 py-2 shadow-lg">
          <div className="text-sm text-gray-700">
            <div>模式: {is3D ? '3D' : '2D'} | 数据: TUM</div>
            <div>建筑物: {buildingsLoaded ? '已加载' : '加载中'}</div>
            <div>阴影: {shadeMapRef.current ? '已启用' : '未启用'}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
