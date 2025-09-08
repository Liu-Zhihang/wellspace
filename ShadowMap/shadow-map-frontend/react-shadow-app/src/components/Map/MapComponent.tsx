import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { useShadowMap } from '../../hooks/useShadowMap';
import { baseMapManager } from '../../services/baseMapManager';
import { useShadowAnalysis } from '../../hooks/useShadowAnalysis';
import { BaseMapSelector } from '../Controls/BaseMapSelector';
import { advancedCacheManager } from '../../services/advancedCacheManager';

// 修复 Leaflet 默认图标问题
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

interface MapComponentProps {
  className?: string;
}

export const MapComponent: React.FC<MapComponentProps> = ({ className = '' }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const buildingLayersRef = useRef<L.LayerGroup | null>(null);
  const demTileLayerRef = useRef<L.TileLayer | null>(null);
  const [cacheStats, setCacheStats] = useState<{
    memorySize: number;
    storageSize: number;
    maxMemorySize: number;
    maxStorageSize: number;
    hitRate: string;
    totalHits: number;
    totalMisses: number;
    memoryUsage: string;
  }>({
    memorySize: 0,
    storageSize: 0,
    maxMemorySize: 0,
    maxStorageSize: 0,
    hitRate: '0%',
    totalHits: 0,
    totalMisses: 0,
    memoryUsage: '0%'
  });
  
  const {
    mapCenter,
    mapZoom,
    mapSettings,
    setMapView,
    addStatusMessage,
  } = useShadowMapStore();
  
  const {
    mapRef,
    shadeMapRef,
    initShadowSimulator,
    getCurrentViewBuildings,
    updateSunPosition,
  } = useShadowMap();

  const { analyzePointShadow } = useShadowAnalysis();

  // 初始化地图
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // 创建地图实例（不添加默认底图，由BaseMapManager管理）
    const map = L.map(mapContainerRef.current, {
      zoomControl: false, // 暂时隐藏默认zoom控制，我们将添加自定义控件
    }).setView(mapCenter, mapZoom);
    
    // 设置底图管理器并添加默认底图（使用更稳定的 CartoDB）
    baseMapManager.setMap(map);
    baseMapManager.switchBaseMap('cartodb-light'); // 使用更稳定的 CartoDB 替代 OSM
    
    console.log('🗺️ 地图实例已创建，底图管理器已初始化');

    // 初始化建筑物图层组
    const buildingLayers = L.layerGroup();
    buildingLayers.addTo(map);
    buildingLayersRef.current = buildingLayers;

    // 绑定地图事件
    map.on('move', () => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      setMapView([center.lat, center.lng], zoom);
      updateSunPosition();
    });

    map.on('zoom', () => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      setMapView([center.lat, center.lng], zoom);
      loadCurrentViewBuildings();
    });

    map.on('click', handleMapClick);

    mapRef.current = map;
    
    // 设置全局地图实例引用，供其他组件使用
    (window as any).mapInstance = map;

    // 确保地图完全加载后再初始化阴影模拟器
    map.whenReady(() => {
      console.log('🗺️ 地图已完全加载，开始初始化阴影模拟器');
      // 延迟一点时间确保所有组件都稳定
      setTimeout(() => {
        initShadowSimulator(map);
        loadCurrentViewBuildings();
        updateCacheStats(); // 更新缓存统计
      }, 500);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 更新缓存统计
  const updateCacheStats = () => {
    const stats = advancedCacheManager.getStats();
    setCacheStats(stats);
  };

  // 定期更新缓存统计
  useEffect(() => {
    const interval = setInterval(updateCacheStats, 5000); // 每5秒更新一次
    return () => clearInterval(interval);
  }, []);

  // 处理地图点击事件
  const handleMapClick = async (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;
    console.log(`点击位置: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    
    // 执行阴影分析
    if (mapRef.current && shadeMapRef.current) {
      await analyzePointShadow(mapRef.current, lat, lng, shadeMapRef.current);
    } else {
      addStatusMessage(`点击位置: ${lat.toFixed(4)}°, ${lng.toFixed(4)}° (阴影模拟器未就绪)`, 'info');
    }
  };

  // 加载当前视图的建筑物
  const loadCurrentViewBuildings = async () => {
    if (!mapRef.current || !buildingLayersRef.current || !mapSettings.showBuildingLayer) {
      return;
    }

    try {
      buildingLayersRef.current.clearLayers();
      const buildings = await getCurrentViewBuildings(mapRef.current);
      
      if (buildings.length > 0) {
        const geoJsonLayer = L.geoJSON(buildings, {
          style: (feature) => {
            const height = feature?.properties?.height || 10;
            const isHighRise = height > 20;
            
            return {
              color: isHighRise ? '#0064ff' : '#ff6b6b',
              weight: 1,
              fillOpacity: 0.3,
              fillColor: isHighRise ? '#0064ff' : '#ff6b6b',
            };
          },
          onEachFeature: (feature, layer) => {
            if (feature.properties) {
              const props = feature.properties;
              layer.bindPopup(`
                <div class="min-w-48">
                  <h4 class="font-bold text-gray-800 mb-2">🏢 建筑物信息</h4>
                  <p><strong>类型:</strong> ${props.buildingType || '未知'}</p>
                  <p><strong>高度:</strong> ${props.height || '未知'}m</p>
                  <p><strong>楼层:</strong> ${props.levels || '未知'}</p>
                </div>
              `);
            }
          },
        });
        
        buildingLayersRef.current.addLayer(geoJsonLayer);
        addStatusMessage(`加载了 ${buildings.length} 个建筑物`, 'info');
      }
    } catch (error) {
      console.error('加载建筑物失败:', error);
      addStatusMessage(`加载建筑物失败: ${error}`, 'error');
    }
  };

  // 切换建筑物图层
  useEffect(() => {
    if (!mapRef.current || !buildingLayersRef.current) return;

    if (mapSettings.showBuildingLayer) {
      mapRef.current.addLayer(buildingLayersRef.current);
      loadCurrentViewBuildings();
    } else {
      mapRef.current.removeLayer(buildingLayersRef.current);
    }
  }, [mapSettings.showBuildingLayer]);

  // 切换DEM图层
  useEffect(() => {
    if (!mapRef.current) return;

    if (mapSettings.showDEMLayer && !demTileLayerRef.current) {
      demTileLayerRef.current = L.tileLayer('http://localhost:3002/api/dem/{z}/{x}/{y}.png', {
        attribution: '© 自建DEM服务',
        maxZoom: 15,
        opacity: 0.5,
      });
    }

    if (mapSettings.showDEMLayer && demTileLayerRef.current) {
      demTileLayerRef.current.addTo(mapRef.current);
      addStatusMessage('地形图层已开启', 'info');
    } else if (demTileLayerRef.current) {
      mapRef.current.removeLayer(demTileLayerRef.current);
      addStatusMessage('地形图层已关闭', 'info');
    }
  }, [mapSettings.showDEMLayer]);

  return (
    <div className={`relative w-full h-full ${className}`} style={{ minHeight: '400px' }}>
      {/* 地图容器 */}
      <div 
        ref={mapContainerRef} 
        className="w-full h-full"
      />
      
      {/* 底图选择器 */}
      <div className="absolute top-4 left-4 z-[1000]">
        <BaseMapSelector 
          mapInstance={mapRef.current}
          onBaseMapChange={(baseMapId) => {
            console.log('底图已切换到:', baseMapId);
            addStatusMessage(`已切换到 ${baseMapId} 底图`, 'info');
          }}
        />
      </div>

      {/* 缓存状态显示 */}
      {mapSettings.showCacheStats && (
        <div className="absolute bottom-4 right-4 z-[1000] bg-white bg-opacity-90 rounded-lg p-3 text-xs">
          <h4 className="font-semibold text-gray-800 mb-2">缓存状态</h4>
          <div className="grid grid-cols-2 gap-2 text-gray-600">
            <div>内存: {cacheStats.memoryUsage}</div>
            <div>存储: {Math.round(cacheStats.storageSize / 1024)}KB</div>
            <div>命中率: {cacheStats.hitRate}</div>
            <div>总请求: {cacheStats.totalHits + cacheStats.totalMisses}</div>
          </div>
        </div>
      )}
    </div>
  );
};
