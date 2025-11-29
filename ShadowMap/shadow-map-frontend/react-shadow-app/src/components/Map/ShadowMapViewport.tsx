import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, Polygon, MultiPolygon, FeatureCollection } from 'geojson';
import { getWfsBuildings } from '../../services/wfsBuildingService';
import { buildingCache } from '../../cache/buildingCache';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { shadowOptimizer } from '../../services/shadowOptimizer';
import { weatherService } from '../../services/weatherService';
import { ApiService } from '../../services/apiService';
import { shadowAnalysisClient } from '../../services/shadowAnalysisService';
import { GeometryAnalysisOverlay } from '../Analysis/GeometryAnalysisOverlay';
import type { GeometryAnalysisSample } from '../../types/index.ts';
import { getBaseMapStyle, getBaseMapById } from '../../services/baseMapManager';
import { useMobilityPlayback } from '../../hooks/useMobilityPlayback';
import { useMobilityDemoBootstrap } from '../../hooks/useMobilityDemoBootstrap';
import { useDeckMobilityFlow } from '../../hooks/useDeckMobilityFlow';

const MIN_SHADOW_DARKNESS_FACTOR = 0.45;
const WEATHER_REFRESH_THROTTLE_MS = 2 * 60 * 1000;
const BASE_ANIMATION_MINUTES_PER_SECOND = 12;

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

const BUILDING_SOURCE_ID = 'clean-buildings';
const BUILDING_LAYER_ID = 'clean-buildings-extrusion';

const inferBaseMapCategory = (baseMapId?: string) => {
  if (!baseMapId) return undefined;
  const fallback = baseMapId.toLowerCase();
  if (fallback.includes('dark') || fallback.includes('black')) return 'dark';
  if (fallback.includes('satellite') || fallback.includes('imagery')) return 'satellite';
  if (fallback.includes('terrain')) return 'terrain';
  if (fallback.includes('light') || fallback.includes('street') || fallback.includes('carto')) return 'light';
  return undefined;
};

const computeBuildingStyle = (baseMapId?: string) => {
  const baseOption = baseMapId ? getBaseMapById(baseMapId) : undefined;
  const category = baseOption?.category ?? inferBaseMapCategory(baseMapId);
  switch (category) {
    case 'dark':
      return { fill: '#fbbf24', opacity: 0.88 };
    case 'satellite':
      return { fill: '#34d399', opacity: 0.75 };
    case 'terrain':
      return { fill: '#0ea5e9', opacity: 0.7 };
    case 'light':
    case 'street':
      return { fill: '#1d4ed8', opacity: 0.6 };
    default:
      return { fill: '#f97316', opacity: 0.72 };
  }
};

const UPLOADED_SOURCE_ID = 'uploaded-geometry-source';
const UPLOADED_FILL_LAYER_ID = 'uploaded-geometry-fill';
const UPLOADED_OUTLINE_LAYER_ID = 'uploaded-geometry-outline';
const ANALYSIS_HEATMAP_SOURCE_ID = 'analysis-heatmap-source';
const ANALYSIS_HEATMAP_LAYER_ID = 'analysis-heatmap-layer';
const ANALYSIS_POINTS_LAYER_ID = 'analysis-heatmap-points';
const SHADOW_RESULT_SOURCE_ID = 'analysis-shadow-source';
const SHADOW_RESULT_LAYER_ID = 'analysis-shadow-layer';
const EMPTY_FEATURE_COLLECTION: FeatureCollection = { type: 'FeatureCollection', features: [] };

// Declare global ShadeMap type
declare global {
  interface Window {
    ShadeMap: any;
  }
}

interface ShadowMapViewportProps {
  className?: string;
  baseMapId?: string;
}

