import { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GeoJSONSourceRaw } from 'mapbox-gl';
import type { Feature, Geometry } from 'geojson';
import type { BuildingFeature, BuildingFeatureCollection } from '../../types/index.ts';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { shadowAnalysisService } from '../../services/shadowAnalysisService';
import type { ShadowCalculationResult } from '../../services/shadowAnalysisService';
import { getWfsBuildings } from '../../services/wfsBuildingService';
import { debugHelper } from '../../utils/debugHelper';
import * as SunCalc from 'suncalc';
import { MAPBOX_ACCESS_TOKEN } from '../../config/runtime';

interface Wfs3DShadowMapProps {
  className?: string;
}

type GeoJSONSourceWithData = mapboxgl.GeoJSONSource & { _data?: BuildingFeatureCollection };

export const Wfs3DShadowMap = ({ className = '' }: Wfs3DShadowMapProps) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [is3D, setIs3D] = useState(true); // 默认3D模式
  const [isLoading, setIsLoading] = useState(false);
  const [isCalculatingShadows, setIsCalculatingShadows] = useState(false);
  const [shadowData, setShadowData] = useState<ShadowCalculationResult | null>(null);
  const buildingSourceId = 'wfs-buildings-source';
  const buildingFillLayerId = 'wfs-buildings-fill';
  const buildingOutlineLayerId = 'wfs-buildings-outline';
  const buildingExtrusionLayerId = 'wfs-buildings-extrusion';
  
  const {
    currentDate,
    addStatusMessage,
    setMapView,
  } = useShadowMapStore();

  // 初始化地图
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    console.log('🗺️ Initialising WFS 3D shadow map...');

    if (!MAPBOX_ACCESS_TOKEN) {
      addStatusMessage('Mapbox access token is not configured.', 'error');
      return;
    }
    mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

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
      console.log('✅ WFS 3D shadow map ready');
      loadWfsBuildings();
      
      // 立即添加测试阴影
      window.setTimeout(() => {
        addRealBuildingShadows();
      }, 1000);
      
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

  // 监听时间变化，重新计算阴影
  useEffect(() => {
    if (mapRef.current && shadowData) {
      calculateShadows();
    }
  }, [currentDate]);

  // 加载WFS建筑物数据
  const loadWfsBuildings = async () => {
    if (!mapRef.current) return;

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
        
        // 加载完成后自动计算真实阴影
        window.setTimeout(() => {
          addRealBuildingShadows();
        }, 500);
      } else {
        addStatusMessage('No building data returned from WFS', 'warning');
        // 即使没有建筑物数据，也添加测试阴影
        addRealBuildingShadows();
      }
    } catch (error) {
      console.error('[ShadowMap] Failed to load WFS buildings', error);
      addStatusMessage(`Failed to load WFS buildings: ${error}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // 计算实时阴影
  const calculateShadows = useCallback(async () => {
    if (!mapRef.current) return;

    setIsCalculatingShadows(true);
    try {
      const mapBounds = mapRef.current.getBounds();
      const zoom = mapRef.current.getZoom();
      
      // 验证Mapbox bounds对象
      if (!debugHelper.validateMapboxBounds(mapBounds)) {
        throw new Error('Invalid map bounds object');
      }
      
      // 转换Mapbox bounds为ShadowBounds格式
      const bounds = {
        north: mapBounds.getNorth(),
        south: mapBounds.getSouth(),
        east: mapBounds.getEast(),
        west: mapBounds.getWest()
      };
      
      // 验证转换后的边界对象
      if (!debugHelper.validateConvertedBounds(bounds)) {
        throw new Error('Invalid converted bounds object');
      }
      
      // 记录调试信息
      debugHelper.logDebugInfo({
        mapBounds: {
          north: mapBounds.getNorth(),
          south: mapBounds.getSouth(),
          east: mapBounds.getEast(),
          west: mapBounds.getWest()
        },
        convertedBounds: bounds,
        currentDate,
        zoom,
        mapReady: true,
        timestamp: new Date().toISOString()
      });
      
      console.log('🌅 开始计算阴影，边界:', bounds);
      const result = await shadowAnalysisService.calculateRealTimeShadows(bounds, currentDate, zoom);
      
      setShadowData(result);
      addShadowsToMap(result);
      
      addStatusMessage(
        `阴影计算完成: ${result.shadows.length} 个阴影, 用时 ${result.calculationTime.toFixed(0)}ms`,
        'info'
      );
    } catch (error) {
      console.error('❌ 阴影计算失败:', error);
      addStatusMessage(`阴影计算失败: ${error}`, 'error');
    } finally {
      setIsCalculatingShadows(false);
    }
  }, [currentDate, addStatusMessage]);

  // 将建筑物添加到地图
  const addBuildingsToMap = (buildingData: BuildingFeatureCollection | null) => {
    if (!mapRef.current) return;

    const map = mapRef.current;

    // 移除现有图层
    [buildingFillLayerId, buildingOutlineLayerId, buildingExtrusionLayerId].forEach(layerId => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    });
    if (map.getSource(buildingSourceId)) map.removeSource(buildingSourceId);

    if (!buildingData) {
      addStatusMessage('No building data available to render', 'warning');
      return;
    }

    // 处理建筑物数据
    const processedFeatures = buildingData.features.map((feature: BuildingFeature) => {
      const baseHeight = feature.properties?.height ?? (
        feature.properties?.levels
          ? feature.properties.levels * 3.5
          : estimateBuildingHeight(feature.properties?.buildingType || 'building')
      );

      const properties: BuildingFeature['properties'] = {
        ...feature.properties,
        height: baseHeight,
        render_height: baseHeight,
      };

      return {
        ...feature,
        properties,
      };
    });

    // 添加数据源
    const sourceSpec: GeoJSONSourceRaw = {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: processedFeatures
      } as BuildingFeatureCollection
    };

    map.addSource(buildingSourceId, sourceSpec);

    // 添加2D填充图层
    map.addLayer({
      id: buildingFillLayerId,
      type: 'fill',
      source: buildingSourceId,
      paint: {
        'fill-color': '#D3D3D3',
        'fill-opacity': 0.8
      }
    });
    
    console.log(`✅ 建筑物图层添加成功: ${processedFeatures.length} 个建筑物`);

    // 添加轮廓图层
    map.addLayer({
      id: buildingOutlineLayerId,
      type: 'line',
      source: buildingSourceId,
      paint: {
        'line-color': '#A0A0A0',
        'line-width': 1,
        'line-opacity': 0.9
      }
    });

    // 添加3D挤出图层
    map.addLayer({
      id: buildingExtrusionLayerId,
      type: 'fill-extrusion',
      source: buildingSourceId,
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
    map.setLayoutProperty(buildingExtrusionLayerId, 'visibility', 'visible');
    map.setLayoutProperty(buildingFillLayerId, 'visibility', 'none');
    map.setLayoutProperty(buildingOutlineLayerId, 'visibility', 'none');
    
    console.log('🏗️ 建筑物图层初始化完成，当前模式: 3D');
  };

  // 将阴影添加到地图
  const addShadowsToMap = (shadowResult: ShadowCalculationResult) => {
    if (!mapRef.current) return;

    const map = mapRef.current;
    const sourceId = 'wfs-shadows';
    const shadowLayerId = 'wfs-shadows-fill';

    console.log(`🌅 开始添加阴影到地图: ${shadowResult.shadows.length} 个阴影`);

    // 移除现有阴影图层
    if (map.getLayer(shadowLayerId)) {
      map.removeLayer(shadowLayerId);
      console.log('🗑️ 移除现有阴影图层');
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
      console.log('🗑️ 移除现有阴影数据源');
    }

    if (shadowResult.shadows.length === 0) {
      console.log('⚠️ 没有阴影需要显示');
      return;
    }

    // 添加阴影数据源
    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: shadowResult.shadows
      }
    });
    console.log('✅ 阴影数据源添加成功');

    // 添加阴影填充图层 - 淡紫色
    map.addLayer({
      id: shadowLayerId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': '#DDA0DD', // 淡紫色
        'fill-opacity': 0.6
      }
    });
    console.log('✅ 阴影填充图层添加成功');

    // 确保阴影图层在最上层
    map.moveLayer(shadowLayerId);
    console.log('✅ 阴影图层已移至最上层');

    console.log(`✅ 成功添加了 ${shadowResult.shadows.length} 个阴影到地图`);
  };

  // 添加基于建筑物的真实阴影
  const addRealBuildingShadows = () => {
    if (!mapRef.current) return;
    
    try {
      const map = mapRef.current;
      const shadowSource = 'real-building-shadows';
      const shadowLayer = 'real-building-shadows-fill';
      
      // 移除现有阴影
      if (map.getLayer(shadowLayer)) map.removeLayer(shadowLayer);
      if (map.getSource(shadowSource)) map.removeSource(shadowSource);
      
      // 获取建筑物数据
    const buildingSource = map.getSource(buildingSourceId) as GeoJSONSourceWithData | undefined;
    const sourceData = buildingSource?._data;
    if (!sourceData) {
      console.log('⚠️ 没有建筑物数据，无法生成阴影');
      return;
    }
    
      const buildings = sourceData.features as BuildingFeature[];
      if (!buildings || buildings.length === 0) {
        console.log('⚠️ 建筑物数据为空，无法生成阴影');
        return;
      }
      
      // 计算太阳位置
      const bounds = map.getBounds();
      const lat = (bounds.getNorth() + bounds.getSouth()) / 2;
      const lng = (bounds.getEast() + bounds.getWest()) / 2;
      const sunPosition = calculateSunPosition(lat, lng, currentDate);
      
      console.log(`☀️ 太阳位置: 高度角 ${sunPosition.altitude.toFixed(1)}°, 方位角 ${sunPosition.azimuth.toFixed(1)}°`);
      
      // 为每个建筑物计算阴影
      const shadowFeatures = buildings.map<Feature<Geometry> | null>((building: BuildingFeature) => {
        if (!building.geometry || !building.properties) return null;
        
        const height = building.properties.height || 20;
        const geometry = building.geometry;
        
        // 太阳高度角太低，不产生阴影
        if (sunPosition.altitude <= 0) return null;
        
        // 计算阴影长度
        const shadowLength = height / Math.tan((sunPosition.altitude * Math.PI) / 180);
        
        // 计算阴影方向（方位角）
        const shadowDirection = (sunPosition.azimuth + 180) % 360;
        const shadowDirectionRad = (shadowDirection * Math.PI) / 180;
        
        // 计算阴影偏移
        const offsetX = shadowLength * Math.sin(shadowDirectionRad);
        const offsetY = shadowLength * Math.cos(shadowDirectionRad);
        
        // 根据几何类型处理阴影
        let shadowGeometry: Geometry;
        
        if (geometry.type === 'Polygon') {
          shadowGeometry = {
            type: 'Polygon',
            coordinates: geometry.coordinates.map((ring: number[][]) =>
              offsetPolygonRing(ring, offsetX, offsetY)
            ),
          };
        } else if (geometry.type === 'MultiPolygon') {
          shadowGeometry = {
            type: 'MultiPolygon',
            coordinates: geometry.coordinates.map((polygon: number[][][]) =>
              polygon.map((ring: number[][]) => offsetPolygonRing(ring, offsetX, offsetY))
            ),
          };
        } else {
          return null;
        }
        
        return {
          type: 'Feature',
          geometry: shadowGeometry,
          properties: {
            buildingId: building.properties.id || `building_${Math.random()}`,
            buildingHeight: height,
            shadowLength: shadowLength
          }
        };
      }).filter((feature): feature is Feature<Geometry> => feature !== null);
      
      if (shadowFeatures.length === 0) {
        console.log('⚠️ 没有生成任何阴影');
        return;
      }
      
      // 添加阴影数据源
      map.addSource(shadowSource, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: shadowFeatures
        }
      });
      
      // 添加阴影图层
      map.addLayer({
        id: shadowLayer,
        type: 'fill',
        source: shadowSource,
        paint: {
          'fill-color': '#DDA0DD',
          'fill-opacity': 0.6
        }
      });
      
      console.log(`✅ 基于建筑物生成了 ${shadowFeatures.length} 个真实阴影`);
      addStatusMessage(`生成了 ${shadowFeatures.length} 个建筑物阴影`, 'info');
    } catch (error) {
      console.error('❌ 生成建筑物阴影失败:', error);
      addStatusMessage(`生成阴影失败: ${error}`, 'error');
    }
  };
  
  // 计算太阳位置
  const calculateSunPosition = (lat: number, lng: number, date: Date) => {
    const sunPosition = SunCalc.getPosition(date, lat, lng);
    return {
      altitude: (sunPosition.altitude * 180) / Math.PI,
      azimuth: ((sunPosition.azimuth * 180) / Math.PI + 180) % 360
    };
  };
  
  // 计算多边形阴影
  const offsetPolygonRing = (coordinates: number[][], offsetX: number, offsetY: number) => {
    return coordinates.map(coord => [
      coord[0] + offsetX,
      coord[1] + offsetY
    ]);
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
    const extrusionLayerId = buildingExtrusionLayerId;
    const fillLayerId = buildingFillLayerId;
    const outlineLayerId = buildingOutlineLayerId;

    console.log(`🔄 切换模式: ${is3D ? '3D' : '2D'} → ${!is3D ? '3D' : '2D'}`);

    setIs3D(!is3D);

    if (!is3D) {
      // 切换到3D模式
      console.log('🏗️ 切换到3D模式...');
      
      // 确保图层存在
      if (map.getLayer(extrusionLayerId)) {
        map.setLayoutProperty(extrusionLayerId, 'visibility', 'visible');
        console.log('✅ 3D挤出图层已显示');
      } else {
        console.warn('⚠️ 3D挤出图层不存在');
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

  // 防抖定时器
  const moveTimeoutRef = useRef<number | null>(null);

  // 处理地图移动
  const handleMapMove = () => {
    if (!mapRef.current) return;
    
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    setMapView([center.lat, center.lng], zoom);
    
    // 清除之前的定时器
    if (moveTimeoutRef.current) {
      window.clearTimeout(moveTimeoutRef.current);
      moveTimeoutRef.current = null;
    }
    
    // 地图移动后重新加载建筑物数据和计算阴影（防抖）
    if (zoom >= 14) {
      console.log('🔄 地图移动，准备重新加载...');
      moveTimeoutRef.current = window.setTimeout(async () => {
        try {
          await loadWfsBuildings();
          window.setTimeout(() => {
            addRealBuildingShadows();
          }, 500);
        } catch (error) {
          console.error('❌ 地图移动后重新加载失败:', error);
        }
        moveTimeoutRef.current = null;
      }, 2000); // 2秒防抖
    }
  };

  // 处理地图点击
  const handleMapClick = (e: mapboxgl.MapMouseEvent) => {
    if (!mapRef.current) return;

    const features = mapRef.current.queryRenderedFeatures(e.point, {
      layers: [buildingFillLayerId, buildingExtrusionLayerId],
    });

    if (features.length > 0) {
      const feature = features[0];
      const props = (feature.properties ?? {}) as Record<string, unknown>;
      const buildingType = typeof props.buildingType === 'string' ? props.buildingType : '未知';
      const heightValue = typeof props.height === 'number' ? props.height : '未知';
      const levelsValue = typeof props.levels === 'number' ? props.levels : '未知';
      
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="min-w-48">
            <h4 class="font-bold text-gray-800 mb-2">🏢 建筑物信息</h4>
            <p><strong>类型:</strong> ${buildingType}</p>
            <p><strong>高度:</strong> ${heightValue}m</p>
            <p><strong>楼层:</strong> ${levelsValue}</p>
            <p><strong>数据源:</strong> WFS 服务</p>
            ${shadowData ? `
              <hr class="my-2">
              <h5 class="font-semibold text-gray-700 mb-1">☀️ 太阳信息</h5>
              <p><strong>高度角:</strong> ${shadowData.sunPosition.altitude.toFixed(1)}°</p>
              <p><strong>方位角:</strong> ${shadowData.sunPosition.azimuth.toFixed(1)}°</p>
            ` : ''}
          </div>
        `)
        .addTo(mapRef.current);
    }
  };

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* 地图容器 */}
      <div ref={mapContainerRef} className="w-full h-full" />
      
      {/* 控制面板 - 确保在最顶层 */}
      <div className="absolute top-4 right-4 z-[9999] space-y-2">
        {/* 2D/3D切换按钮 */}
        <button
          onClick={toggle2D3D}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded shadow-lg"
          disabled={isLoading || isCalculatingShadows}
        >
          {isLoading ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
              加载中...
            </>
          ) : isCalculatingShadows ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              计算阴影...
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

        {/* 刷新按钮 */}
        <button
          onClick={async () => {
            console.log('🔄 刷新所有图层...');
            setIsLoading(true);
            try {
              await loadWfsBuildings();
              addStatusMessage('图层已刷新', 'info');
            } catch (error) {
              console.error('❌ 刷新失败:', error);
              addStatusMessage(`刷新失败: ${error}`, 'error');
            } finally {
              setIsLoading(false);
            }
          }}
          className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded shadow-lg"
        >
          <span>🔄</span>
          刷新
        </button>
      </div>

      {/* 加载状态指示器 */}
      {(isLoading || isCalculatingShadows) && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-20">
          <div className="bg-white bg-opacity-90 rounded-lg p-4 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              <span className="text-gray-700">
                {isLoading ? '正在加载建筑物数据...' : '正在计算实时阴影...'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 状态信息 - 确保在最顶层 */}
      <div className="absolute bottom-4 left-4 z-[9999]">
        <div className="bg-white bg-opacity-90 rounded px-3 py-2 shadow-lg">
          <div className="text-sm text-gray-700">
            <div>模式: {is3D ? '3D' : '2D'} | 数据: WFS</div>
            {shadowData && (
              <div>建筑物: {shadowData.buildingCount} | 阴影: {shadowData.shadows.length}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
