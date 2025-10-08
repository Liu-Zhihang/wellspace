import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import TUMCacheManager from '../UI/TUMCacheManager';
import type { Feature } from 'geojson';
import { getTUMBuildings } from '../../services/tumBuildingService';
import { buildingCache } from '../../cache/buildingCache';
import { useShadowMapStore } from '../../store/shadowMapStore';

// 声明全局ShadeMap类型
declare global {
  interface Window {
    ShadeMap: any;
  }
}

interface CleanShadowMapProps {
  className?: string;
}

export const CleanShadowMap: React.FC<CleanShadowMapProps> = ({ className = '' }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shadeMapRef = useRef<any>(null);
  const [buildingsLoaded, setBuildingsLoaded] = useState(false);
  const [shadowLoaded, setShadowLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('准备中...');
  const [showCacheManager, setShowCacheManager] = useState(false);
  
  // Connect to Zustand store
  const { currentDate, mapSettings } = useShadowMapStore();

  // 组件加载完成
  console.log('✅ CleanShadowMap组件已加载');

  // 加载阴影模拟器库
  const loadShadowSimulator = useCallback(() => {
    return new Promise((resolve, reject) => {
      if (window.ShadeMap) {
        resolve(window.ShadeMap);
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://unpkg.com/mapbox-gl-shadow-simulator/dist/mapbox-gl-shadow-simulator.umd.min.js';
      script.onload = () => {
        if (window.ShadeMap) {
          console.log('✅ 阴影模拟器库加载成功');
          setStatusMessage('阴影模拟器库加载成功');
          resolve(window.ShadeMap);
        } else {
          reject(new Error('ShadeMap not loaded'));
        }
      };
      script.onerror = () => reject(new Error('Failed to load ShadeMap'));
      document.head.appendChild(script);
    });
  }, []);

  // 测试TUM连接
  const testTUMConnection = useCallback(async () => {
    try {
      setStatusMessage('测试TUM连接...');
      const response = await fetch('http://localhost:3001/api/tum-buildings/test');
      const result = await response.json();
      
      if (result.success) {
        setStatusMessage('TUM连接测试成功');
        return true;
      } else {
        setStatusMessage('TUM连接测试失败: ' + result.message);
        return false;
      }
    } catch (error) {
      setStatusMessage('TUM连接测试失败: ' + (error as Error).message);
      return false;
    }
  }, []);

  // 加载建筑物数据（使用后端流式处理）
  const loadBuildings = useCallback(async () => {
    if (!mapRef.current) {
      setStatusMessage('地图未初始化');
      return;
    }

    try {
      setIsLoading(true);
      setStatusMessage('正在加载当前视野范围的建筑物...');
      console.log('🏢 开始加载当前视野范围的建筑物数据');
      
      const bounds = mapRef.current.getBounds();
      const boundingBox = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      };

      console.log('📍 当前视野边界:', boundingBox);

      // Use the service with caching
      const result = await getTUMBuildings(boundingBox, 10000); // Increase maxFeatures
      
      if (result.success && result.data) {
        addBuildingsToMap(result.data);
        setBuildingsLoaded(true);
        setStatusMessage(`加载了 ${result.data.features.length} 个建筑物 (累计)`);
      } else {
        throw new Error(result.metadata?.message || 'Failed to load buildings');
      }
    } catch (error) {
      console.error('❌ 加载建筑物失败:', error);
      setStatusMessage('加载建筑物失败: ' + (error as Error).message);
      setBuildingsLoaded(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 添加建筑物到地图 - 完整调试版本
  const addBuildingsToMap = useCallback((buildingData: any) => {
    console.log('🚀 开始添加建筑物到地图...');
    
    if (!mapRef.current) {
      console.error('❌ mapRef.current 为空');
      return;
    }

    const map = mapRef.current;
    const sourceId = 'clean-buildings';
    const layerId = 'clean-buildings-extrusion';

    console.log('🗺️ 地图状态:', {
      loaded: map.loaded(),
      style: map.getStyle()?.name,
      center: map.getCenter(),
      zoom: map.getZoom(),
      pitch: map.getPitch()
    });

    // 移除现有图层
    if (map.getLayer(layerId)) {
      console.log('🗑️ 移除现有图层:', layerId);
      map.removeLayer(layerId);
    }
    if (map.getSource(sourceId)) {
      console.log('🗑️ 移除现有数据源:', sourceId);
      map.removeSource(sourceId);
    }

    // 详细数据检查
    console.log('🔍 详细数据分析:', {
      dataType: typeof buildingData,
      hasFeatures: !!buildingData.features,
      featuresCount: buildingData.features?.length,
      isArray: Array.isArray(buildingData.features)
    });

    if (!buildingData.features || !Array.isArray(buildingData.features)) {
      console.error('❌ 数据格式错误: features不是数组');
      return;
    }

    if (buildingData.features.length === 0) {
      console.warn('⚠️ 建筑物数据为空');
      return;
    }

    // 分析前3个建筑物的数据结构
    for (let i = 0; i < Math.min(3, buildingData.features.length); i++) {
      const feature = buildingData.features[i];
      console.log(`🏢 建筑物 ${i + 1} 详细分析:`, {
        type: feature.type,
        geometry: {
          type: feature.geometry?.type,
          hasCoordinates: !!feature.geometry?.coordinates,
          coordinatesLength: feature.geometry?.coordinates?.length,
          firstCoordinate: feature.geometry?.coordinates?.[0]
        },
        properties: {
          hasProperties: !!feature.properties,
          keys: feature.properties ? Object.keys(feature.properties) : [],
          height: feature.properties?.height,
          height_mean: feature.properties?.height_mean,
          levels: feature.properties?.levels
        }
      });
    }

    // 处理高度数据
    const processedFeatures = buildingData.features.map((feature: Feature, index: number) => {
      if (!feature.properties) feature.properties = {};
      
      // 设置高度
      if (!feature.properties.height) {
        if (feature.properties.height_mean) {
          feature.properties.height = feature.properties.height_mean;
        } else if (feature.properties.levels) {
          feature.properties.height = feature.properties.levels * 3.5;
        } else {
          feature.properties.height = 15; // 默认高度
        }
      }

      // 确保高度是数字
      feature.properties.height = Number(feature.properties.height) || 15;

      if (index < 3) {
        console.log(`🔧 处理后建筑物 ${index + 1}:`, {
          height: feature.properties.height,
          heightType: typeof feature.properties.height
        });
      }

      return feature;
    });

    console.log('📊 处理后数据统计:', {
      totalFeatures: processedFeatures.length,
      heightStats: {
        min: Math.min(...processedFeatures.map((f: Feature) => f.properties?.height || 0)),
        max: Math.max(...processedFeatures.map((f: Feature) => f.properties?.height || 0)),
        avg: processedFeatures.reduce((sum: number, f: Feature) => sum + (f.properties?.height || 0), 0) / processedFeatures.length
      }
    });

    // 创建GeoJSON数据源
    const geoJsonData: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: processedFeatures
    };

    console.log('📍 添加数据源到地图...');
    try {
      map.addSource(sourceId, {
        type: 'geojson',
        data: geoJsonData
      });
      console.log('✅ 数据源添加成功');
    } catch (sourceError) {
      console.error('❌ 添加数据源失败:', sourceError);
      return;
    }

    // 添加图层
    console.log('🎨 添加图层到地图...');
    try {
      map.addLayer({
        id: layerId,
        type: 'fill-extrusion',
        source: sourceId,
        paint: {
          'fill-extrusion-color': '#4a4a4a', // 深灰色建筑物
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.8
        }
      });
      console.log('✅ 图层添加成功');
    } catch (layerError) {
      console.error('❌ 添加图层失败:', layerError);
      return;
    }

    // 立即验证
    console.log('🔍 立即验证图层状态:');
    const addedLayer = map.getLayer(layerId);
    const addedSource = map.getSource(sourceId);
    console.log('📊 验证结果:', {
      layerExists: !!addedLayer,
      layerType: addedLayer?.type,
      sourceExists: !!addedSource,
      sourceType: addedSource?.type
    });

    // 检查地图边界是否包含数据
    const mapBounds = map.getBounds();
    console.log('🗺️ 地图边界与数据范围检查:', {
      mapBounds: {
        north: mapBounds.getNorth(),
        south: mapBounds.getSouth(),
        east: mapBounds.getEast(),
        west: mapBounds.getWest()
      }
    });

    // 延迟验证渲染状态
    setTimeout(() => {
      if (!map || !mapRef.current) {
        console.warn('⚠️ 地图对象已销毁，跳过延迟验证');
        return;
      }
      
      console.log('⏰ 延迟验证 (1秒后):');
      const finalLayer = map.getLayer(layerId);
      const finalSource = map.getSource(sourceId);
      
      if (finalSource && 'type' in finalSource && finalSource.type === 'geojson') {
        console.log('📈 最终状态:', {
          layerVisible: finalLayer ? true : false,
          sourceLoaded: true,
          mapRendering: map.loaded()
        });
      }
    }, 1000);

    console.log('🎯 建筑物添加流程完成');
  }, []);

  // 初始化阴影模拟器
  const initShadowSimulator = useCallback(() => {
    if (!mapRef.current || !window.ShadeMap) {
      setStatusMessage('地图或阴影模拟器未就绪');
      return;
    }

    if (!buildingsLoaded) {
      setStatusMessage('请先加载建筑物数据');
      return;
    }

    try {
      console.log('🌅 开始初始化阴影模拟器...');
      
      // 安全地移除现有阴影模拟器
      if (shadeMapRef.current) {
        try {
          console.log('🗑️ 移除现有阴影模拟器...');
          shadeMapRef.current.remove();
        } catch (removeError) {
          console.warn('⚠️ 移除现有阴影模拟器时出错:', removeError);
        } finally {
          shadeMapRef.current = null;
        }
      }

      // 验证建筑物数据
      const buildingSource = mapRef.current.getSource('clean-buildings');
      if (!buildingSource) {
        setStatusMessage('建筑物数据源不存在');
        return;
      }

      const sourceData = (buildingSource as any)._data;
      if (!sourceData || !sourceData.features || sourceData.features.length === 0) {
        setStatusMessage('建筑物数据为空');
        return;
      }

      const buildings = sourceData.features;
      console.log(`🏢 准备为阴影模拟器提供 ${buildings.length} 个建筑物`);

      // 验证建筑物数据格式
      const validBuildings = buildings.filter((building: any) => {
        return building && 
               building.geometry && 
               building.geometry.coordinates && 
               building.properties;
      });

      console.log(`✅ 有效建筑物数量: ${validBuildings.length}`);

      if (validBuildings.length === 0) {
        setStatusMessage('没有有效的建筑物数据');
        return;
      }

      // 创建新的阴影模拟器 - 使用store中的设置
      shadeMapRef.current = new window.ShadeMap({
        date: currentDate,
        color: mapSettings.shadowColor,
        opacity: mapSettings.shadowOpacity,
        apiKey: mapboxgl.accessToken,
        terrainSource: {
          tileSize: 256,
          maxZoom: 15,
          getSourceUrl: () => {
            // 使用本地Example DEM数据
            return `/Example/Height/europe/11.4_48.2_11.6_48.0_sr_ss.tif`;
          },
          getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
            // GeoTIFF格式的高程解析（根据TUM数据格式）
            return (r * 256 + g + b / 256) - 32768;
          }
        },
        getFeatures: () => {
          const buildingSource = mapRef.current?.getSource('clean-buildings');
          if (buildingSource && (buildingSource as any)._data) {
            const buildings = (buildingSource as any)._data.features;
            const validBuildings = buildings.filter((building: any) => {
              return building && 
                     building.geometry && 
                     building.geometry.coordinates && 
                     building.properties;
            });
            console.log(`🏢 实时提供 ${validBuildings.length} 个有效建筑物给阴影模拟器`);
            return validBuildings;
          }
          console.warn('⚠️ 无法获取建筑物数据源');
          return [];
        },
        debug: (msg: string) => {
          console.log('ShadeMap:', msg);
        }
      }).addTo(mapRef.current);

      setShadowLoaded(true);
      setStatusMessage(`阴影模拟器初始化成功，处理了 ${validBuildings.length} 个建筑物`);
      console.log('✅ 阴影模拟器初始化成功');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setStatusMessage('阴影模拟器初始化失败: ' + errorMessage);
      console.error('❌ 阴影模拟器初始化失败:', error);
      
      // 重置状态
      setShadowLoaded(false);
      shadeMapRef.current = null;
    }
  }, [buildingsLoaded, currentDate]);

  // 更新阴影时间
  const updateShadowTime = useCallback((newTime: Date) => {
    const { setCurrentDate } = useShadowMapStore.getState();
    if (shadeMapRef.current && typeof shadeMapRef.current.setDate === 'function') {
      shadeMapRef.current.setDate(newTime);
      setCurrentDate(newTime);
      setStatusMessage('阴影时间已更新: ' + newTime.toLocaleString());
    } else {
      setStatusMessage('阴影模拟器未初始化');
    }
  }, []);

  // Watch for setting changes and update shadow simulator
  useEffect(() => {
    if (shadeMapRef.current) {
      console.log('🎨 Updating shadow settings:', {
        color: mapSettings.shadowColor,
        opacity: mapSettings.shadowOpacity
      });
      
      // Update color
      if (typeof shadeMapRef.current.setColor === 'function') {
        shadeMapRef.current.setColor(mapSettings.shadowColor);
      }
      
      // Update opacity
      if (typeof shadeMapRef.current.setOpacity === 'function') {
        shadeMapRef.current.setOpacity(mapSettings.shadowOpacity);
      }
      
      // Update date
      if (typeof shadeMapRef.current.setDate === 'function') {
        shadeMapRef.current.setDate(currentDate);
      }
    }
  }, [mapSettings.shadowColor, mapSettings.shadowOpacity, currentDate]);

  // 清除建筑物和阴影
  const clearBuildings = useCallback(() => {
    if (!mapRef.current) return;

    const map = mapRef.current;
    const sourceId = 'clean-buildings';
    const layerId = 'clean-buildings-extrusion';

    // 移除建筑物图层
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
      console.log('🗑️ 移除建筑物图层');
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
      console.log('🗑️ 移除建筑物数据源');
    }

    // Clear the client-side cache
    buildingCache.clear();

    // 安全地移除阴影模拟器
    if (shadeMapRef.current) {
      try {
        shadeMapRef.current.remove();
        console.log('🗑️ 移除阴影模拟器');
      } catch (removeError) {
        console.warn('⚠️ 移除阴影模拟器时出错:', removeError);
      } finally {
        shadeMapRef.current = null;
      }
    }

    // 重置状态
    setBuildingsLoaded(false);
    setShadowLoaded(false);
    setStatusMessage('已清除建筑物和阴影，可以重新加载');
  }, []);

  // 初始化地图
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    console.log('🗺️ 初始化清洁版阴影地图...');

    mapboxgl.accessToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v11',
      center: [11.5755, 48.1374], // 慕尼黑
      zoom: 16,
      pitch: 45,
      bearing: 0
    });

    mapRef.current = map;

    map.on('load', async () => {
      console.log('✅ 地图加载完成');
      setStatusMessage('地图加载完成，请手动执行操作步骤');
      
      // 只加载阴影模拟器库，不自动执行其他步骤
      await loadShadowSimulator();
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [loadShadowSimulator, testTUMConnection, loadBuildings, initShadowSimulator]);

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* 添加CSS动画样式 */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* 地图容器 */}
      <div ref={mapContainerRef} className="w-full h-full" />
      
      {/* 简洁的控制面板 - 修复定位问题 */}
      <div style={{ 
        position: 'absolute', 
        top: '16px', 
        right: '16px', 
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}>
        {/* 控制面板 */}
        {/* TUM连接测试按钮 */}
        <button
          onClick={testTUMConnection}
          disabled={isLoading}
          style={{
            background: '#2563eb',
            color: 'white',
            fontWeight: 'bold',
            padding: '8px 16px',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            border: 'none',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            opacity: isLoading ? 0.6 : 1,
            fontSize: '14px',
            minWidth: '140px'
          }}
          onMouseEnter={(e) => {
            if (!isLoading) {
              e.currentTarget.style.background = '#1d4ed8';
            }
          }}
          onMouseLeave={(e) => {
            if (!isLoading) {
              e.currentTarget.style.background = '#2563eb';
            }
          }}
        >
          🔍 测试TUM连接
        </button>

        {/* 加载建筑物按钮 */}
        <button
          onClick={loadBuildings}
          disabled={isLoading}
          style={{
            background: buildingsLoaded ? '#059669' : '#16a34a',
            color: 'white',
            fontWeight: 'bold',
            padding: '8px 16px',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            border: 'none',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            opacity: isLoading ? 0.6 : 1,
            fontSize: '14px',
            minWidth: '140px'
          }}
          onMouseEnter={(e) => {
            if (!isLoading) {
              e.currentTarget.style.background = buildingsLoaded ? '#047857' : '#15803d';
            }
          }}
          onMouseLeave={(e) => {
            if (!isLoading) {
              e.currentTarget.style.background = buildingsLoaded ? '#059669' : '#16a34a';
            }
          }}
        >
          {isLoading ? (
            <>
              <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⏳</span> 加载中...
            </>
          ) : (
            <>
              🏢 {buildingsLoaded ? '重新加载建筑物' : '加载建筑物'}
            </>
          )}
        </button>

        {/* 初始化阴影模拟器按钮 */}
        <button
          onClick={initShadowSimulator}
          disabled={isLoading || !buildingsLoaded}
          style={{
            background: shadowLoaded ? '#6d28d9' : '#7c3aed',
            color: 'white',
            fontWeight: 'bold',
            padding: '8px 16px',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            border: 'none',
            cursor: (isLoading || !buildingsLoaded) ? 'not-allowed' : 'pointer',
            opacity: (isLoading || !buildingsLoaded) ? 0.6 : 1,
            fontSize: '14px',
            minWidth: '140px'
          }}
          onMouseEnter={(e) => {
            if (!isLoading && buildingsLoaded) {
              e.currentTarget.style.background = '#5b21b6';
            }
          }}
          onMouseLeave={(e) => {
            if (!isLoading && buildingsLoaded) {
              e.currentTarget.style.background = shadowLoaded ? '#6d28d9' : '#7c3aed';
            }
          }}
        >
          🌅 {shadowLoaded ? '重新计算阴影' : '初始化阴影模拟器'}
        </button>

        {/* 清除按钮 */}
        <button
          onClick={clearBuildings}
          disabled={isLoading || (!buildingsLoaded && !shadowLoaded)}
          style={{
            background: '#dc2626',
            color: 'white',
            fontWeight: 'bold',
            padding: '8px 16px',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            border: 'none',
            cursor: (isLoading || (!buildingsLoaded && !shadowLoaded)) ? 'not-allowed' : 'pointer',
            opacity: (isLoading || (!buildingsLoaded && !shadowLoaded)) ? 0.6 : 1,
            fontSize: '14px',
            minWidth: '140px'
          }}
          onMouseEnter={(e) => {
            if (!isLoading && (buildingsLoaded || shadowLoaded)) {
              e.currentTarget.style.background = '#b91c1c';
            }
          }}
          onMouseLeave={(e) => {
            if (!isLoading && (buildingsLoaded || shadowLoaded)) {
              e.currentTarget.style.background = '#dc2626';
            }
          }}
        >
          🗑️ 清除所有数据
        </button>
        
        <button
          onClick={() => setShowCacheManager(true)}
          style={{
            padding: '10px 16px',
            background: '#8B5CF6',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: '500',
            boxShadow: '0 2px 8px rgba(139, 92, 246, 0.3)',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#7C3AED';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#8B5CF6';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          🗺️ 缓存管理器
        </button>

        {/* 时间控制 */}
        <div style={{
          background: 'rgba(255, 255, 255, 0.9)',
          backdropFilter: 'blur(12px)',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          padding: '12px',
          minWidth: '200px'
        }}>
          <label style={{
            display: 'block',
            fontSize: '14px',
            fontWeight: '500',
            color: '#374151',
            marginBottom: '8px'
          }}>
            阴影时间
          </label>
          <input
            type="datetime-local"
            value={currentDate.toISOString().slice(0, 16)}
            onChange={(e) => updateShadowTime(new Date(e.target.value))}
            style={{
              width: '100%',
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '14px'
            }}
          />
        </div>
      </div>

      {/* 状态信息和操作指南 */}
      <div className="absolute bottom-4 left-4 z-[9999] space-y-3">
        {/* 状态信息 */}
        <div className="bg-white/90 backdrop-blur-md rounded-lg shadow-lg border border-white/20 px-4 py-3">
          <div className="text-sm text-gray-700 space-y-1">
            <div className="flex items-center">
              <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
              状态: {statusMessage}
            </div>
            <div className="flex items-center">
              <div className={`w-2 h-2 rounded-full mr-2 ${buildingsLoaded ? 'bg-green-500' : 'bg-gray-400'}`}></div>
              建筑物: {buildingsLoaded ? '已加载' : '未加载'}
            </div>
            <div className="flex items-center">
              <div className={`w-2 h-2 rounded-full mr-2 ${shadowLoaded ? 'bg-green-500' : 'bg-gray-400'}`}></div>
              阴影: {shadowLoaded ? '已启用' : '未启用'}
            </div>
          </div>
        </div>

        {/* 操作指南 */}
        <div className="bg-blue-50/90 backdrop-blur-md rounded-lg shadow-lg border border-blue-200/20 px-4 py-3">
          <div className="text-sm text-blue-800">
            <div className="font-medium mb-2">📋 操作步骤:</div>
            <div className="space-y-1 text-xs">
              <div>1. 🔍 测试TUM连接</div>
              <div>2. 🏢 加载建筑物数据</div>
              <div>3. 🌅 初始化阴影模拟器</div>
              <div>4. ⏰ 调整时间查看阴影变化</div>
            </div>
          </div>
        </div>
      </div>

      {/* TUM缓存管理器 */}
      <TUMCacheManager 
        isVisible={showCacheManager}
        onClose={() => setShowCacheManager(false)}
      />
    </div>
  );
};