export const ShadowMapViewport: React.FC<ShadowMapViewportProps> = ({ className = '', baseMapId }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shadeMapRef = useRef<any>(null);
  const [, setStatusMessage] = useState('Preparing');
  const loadBuildingsRef = useRef<(() => Promise<void>) | undefined>(undefined); // Preserve latest loader for debounced callbacks
  const moveEndTimeoutRef = useRef<number | null>(null); // Debounce timer used by moveend handler
  const tracePlaybackRef = useRef<number | null>(null);
  const weatherRequestRef = useRef<Promise<void> | null>(null);
  const lastWeatherKeyRef = useRef<string | null>(null);
  const analysisInFlightRef = useRef(false);
  const lastFitGeometryRef = useRef<string | null>(null);
  const analysisKeyRef = useRef<string | null>(null);
  const sunExposureStateRef = useRef<string | null>(null);
  const loadShadowSimulatorRef = useRef<(() => Promise<unknown>) | null>(null);
  const refreshWeatherDataRef = useRef<((reason: string) => void) | null>(null);
  const heatmapDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const animationLastTimestampRef = useRef<number | null>(null);
  const shadowResultDataRef = useRef<GeoJSON.FeatureCollection>(EMPTY_FEATURE_COLLECTION);
  const addBuildingsToMapRef = useRef<((buildingData: any) => void) | null>(null);
  const baseMapBootstrapRef = useRef(false);
  const lastBaseMapIdRef = useRef<string | null>(null);

  const updateMapSource = useCallback((sourceId: string, data: GeoJSON.FeatureCollection) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const existing = map.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined;
    if (existing) {
      existing.setData(data as GeoJSON.FeatureCollection);
    } else {
      map.addSource(sourceId, {
        type: 'geojson',
        data,
      });
    }
  }, []);

  const bringLayerToFront = useCallback((layerId: string) => {
    const map = mapRef.current;
    if (!map || !map.getLayer(layerId)) return;
    map.moveLayer(layerId);
  }, []);

  const ensureHeatmapLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!map.getLayer(ANALYSIS_HEATMAP_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_HEATMAP_LAYER_ID,
        type: 'heatmap',
        source: ANALYSIS_HEATMAP_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: {
          'heatmap-radius': 25,
          'heatmap-opacity': 0.85,
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'weight'],
            0,
            0,
            1,
            1,
          ],
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(59, 130, 246, 0)',
            0.25,
            'rgba(59, 130, 246, 0.35)',
            0.5,
            'rgba(59, 130, 246, 0.65)',
            0.8,
            'rgba(37, 99, 235, 0.9)',
            1,
            'rgba(30, 64, 175, 0.95)',
          ],
        },
      }, 'waterway-label');
    }

    if (!map.getLayer(ANALYSIS_POINTS_LAYER_ID)) {
      map.addLayer({
        id: ANALYSIS_POINTS_LAYER_ID,
        type: 'circle',
        source: ANALYSIS_HEATMAP_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: {
          'circle-radius': 5,
          'circle-opacity': 0.0,
          'circle-color': '#f97316',
        },
      });
    }

    bringLayerToFront(ANALYSIS_HEATMAP_LAYER_ID);
  }, [bringLayerToFront]);

  const ensureShadowLayer = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!map.getSource(SHADOW_RESULT_SOURCE_ID)) {
      map.addSource(SHADOW_RESULT_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }

    if (!map.getLayer(SHADOW_RESULT_LAYER_ID)) {
      map.addLayer({
        id: SHADOW_RESULT_LAYER_ID,
        type: 'fill',
        source: SHADOW_RESULT_SOURCE_ID,
        paint: {
          'fill-color': '#0f172a',
          'fill-opacity': 0.28,
          'fill-outline-color': '#1e293b',
        },
      });
    }

    bringLayerToFront(SHADOW_RESULT_LAYER_ID);
  }, [bringLayerToFront]);

  useEffect(() => {
    ensureHeatmapLayers();
    ensureShadowLayer();
  }, [ensureHeatmapLayers, ensureShadowLayer]);

  const updateAnalysisHeatmap = useCallback((samples: GeometryAnalysisSample[]) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    if (!samples.length) {
      updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
      heatmapDataRef.current = EMPTY_FEATURE_COLLECTION;
      updateMapSource(SHADOW_RESULT_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
      shadowResultDataRef.current = EMPTY_FEATURE_COLLECTION;
      return;
    }

    const featureCollection: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: samples.map((sample) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [sample.lng, sample.lat],
        },
        properties: {
          sunHours: sample.hoursOfSun,
          weight: Math.max(0, Math.min(sample.hoursOfSun / 6, 1)),
        },
      })),
    };

    updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, featureCollection);
    heatmapDataRef.current = featureCollection;
    ensureHeatmapLayers();
  }, [ensureHeatmapLayers, updateMapSource]);
  
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
    buildingsLoaded,
    setBuildingsLoaded,
    setIsLoadingBuildings,
    shadowSimulatorReady,
    isAnimating,
    setShadowSimulatorReady,
    setIsInitialisingShadow,
    autoLoadBuildings,
    setViewportActions,
    setShadowServiceStatus,
    setShadowServiceResult,
    setShadowServiceError,
    mapCenter,
    mapZoom,
    setMapView,
  } = useShadowMapStore();

  const setMapViewRef = useRef(setMapView);
  useEffect(() => {
    setMapViewRef.current = setMapView;
  }, [setMapView]);

  const autoLoadBuildingsRef = useRef(autoLoadBuildings);
  const selectedBaseMapId = baseMapId ?? mapSettings.baseMapId ?? 'mapbox-streets';
  const buildingStyle = useMemo(() => computeBuildingStyle(selectedBaseMapId), [selectedBaseMapId]);
  const baseMapStyle = useMemo(() => getBaseMapStyle(selectedBaseMapId), [selectedBaseMapId]);
  useMobilityDemoBootstrap();
  useMobilityPlayback();
  useDeckMobilityFlow();

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (!map.getLayer(BUILDING_LAYER_ID)) return;
    map.setPaintProperty(BUILDING_LAYER_ID, 'fill-extrusion-color', buildingStyle.fill);
    map.setPaintProperty(BUILDING_LAYER_ID, 'fill-extrusion-opacity', buildingStyle.opacity);
  }, [buildingStyle.fill, buildingStyle.opacity]);

  // Component initialisation lifecycle
  console.log(' ShadowMapViewport mounted')

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

  const hideNativeBuildingLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const style = map.getStyle();
    const layerIds = style?.layers?.map((layer) => layer.id) ?? [];
    layerIds.forEach((layerId) => {
      if (layerId === BUILDING_LAYER_ID) return;
      if (!layerId.toLowerCase().includes('building')) return;
      try {
        map.removeLayer(layerId);
      } catch {
        try {
          map.setLayoutProperty(layerId, 'visibility', 'none');
        } catch {
          // ignore
        }
      }
    });
  }, []);


  const applyUploadedGeometrySelectionStyles = useCallback((geometryId: string | null) => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (map.getLayer(UPLOADED_FILL_LAYER_ID)) {
      map.setPaintProperty(UPLOADED_FILL_LAYER_ID, 'fill-opacity', [
        'case',
        ['==', ['get', '__geometryId'], geometryId ?? ''],
        0.05,
        0.02,
      ]);
    }

    if (map.getLayer(UPLOADED_OUTLINE_LAYER_ID)) {
      map.setPaintProperty(UPLOADED_OUTLINE_LAYER_ID, 'line-color', [
        'case',
        ['==', ['get', '__geometryId'], geometryId ?? ''],
        '#1d4ed8',
        '#94a3b8',
      ]);
      map.setPaintProperty(UPLOADED_OUTLINE_LAYER_ID, 'line-width', [
        'case',
        ['==', ['get', '__geometryId'], geometryId ?? ''],
        2.4,
        1.2,
      ]);
    }
  }, []);

  const refreshUploadedGeometryLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      return undefined;
    }

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

    const applyLayers = () => {
      const existingSource = map.getSource(UPLOADED_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined;

      if (existingSource) {
        existingSource.setData(featureCollection as any);
      } else {
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
      }

      const { selectedGeometryId: activeGeometryId } = useShadowMapStore.getState();
      applyUploadedGeometrySelectionStyles(activeGeometryId ?? null);
    };

    if (map.isStyleLoaded()) {
      applyLayers();
      return undefined;
    }

    const handleStyle = () => {
      applyLayers();
      ensureHeatmapLayers();
      ensureShadowLayer();
      bringLayerToFront(SHADOW_RESULT_LAYER_ID);
      bringLayerToFront(ANALYSIS_HEATMAP_LAYER_ID);
    };

    map.once('styledata', handleStyle);
    return () => {
      map.off('styledata', handleStyle);
    };
  }, [uploadedGeometries, ensureHeatmapLayers, ensureShadowLayer, bringLayerToFront, applyUploadedGeometrySelectionStyles]);

  useEffect(() => {
    const cleanup = refreshUploadedGeometryLayers();
    return () => {
      if (cleanup) {
        cleanup();
      }
    };
  }, [refreshUploadedGeometryLayers]);

  const refreshUploadedGeometryLayersRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    refreshUploadedGeometryLayersRef.current = () => {
      refreshUploadedGeometryLayers();
    };
  }, [refreshUploadedGeometryLayers]);

  useEffect(() => {
    applyUploadedGeometrySelectionStyles(selectedGeometryId);
  }, [applyUploadedGeometrySelectionStyles, selectedGeometryId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (map.getLayer(UPLOADED_FILL_LAYER_ID)) {
      map.setPaintProperty(UPLOADED_FILL_LAYER_ID, 'fill-opacity', [
        'case',
        ['==', ['get', '__geometryId'], selectedGeometryId ?? ''],
        0.05,
        0.02,
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
    bringLayerToFront(SHADOW_RESULT_LAYER_ID);
    bringLayerToFront(ANALYSIS_HEATMAP_LAYER_ID);
  }, [selectedGeometryId, uploadedGeometries, bringLayerToFront]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (!selectedGeometryId) {
      if (heatmapDataRef.current) {
        updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
        heatmapDataRef.current = EMPTY_FEATURE_COLLECTION;
        updateMapSource(SHADOW_RESULT_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
        shadowResultDataRef.current = EMPTY_FEATURE_COLLECTION;
      }
      setShadowServiceResult(null);
      setShadowServiceStatus('idle');
      setShadowServiceError(null);
      analysisKeyRef.current = null;
      return;
    }

    const geometryEntry = uploadedGeometries.find((item) => item.id === selectedGeometryId);
    if (!geometryEntry) {
      return;
    }

    const geometry = geometryEntry.feature.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
      setShadowServiceStatus('error');
      setShadowServiceError('Only Polygon or MultiPolygon geometries are supported for analysis.');
      addStatusMessage?.(' Only Polygon or MultiPolygon geometries can be analysed for shadows.', 'warning');
      return;
    }

    if (analysisInFlightRef.current) {
      return;
    }

    const requestKey = `${selectedGeometryId}|${currentDate.toISOString()}|${geometryEntry.bbox.join(',')}`;
    if (analysisKeyRef.current === requestKey) {
      return;
    }

    const controller = new AbortController();
    analysisInFlightRef.current = true;
    setIsInitialisingShadow(true);
    setShadowServiceStatus('loading');
    setShadowServiceError(null);
    addStatusMessage?.(' Requesting real-time shadow analysis', 'info');

    shadowAnalysisClient
      .requestAnalysis({
        bbox: geometryEntry.bbox,
        timestamp: currentDate,
        geometry: geometryEntry.feature as Feature<Polygon | MultiPolygon>,
        outputs: { shadowPolygons: true, sunlightGrid: true, heatmap: true },
        signal: controller.signal,
      })
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }

        const samples = (response.data.sunlight?.features ??
          response.data.heatmap?.features ??
          []) as Array<Feature>;

        const geometrySamples: GeometryAnalysisSample[] = samples
          .map((feature) => {
            if (!feature.geometry || feature.geometry.type !== 'Point') {
              return null;
            }
            const [lng, lat] = feature.geometry.coordinates as [number, number];
            const props = feature.properties ?? {};
            const hoursOfSun = Number(props['hoursOfSun'] ?? props['sunHours'] ?? response.metrics.avgSunlightHours);
            const shadowPercent =
              typeof props['shadowPercent'] === 'number'
                ? Number(props['shadowPercent'])
                : Math.max(0, Math.min(100, response.metrics.avgShadowPercent));
            return {
              lat,
              lng,
              shadowPercent,
              hoursOfSun,
            };
          })
          .filter((item): item is GeometryAnalysisSample => Boolean(item));

        const heatmapAllowed = mapSettings.showSunExposure || shadowSettingsState.showSunExposure;
        if (heatmapAllowed && geometrySamples.length) {
          updateAnalysisHeatmap(geometrySamples);
          bringLayerToFront(ANALYSIS_HEATMAP_LAYER_ID);
        } else {
          updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
          heatmapDataRef.current = EMPTY_FEATURE_COLLECTION;
        }

        const shadowFeatures = (response.data.shadows as FeatureCollection | undefined) ?? EMPTY_FEATURE_COLLECTION;
        updateMapSource(SHADOW_RESULT_SOURCE_ID, shadowFeatures);
        shadowResultDataRef.current = shadowFeatures;
        ensureShadowLayer();

        setGeometryAnalysis({
          geometryId: selectedGeometryId,
          stats: {
            shadedRatio: response.metrics.avgShadowPercent / 100,
            avgSunlightHours: response.metrics.avgSunlightHours,
            sampleCount: response.metrics.sampleCount,
            validSamples: geometrySamples.length,
            invalidSamples: Math.max(response.metrics.sampleCount - geometrySamples.length, 0),
            generatedAt: new Date(response.bucketStart),
            notes: response.cache.hit ? 'Served from cache' : undefined,
          },
          samples: geometrySamples,
        });

        analysisKeyRef.current = requestKey;
        setShadowServiceResult(response);
        setShadowServiceStatus('success');
        addStatusMessage?.(' Shadow analysis ready.', 'info');
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setShadowServiceStatus('error');
        setShadowServiceError(message);
        addStatusMessage?.(` Shadow analysis failed: ${message}`, 'error');
        updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
        heatmapDataRef.current = EMPTY_FEATURE_COLLECTION;
        updateMapSource(SHADOW_RESULT_SOURCE_ID, EMPTY_FEATURE_COLLECTION);
        shadowResultDataRef.current = EMPTY_FEATURE_COLLECTION;
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          analysisInFlightRef.current = false;
          setIsInitialisingShadow(false);
        }
      });

    return () => {
      controller.abort();
      analysisInFlightRef.current = false;
      setIsInitialisingShadow(false);
    };
  }, [
    selectedGeometryId,
    uploadedGeometries,
    currentDate,
    updateMapSource,
    addStatusMessage,
    setGeometryAnalysis,
    setShadowServiceResult,
    setShadowServiceStatus,
    setShadowServiceError,
    setIsInitialisingShadow,
    updateAnalysisHeatmap,
    ensureShadowLayer,
    bringLayerToFront,
    mapSettings.showSunExposure,
    shadowSettingsState.showSunExposure,
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
          console.log(' Shadow simulator library loaded')
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
  // Load buildings from the back-end stream
  const loadBuildings = useCallback(async () => {
    if (!mapRef.current) {
      setStatusMessage('Map is not ready')
      return
    }

    try {
      setBuildingsLoaded(false)
      setIsLoadingBuildings(true)
      setStatusMessage('Loading buildings for the current view...')
      console.log(' Begin loading buildings for current viewport')
      
      const bounds = mapRef.current.getBounds()
      const boundingBox = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      }

      console.log(' Viewport bounds:', boundingBox)

      // Use the service with caching
      const result = await getWfsBuildings(boundingBox, 10000) // Increase maxFeatures
      
      if (result.success && result.data) {
        (addBuildingsToMapRef.current ?? addBuildingsToMap)(result.data);
        setBuildingsLoaded(true)
        setStatusMessage(`Loaded ${result.data.features.length} buildings in this session`)
      } else {
        const metadata = result.metadata as { message?: string } | undefined
        throw new Error(metadata?.message ?? 'Failed to load buildings')
      }
    } catch (error) {
      console.error(' Failed to load buildings:', error)
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage('Building load failed: ' + message)
      setBuildingsLoaded(false)
    } finally {
      setIsLoadingBuildings(false)
    }
  }, [])

  // Keep the latest load handler accessible for debounced callbacks
  useEffect(() => {
    loadBuildingsRef.current = loadBuildings
  }, [loadBuildings])

  useEffect(() => {
    loadShadowSimulatorRef.current = loadShadowSimulator;
  }, [loadShadowSimulator]);
  useEffect(() => {
    refreshWeatherDataRef.current = refreshWeatherData;
  }, [refreshWeatherData]);

  useEffect(() => {
    autoLoadBuildingsRef.current = autoLoadBuildings;
  }, [autoLoadBuildings]);

  // Add building data to the map with verbose diagnostics
  const addBuildingsToMap = useCallback((buildingData: any) => {
    console.log(' Starting building ingestion...');
    
    if (!mapRef.current) {
      console.error(' mapRef.current is null');
      return;
    }

    const map = mapRef.current;
    const sourceId = BUILDING_SOURCE_ID;
    const layerId = BUILDING_LAYER_ID;

    console.log(' Map state:', {
      loaded: map.loaded(),
      style: map.getStyle()?.name,
      center: map.getCenter(),
      zoom: map.getZoom(),
      pitch: map.getPitch()
    });

    // Check whether the source already exists
    const existingSource = map.getSource(sourceId);
    const hasExistingLayer = !!map.getLayer(layerId);
    
    console.log(' Existing layer/source status:', {
      hasSource: !!existingSource,
      hasLayer: hasExistingLayer
    });

    // Log dataset diagnostics
    console.log(' Dataset diagnostics:', {
      dataType: typeof buildingData,
      hasFeatures: !!buildingData.features,
      featuresCount: buildingData.features?.length,
      isArray: Array.isArray(buildingData.features)
    });

    if (!buildingData.features || !Array.isArray(buildingData.features)) {
      console.error(' Invalid data format: features is not an array');
      return;
    }

    if (buildingData.features.length === 0) {
      console.warn(' Building dataset is empty');
      return;
    }

    // Inspect the first few features for sanity checks
    for (let i = 0; i < Math.min(3, buildingData.features.length); i++) {
      const feature = buildingData.features[i];
      console.log(` Building ${i + 1} diagnostics:`, {
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

    // Prepare building height attributes
    const processedFeatures = buildingData.features.map((feature: Feature, index: number) => {
      if (!feature.properties) feature.properties = {};
      
      // Assign height when explicit values are missing
      if (!feature.properties.height) {
        if (feature.properties.height_mean) {
          feature.properties.height = feature.properties.height_mean;
        } else if (feature.properties.levels) {
          feature.properties.height = feature.properties.levels * 3.5;
        } else {
          feature.properties.height = 15; // Default height fallback
        }
      }

      // Ensure height is numeric
      feature.properties.height = Number(feature.properties.height) || 15;

      if (index < 3) {
        console.log(` Post-processed building ${index + 1}:`, {
          height: feature.properties.height,
          heightType: typeof feature.properties.height
        });
      }

      return feature;
    });

    console.log(' Processed dataset stats:', {
      totalFeatures: processedFeatures.length,
      heightStats: {
        min: Math.min(...processedFeatures.map((f: Feature) => f.properties?.height || 0)),
        max: Math.max(...processedFeatures.map((f: Feature) => f.properties?.height || 0)),
        avg: processedFeatures.reduce((sum: number, f: Feature) => sum + (f.properties?.height || 0), 0) / processedFeatures.length
      }
    });

    // Build GeoJSON source payload
    const geoJsonData: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: processedFeatures
    };

    const applyBuildingPaint = () => {
      if (!map.getLayer(layerId)) {
        return;
      }
      map.setPaintProperty(layerId, 'fill-extrusion-color', buildingStyle.fill);
      map.setPaintProperty(layerId, 'fill-extrusion-height', ['get', 'height']);
      map.setPaintProperty(layerId, 'fill-extrusion-base', 0);
      map.setPaintProperty(layerId, 'fill-extrusion-opacity', buildingStyle.opacity);
      try {
        map.moveLayer(layerId);
      } catch (error) {
        console.warn('Unable to move building layer to front:', error);
      }
    };

    // Update the source if present; otherwise create it alongside the layer
    if (existingSource && 'setData' in existingSource) {
      console.log(' Updating existing source (keep layers to avoid ShadeMap conflicts)');
      (existingSource as mapboxgl.GeoJSONSource).setData(geoJsonData);
      console.log(' Source update complete');
      applyBuildingPaint();
    } else {
      console.log(' Creating new data source...');
      try {
        map.addSource(sourceId, {
          type: 'geojson',
          data: geoJsonData
        });
        console.log(' Data source added successfully');
      } catch (sourceError) {
        console.error(' Failed to add data source:', sourceError);
        return;
      }

      // Add the extrusion layer when creating the source
      console.log(' Adding extrusion layer to the map...');
      try {
        map.addLayer({
        id: layerId,
        type: 'fill-extrusion',
        source: sourceId,
        paint: {
          'fill-extrusion-color': buildingStyle.fill,
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': buildingStyle.opacity
        }
      });
      console.log(' Layer added successfully');
      } catch (layerError) {
        console.error(' Failed to add layer:', layerError);
        return;
      }
      try {
        map.moveLayer(layerId);
      } catch (error) {
        console.warn('Unable to move building layer to front:', error);
      }
    } // Close conditional source creation block

    // Immediate validation
    console.log(' Validating layer state immediately:');
    const addedLayer = map.getLayer(layerId);
    const addedSource = map.getSource(sourceId);
    console.log(' Validation result:', {
      layerExists: !!addedLayer,
      layerType: addedLayer?.type,
      sourceExists: !!addedSource,
      sourceType: addedSource?.type
    });

    // Log map bounds for troubleshooting
    const mapBounds = map.getBounds();
    console.log(' Map bounds vs data extents:', {
      mapBounds: {
        north: mapBounds.getNorth(),
        south: mapBounds.getSouth(),
        east: mapBounds.getEast(),
        west: mapBounds.getWest()
      }
    });

    // Delayed validation to ensure render completes
    setTimeout(() => {
      if (!map || !mapRef.current) {
        console.warn(' Map instance disposed, skipping delayed validation');
        return;
      }
      
      console.log(' Delayed validation (after 1s):');
      const finalLayer = map.getLayer(layerId);
      const finalSource = map.getSource(sourceId);
      
      if (finalSource && 'type' in finalSource && finalSource.type === 'geojson') {
        console.log(' Final render state:', {
          layerVisible: finalLayer ? true : false,
          sourceLoaded: true,
          mapRendering: map.loaded()
        });
      }
    }, 1000);

    console.log(' Building ingestion sequence complete');
  }, [refreshWeatherData, buildingStyle.fill, buildingStyle.opacity]);

  useEffect(() => {
    addBuildingsToMapRef.current = addBuildingsToMap;
  }, [addBuildingsToMap]);

  const restoreBuildingLayerFromCache = useCallback(() => {
    const cached = buildingCache.getAllAsFeatureCollection();
    if (!cached?.features?.length) {
      return;
    }
    addBuildingsToMap(cached);
  }, [addBuildingsToMap]);

  const restoreBuildingLayerFromCacheRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    restoreBuildingLayerFromCacheRef.current = restoreBuildingLayerFromCache;
  }, [restoreBuildingLayerFromCache]);

  // Initialise shadow simulator
  const initShadowSimulator = useCallback(() => {
    if (!mapRef.current || !window.ShadeMap) {
      setStatusMessage('Map or shadow simulator not ready');
      return;
    }

    if (!buildingsLoaded) {
      setStatusMessage('Load buildings before initializing ShadeMap');
      return;
    }

    try {
      //  Get fresh state from store at call time, not from closure
      const { currentDate: latestDate, mapSettings: latestMapSettings } = useShadowMapStore.getState();
      
      //  Check if we should recalculate (optimization)
      const checkBuildingSource = mapRef.current.getSource(BUILDING_SOURCE_ID);
      const buildingCount = checkBuildingSource ? ((checkBuildingSource as any)._data?.features?.length || 0) : 0;
      
      const optimizationCheck = shadowOptimizer.shouldRecalculate(
        mapRef.current,
        latestDate,
        buildingCount
      );

      if (!optimizationCheck.shouldCalculate && shadeMapRef.current) {
        console.log(' Skip shadow calculation:', optimizationCheck.reason);
        setStatusMessage(`Shadows already up to date (${optimizationCheck.reason})`);
        return;
      }

      console.log(' Initializing shadow simulator...', { 
        date: latestDate,
        reason: optimizationCheck.reason 
      });
      
      // Remove any existing ShadeMap instance before reinitialising
      if (shadeMapRef.current) {
        try {
          console.log(' Removing existing shadow simulator...');
          shadeMapRef.current.remove();
        } catch (removeError) {
          console.warn(' Error removing existing shadow simulator:', removeError);
        } finally {
          shadeMapRef.current = null;
          sunExposureStateRef.current = null;
        }
      }

      // Validate building data presence
      const buildingSource = mapRef.current.getSource(BUILDING_SOURCE_ID);
      if (!buildingSource) {
        setStatusMessage('Building data source not found');
        return;
      }

      const sourceData = (buildingSource as any)._data;
      if (!sourceData || !sourceData.features || sourceData.features.length === 0) {
        setStatusMessage('Building dataset is empty');
        return;
      }

      const buildings = sourceData.features;
      console.log(` Preparing to provide ${buildings.length} building features to ShadeMap`);

      // Validate building data presence
      const validBuildings = buildings.filter((building: any) => {
        return building && 
               building.geometry && 
               building.geometry.coordinates && 
               building.properties;
      });

      console.log(` Valid building count: ${validBuildings.length}`);

      if (validBuildings.length === 0) {
        setStatusMessage('No valid building features provided');
        return;
      }

      const terrainSource = latestMapSettings.showDEMLayer
        ? {
            tileSize: 256,
            maxZoom: 15,
            getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) =>
              ApiService.getDEMTileUrl(z, x, y),
            getElevation: ({ r, g, b }: { r: number; g: number; b: number }) =>
              r * 256 + g + b / 256 - 32768,
          }
        : undefined;

      // Instantiate ShadeMap with the freshest settings from the store
      shadeMapRef.current = new window.ShadeMap({
        date: latestDate,
        color: latestMapSettings.shadowColor,
        opacity: getEffectiveOpacity(latestMapSettings.shadowOpacity),
        apiKey: mapboxgl.accessToken,
        ...(terrainSource ? { terrainSource } : {}),
        getFeatures: () => {
          const buildingSource = mapRef.current?.getSource(BUILDING_SOURCE_ID);
          if (buildingSource && (buildingSource as any)._data) {
            const buildings = (buildingSource as any)._data.features;
            const validBuildings = buildings.filter((building: any) => {
              return building && 
                     building.geometry && 
                     building.geometry.coordinates && 
                     building.properties;
            });
            console.log(` Providing ${validBuildings.length} valid buildings to ShadeMap in real time`);
            return validBuildings;
          }
          console.warn(' Unable to read building data source');
          return [];
        },
        debug: (msg: string) => {
          console.log('ShadeMap:', msg);
        }
      }).addTo(mapRef.current);

      applyShadowOpacity(latestMapSettings.shadowOpacity);

      // Record this calculation for optimisation statistics
      shadowOptimizer.recordCalculation(mapRef.current, latestDate, validBuildings.length);

      setShadowSimulatorReady(true);
      setStatusMessage(`Shadow simulator ready; processed ${validBuildings.length} building features to ShadeMap`);
      console.log(' Shadow simulator initialised');
      
      // Emit optimisation statistics
      const stats = shadowOptimizer.getStats();
      console.log(' Shadow optimiser stats:', stats);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setStatusMessage('Shadow simulator initialisation failed: ' + errorMessage);
      console.error(' Shadow simulator initialisation failed:', error);
      
      // Reset status indicators
      setShadowSimulatorReady(false);
      shadeMapRef.current = null;
    } finally {
      setIsInitialisingShadow(false);
    }
    //  FIXED: Don't include currentDate in deps - time updates via setDate(), not re-init
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingsLoaded]);

  // Update shadow simulation time
  const updateShadowTime = useCallback((newTime: Date) => {
    const { setCurrentDate } = useShadowMapStore.getState();
    
    //  Add safety checks
    if (!shadeMapRef.current) {
      setStatusMessage('Shadow simulator not initialised');
      return;
    }

    if (!mapRef.current || !mapRef.current.loaded()) {
      setStatusMessage('Map is not fully loaded');
      return;
    }

    const buildingSource = mapRef.current.getSource(BUILDING_SOURCE_ID);
    if (!buildingSource) {
      setStatusMessage('Building data not loaded');
      return;
    }

    try {
      if (typeof shadeMapRef.current.setDate === 'function') {
        shadeMapRef.current.setDate(newTime);
        setCurrentDate(newTime);
        setStatusMessage('Shadow time updated: ' + newTime.toLocaleString());
        refreshWeatherData('time-update');
      }
    } catch (error) {
      console.error(' Error updating shadow time:', error);
      setStatusMessage('Failed to update shadow time');
    }
  }, []);

  const stopTimeAnimation = useCallback(() => {
    if (animationFrameRef.current != null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    animationLastTimestampRef.current = null;
  }, []);

  const animateShadowTime = useCallback((timestamp: number) => {
    if (!isAnimating || !shadowSimulatorReady || !shadeMapRef.current) {
      stopTimeAnimation();
      return;
    }

    if (animationLastTimestampRef.current == null) {
      animationLastTimestampRef.current = timestamp;
      animationFrameRef.current = requestAnimationFrame(animateShadowTime);
      return;
    }

    const deltaMs = timestamp - animationLastTimestampRef.current;
    animationLastTimestampRef.current = timestamp;
    const minutesDelta = (deltaMs / 1000) * BASE_ANIMATION_MINUTES_PER_SECOND;

    if (minutesDelta > 0) {
      const { currentDate: latestDate } = useShadowMapStore.getState();
      const nextDate = new Date(latestDate);
      nextDate.setMinutes(nextDate.getMinutes() + minutesDelta);
      updateShadowTime(nextDate);
    }

    animationFrameRef.current = requestAnimationFrame(animateShadowTime);
  }, [isAnimating, shadowSimulatorReady, stopTimeAnimation, updateShadowTime]);

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
      if (isTracePlaying) {
        setTracePlaying(false);
      }
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
    //  Guard: Check if shadow simulator and map are fully ready
    if (!shadeMapRef.current || !mapRef.current) {
      console.log(' Shadow simulator or map not ready, skipping update');
      return;
    }

    //  Guard: Check if building source exists (shadow simulator needs this)
    const buildingSource = mapRef.current.getSource(BUILDING_SOURCE_ID);
    if (!buildingSource) {
      console.log(' Building source not loaded yet, skipping shadow update');
      return;
    }

    //  Guard: Check if map is loaded
    if (!mapRef.current.loaded()) {
      console.log(' Map not fully loaded, skipping shadow update');
      return;
    }

    try {
      console.log(' Updating shadow settings:', {
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
      console.error(' Error updating shadow settings:', error);
      // Don't crash the app, just log the error
    }
  }, [mapSettings.shadowColor, mapSettings.shadowOpacity, currentDate, applyShadowOpacity]);

  //  Watch for layer visibility changes and update map layers
  useEffect(() => {
    if (!mapRef.current || !mapRef.current.loaded()) return;

    const map = mapRef.current;
    const buildingLayerId = BUILDING_LAYER_ID;
    const sunExposureActive = mapSettings.showSunExposure || shadowSettingsState.showSunExposure;

    console.log(' Updating layer visibility:', {
      buildings: mapSettings.showBuildingLayer,
      shadow: mapSettings.showShadowLayer
    });

    if (map.getLayer(buildingLayerId)) {
      map.setPaintProperty(buildingLayerId, 'fill-extrusion-color', buildingStyle.fill);
      map.setPaintProperty(buildingLayerId, 'fill-extrusion-opacity', buildingStyle.opacity);
      map.setLayoutProperty(
        buildingLayerId,
        'visibility',
        mapSettings.showBuildingLayer ? 'visible' : 'none'
      );
      console.log(` Building layer: ${mapSettings.showBuildingLayer ? 'visible' : 'hidden'}`);
    }

    // Control shadow layer visibility (if shadow simulator exists)
    if (shadeMapRef.current) {
      try {
        // Shadow simulator doesn't have a direct visibility method, 
        // but we can control it via opacity
        if (typeof shadeMapRef.current.setOpacity === 'function') {
          const adjustedShadowOpacity = sunExposureActive
            ? mapSettings.shadowOpacity * 0.25
            : mapSettings.shadowOpacity;
          const effectiveOpacity = mapSettings.showShadowLayer
            ? getEffectiveOpacity(adjustedShadowOpacity)
            : 0;
          shadeMapRef.current.setOpacity(effectiveOpacity);
          console.log(` Shadow layer: ${mapSettings.showShadowLayer ? 'visible' : 'hidden'}`);
        }
      } catch (error) {
        console.error(' Error controlling shadow visibility:', error);
      }
    }
  }, [
    mapSettings.showBuildingLayer,
    mapSettings.showShadowLayer,
    mapSettings.shadowOpacity,
    mapSettings.showSunExposure,
    shadowSettingsState.showSunExposure,
    getEffectiveOpacity,
  ]);

  useEffect(() => {
    const shadeMap = shadeMapRef.current;
    if (!shadeMap || typeof shadeMap.setSunExposure !== 'function') {
      return;
    }

    if (!shadowSimulatorReady) {
      return;
    }

    const enableSunExposure = mapSettings.showSunExposure || shadowSettingsState.showSunExposure;
    const exposureKey = enableSunExposure ? `on:${currentDate.toISOString()}` : 'off';

    if (sunExposureStateRef.current === exposureKey) {
      return;
    }
    sunExposureStateRef.current = exposureKey;

    let cancelled = false;

    const applySunExposure = async () => {
      try {
        if (!enableSunExposure) {
          await shadeMap.setSunExposure(false);
          if (typeof shadeMap.setOpacity === 'function') {
            shadeMap.setOpacity(getEffectiveOpacity(mapSettings.shadowOpacity));
          }
          return;
        }

        const startDate = new Date(currentDate);
        startDate.setHours(6, 0, 0, 0);

        const endDate = new Date(currentDate);
        endDate.setHours(18, 0, 0, 0);

        await shadeMap.setSunExposure(true, {
          startDate,
          endDate,
          iterations: 24,
        });

        if (typeof shadeMap.setOpacity === 'function') {
          const dimmedOpacity = getEffectiveOpacity(mapSettings.shadowOpacity * 0.25);
          shadeMap.setOpacity(dimmedOpacity);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn(' Failed to toggle sun exposure:', error);
        }
      }
    };

    applySunExposure();

    return () => {
      cancelled = true;
    };
  }, [
    mapSettings.showSunExposure,
    shadowSettingsState.showSunExposure,
    shadowSimulatorReady,
    currentDate,
    mapSettings.shadowOpacity,
    getEffectiveOpacity,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const heatmapOpacity = mapSettings.showSunExposure || shadowSettingsState.showSunExposure ? 0.85 : 0;
    if (map.getLayer(ANALYSIS_HEATMAP_LAYER_ID)) {
      map.setPaintProperty(ANALYSIS_HEATMAP_LAYER_ID, 'heatmap-opacity', heatmapOpacity);
    }
    if (map.getLayer(ANALYSIS_POINTS_LAYER_ID)) {
      map.setPaintProperty(ANALYSIS_POINTS_LAYER_ID, 'circle-opacity', heatmapOpacity > 0 ? 0.2 : 0);
    }
  }, [mapSettings.showSunExposure, shadowSettingsState.showSunExposure]);

  useEffect(() => {
    if (!buildingsLoaded) {
      return;
    }

    const timer = window.setTimeout(() => {
      initShadowSimulator();
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [buildingsLoaded, initShadowSimulator]);

  useEffect(() => {
    if (!isAnimating) {
      stopTimeAnimation();
      return;
    }

    if (!shadowSimulatorReady || !shadeMapRef.current) {
      return;
    }

    animationFrameRef.current = requestAnimationFrame(animateShadowTime);

    return () => {
      stopTimeAnimation();
    };
  }, [isAnimating, shadowSimulatorReady, animateShadowTime, stopTimeAnimation]);

  // Clear building and shadow artefacts
  const clearBuildings = useCallback(() => {
    if (!mapRef.current) return;

    const map = mapRef.current;
    const sourceId = BUILDING_SOURCE_ID;
    const layerId = BUILDING_LAYER_ID;

    // Remove building layer
    if (map.getLayer(layerId)) {
      map.removeLayer(layerId);
      console.log(' Removing building layer');
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
      console.log(' Removing building source');
    }

    // Clear the client-side cache
    buildingCache.clear();

    // Remove ShadeMap safely
    if (shadeMapRef.current) {
      try {
        shadeMapRef.current.remove();
        console.log(' Removing shadow simulator');
      } catch (removeError) {
        console.warn(' Error removing shadow simulator:', removeError);
      } finally {
        shadeMapRef.current = null;
        sunExposureStateRef.current = null;
      }
    }

    if (map.getLayer(ANALYSIS_HEATMAP_LAYER_ID)) {
      map.removeLayer(ANALYSIS_HEATMAP_LAYER_ID);
    }
    if (map.getLayer(ANALYSIS_POINTS_LAYER_ID)) {
      map.removeLayer(ANALYSIS_POINTS_LAYER_ID);
    }
    if (map.getSource(ANALYSIS_HEATMAP_SOURCE_ID)) {
      map.removeSource(ANALYSIS_HEATMAP_SOURCE_ID);
    }
    heatmapDataRef.current = null;
    shadowResultDataRef.current = EMPTY_FEATURE_COLLECTION;

    // Reset status indicators
    setBuildingsLoaded(false);
    setShadowSimulatorReady(false);
    setStatusMessage('Buildings and shadow data cleared; ready to reload');
  }, []);

  // Expose core viewport actions to the toolbar
  useEffect(() => {
    setViewportActions({
      loadBuildings,
      initShadowSimulator,
      clearBuildings,
      fitToBounds: (bounds, options) => {
        if (!mapRef.current) return;
        mapRef.current.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north],
          ],
          {
            padding: options?.padding ?? 80,
            maxZoom: options?.maxZoom ?? 16.5,
          },
        );
      },
    });

    return () => {
      setViewportActions({
        loadBuildings: undefined,
        initShadowSimulator: undefined,
        clearBuildings: undefined,
        fitToBounds: undefined,
      });
    };
  }, [setViewportActions, loadBuildings, initShadowSimulator, clearBuildings]);

  // Initialise the map instance
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    console.log(' Initialising streamlined shadow map...');

    mapboxgl.accessToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';

    const initialCenter: [number, number] = (mapCenter ?? [114.1694, 22.3193]) as [number, number];
    const initialZoom = mapZoom ?? 16;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: baseMapStyle,
      center: initialCenter,
      zoom: initialZoom,
      pitch: 45,
      bearing: 0,
      attributionControl: false,
    });

    mapRef.current = map;
    (window as any).__shadowMapInstance = map;
    window.dispatchEvent(new CustomEvent('shadow-map-ready'));
    baseMapBootstrapRef.current = true;
    lastBaseMapIdRef.current = selectedBaseMapId;

    const handleResize = () => {
      if (mapRef.current) {
        mapRef.current.resize();
      }
    };

    const handleLoad = async () => {
      console.log(' Map load complete');
      map.resize();
      hideNativeBuildingLayers();
      const center = map.getCenter();
      setMapViewRef.current?.([center.lng, center.lat], map.getZoom());
      baseMapBootstrapRef.current = true;
      lastBaseMapIdRef.current = selectedBaseMapId;

      try {
        const shadowLoader = loadShadowSimulatorRef.current ?? loadShadowSimulator;
        await shadowLoader();
      } catch (error) {
        console.warn(' ShadeMap library load failed:', error);
      }

      console.log(' Auto-loading initial viewport buildings...');
      setStatusMessage('Auto-loading buildings...');
      await loadBuildings();
      (refreshWeatherDataRef.current ?? refreshWeatherData)('map-load');
    };

    const handleStyleData = () => {
      if (heatmapDataRef.current) {
        try {
          updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, heatmapDataRef.current);
          ensureHeatmapLayers();
        } catch (error) {
          console.warn(' Failed to restore analysis heatmap after style change:', error);
        }
      }
    };

    const handleMoveEnd = () => {
      const center = map.getCenter();
      setMapViewRef.current?.([center.lng, center.lat], map.getZoom());

      if (!autoLoadBuildingsRef.current) {
        return;
      }

      if (!loadBuildingsRef.current) {
        console.warn(' loadBuildingsRef is undefined');
        return;
      }

      if (moveEndTimeoutRef.current) {
        window.clearTimeout(moveEndTimeoutRef.current);
      }

      moveEndTimeoutRef.current = window.setTimeout(() => {
        loadBuildingsRef.current?.();
        (refreshWeatherDataRef.current ?? refreshWeatherData)('moveend');
        if (shadeMapRef.current && typeof shadeMapRef.current.setOpacity === 'function') {
          const dimmedOpacity = getEffectiveOpacity(mapSettings.shadowOpacity * 0.25);
          shadeMapRef.current.setOpacity(dimmedOpacity);
        }
      }, 500);
    };

    map.on('load', handleLoad);
    map.on('moveend', handleMoveEnd);
    map.on('styledata', handleStyleData);
    map.on('styledata', hideNativeBuildingLayers);
    window.addEventListener('resize', handleResize);

    return () => {
      if (moveEndTimeoutRef.current) {
        window.clearTimeout(moveEndTimeoutRef.current);
        moveEndTimeoutRef.current = null;
      }
      window.removeEventListener('resize', handleResize);
      map.off('load', handleLoad);
      map.off('moveend', handleMoveEnd);
      map.off('styledata', handleStyleData);
      map.off('styledata', hideNativeBuildingLayers);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // Initialise map once

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (!baseMapBootstrapRef.current) {
      baseMapBootstrapRef.current = true;
      lastBaseMapIdRef.current = selectedBaseMapId;
      return;
    }

    if (lastBaseMapIdRef.current === selectedBaseMapId) {
      return;
    }

    lastBaseMapIdRef.current = selectedBaseMapId;

    if (shadeMapRef.current) {
      try {
        shadeMapRef.current.remove();
      } catch (error) {
        console.warn(' Failed to remove shadow simulator before style change:', error);
      } finally {
        shadeMapRef.current = null;
        sunExposureStateRef.current = null;
        setShadowSimulatorReady(false);
        setStatusMessage('Shadow simulator reset after basemap change');
      }
    }

    const restoreLayers = () => {
      restoreBuildingLayerFromCacheRef.current?.();
      refreshUploadedGeometryLayersRef.current?.();
      if (heatmapDataRef.current) {
        updateMapSource(ANALYSIS_HEATMAP_SOURCE_ID, heatmapDataRef.current);
      }
      if (shadowResultDataRef.current) {
        updateMapSource(SHADOW_RESULT_SOURCE_ID, shadowResultDataRef.current);
      }
      ensureHeatmapLayers();
      ensureShadowLayer();
      bringLayerToFront(SHADOW_RESULT_LAYER_ID);
      bringLayerToFront(ANALYSIS_HEATMAP_LAYER_ID);

      window.setTimeout(() => {
        initShadowSimulator();
      }, 50);
    };

    map.once('styledata', restoreLayers);
    map.setStyle(baseMapStyle, { diff: false });

    return () => {
      map.off('styledata', restoreLayers);
    };
  }, [
    baseMapStyle,
    selectedBaseMapId,
    ensureHeatmapLayers,
    ensureShadowLayer,
    bringLayerToFront,
    updateMapSource,
    initShadowSimulator,
    setShadowSimulatorReady,
    setStatusMessage,
  ]);

  return (
    <div className={`relative w-full h-full ${className}`}>
      {/* Inline animation styles */}
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
      {/* Map container */}
      <div ref={mapContainerRef} className="h-full w-full" />
      <GeometryAnalysisOverlay />
    </div>
  );
};
