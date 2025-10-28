import React, { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { CleanControlPanel } from '../UI/CleanControlPanel';
import type { Feature, Polygon, MultiPolygon, FeatureCollection } from 'geojson';
import { getWfsBuildings } from '../../services/wfsBuildingService';
import { buildingCache } from '../../cache/buildingCache';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { shadowOptimizer } from '../../services/shadowOptimizer';
import { weatherService } from '../../services/weatherService';

const MIN_SHADOW_DARKNESS_FACTOR = 0.45;
const WEATHER_REFRESH_THROTTLE_MS = 2 * 60 * 1000;

const computeEffectiveShadowOpacity = (
  baseOpacity: number,
  sunlightFactor: number,
  enforceMinimum: boolean
): number => {
  const factor = enforceMinimum
    ? MIN_SHADOW_DARKNESS_FACTOR + (1 - MIN_SHADOW_DARKNESS_FACTOR) * sunlightFactor
    : sunlightFactor;
  return Math.max(0, Math.min(1, baseOpacity * factor));
};

const isPointInRing = (point: [number, number], ring: number[][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersect = yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const pointInPolygonGeometry = (point: [number, number], geometry: Polygon | MultiPolygon): boolean => {
  if (geometry.type === 'Polygon') {
    const [outer, ...holes] = geometry.coordinates;
    if (!outer || !isPointInRing(point, outer)) {
      return false;
    }
    for (const hole of holes) {
      if (hole && isPointInRing(point, hole)) {
        return false;
      }
    }
    return true;
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => {
      const [outer, ...holes] = polygon;
      if (!outer || !isPointInRing(point, outer)) {
        return false;
      }
      for (const hole of holes) {
        if (hole && isPointInRing(point, hole)) {
          return false;
        }
      }
      return true;
    });
  }

  return false;
};

const SAMPLE_MIN = 40;
const SAMPLE_MAX = 180;

const generateSamplePointsForGeometry = (
  geometry: Polygon | MultiPolygon,
  bbox: [number, number, number, number]
): Array<[number, number]> => {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const lonSpan = Math.max(1e-6, maxLng - minLng);
  const latSpan = Math.max(1e-6, maxLat - minLat);
  const approxArea = Math.abs(lonSpan * latSpan);
  const targetSamples = Math.min(SAMPLE_MAX, Math.max(SAMPLE_MIN, Math.round(approxArea * 4000)));
  const gridSize = Math.max(6, Math.ceil(Math.sqrt(targetSamples)));
  const stepLng = lonSpan / (gridSize + 1);
  const stepLat = latSpan / (gridSize + 1);

  const points: Array<[number, number]> = [];

  for (let i = 1; i <= gridSize; i++) {
    for (let j = 1; j <= gridSize; j++) {
      const lng = minLng + stepLng * i;
      const lat = minLat + stepLat * j;
      if (pointInPolygonGeometry([lng, lat], geometry)) {
        points.push([lng, lat]);
      }
      if (points.length >= SAMPLE_MAX) {
        break;
      }
    }
    if (points.length >= SAMPLE_MAX) {
      break;
    }
  }

  if (!points.length) {
    points.push([(minLng + maxLng) / 2, (minLat + maxLat) / 2]);
  }

  return points;
};

const UPLOADED_SOURCE_ID = 'uploaded-geometry-source';
const UPLOADED_FILL_LAYER_ID = 'uploaded-geometry-fill';
const UPLOADED_OUTLINE_LAYER_ID = 'uploaded-geometry-outline';

// 声明全局ShadeMap类型
declare global {
  interface Window {
    ShadeMap: any;
  }
}

interface ShadowMapViewportProps {
  className?: string;
}

export const ShadowMapViewport: React.FC<ShadowMapViewportProps> = ({ className = '' }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shadeMapRef = useRef<any>(null);
  const [buildingsLoaded, setBuildingsLoaded] = useState(false);
  const [shadowLoaded, setShadowLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('准备中...');
  const [autoLoadBuildings, setAutoLoadBuildings] = useState(true); // 🆕 默认开启自动加载
  const loadBuildingsRef = useRef<(() => Promise<void>) | undefined>(undefined); // 🆕 用于打破循环依赖
  const moveEndTimeoutRef = useRef<number | null>(null); // 🆕 防抖timer（在load事件中使用）
  const tracePlaybackRef = useRef<number | null>(null);
  const weatherRequestRef = useRef<Promise<void> | null>(null);
  const lastWeatherKeyRef = useRef<string | null>(null);
  const analysisInFlightRef = useRef(false);
  const lastFitGeometryRef = useRef<string | null>(null);
  const analysisKeyRef = useRef<string | null>(null);
  
  // Connect to Zustand store
  const {
    currentDate,
    mapSettings,
    shadowSettings: shadowSettingsState,
    currentWeather,
    setCurrentWeather,
    mobilityTrace,
    currentTraceIndex,
    isTracePlaying,
    setTracePlaying,
    advanceTraceIndex,
    uploadedGeometries,
    selectedGeometryId,
    setGeometryAnalysis,
    addStatusMessage,
  } = useShadowMapStore();
  const actionButtonBase =
    'flex w-full h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white shadow-md transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60';

  // Component initialisation lifecycle
  console.log('✅ ShadowMapViewport mounted')

  const getActiveSunlightFactor = useCallback(() => (
    shadowSettingsState.autoCloudAttenuation
      ? (currentWeather.sunlightFactor ?? 1)
      : shadowSettingsState.manualSunlightFactor
  ), [shadowSettingsState.autoCloudAttenuation, shadowSettingsState.manualSunlightFactor, currentWeather.sunlightFactor]);

  const getEffectiveOpacity = useCallback((baseOpacity: number) =>
    computeEffectiveShadowOpacity(
      baseOpacity,
      getActiveSunlightFactor(),
      shadowSettingsState.autoCloudAttenuation
    ), [getActiveSunlightFactor, shadowSettingsState.autoCloudAttenuation]);

  const applyShadowOpacity = useCallback((baseOpacity: number) => {
    if (!shadeMapRef.current || typeof shadeMapRef.current.setOpacity !== 'function') {
      return;
    }
    const effectiveOpacity = getEffectiveOpacity(baseOpacity);
    shadeMapRef.current.setOpacity(effectiveOpacity);
  }, [getEffectiveOpacity]);

  const refreshWeatherData = useCallback((reason: string) => {
    if (!mapRef.current) return;
    if (!shadowSettingsState.autoCloudAttenuation) return;

    const now = Date.now();
    const center = mapRef.current.getCenter();
    const cacheKey = weatherService.buildCacheKey(center.lat, center.lng, currentDate);

    const lastFetched = currentWeather.fetchedAt ? currentWeather.fetchedAt.getTime() : 0;
    if (lastWeatherKeyRef.current === cacheKey && now - lastFetched < WEATHER_REFRESH_THROTTLE_MS) {
      return;
    }

    if (weatherRequestRef.current) {
      return;
    }

    weatherRequestRef.current = (async () => {
      try {
        const { snapshot } = await weatherService.getCurrentWeather(center.lat, center.lng, currentDate);
        const fetchedAt = snapshot.fetchedAt ?? new Date();

        setCurrentWeather({
          cloudCover: snapshot.cloudCover,
          sunlightFactor: snapshot.sunlightFactor,
          fetchedAt,
          raw: snapshot.raw ?? null,
          source: 'gfs'
        });
        lastWeatherKeyRef.current = cacheKey;

        if (snapshot.cloudCover != null && shadowSettingsState.autoCloudAttenuation) {
          const cloudPct = Math.round(snapshot.cloudCover * 100);
          const sunlightPct = Math.round(snapshot.sunlightFactor * 100);
          setStatusMessage(`Cloud cover ${cloudPct}%, sunlight factor ${sunlightPct}%`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[weather] refresh failed (${reason}):`, message);
      } finally {
        weatherRequestRef.current = null;
      }
    })();
  }, [shadowSettingsState.autoCloudAttenuation, currentWeather.fetchedAt, currentDate, setCurrentWeather]);

  useEffect(() => {
    refreshWeatherData(shadowSettingsState.autoCloudAttenuation ? 'auto-on' : 'manual-mode');
  }, [refreshWeatherData, shadowSettingsState.autoCloudAttenuation, currentDate]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const updateSource = () => {
      const featureCollection: FeatureCollection = {
        type: 'FeatureCollection',
        features: uploadedGeometries.map((item) => ({
          ...item.feature,
          properties: {
            ...(item.feature.properties ?? {}),
            __geometryId: item.id,
          },
        })),
      };

      const existingSource = map.getSource(UPLOADED_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

      if (existingSource) {
        existingSource.setData(featureCollection as any);
        return;
      }

      map.addSource(UPLOADED_SOURCE_ID, {
        type: 'geojson',
        data: featureCollection,
      });

      map.addLayer({
        id: UPLOADED_FILL_LAYER_ID,
        type: 'fill',
        source: UPLOADED_SOURCE_ID,
        paint: {
          'fill-color': '#2563eb',
          'fill-opacity': 0.12,
        },
      });

      map.addLayer({
        id: UPLOADED_OUTLINE_LAYER_ID,
        type: 'line',
        source: UPLOADED_SOURCE_ID,
        paint: {
          'line-color': '#2563eb',
          'line-width': 1.2,
        },
      });
    };

    if (map.isStyleLoaded()) {
      updateSource();
      return;
    }

    const handleStyle = () => {
      updateSource();
    };
    map.once('styledata', handleStyle);
    return () => {
      map.off('styledata', handleStyle);
    };
  }, [uploadedGeometries]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (map.getLayer(UPLOADED_FILL_LAYER_ID)) {
      map.setPaintProperty(UPLOADED_FILL_LAYER_ID, 'fill-opacity', [
        'case',
        ['==', ['get', '__geometryId'], selectedGeometryId ?? ''],
        0.35,
        0.12,
      ]);
    }

    if (map.getLayer(UPLOADED_OUTLINE_LAYER_ID)) {
      map.setPaintProperty(UPLOADED_OUTLINE_LAYER_ID, 'line-color', [
        'case',
        ['==', ['get', '__geometryId'], selectedGeometryId ?? ''],
        '#1d4ed8',
        '#94a3b8',
      ]);
      map.setPaintProperty(UPLOADED_OUTLINE_LAYER_ID, 'line-width', [
        'case',
        ['==', ['get', '__geometryId'], selectedGeometryId ?? ''],
        2.4,
        1.2,
      ]);
    }

    if (selectedGeometryId) {
      const target = uploadedGeometries.find((geometry) => geometry.id === selectedGeometryId);
      if (target) {
        const [minLng, minLat, maxLng, maxLat] = target.bbox;
        try {
          const bounds = new mapboxgl.LngLatBounds([minLng, minLat], [maxLng, maxLat]);
          // Avoid repeated fit
          if (lastFitGeometryRef.current !== selectedGeometryId) {
            map.fitBounds(bounds, { padding: 80, maxZoom: Math.max(map.getZoom(), 17) });
            lastFitGeometryRef.current = selectedGeometryId;
          }
        } catch (error) {
          console.warn('Failed to fit bounds for geometry', error);
        }
      }
    }
  }, [selectedGeometryId, uploadedGeometries]);

  useEffect(() => {
    const map = mapRef.current;
    const shadeMap = shadeMapRef.current;

    if (!map || !shadeMap || !shadowLoaded) {
      return;
    }

    if (!selectedGeometryId) {
      return;
    }

    const geometryEntry = uploadedGeometries.find((item) => item.id === selectedGeometryId);
    if (!geometryEntry) {
      return;
    }

    const geometry = geometryEntry.feature.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
      return;
    }

    if (!shadowSettingsState.showSunExposure) {
      addStatusMessage?.('⚠️ 请先开启“🌈 太阳热力图”以计算日照时长。', 'warning');
      return;
    }

    if (analysisInFlightRef.current) {
      return;
    }

    const analysisKey = `${selectedGeometryId}|${currentDate.toISOString()}|${shadowSettingsState.showSunExposure ? '1' : '0'}`;
    if (analysisKeyRef.current === analysisKey) {
      return;
    }

    let cancelled = false;
    analysisInFlightRef.current = true;

    try {
      const samples = generateSamplePointsForGeometry(geometry, geometryEntry.bbox);

      const results: { lat: number; lng: number; shadowPercent: number; hoursOfSun: number }[] = [];

      samples.forEach((samplePoint) => {
        if (cancelled) return;
        const projected = map.project({ lng: samplePoint[0], lat: samplePoint[1] });
        let hoursOfSun = 0;

        try {
          if (typeof shadeMap.getHoursOfSun === 'function') {
            const value = shadeMap.getHoursOfSun(projected.x, projected.y);
            if (typeof value === 'number' && !Number.isNaN(value)) {
              hoursOfSun = Math.max(0, value);
            }
          }
        } catch (error) {
          console.warn('getHoursOfSun failed', error);
        }

        const shadowPercent = hoursOfSun <= 0.1 ? 1 : 0;
        results.push({
          lat: samplePoint[1],
          lng: samplePoint[0],
          shadowPercent,
          hoursOfSun,
        });
      });

      const shadedCount = results.filter((item) => item.shadowPercent >= 1).length;
      const sumSunlight = results.reduce((acc, item) => acc + item.hoursOfSun, 0);

      const stats = {
        shadedRatio: results.length ? shadedCount / results.length : 0,
        avgSunlightHours: results.length ? sumSunlight / results.length : 0,
        sampleCount: results.length,
        generatedAt: new Date(),
      };

      if (!cancelled) {
        setGeometryAnalysis({
          geometryId: selectedGeometryId,
          stats,
          samples: results,
        });
        analysisKeyRef.current = analysisKey;
        addStatusMessage?.('✅ 阴影分析完成。', 'info');
      }
    } catch (error) {
      if (!cancelled) {
        console.error('Geometry analysis failed', error);
        addStatusMessage?.('❌ 阴影分析失败。', 'error');
      }
    } finally {
      analysisInFlightRef.current = false;
    }

    return () => {
      cancelled = true;
      analysisInFlightRef.current = false;
    };
  }, [
    selectedGeometryId,
    uploadedGeometries,
    currentDate,
    shadowSettingsState.showSunExposure,
    shadowLoaded,
    addStatusMessage,
    setGeometryAnalysis,
  ]);

  // Load the shadow simulator script on demand
  const loadShadowSimulator = useCallback(() => {
    return new Promise((resolve, reject) => {
      if (window.ShadeMap) {
        resolve(window.ShadeMap)
        return
      }

      const script = document.createElement('script')
      script.src = 'https://unpkg.com/mapbox-gl-shadow-simulator/dist/mapbox-gl-shadow-simulator.umd.min.js'
      script.onload = () => {
        if (window.ShadeMap) {
          console.log('✅ Shadow simulator library loaded')
          setStatusMessage('Shadow simulator ready')
          resolve(window.ShadeMap)
        } else {
          reject(new Error('ShadeMap not loaded'))
        }
      }
      script.onerror = () => reject(new Error('Failed to load ShadeMap'))
      document.head.appendChild(script)
    })
  }, [])

  // Back-end connectivity quick check
  const testWfsConnection = useCallback(async () => {
    try {
      setStatusMessage('Testing WFS connection...')
      const response = await fetch('http://localhost:3500/api/wfs-buildings/test')
      const result = await response.json()
      
      if (result.success) {
        setStatusMessage('WFS connection successful')
        return true
      } else {
        setStatusMessage('WFS connection failed: ' + result.message)
        return false
      }
    } catch (error) {
      setStatusMessage('WFS connection failed: ' + (error as Error).message)
      return false
    }
  }, [])

  // Load buildings from the back-end stream
  const loadBuildings = useCallback(async () => {
    if (!mapRef.current) {
      setStatusMessage('Map is not ready')
      return
    }

    try {
      setIsLoading(true)
      setStatusMessage('Loading buildings for the current view...')
      console.log('🏢 Begin loading buildings for current viewport')
      
      const bounds = mapRef.current.getBounds()
      const boundingBox = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      }

      console.log('📍 Viewport bounds:', boundingBox)

      // Use the service with caching
      const result = await getWfsBuildings(boundingBox, 10000) // Increase maxFeatures
      
      if (result.success && result.data) {
        addBuildingsToMap(result.data)
        setBuildingsLoaded(true)
        setStatusMessage(`Loaded ${result.data.features.length} buildings in this session`)
      } else {
        const metadata = result.metadata as { message?: string } | undefined
        throw new Error(metadata?.message ?? 'Failed to load buildings')
      }
    } catch (error) {
      console.error('❌ Failed to load buildings:', error)
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage('Building load failed: ' + message)
      setBuildingsLoaded(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Keep the latest load handler accessible for debounced callbacks
  useEffect(() => {
    loadBuildingsRef.current = loadBuildings
  }, [loadBuildings])

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

    // 🆕 检查是否已有数据源
    const existingSource = map.getSource(sourceId);
    const hasExistingLayer = !!map.getLayer(layerId);
    
    console.log('� 现有状态:', {
      hasSource: !!existingSource,
      hasLayer: hasExistingLayer
    });

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

    // 🆕 如果数据源已存在，只更新数据；否则创建新数据源和图层
    if (existingSource && 'setData' in existingSource) {
      console.log('� 更新现有数据源（不删除图层，避免阴影模拟器冲突）');
      (existingSource as mapboxgl.GeoJSONSource).setData(geoJsonData);
      console.log('✅ 数据源更新成功');
    } else {
      console.log('�📍 创建新数据源...');
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

      // 添加图层（仅首次）
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
    } // 🆕 关闭 else 块

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
  }, [refreshWeatherData]);

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
      // ✅ Get fresh state from store at call time, not from closure
      const { currentDate: latestDate, mapSettings: latestMapSettings } = useShadowMapStore.getState();
      
      // 🎯 Check if we should recalculate (optimization)
      const checkBuildingSource = mapRef.current.getSource('clean-buildings');
      const buildingCount = checkBuildingSource ? ((checkBuildingSource as any)._data?.features?.length || 0) : 0;
      
      const optimizationCheck = shadowOptimizer.shouldRecalculate(
        mapRef.current,
        latestDate,
        buildingCount
      );

      if (!optimizationCheck.shouldCalculate && shadeMapRef.current) {
        console.log('⏭️ 跳过阴影计算:', optimizationCheck.reason);
        setStatusMessage(`阴影已是最新 (${optimizationCheck.reason})`);
        return;
      }

      console.log('🌅 开始初始化阴影模拟器...', { 
        date: latestDate,
        reason: optimizationCheck.reason 
      });
      
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

      // 创建新的阴影模拟器 - 使用store中的最新设置
      shadeMapRef.current = new window.ShadeMap({
        date: latestDate,
        color: latestMapSettings.shadowColor,
        opacity: getEffectiveOpacity(latestMapSettings.shadowOpacity),
        apiKey: mapboxgl.accessToken,
        terrainSource: {
          tileSize: 256,
          maxZoom: 15,
          getSourceUrl: () => {
            // 使用本地Example DEM数据
            return `/Example/Height/europe/11.4_48.2_11.6_48.0_sr_ss.tif`;
          },
          getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
            // GeoTIFF格式的高程解析（示例实现，视数据格式调整）
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

      applyShadowOpacity(latestMapSettings.shadowOpacity);

      // 🎯 记录这次计算，用于后续优化
      shadowOptimizer.recordCalculation(mapRef.current, latestDate, validBuildings.length);

      setShadowLoaded(true);
      setStatusMessage(`阴影模拟器初始化成功，处理了 ${validBuildings.length} 个建筑物`);
      console.log('✅ 阴影模拟器初始化成功');
      
      // 📊 输出优化统计
      const stats = shadowOptimizer.getStats();
      console.log('📊 阴影优化统计:', stats);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setStatusMessage('阴影模拟器初始化失败: ' + errorMessage);
      console.error('❌ 阴影模拟器初始化失败:', error);
      
      // 重置状态
      setShadowLoaded(false);
      shadeMapRef.current = null;
    }
    // ✅ FIXED: Don't include currentDate in deps - time updates via setDate(), not re-init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingsLoaded]);

  // 更新阴影时间
  const updateShadowTime = useCallback((newTime: Date) => {
    const { setCurrentDate } = useShadowMapStore.getState();
    
    // ✅ Add safety checks
    if (!shadeMapRef.current) {
      setStatusMessage('阴影模拟器未初始化');
      return;
    }

    if (!mapRef.current || !mapRef.current.loaded()) {
      setStatusMessage('地图未完全加载');
      return;
    }

    const buildingSource = mapRef.current.getSource('clean-buildings');
    if (!buildingSource) {
      setStatusMessage('建筑物数据未加载');
      return;
    }

    try {
      if (typeof shadeMapRef.current.setDate === 'function') {
        shadeMapRef.current.setDate(newTime);
        setCurrentDate(newTime);
        setStatusMessage('阴影时间已更新: ' + newTime.toLocaleString());
        refreshWeatherData('time-update');
      }
    } catch (error) {
      console.error('❌ Error updating shadow time:', error);
      setStatusMessage('更新阴影时间失败');
    }
  }, []);

  // Sync uploaded mobility trace onto the map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const lineSourceId = 'mobility-trace-line';
    const pointsSourceId = 'mobility-trace-points';
    const currentPointSourceId = 'mobility-trace-current';

    const removeTraceLayers = () => {
      if (!map) return;
      const removeLayerAndSource = (layerId: string, sourceId: string) => {
        if (map.getLayer(layerId)) {
          map.removeLayer(layerId);
        }
        if (map.getSource(sourceId)) {
          map.removeSource(sourceId);
        }
      };

      removeLayerAndSource('mobility-trace-line-layer', lineSourceId);
      removeLayerAndSource('mobility-trace-point-layer', pointsSourceId);
      removeLayerAndSource('mobility-trace-current-layer', currentPointSourceId);
    };

    const applyTraceLayers = () => {
      if (!map || !map.isStyleLoaded()) {
        return;
      }

      if (!mobilityTrace.length) {
        removeTraceLayers();
        return;
      }

      const lineFeature: Feature = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: mobilityTrace.map((point) => point.coordinates),
        },
        properties: {},
      };

      const pointsCollection = {
        type: 'FeatureCollection' as const,
        features: mobilityTrace.map((point, index) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: point.coordinates },
          properties: { index, timestamp: point.timestampLabel },
        })),
      };

      const updateSource = (sourceId: string, data: any) => {
        const existing = map.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined;
        if (existing) {
          existing.setData(data);
        } else {
          map.addSource(sourceId, { type: 'geojson', data });
        }
      };

      updateSource(lineSourceId, lineFeature);
      updateSource(pointsSourceId, pointsCollection);

      if (!map.getLayer('mobility-trace-line-layer')) {
        map.addLayer({
          id: 'mobility-trace-line-layer',
          type: 'line',
          source: lineSourceId,
          paint: {
            'line-width': 3,
            'line-color': '#ef4444',
            'line-opacity': 0.7,
          },
        });
      }

      if (!map.getLayer('mobility-trace-point-layer')) {
        map.addLayer({
          id: 'mobility-trace-point-layer',
          type: 'circle',
          source: pointsSourceId,
          paint: {
            'circle-radius': 5,
            'circle-color': '#f97316',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#ffffff',
            'circle-opacity': 0.9,
          },
        });
      }

      if (!map.getSource(currentPointSourceId)) {
        map.addSource(currentPointSourceId, {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [],
          },
        });
      }

      if (!map.getLayer('mobility-trace-current-layer')) {
        map.addLayer({
          id: 'mobility-trace-current-layer',
          type: 'circle',
          source: currentPointSourceId,
          paint: {
            'circle-radius': 7,
            'circle-color': '#2563eb',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });
      }
    };

    if (!mobilityTrace.length) {
      applyTraceLayers();
      return;
    }

    let styleHandler: (() => void) | undefined;
    if (!map.isStyleLoaded()) {
      styleHandler = () => {
        applyTraceLayers();
        if (styleHandler) {
          map.off('styledata', styleHandler);
        }
      };
      map.on('styledata', styleHandler);
    } else {
      applyTraceLayers();
    }

    return () => {
      if (styleHandler) {
        map.off('styledata', styleHandler);
      }
    };
  }, [mobilityTrace]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const currentPoint = mobilityTrace[currentTraceIndex];
    const currentSource = map.getSource('mobility-trace-current') as mapboxgl.GeoJSONSource | undefined;
    if (!currentSource) return;

    if (!currentPoint) {
      currentSource.setData({
        type: 'FeatureCollection',
        features: [],
      });
      return;
    }

    currentSource.setData({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: currentPoint.coordinates },
      properties: { timestamp: currentPoint.timestampLabel },
    });
  }, [mobilityTrace, currentTraceIndex]);

  useEffect(() => {
    if (!mobilityTrace.length) {
      setTracePlaying(false);
      return;
    }

    const point = mobilityTrace[currentTraceIndex];
    if (!point) return;

    if (mapRef.current) {
      mapRef.current.easeTo({
        center: point.coordinates,
        duration: 1200,
      });
    }

    updateShadowTime(point.time);
  }, [mobilityTrace, currentTraceIndex, updateShadowTime, setTracePlaying]);

  useEffect(() => {
    if (tracePlaybackRef.current) {
      window.clearInterval(tracePlaybackRef.current);
      tracePlaybackRef.current = null;
    }

    if (!isTracePlaying || mobilityTrace.length <= 1) {
      return;
    }

    const interval = window.setInterval(() => {
      advanceTraceIndex();
    }, 2000);

    tracePlaybackRef.current = interval;

    return () => {
      if (tracePlaybackRef.current) {
        window.clearInterval(tracePlaybackRef.current);
        tracePlaybackRef.current = null;
      }
    };
  }, [isTracePlaying, mobilityTrace.length, advanceTraceIndex]);

  useEffect(() => {
    return () => {
      if (tracePlaybackRef.current) {
        window.clearInterval(tracePlaybackRef.current);
        tracePlaybackRef.current = null;
      }
    };
  }, []);

  // Watch for setting changes and update shadow simulator
  useEffect(() => {
    // ✅ Guard: Check if shadow simulator and map are fully ready
    if (!shadeMapRef.current || !mapRef.current) {
      console.log('⏸️ Shadow simulator or map not ready, skipping update');
      return;
    }

    // ✅ Guard: Check if building source exists (shadow simulator needs this)
    const buildingSource = mapRef.current.getSource('clean-buildings');
    if (!buildingSource) {
      console.log('⏸️ Building source not loaded yet, skipping shadow update');
      return;
    }

    // ✅ Guard: Check if map is loaded
    if (!mapRef.current.loaded()) {
      console.log('⏸️ Map not fully loaded, skipping shadow update');
      return;
    }

    try {
      console.log('🎨 Updating shadow settings:', {
        color: mapSettings.shadowColor,
        opacity: mapSettings.shadowOpacity,
        date: currentDate
      });
      
      // Update color
      if (typeof shadeMapRef.current.setColor === 'function') {
        shadeMapRef.current.setColor(mapSettings.shadowColor);
      }
      
      // Update opacity
      applyShadowOpacity(mapSettings.shadowOpacity);
      
      // Update date
      if (typeof shadeMapRef.current.setDate === 'function') {
        shadeMapRef.current.setDate(currentDate);
      }
    } catch (error) {
      console.error('❌ Error updating shadow settings:', error);
      // Don't crash the app, just log the error
    }
  }, [mapSettings.shadowColor, mapSettings.shadowOpacity, currentDate, applyShadowOpacity]);

  // 🆕 Watch for layer visibility changes and update map layers
  useEffect(() => {
    if (!mapRef.current || !mapRef.current.loaded()) return;

    const map = mapRef.current;
    const buildingLayerId = 'clean-buildings-extrusion';

    console.log('👁️ Updating layer visibility:', {
      buildings: mapSettings.showBuildingLayer,
      shadow: mapSettings.showShadowLayer
    });

    // Control building layer visibility
    if (map.getLayer(buildingLayerId)) {
      map.setLayoutProperty(
        buildingLayerId,
        'visibility',
        mapSettings.showBuildingLayer ? 'visible' : 'none'
      );
      console.log(`🏢 Building layer: ${mapSettings.showBuildingLayer ? 'visible' : 'hidden'}`);
    }

    // Control shadow layer visibility (if shadow simulator exists)
    if (shadeMapRef.current) {
      try {
        // Shadow simulator doesn't have a direct visibility method, 
        // but we can control it via opacity
        if (typeof shadeMapRef.current.setOpacity === 'function') {
          const effectiveOpacity = mapSettings.showShadowLayer 
            ? getEffectiveOpacity(mapSettings.shadowOpacity)
            : 0;
          shadeMapRef.current.setOpacity(effectiveOpacity);
          console.log(`🌑 Shadow layer: ${mapSettings.showShadowLayer ? 'visible' : 'hidden'}`);
        }
      } catch (error) {
        console.error('❌ Error controlling shadow visibility:', error);
      }
    }
  }, [mapSettings.showBuildingLayer, mapSettings.showShadowLayer, mapSettings.shadowOpacity, getEffectiveOpacity]);

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
      center: [114.1694, 22.3193], // 香港
      zoom: 16,
      pitch: 45,
      bearing: 0,
      attributionControl: false,
    });

    mapRef.current = map;

    map.on('load', async () => {
      console.log('✅ 地图加载完成');
      
      // 加载阴影模拟器库
      await loadShadowSimulator();
      
      // 🆕 自动加载初始区域的建筑物
      console.log('🏗️ 自动加载初始区域建筑物...');
      setStatusMessage('自动加载建筑物中...');
      await loadBuildings();
      
      // 自动初始化阴影
      console.log('🌅 自动初始化阴影模拟器...');
      setStatusMessage('自动初始化阴影...');
      // 给建筑物一点时间渲染
      setTimeout(() => {
        initShadowSimulator();
      }, 500);

      refreshWeatherData('map-load');
      
      // 🆕 地图加载完成后，绑定 moveend 监听器
      console.log('🎯 地图完全加载，现在绑定moveend监听器...');
      const handleMoveEnd = () => {
        console.log('📍 moveend事件触发！');
        
        if (!loadBuildingsRef.current) {
          console.warn('⚠️ loadBuildingsRef 为空');
          return;
        }
        
        // 清除之前的timer
        if (moveEndTimeoutRef.current) {
          window.clearTimeout(moveEndTimeoutRef.current);
        }
        
        // 防抖：500ms后加载
        moveEndTimeoutRef.current = window.setTimeout(() => {
          console.log('🗺️ 地图移动结束（500ms防抖后），开始加载建筑物...');
          if (loadBuildingsRef.current) {
            loadBuildingsRef.current();
          }
          refreshWeatherData('moveend');
        }, 500);
      };
      
      map.on('moveend', handleMoveEnd);
      console.log('✅ moveend监听器已绑定（在load事件中）');
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [loadShadowSimulator, testWfsConnection, initShadowSimulator]); // ✅ 移除 loadBuildings 依赖

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* 添加CSS动画样式 */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .mapboxgl-ctrl-logo,
        .mapboxgl-ctrl-bottom-right,
        .mapboxgl-ctrl-attrib {
          display: none !important;
        }
      `}</style>
      {/* 地图容器 */}
      <div ref={mapContainerRef} className="w-full h-full" />
      
      {/* 🆕 左侧控制面板 (包含 Shadow Layer, Sun Exposure, Buildings, Dynamic Quality 按钮) */}
      <CleanControlPanel />
      
      {/* 实用控制面板 */}
      <div className="absolute top-6 right-6 z-40 flex w-72 max-w-[90vw] flex-col gap-4">
        <div className="space-y-3 rounded-2xl border border-white/40 bg-white/95 p-4 shadow-2xl backdrop-blur-xl">
          <button
            onClick={testWfsConnection}
            disabled={isLoading}
            className={`${actionButtonBase} bg-blue-600 hover:bg-blue-700 focus:ring-blue-300`}
          >
            <span className="text-lg">🔍</span>
            <span className="leading-tight">测试WFS连接</span>
          </button>

          <button
            onClick={() => {
              if (mapRef.current) {
                console.log('🧪 手动触发moveend事件测试');
                console.log('地图对象:', mapRef.current);
                console.log('自动加载状态:', autoLoadBuildings);
                console.log('地图已加载:', mapRef.current.loaded());
                mapRef.current.fire('moveend');
              }
            }}
            className={`${actionButtonBase} bg-violet-500 hover:bg-violet-600 focus:ring-violet-300`}
          >
            <span className="text-lg">🧪</span>
            <span className="leading-tight">测试moveend</span>
          </button>

          <button
            onClick={loadBuildings}
            disabled={isLoading}
            className={`${actionButtonBase} ${
              buildingsLoaded
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-emerald-500 hover:bg-emerald-600'
            } focus:ring-emerald-300`}
          >
            {isLoading ? (
              <>
                <span className="animate-spin text-lg">⏳</span>
                <span className="leading-tight">加载中...</span>
              </>
            ) : (
              <>
                <span className="text-lg">🏢</span>
                <span className="leading-tight">
                  {buildingsLoaded ? '重新加载建筑物' : '加载建筑物'}
                </span>
              </>
            )}
          </button>

          <button
            onClick={() => setAutoLoadBuildings(!autoLoadBuildings)}
            className={`${actionButtonBase} ${
              autoLoadBuildings
                ? 'bg-amber-500 hover:bg-amber-600 focus:ring-amber-300'
                : 'bg-slate-500 hover:bg-slate-600 focus:ring-slate-300'
            }`}
          >
            <span className="text-lg">{autoLoadBuildings ? '🟢' : '⚫'}</span>
            <span className="leading-tight">
              自动加载: {autoLoadBuildings ? '开' : '关'}
            </span>
          </button>

          <button
            onClick={initShadowSimulator}
            disabled={isLoading || !buildingsLoaded}
            className={`${actionButtonBase} ${
              shadowLoaded
                ? 'bg-indigo-600 hover:bg-indigo-700'
                : 'bg-violet-600 hover:bg-violet-700'
            } focus:ring-violet-300`}
          >
            <span className="text-lg">🌅</span>
            <span className="leading-tight">
              {shadowLoaded ? '重新计算阴影' : '初始化阴影模拟器'}
            </span>
          </button>

          <button
            onClick={clearBuildings}
            disabled={isLoading || (!buildingsLoaded && !shadowLoaded)}
            className={`${actionButtonBase} bg-red-500 hover:bg-red-600 focus:ring-red-300`}
          >
            <span className="text-lg">🗑️</span>
            <span className="leading-tight">清除所有数据</span>
          </button>

        </div>

        <div className="rounded-2xl border border-white/40 bg-white/95 p-4 shadow-2xl backdrop-blur-xl">
          <label className="mb-2 block text-sm font-medium text-gray-700">阴影时间</label>
          <input
            type="datetime-local"
            value={currentDate.toISOString().slice(0, 16)}
            onChange={(e) => updateShadowTime(new Date(e.target.value))}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 shadow-inner focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
        </div>
      </div>

      {/* 状态信息和操作指南 */}
      <div className="absolute bottom-4 left-6 z-30 space-y-3">
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
              <div>1. 🔍 测试WFS连接</div>
              <div>2. 🏢 加载建筑物数据</div>
              <div>3. 🌅 初始化阴影模拟器</div>
              <div>4. ⏰ 调整时间查看阴影变化</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
