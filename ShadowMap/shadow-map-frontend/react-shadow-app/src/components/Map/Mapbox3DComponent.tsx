import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { getWfsBuildings } from '../../services/wfsBuildingService';

interface Mapbox3DComponentProps {
  className?: string;
}

export const Mapbox3DComponent: React.FC<Mapbox3DComponentProps> = ({ className = '' }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [is3D, setIs3D] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  const {
    mapSettings,
    currentDate,
    addStatusMessage,
    setMapView,
  } = useShadowMapStore();

  // 初始化3D地图
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    console.log('🗺️ 初始化Mapbox 3D地图...');

    // 设置Mapbox访问令牌
    mapboxgl.accessToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';

    // 创建Mapbox地图实例
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v11',
      center: [116.4074, 39.9042], // 北京天安门
      zoom: 15,
      pitch: 0, // 初始俯仰角为0（2D模式）
      bearing: 0, // 初始方位角
      hash: true,
      antialias: true,
    });

    mapRef.current = map;

    // 地图加载完成后初始化
    map.on('load', () => {
      console.log('✅ Mapbox 3D地图加载完成');
      loadWfsBuildings();
      
      // 添加地图事件监听
      map.on('click', handleMapClick);
      map.on('moveend', () => {
        const center = map.getCenter();
        const zoom = map.getZoom();
        setMapView([center.lat, center.lng], zoom);
      });
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // 加载TUM建筑物数据
  const loadWfsBuildings = async () => {
    if (!mapRef.current) return;

    setIsLoading(true);
    try {
      const bounds = mapRef.current.getBounds();
      const buildingData = await getWfsBuildings({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      });

      if (buildingData.success && buildingData.data.features.length > 0) {
        addBuildingsToMap(buildingData.data);
        addStatusMessage(`Loaded ${buildingData.data.features.length} buildings from WFS`, 'info');
      } else {
        addStatusMessage('No building data returned from WFS', 'warning');
      }
    } catch (error) {
      console.error('[Mapbox3D] Failed to load WFS buildings', error);
      addStatusMessage(`Failed to load WFS buildings: ${error}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // 将建筑物添加到地图
  const addBuildingsToMap = (buildingData: any) => {
    if (!mapRef.current) return;

    const map = mapRef.current;
    const sourceId = 'tum-buildings';
    const fillLayerId = 'tum-buildings-fill';
    const outlineLayerId = 'tum-buildings-outline';
    const extrusionLayerId = 'tum-buildings-extrusion';

    // 移除现有图层
    if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
    if (map.getLayer(outlineLayerId)) map.removeLayer(outlineLayerId);
    if (map.getLayer(extrusionLayerId)) map.removeLayer(extrusionLayerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    // 处理建筑物数据，确保有高度信息
    const processedFeatures = buildingData.features.map((feature: any) => {
      if (!feature.properties) feature.properties = {};
      
      // 确保有高度属性
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

    // 添加2D填充图层（浅灰色）
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

    // 添加3D挤出图层（基于高度）
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

    // 初始时隐藏3D图层
    map.setLayoutProperty(extrusionLayerId, 'visibility', 'none');
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

    setIs3D(!is3D);

    if (!is3D) {
      // 切换到3D模式
      map.setLayoutProperty(extrusionLayerId, 'visibility', 'visible');
      map.setLayoutProperty(fillLayerId, 'visibility', 'none');
      map.setLayoutProperty(outlineLayerId, 'visibility', 'none');
      
      // 设置3D视角
      map.easeTo({
        pitch: 60,
        bearing: -17.6,
        duration: 1000
      });
      
      addStatusMessage('已切换到3D模式', 'info');
    } else {
      // 切换到2D模式
      map.setLayoutProperty(extrusionLayerId, 'visibility', 'none');
      map.setLayoutProperty(fillLayerId, 'visibility', 'visible');
      map.setLayoutProperty(outlineLayerId, 'visibility', 'visible');
      
      // 设置2D视角
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 1000
      });
      
      addStatusMessage('已切换到2D模式', 'info');
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
      
      // 显示建筑物信息弹窗
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

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* 地图容器 */}
      <div ref={mapContainerRef} className="w-full h-full" />
      
      {/* 2D/3D切换按钮 */}
      <div className="absolute top-4 right-4 z-10">
        <button
          onClick={toggle2D3D}
          className="bg-white hover:bg-gray-100 text-gray-800 font-bold py-2 px-4 rounded-lg shadow-lg border border-gray-300 transition-colors duration-200 flex items-center gap-2"
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

      {/* 数据源标识 */}
      <div className="absolute bottom-4 left-4 z-10">
        <div className="bg-white bg-opacity-90 rounded-lg px-3 py-2 shadow-lg">
          <div className="text-sm text-gray-600">
            <span className="font-semibold">数据源:</span> TUM GlobalBuildingAtlas
          </div>
        </div>
      </div>
    </div>
  );
};
