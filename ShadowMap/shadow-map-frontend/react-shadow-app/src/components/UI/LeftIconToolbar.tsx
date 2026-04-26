import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Popover, Slider, Switch, Tooltip, Divider, Progress } from 'antd'
import {
  ClockIcon,
  SwatchIcon,
  GlobeAltIcon,
  ArrowUpTrayIcon,
  PlayCircleIcon,
  PauseCircleIcon,
  BuildingOfficeIcon,
  SunIcon,
  TrashIcon,
  MapPinIcon,
} from '@heroicons/react/24/outline'
import { useShadowMapStore } from '../../store/shadowMapStore'
import type { MobilityTracePoint } from '../../store/shadowMapStore'
import type { MobilityDataset } from '../../types/index.ts'
import type { Feature, Geometry } from 'geojson'
import { BASE_MAPS } from '../../services/baseMapManager'
import { parseMobilityCsv } from '../../utils/mobilityCsv'
import { fetchDirectionsRoute, type MapboxDirectionsProfile } from '../../services/mapboxDirectionsService'
import { buildMobilityTraceFromRoute } from '../../utils/routeTrace'

type PanelId = 'time' | 'shadow' | 'style' | 'upload' | 'buildings' | 'analysis' | 'mobility' | null;

type ShadowMapClickEvent = {
  lngLat?: {
    lng: number
    lat: number
  }
}

type ShadowMapInstance = {
  on: (event: 'click', handler: (event: ShadowMapClickEvent) => void) => void
  off: (event: 'click', handler: (event: ShadowMapClickEvent) => void) => void
  getCanvas?: () => HTMLCanvasElement
  getCenter?: () => { lng: number; lat: number }
}

const getShadowMapInstance = () => {
  return (window as unknown as Window & { __shadowMapInstance?: ShadowMapInstance }).__shadowMapInstance ?? null
}

const presetHours = [
  { hour: 6, label: 'Sunrise' },
  { hour: 12, label: 'Noon' },
  { hour: 18, label: 'Sunset' },
];

const baseMapPresets = BASE_MAPS;

export const LeftIconToolbar: React.FC = () => {
  const {
    currentDate,
    setCurrentDate,
    isAnimating,
    setIsAnimating,
    mobilityPlaybackTime,
    setMobilityPlaybackTime,
    isMobilityPlaying,
    setMobilityPlaying,
    mapSettings,
    updateMapSettings,
    updateShadowSettings,
    addStatusMessage,
    setMobilityTrace,
    clearMobilityTrace,
    setTracePlaying,
    addUploadedGeometry,
    selectGeometry,
    uploadedGeometries,
    buildingsLoaded,
    isLoadingBuildings,
    shadowSimulatorReady,
    autoLoadBuildings,
    setAutoLoadBuildings,
    viewportActions,
    shadowServiceStatus,
    shadowServiceResult,
    mobilityDatasets,
    addMobilityDataset,
    removeMobilityDataset,
    setMobilityDatasetVisibility,
    activeMobilityDatasetId,
    setActiveMobilityDataset,
    mobilitySunlight,
    mobilitySunlightProgress,
    mobilitySunlightStatus,
    mobilitySunlightError,
    computeMobilitySunlight,
    exportMobilitySunlight,
    includeCanopy,
    setIncludeCanopy,
    mobilityFlowStyle,
    setMobilityFlowStyle,
    mobilityColorBySunlight,
    setMobilityColorBySunlight,
    mobilityInferIndoor,
    setMobilityInferIndoor,
    mobilityDashIndoor,
    setMobilityDashIndoor,
    mobilityPathWidthScale,
    setMobilityPathWidthScale,
    figureModeEnabled,
    setFigureModeEnabled,
    setFigureHudVisible,
  } = useShadowMapStore();

  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [routeProfile, setRouteProfile] = useState<MapboxDirectionsProfile>('walking')
  const [routeStepSeconds, setRouteStepSeconds] = useState<number>(10)
  const [routeTraceId, setRouteTraceId] = useState<string>('road_001')
  const [routeStartLng, setRouteStartLng] = useState<string>('114.1588')
  const [routeStartLat, setRouteStartLat] = useState<string>('22.2814')
  const [routeEndLng, setRouteEndLng] = useState<string>('114.1858')
  const [routeEndLat, setRouteEndLat] = useState<string>('22.2801')
  const [routePickingTarget, setRoutePickingTarget] = useState<'start' | 'end' | null>(null)
  const [routeGenerating, setRouteGenerating] = useState(false)
  const [routeError, setRouteError] = useState<string | null>(null)
  const selectedBaseMap = mapSettings.baseMapId ?? 'mapbox-streets';
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mobilityFileInputRef = useRef<HTMLInputElement | null>(null);

  const formattedDate = useMemo(
    () => new Date(currentDate).toLocaleString(undefined, { hour12: false }),
    [currentDate],
  );

  const handleOpenChange = (panelId: PanelId, nextOpen: boolean) => {
    setOpenPanel((prev) => {
      if (!nextOpen && prev === panelId) {
        return null;
      }
      return nextOpen ? panelId : prev;
    });
  };

  const setPresetHour = (hour: number) => {
    const next = new Date(currentDate);
    next.setHours(hour, 0, 0, 0);
    setCurrentDate(next);
  };

  const toggleAnimation = () => setIsAnimating(!isAnimating);
  const handleMobilityUploadClick = () => mobilityFileInputRef.current?.click();

  useEffect(() => {
    if (!routePickingTarget) return

    const map = getShadowMapInstance()
    if (!map) {
      addStatusMessage?.('Map is not ready for picking coordinates yet.', 'warning')
      setRoutePickingTarget(null)
      return
    }

    const canvas = map.getCanvas?.()
    const previousCursor = canvas?.style?.cursor
    if (canvas?.style) {
      canvas.style.cursor = 'crosshair'
    }

    const handleClick = (event: ShadowMapClickEvent) => {
      const lngLat = event?.lngLat
      const lng = Number(lngLat?.lng)
      const lat = Number(lngLat?.lat)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        addStatusMessage?.('Failed to pick coordinate from map click.', 'warning')
        return
      }

      const lngText = lng.toFixed(6)
      const latText = lat.toFixed(6)
      if (routePickingTarget === 'start') {
        setRouteStartLng(lngText)
        setRouteStartLat(latText)
        addStatusMessage?.(`Start set: ${lngText}, ${latText}`, 'info')
      } else {
        setRouteEndLng(lngText)
        setRouteEndLat(latText)
        addStatusMessage?.(`End set: ${lngText}, ${latText}`, 'info')
      }
      setRoutePickingTarget(null)
    }

    map.on('click', handleClick)
    addStatusMessage?.(`Click on map to set ${routePickingTarget}.`, 'info')

    return () => {
      try {
        map.off('click', handleClick)
      } catch {
        // ignore cleanup issues
      }
      if (canvas?.style) {
        canvas.style.cursor = previousCursor ?? ''
      }
    }
  }, [addStatusMessage, routePickingTarget])

  const ensurePlaybackTimeWithinDataset = (dataset: MobilityDataset) => {
    const start = dataset.timeRange.start.getTime();
    const end = dataset.timeRange.end.getTime();
    const current = mobilityPlaybackTime?.getTime() ?? start;
    if (current < start || current > end) {
      setMobilityPlaybackTime(dataset.timeRange.start);
    }
  };

  const handleMobilityPlaybackToggle = (dataset: MobilityDataset) => {
    const datasetIsActive = activeMobilityDatasetId === dataset.id;
    if (!datasetIsActive) {
      setActiveMobilityDataset(dataset.id);
      setMobilityPlaybackTime(dataset.timeRange.start);
      setMobilityPlaying(true);
      return;
    }

    if (!isMobilityPlaying) {
      ensurePlaybackTimeWithinDataset(dataset);
      setMobilityPlaying(true);
      return;
    }

    setMobilityPlaying(false);
  };

  const zoomToMobilityDataset = (datasetId: string) => {
    const dataset = mobilityDatasets.find((item) => item.id === datasetId);
    if (!dataset) {
      addStatusMessage?.('Dataset not found.', 'warning');
      return;
    }
    if (!viewportActions.fitToBounds) {
      addStatusMessage?.('Map viewport is not ready to zoom.', 'warning');
      return;
    }
    // Allow tighter framing for small traces; users can always zoom out manually.
    viewportActions.fitToBounds(dataset.bounds, { padding: 80, maxZoom: 18 });
  };

  const handleBaseMapChange = (mapId: string) => {
    updateMapSettings({ baseMapId: mapId });
    const preset = baseMapPresets.find((item) => item.id === mapId);
    addStatusMessage?.(`Base map switched to ${preset?.name ?? mapId}`);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const readFileAsText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsText(file);
    });

  const generateGeometryId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `geom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const generateMobilityDatasetId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const pickMobilityColor = (index: number) => {
    const palette = ['#38bdf8', '#f97316', '#22c55e', '#e879f9', '#facc15'];
    return palette[index % palette.length];
  };

  const routePresets: Array<{
    id: string
    label: string
    start: { lng: number; lat: number }
    end: { lng: number; lat: number }
  }> = [
    {
      id: 'hk-central-to-causeway',
      label: 'HK Island: Central → Causeway Bay',
      start: { lng: 114.1588, lat: 22.2814 },
      end: { lng: 114.1858, lat: 22.2801 },
    },
    {
      id: 'hk-central-to-wanchai',
      label: 'HK Island: Central → Wan Chai',
      start: { lng: 114.1588, lat: 22.2814 },
      end: { lng: 114.1728, lat: 22.2787 },
    },
    {
      id: 'hk-mongkok',
      label: 'Kowloon: Mong Kok (dense)',
      start: { lng: 114.1696, lat: 22.3173 },
      end: { lng: 114.1738, lat: 22.3114 },
    },
  ]

  const applyRoutePreset = (presetId: string) => {
    const preset = routePresets.find((item) => item.id === presetId)
    if (!preset) return
    setRouteStartLng(preset.start.lng.toFixed(6))
    setRouteStartLat(preset.start.lat.toFixed(6))
    setRouteEndLng(preset.end.lng.toFixed(6))
    setRouteEndLat(preset.end.lat.toFixed(6))
    addStatusMessage?.(`Route preset loaded: ${preset.label}`, 'info')
  }

  const setRouteEndpointFromCenter = (target: 'start' | 'end') => {
    const map = getShadowMapInstance()
    const center = map?.getCenter?.()
    const lng = Number(center?.lng)
    const lat = Number(center?.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      addStatusMessage?.('Map center is unavailable.', 'warning')
      return
    }
    const lngText = lng.toFixed(6)
    const latText = lat.toFixed(6)
    if (target === 'start') {
      setRouteStartLng(lngText)
      setRouteStartLat(latText)
    } else {
      setRouteEndLng(lngText)
      setRouteEndLat(latText)
    }
    addStatusMessage?.(`${target === 'start' ? 'Start' : 'End'} set from map center.`, 'info')
  }

  const parseCoord = (lngText: string, latText: string) => {
    const lng = Number.parseFloat(lngText)
    const lat = Number.parseFloat(latText)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return null
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return null
    }
    return { lng, lat }
  }

  const generateRoadTrace = async () => {
    setRouteError(null)
    const start = parseCoord(routeStartLng, routeStartLat)
    const end = parseCoord(routeEndLng, routeEndLat)
    if (!start || !end) {
      setRouteError('Invalid start/end coordinates.')
      addStatusMessage?.('Invalid start/end coordinates for road trace.', 'warning')
      return
    }

    const traceId = routeTraceId.trim()
    if (!traceId) {
      setRouteError('Trace id is required.')
      addStatusMessage?.('Trace id is required.', 'warning')
      return
    }

    const stepSeconds = Math.max(2, Math.floor(routeStepSeconds))
    setRouteGenerating(true)
    try {
      const route = await fetchDirectionsRoute({
        profile: routeProfile,
        start,
        end,
      })

      const trace = buildMobilityTraceFromRoute({
        traceId,
        startTime: currentDate,
        stepSeconds,
        coordinates: route.coordinates,
        durationSeconds: route.durationSeconds,
      })

      const datasetId = generateMobilityDatasetId()
      const datasetName = `road-${routeProfile}-${traceId}.csv`
      const dataset: MobilityDataset = {
        id: datasetId,
        name: datasetName,
        color: pickMobilityColor(mobilityDatasets.length),
        createdAt: new Date(),
        sourceFile: datasetName,
        pointCount: trace.rows.length,
        traceIds: trace.traceIds,
        bounds: trace.bounds,
        timeRange: trace.timeRange,
        visible: true,
        errors: [],
      }

      addMobilityDataset(dataset, trace.rows)
      setActiveMobilityDataset(dataset.id)
      setMobilityPlaybackTime(dataset.timeRange.start)
      setMobilityPlaying(false)
      zoomToMobilityDataset(dataset.id)
      addStatusMessage?.(
        `Road trace ready: ${trace.rows.length} points (${Math.round(route.distanceMeters)}m, ${Math.round(route.durationSeconds)}s).`,
        'info',
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRouteError(message)
      addStatusMessage?.(`Road trace generation failed: ${message}`, 'error')
    } finally {
      setRouteGenerating(false)
    }
  }

  const isPolygonGeometry = (geometry: any): geometry is Geometry => {
    if (!geometry || typeof geometry !== 'object') return false;
    return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
  };

  const isTraceGeometry = (geometry: any): boolean => {
    if (!geometry || typeof geometry !== 'object') return false;
    if (geometry.type === 'GeometryCollection') {
      return Array.isArray(geometry.geometries) && geometry.geometries.some(isTraceGeometry);
    }
    return geometry.type === 'Point' || geometry.type === 'MultiPoint' || geometry.type === 'LineString';
  };

  const computeFeatureBbox = (feature: Feature<Geometry>): [number, number, number, number] => {
    const coords: Array<[number, number]> = [];

    const collect = (geometry: any) => {
      if (!geometry) return;
      if (geometry.type === 'GeometryCollection') {
        geometry.geometries?.forEach(collect);
        return;
      }

      const recurse = (value: any) => {
        if (!Array.isArray(value)) return;
        if (typeof value[0] === 'number' && typeof value[1] === 'number') {
          coords.push([value[0], value[1]]);
        } else {
          value.forEach(recurse);
        }
      };

      recurse(geometry.coordinates);
    };

    collect(feature.geometry);

    if (!coords.length) {
      return [0, 0, 0, 0];
    }

    const lons = coords.map(([lon]) => lon);
    const lats = coords.map(([, lat]) => lat);

    return [
      Math.min(...lons),
      Math.min(...lats),
      Math.max(...lons),
      Math.max(...lats),
    ];
  };

  const extractPolygonFeatures = (geojson: any): Feature<Geometry>[] => {
    const features: Feature<Geometry>[] = [];

    const pushFeature = (feature: any) => {
      if (!feature || typeof feature !== 'object') return;
      if (feature.type === 'Feature' && feature.geometry && isPolygonGeometry(feature.geometry)) {
        features.push({
          type: 'Feature',
          geometry: feature.geometry,
          properties: feature.properties ?? {},
        });
        return;
      }

      if (isPolygonGeometry(feature)) {
        features.push({ type: 'Feature', geometry: feature, properties: {} });
      }
    };

    if (!geojson || typeof geojson !== 'object') {
      return features;
    }

    if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
      geojson.features.forEach(pushFeature);
      return features;
    }

    if (geojson.type === 'Feature') {
      pushFeature(geojson);
      return features;
    }

    if (geojson.type === 'GeometryCollection' && Array.isArray(geojson.geometries)) {
      geojson.geometries.forEach(pushFeature);
      return features;
    }

    pushFeature(geojson);
    return features;
  };

  const hasTraceLikeFeatures = (geojson: any): boolean => {
    const checkFeature = (feature: any): boolean => {
      if (!feature || typeof feature !== 'object') return false;
      if (feature.type === 'Feature' && feature.geometry) {
        return isTraceGeometry(feature.geometry);
      }
      if (feature.type === 'GeometryCollection') {
        return Array.isArray(feature.geometries) && feature.geometries.some(checkFeature);
      }
      return isTraceGeometry(feature);
    };

    if (!geojson || typeof geojson !== 'object') {
      return false;
    }

    if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
      return geojson.features.some(checkFeature);
    }

    return checkFeature(geojson);
  };

  const parseMobilityTraceGeoJson = (raw: string | unknown): MobilityTracePoint[] => {
    const json = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const points: MobilityTracePoint[] = [];

    const pushPoint = (coordinates: unknown, timestampValue: unknown) => {
      if (
        !Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        typeof coordinates[0] !== 'number' ||
        typeof coordinates[1] !== 'number'
      ) {
        throw new Error('Invalid coordinate pair detected in trace file');
      }

      const candidate = typeof timestampValue === 'number' ? new Date(timestampValue) : new Date(String(timestampValue));
      if (!timestampValue || Number.isNaN(candidate.getTime())) {
        throw new Error('Trace point is missing a valid timestamp');
      }

      points.push({
        coordinates: [coordinates[0], coordinates[1]],
        time: candidate,
        timestampLabel: candidate.toISOString(),
      });
    };

    const extractTimestamp = (properties: Record<string, unknown> | undefined, index: number): unknown => {
      if (!properties) return undefined;
      if (properties.timestamp) return properties.timestamp;
      if (properties.time) return properties.time;
      if (properties.datetime) return properties.datetime;
      if (Array.isArray(properties.timestamps) || Array.isArray((properties as Record<string, unknown>).times)) {
        const arr = (properties.timestamps ?? (properties as Record<string, unknown>).times) as unknown[];
        return arr[index];
      }
      return undefined;
    };

    const processFeature = (feature: any) => {
      if (!feature || typeof feature !== 'object') return;
      const { geometry, properties } = feature;
      if (!geometry || typeof geometry !== 'object') return;

      if (geometry.type === 'Point') {
        pushPoint(geometry.coordinates, extractTimestamp(properties, 0));
      } else if (geometry.type === 'MultiPoint') {
        geometry.coordinates.forEach((coords: unknown, idx: number) => {
          pushPoint(coords, extractTimestamp(properties, idx));
        });
      } else if (geometry.type === 'LineString') {
        if (!Array.isArray(geometry.coordinates)) return;
        geometry.coordinates.forEach((coords: unknown, idx: number) => {
          pushPoint(coords, extractTimestamp(properties, idx));
        });
      }
    };

    if (json && typeof json === 'object') {
      const geo = json as any;
      if (geo.type === 'FeatureCollection' && Array.isArray(geo.features)) {
        geo.features.forEach(processFeature);
      } else if (geo.type === 'Feature') {
        processFeature(geo);
      } else if (geo.type === 'LineString') {
        geo.coordinates?.forEach((coords: unknown, idx: number) => {
          pushPoint(coords, geo.timestamps ? geo.timestamps[idx] : undefined);
        });
      } else if (geo.type === 'Point') {
        pushPoint(geo.coordinates, geo.timestamp ?? geo.time ?? geo.datetime);
      }
    }

    if (!points.length) {
      throw new Error('Trace file did not contain any timestamped positions');
    }

    points.sort((a, b) => a.time.getTime() - b.time.getTime());
    points.forEach((point) => {
      point.timestampLabel = point.time.toLocaleString();
    });

    return points;
  };

  const createUploadedGeometry = (feature: Feature<Geometry>, sourceName: string, orderIndex: number): string => {
    const nameFromProps = feature.properties?.name ?? feature.properties?.id;
    const fallbackName = `Geometry ${orderIndex + 1}`;
    const bbox = computeFeatureBbox(feature);

    const geometryId = generateGeometryId();

    addUploadedGeometry({
      id: geometryId,
      name: String(nameFromProps ?? fallbackName),
      feature,
      bbox,
      uploadedAt: new Date(),
      sourceFile: sourceName,
    });

    return geometryId;
  };

  const toggleSunExposureSetting = (enabled: boolean) => {
    updateMapSettings({
      showSunExposure: enabled,
      showShadowLayer: true,
    });
    updateShadowSettings({ showSunExposure: enabled });
    addStatusMessage?.(
      enabled
        ? 'Sun exposure heatmap enabled. Shadow layer is dimmed to improve contrast.'
        : 'Sun exposure heatmap disabled. Shadow layer restored to normal intensity.',
      'info',
    );
  };

  const handleFilesSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    const geoJsonFile = files.find((file) => {
      const name = file.name.toLowerCase();
      return name.endsWith('.geojson') || name.endsWith('.json') || file.type.includes('geo+json');
    });

    if (!geoJsonFile) {
      addStatusMessage?.('Please select a GeoJSON file.', 'warning');
      event.target.value = '';
      return;
    }

    try {
      setTracePlaying(false);
      const raw = await readFileAsText(geoJsonFile);
      const parsed = JSON.parse(raw);

      const polygonFeatures = extractPolygonFeatures(parsed);
      const containsTrace = hasTraceLikeFeatures(parsed);

      if (polygonFeatures.length > 0) {
        const baseOffset = uploadedGeometries.length;
        const createdIds = polygonFeatures.map((feature, index) =>
          createUploadedGeometry(feature, geoJsonFile.name, baseOffset + index)
        );

        if (createdIds[0]) {
          selectGeometry(createdIds[0]);
        }

        clearMobilityTrace();
        toggleSunExposureSetting(true);

        addStatusMessage?.(`✅ Uploaded ${polygonFeatures.length} polygon feature(s) for analysis.`, 'info');
        setOpenPanel(null);
      } else if (containsTrace) {
        const tracePoints = parseMobilityTraceGeoJson(parsed);
        setMobilityTrace(tracePoints);
        addStatusMessage?.(`Mobility trace ready (${tracePoints.length} points)`, 'info');
        setOpenPanel(null);
      } else {
        addStatusMessage?.('The selected GeoJSON does not contain polygons or trace features that can be processed.', 'warning');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to parse GeoJSON';
      clearMobilityTrace();
      addStatusMessage?.(message, 'error');
    } finally {
      event.target.value = '';
    }
  };

  const renderPanelContent = (panelId: Exclude<PanelId, null>): React.ReactNode => {
    if (panelId === 'time') {
      return (
        <div className="w-full space-y-4 p-4 text-slate-700">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Date & time</span>
            <span className="text-xs text-slate-400">{formattedDate}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {presetHours.map((preset) => (
              <Button
                key={preset.hour}
                size="small"
                type="text"
                className="h-9 rounded-lg border border-slate-200 bg-slate-100 text-slate-600 hover:bg-slate-200"
                onClick={() => setPresetHour(preset.hour)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Button
              type={isAnimating ? 'default' : 'primary'}
              className="h-10 rounded-lg px-4"
              icon={
                isAnimating ? (
                  <PauseCircleIcon className="h-4 w-4" />
                ) : (
                  <PlayCircleIcon className="h-4 w-4" />
                )
              }
              onClick={toggleAnimation}
            >
              {isAnimating ? 'Pause' : 'Animate'}
            </Button>
            <span className="text-xs text-slate-400">Timeline playback</span>
          </div>
        </div>
      );
    }

    if (panelId === 'upload') {
      return (
        <div className="w-full space-y-4 p-4 text-slate-700">
          <div>
            <span className="text-sm font-semibold text-slate-900">Geo data uploads</span>
            <p className="text-xs text-slate-400">Supported: .tif .tiff .gpx .kml .json .geojson</p>
          </div>
          <Button
            type="primary"
            icon={<ArrowUpTrayIcon className="h-4 w-4" />}
            onClick={handleUploadClick}
            className="h-11 w-full rounded-xl"
          >
            Choose files
          </Button>
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Drag & drop coming soon. Uploads align to current viewport.
          </p>
        </div>
      );
    }

    if (panelId === 'shadow') {
      return (
        <div className="w-full space-y-4 p-4 text-slate-700">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Shadow layer</span>
            <Switch
              size="small"
              checked={mapSettings.showShadowLayer}
              onChange={(checked) => updateMapSettings({ showShadowLayer: checked })}
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Opacity</span>
              <span>{Math.round(mapSettings.shadowOpacity * 100)}%</span>
            </div>
            <Slider
              min={10}
              max={100}
              step={5}
              value={Math.round(mapSettings.shadowOpacity * 100)}
              onChange={(value) => updateMapSettings({ shadowOpacity: (value as number) / 100 })}
              tooltip={{ open: false }}
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Color</span>
            <input
              type="color"
              value={mapSettings.shadowColor}
              onChange={(event) => updateMapSettings({ shadowColor: event.target.value })}
              className="h-7 w-12 cursor-pointer rounded border border-gray-300"
            />
          </div>
        </div>
      );
    }

    if (panelId === 'mobility') {
      return (
        <div className="w-full space-y-4 p-4 text-slate-700">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Mobility datasets</span>
            <Button size="small" onClick={handleMobilityUploadClick} icon={<ArrowUpTrayIcon className="h-4 w-4" />}>
              Upload
            </Button>
          </div>
          <p className="text-xs text-slate-400">CSV schema: id,time,lng,lat[,speed_kmh]</p>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>Canopy is included by default for mobility sunlight</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">{includeCanopy ? 'Canopy on' : 'Buildings only'}</span>
              <Switch size="small" checked={includeCanopy} onChange={(checked) => setIncludeCanopy(checked)} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>Trajectory style</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">
                {mobilityFlowStyle === 'path' ? 'Static path' : 'Animated trail'}
              </span>
              <Switch
                size="small"
                checked={mobilityFlowStyle === 'path'}
                onChange={(checked) => setMobilityFlowStyle(checked ? 'path' : 'trips')}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>Path color</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">{mobilityColorBySunlight ? 'Sun/Shadow' : 'Dataset'}</span>
              <Switch
                size="small"
                checked={mobilityColorBySunlight}
                onChange={(checked) => setMobilityColorBySunlight(checked)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>Indoor detection</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">{mobilityInferIndoor ? 'On' : 'Off'}</span>
              <Switch
                size="small"
                checked={mobilityInferIndoor}
                onChange={(checked) => setMobilityInferIndoor(checked)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span>Dashed indoor</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">{mobilityDashIndoor ? 'On' : 'Off'}</span>
              <Switch
                size="small"
                checked={mobilityDashIndoor}
                disabled={!mobilityInferIndoor}
                onChange={(checked) => setMobilityDashIndoor(checked)}
              />
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Line weight</span>
              <span>{mobilityPathWidthScale.toFixed(1)}x</span>
            </div>
            <Slider
              min={0.5}
              max={2}
              step={0.1}
              value={mobilityPathWidthScale}
              onChange={(value) => setMobilityPathWidthScale(value as number)}
              tooltip={{ open: false }}
            />
          </div>
          <Divider plain className="text-[11px] text-slate-400">Road trace (Directions)</Divider>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
            <p className="text-[11px] text-slate-500">
              Generate a realistic trace that follows the road network (Mapbox Directions API).
            </p>
            <div className="flex flex-wrap gap-2">
              {routePresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] text-slate-600 hover:border-slate-300"
                  onClick={() => applyRoutePreset(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-500">Profile</span>
              {(['walking', 'driving', 'cycling'] as const).map((profile) => (
                <button
                  key={profile}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    routeProfile === profile
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                  }`}
                  onClick={() => setRouteProfile(profile)}
                >
                  {profile}
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>Sampling step</span>
                <span>{Math.round(routeStepSeconds)}s</span>
              </div>
              <Slider
                min={2}
                max={30}
                step={1}
                value={routeStepSeconds}
                onChange={(value) => setRouteStepSeconds(value as number)}
                tooltip={{ open: false }}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-700">Start</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        routePickingTarget === 'start'
                          ? 'border-blue-200 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                      onClick={() => setRoutePickingTarget(routePickingTarget === 'start' ? null : 'start')}
                    >
                      Pick
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-300"
                      onClick={() => setRouteEndpointFromCenter('start')}
                    >
                      Center
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={routeStartLng}
                    onChange={(event) => setRouteStartLng(event.target.value)}
                    placeholder="lng"
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                  />
                  <input
                    value={routeStartLat}
                    onChange={(event) => setRouteStartLat(event.target.value)}
                    placeholder="lat"
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                  />
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-700">End</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        routePickingTarget === 'end'
                          ? 'border-blue-200 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                      onClick={() => setRoutePickingTarget(routePickingTarget === 'end' ? null : 'end')}
                    >
                      Pick
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-300"
                      onClick={() => setRouteEndpointFromCenter('end')}
                    >
                      Center
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={routeEndLng}
                    onChange={(event) => setRouteEndLng(event.target.value)}
                    placeholder="lng"
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                  />
                  <input
                    value={routeEndLat}
                    onChange={(event) => setRouteEndLat(event.target.value)}
                    placeholder="lat"
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>Trace id</span>
                  </div>
                  <input
                    value={routeTraceId}
                    onChange={(event) => setRouteTraceId(event.target.value)}
                    className="mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
                  />
                </div>
                <Button
                  type="primary"
                  size="small"
                  loading={routeGenerating}
                  disabled={routeGenerating}
                  onClick={generateRoadTrace}
                  className="h-8 rounded-lg"
                >
                  Generate
                </Button>
              </div>
              {routeError && (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-600">{routeError}</p>
              )}
            </div>
          </div>
          {mobilityDatasets.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">
              No mobility datasets yet. Use the Upload button to add CSV traces.
            </div>
          ) : (
            <div className="space-y-3">
              {mobilityDatasets.map((dataset) => {
                const datasetIsActive = activeMobilityDatasetId === dataset.id;
                const datasetIsPlaying = datasetIsActive && isMobilityPlaying;
                const sunlightStatus = mobilitySunlightStatus[dataset.id] ?? 'idle';
                const hasSunlight = (mobilitySunlight[dataset.id]?.length ?? 0) > 0;
                const sunlightError = mobilitySunlightError[dataset.id];
                const sunlightProgress = mobilitySunlightProgress[dataset.id];
                const progressPercent = sunlightProgress && sunlightProgress.total > 0
                  ? Math.round((sunlightProgress.completed / sunlightProgress.total) * 100)
                  : 0;
                return (
                  <div
                    key={dataset.id}
                    className={`rounded-xl border ${
                      datasetIsActive ? 'border-blue-400 shadow-sm' : 'border-slate-200'
                    } bg-white p-3 transition-shadow`}
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{dataset.name}</p>
                          <p className="text-xs text-slate-500">
                            {dataset.pointCount} points · {dataset.traceIds.length} traces
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            size="small"
                            checked={dataset.visible}
                            onChange={(checked) => setMobilityDatasetVisibility(dataset.id, checked)}
                          />
                          <Button size="small" onClick={() => zoomToMobilityDataset(dataset.id)}>
                            Focus
                          </Button>
                          <button
                            type="button"
                            className="rounded-lg border border-slate-200 p-1 text-slate-500 hover:text-red-500"
                            onClick={() => removeMobilityDataset(dataset.id)}
                            aria-label={`Remove ${dataset.name}`}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-400">
                      {dataset.timeRange.start.toISOString()} → {dataset.timeRange.end.toISOString()}
                    </p>
                    {dataset.errors.length > 0 && (
                      <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                        {dataset.errors.length} validation warning(s). First: {dataset.errors[0].message}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleMobilityPlaybackToggle(dataset)}
                        className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                          datasetIsPlaying
                            ? 'border-blue-200 bg-blue-50 text-blue-700'
                            : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300'
                        }`}
                      >
                        {datasetIsPlaying ? (
                          <>
                            <PauseCircleIcon className="h-4 w-4" /> Pause
                          </>
                        ) : (
                          <>
                            <PlayCircleIcon className="h-4 w-4" /> Play
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveMobilityDataset(dataset.id)}
                        className="rounded-full border border-slate-200 px-3 py-1 text-[11px] text-slate-600 hover:border-slate-300"
                      >
                        Set active
                      </button>
                      <button
                        type="button"
                        onClick={() => computeMobilitySunlight(dataset.id)}
                        className="rounded-full border border-blue-200 px-3 py-1 text-[11px] text-blue-700 hover:border-blue-300"
                      >
                        Compute sunlight
                      </button>
                      <button
                        type="button"
                        onClick={() => exportMobilitySunlight(dataset.id, 'csv')}
                        disabled={!hasSunlight}
                        className="rounded-full border border-slate-200 px-3 py-1 text-[11px] text-slate-600 hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Export CSV
                      </button>
                    </div>

                    {sunlightStatus !== 'idle' && (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>Sunlight analysis</span>
                          <span>
                            {sunlightProgress ? `${sunlightProgress.completed}/${sunlightProgress.total}` : 'Starting...'}
                          </span>
                        </div>
                        <Progress percent={progressPercent} size="small" showInfo={false} status="active" />
                      </div>
                    )}
                    {sunlightError && (
                      <p className="mt-1 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-600">
                        {sunlightError}
                      </p>
                    )}
                    {sunlightStatus === 'success' && hasSunlight && (
                      <p className="mt-1 text-[11px] text-emerald-600">
                        Sunlight states ready ({mobilitySunlight[dataset.id].length} points, per-minute).
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    if (panelId === 'buildings') {
      const statusClass = isLoadingBuildings
        ? 'text-amber-600'
        : buildingsLoaded
        ? 'text-emerald-600'
        : 'text-gray-500';
      const statusLabel = isLoadingBuildings
        ? 'Loading…'
        : buildingsLoaded
        ? 'Loaded'
        : 'Not loaded';

      return (
        <div className="w-full space-y-4 p-4 text-slate-700">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-900">Building data</p>
              <p className="text-xs text-slate-400">Manage cached footprints for this view</p>
            </div>
            <span className={`text-xs font-medium ${statusClass}`}>{statusLabel}</span>
          </div>

          <Button
            type="primary"
            icon={<BuildingOfficeIcon className="h-4 w-4" />}
            block
            className="h-11 rounded-xl"
            loading={isLoadingBuildings}
            disabled={!viewportActions.loadBuildings}
            onClick={() =>
              invokeViewportAction(
                viewportActions.loadBuildings,
                'Map viewport is not ready to load buildings yet.',
              )
            }
          >
            {buildingsLoaded ? 'Reload buildings' : 'Load buildings'}
          </Button>

          <div className="flex items-center justify-between rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500">
            <span>Auto-load after map move</span>
            <Switch
              size="small"
              checked={autoLoadBuildings}
              onChange={(checked) => setAutoLoadBuildings(Boolean(checked))}
            />
          </div>

          <Button
            danger
            icon={<TrashIcon className="h-4 w-4" />}
            block
            className="h-11 rounded-xl"
            disabled={
              !viewportActions.clearBuildings || (!buildingsLoaded && !shadowSimulatorReady)
            }
            onClick={() =>
              invokeViewportAction(
                viewportActions.clearBuildings
                  ? () => {
                      viewportActions.clearBuildings?.();
                    }
                  : undefined,
                'No building data to clear at the moment.',
              )
            }
          >
            Clear building & shadow data
          </Button>

          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Building footprints refresh for the active viewport. Disable auto-load if you prefer
            manual requests while exploring the map.
          </p>
        </div>
      );
    }

    if (panelId === 'analysis') {
      const statusMap: Record<string, { label: string; tone: string }> = {
        loading: { label: 'Running analysis…', tone: 'text-amber-500' },
        success: { label: 'Analysis ready', tone: 'text-emerald-500' },
        error: { label: 'Analysis failed', tone: 'text-rose-500' },
        idle: { label: 'Idle', tone: 'text-slate-400' },
      };

      const statusMeta = statusMap[shadowServiceStatus] ?? statusMap.idle;

      return (
        <div className="w-full space-y-4 p-4 text-slate-700">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">Heatmap overlay</span>
            <Switch
              size="small"
              checked={mapSettings.showSunExposure}
              onChange={(checked) => toggleSunExposureSetting(Boolean(checked))}
            />
          </div>
          <p className="text-xs text-slate-500">
            The heatmap is disabled by default to keep the map clear. Toggle it on only when you need an exposure view.
          </p>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <p className={`text-[11px] uppercase tracking-[0.2em] ${statusMeta.tone}`}>{statusMeta.label}</p>
            {shadowServiceResult ? (
              <dl className="mt-3 space-y-2 text-sm text-slate-600">
                <div className="flex items-center justify-between">
                  <dt>Avg sunlight</dt>
                  <dd className="font-semibold text-slate-900">
                    {shadowServiceResult.metrics.avgSunlightHours.toFixed(1)} h
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt>Shadow coverage</dt>
                  <dd className="font-semibold text-slate-900">
                    {shadowServiceResult.metrics.avgShadowPercent.toFixed(1)}%
                  </dd>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <dt>Samples</dt>
                  <dd>{shadowServiceResult.metrics.sampleCount}</dd>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <dt>Cache</dt>
                  <dd>{shadowServiceResult.cache.hit ? 'Hit' : 'Fresh compute'}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-xs text-slate-500">
                Select a polygon to trigger the backend analysis. Metrics appear here automatically when ready.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              block
              className="h-10 rounded-lg border border-blue-200 text-sm font-semibold text-blue-600 hover:border-blue-300"
              onClick={() => toggleSunExposureSetting(true)}
            >
              Show heatmap
            </Button>
            <Button
              block
              className="h-10 rounded-lg border border-slate-200 text-sm font-medium text-slate-600 hover:border-slate-300"
              onClick={() => toggleSunExposureSetting(false)}
            >
              Hide heatmap
            </Button>
          </div>
        </div>
      );
    }

    if (panelId === 'style') {
      return (
        <div className="w-full space-y-3 p-4 text-slate-700">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">Figure mode</span>
              <Switch size="small" checked={figureModeEnabled} onChange={(checked) => setFigureModeEnabled(checked)} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="small" onClick={applyFigurePreset}>
                Best preset (HK Central)
              </Button>
              <Button size="small" onClick={applyFigurePresetSatellite}>
                Satellite preset
              </Button>
              {figureModeEnabled && (
                <Button size="small" onClick={() => setFigureHudVisible(false)}>
                  Hide toolbar (H)
                </Button>
              )}
            </div>
            <span className="text-[11px] text-gray-400">
              Best time: 2025-12-16 16:30 HKT (08:30Z). Suggested files: Example/Mobility/hk-central-mini-*.*
            </span>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-semibold text-slate-900">Camera</span>
            <div className="flex items-center gap-2">
              <Button size="small" onClick={() => invokeViewPreset('3d')}>
                3D view
              </Button>
              <Button size="small" onClick={() => invokeViewPreset('2d')}>
                2D view
              </Button>
            </div>
            <span className="text-[11px] text-gray-400">Fit/zoom actions keep current pitch & bearing.</span>
          </div>
          <span className="text-sm font-semibold text-slate-900">Base map</span>
          {baseMapPresets.map((preset) => (
            <Button
              key={preset.id}
              block
              className={`text-left normal-case flex items-start justify-between rounded-xl border transition-colors ${
                selectedBaseMap === preset.id
                  ? 'border-blue-400 bg-blue-50 text-blue-700'
                  : 'border-transparent bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              onClick={() => handleBaseMapChange(preset.id)}
            >
              <span>
                <span className="block text-sm font-medium">{preset.name}</span>
                <span className="block text-xs text-gray-500">{preset.description}</span>
              </span>
            </Button>
          ))}
          <span className="text-[11px] text-gray-400">Coming soon: direct Mapbox / custom style URL.</span>
        </div>
      );
    }

    return (
      <div className="w-full space-y-4 p-4 text-slate-700">
        <div>
          <span className="text-sm font-semibold text-slate-900">Geo data uploads</span>
          <p className="text-xs text-slate-400">Supported: .tif .tiff .gpx .kml .json .geojson</p>
        </div>
        <Button
          type="primary"
          icon={<ArrowUpTrayIcon className="h-4 w-4" />}
          onClick={handleUploadClick}
          className="h-11 w-full rounded-xl"
        >
          Choose files
        </Button>
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Drag & drop coming soon. Uploads align to current viewport.
        </p>
        <Divider plain className="text-[11px] text-slate-400">Mobility traces</Divider>
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-semibold text-slate-900">Mobility datasets</span>
            <p className="text-xs text-slate-400">CSV schema: id,time,lng,lat[,speed_kmh]</p>
          </div>
          <Button size="small" onClick={handleMobilityUploadClick} icon={<ArrowUpTrayIcon className="h-4 w-4" />}>
            Upload
          </Button>
        </div>
        {mobilityDatasets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs text-slate-500">
            No mobility datasets yet. Use the Upload button to add CSV traces.
          </div>
        ) : (
          <div className="space-y-3">
            {mobilityDatasets.map((dataset) => {
              const datasetIsActive = activeMobilityDatasetId === dataset.id;
              const datasetIsPlaying = datasetIsActive && isMobilityPlaying;
              const sunlightStatus = mobilitySunlightStatus[dataset.id] ?? 'idle';
              const hasSunlight = (mobilitySunlight[dataset.id]?.length ?? 0) > 0;
              const sunlightError = mobilitySunlightError[dataset.id];
              const sunlightProgress = mobilitySunlightProgress[dataset.id];
              const progressPercent = sunlightProgress && sunlightProgress.total > 0
                ? Math.round((sunlightProgress.completed / sunlightProgress.total) * 100)
                : 0;
              return (
                <div
                  key={dataset.id}
                  className={`rounded-xl border ${
                    datasetIsActive ? 'border-blue-400 shadow-sm' : 'border-slate-200'
                  } bg-white p-3 transition-shadow`}
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{dataset.name}</p>
                        <p className="text-xs text-slate-500">
                          {dataset.pointCount} points · {dataset.traceIds.length} traces
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          size="small"
                          checked={dataset.visible}
                          onChange={(checked) => setMobilityDatasetVisibility(dataset.id, checked)}
                        />
                        <Button size="small" onClick={() => zoomToMobilityDataset(dataset.id)}>
                          Focus
                        </Button>
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 p-1 text-slate-500 hover:text-red-500"
                          onClick={() => removeMobilityDataset(dataset.id)}
                          aria-label={`Remove ${dataset.name}`}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {dataset.timeRange.start.toISOString()} → {dataset.timeRange.end.toISOString()}
                  </p>
                  {dataset.errors.length > 0 && (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                      {dataset.errors.length} validation warning(s). First: {dataset.errors[0].message}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleMobilityPlaybackToggle(dataset)}
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                        datasetIsPlaying
                          ? 'border-blue-500 bg-blue-50 text-blue-600'
                          : datasetIsActive
                          ? 'border-blue-200 text-blue-500'
                          : 'border-slate-200 text-slate-500'
                      }`}
                      aria-pressed={datasetIsPlaying}
                    >
                      {datasetIsPlaying ? (
                        <PauseCircleIcon className="h-4 w-4" />
                      ) : (
                        <PlayCircleIcon className="h-4 w-4" />
                      )}
                      {datasetIsPlaying ? 'Pause' : 'Play'}
                    </button>
                    <span
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
                      style={{ backgroundColor: dataset.color }}
                    >
                      {dataset.color}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="small"
                      loading={sunlightStatus === 'loading'}
                      onClick={() => computeMobilitySunlight(dataset.id)}
                    >
                      {sunlightStatus === 'success' && hasSunlight ? 'Recompute sunlight' : 'Analyse sunlight'}
                    </Button>
                    <Button
                      size="small"
                      disabled={!hasSunlight}
                      onClick={() => exportMobilitySunlight(dataset.id, 'csv')}
                    >
                      Export CSV
                    </Button>
                  </div>
                  {sunlightStatus === 'loading' && (
                    <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2">
                      <div className="flex items-center justify-between text-[11px] text-slate-500">
                        <span>Sunlight analysis</span>
                        <span>
                          {sunlightProgress ? `${sunlightProgress.completed}/${sunlightProgress.total}` : 'Starting...'}
                        </span>
                      </div>
                      <Progress percent={progressPercent} size="small" showInfo={false} status="active" />
                    </div>
                  )}
                  {sunlightError && (
                    <p className="mt-1 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-600">
                      {sunlightError}
                    </p>
                  )}
                  {sunlightStatus === 'success' && hasSunlight && (
                    <p className="mt-1 text-[11px] text-emerald-600">
                      Sunlight states ready ({mobilitySunlight[dataset.id].length} points, per-minute).
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const invokeViewportAction = async (
    action: (() => void | Promise<void>) | undefined,
    fallbackMessage: string,
  ) => {
    if (!action) {
      addStatusMessage?.(fallbackMessage, 'warning');
      return;
    }

    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addStatusMessage?.(`Action failed: ${message}`, 'error');
    }
  };

  const invokeViewPreset = (preset: '2d' | '3d') => {
    if (!viewportActions.setViewPreset) {
      addStatusMessage?.('Map viewport is not ready to update camera yet.', 'warning');
      return;
    }
    viewportActions.setViewPreset(preset);
  };

  const applyFigurePreset = () => {
    const time = new Date('2025-12-16T08:30:00Z'); // 16:30 HKT
    const center: [number, number] = [114.1588, 22.2814]; // Central / Admiralty

    setFigureModeEnabled(true);
    setCurrentDate(time);
    setMobilityFlowStyle('path');
    setMobilityColorBySunlight(true);
    setMobilityInferIndoor(true);
    setMobilityDashIndoor(true);
    setMobilityPathWidthScale(1.6);
    updateMapSettings({
      baseMapId: 'carto-light',
      shadowOpacity: 0.55,
      shadowColor: '#0b1220',
      showSunExposure: false,
    });

    if (!viewportActions.flyTo) {
      addStatusMessage?.('Map viewport is not ready to apply preset camera yet.', 'warning');
      return;
    }

    viewportActions.flyTo({
      center,
      zoom: 17.35,
      pitch: 60,
      bearing: -18,
      duration: 1000,
    });

    addStatusMessage?.('Figure preset applied: HK Central @ 16:30 (long shadows).', 'info');
  };

  const applyFigurePresetSatellite = () => {
    const time = new Date('2025-12-16T08:30:00Z'); // 16:30 HKT
    const center: [number, number] = [114.1588, 22.2814]; // Central / Admiralty

    setFigureModeEnabled(true);
    setCurrentDate(time);
    setMobilityFlowStyle('path');
    setMobilityColorBySunlight(true);
    setMobilityInferIndoor(true);
    setMobilityDashIndoor(true);
    setMobilityPathWidthScale(1.6);
    updateMapSettings({
      baseMapId: 'mapbox-satellite',
      shadowOpacity: 0.5,
      shadowColor: '#0b1220',
      showSunExposure: false,
    });

    if (!viewportActions.flyTo) {
      addStatusMessage?.('Map viewport is not ready to apply preset camera yet.', 'warning');
      return;
    }

    viewportActions.flyTo({
      center,
      zoom: 17.35,
      pitch: 60,
      bearing: -18,
      duration: 1000,
    });

    addStatusMessage?.('Figure preset applied: HK Central (satellite) @ 16:30.', 'info');
  };

  const toolbarItems: Array<{
    id: Exclude<PanelId, null>;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: 'time', label: 'Time controls', icon: <ClockIcon className="h-5 w-5" /> },
    { id: 'shadow', label: 'Shadow styling', icon: <SwatchIcon className="h-5 w-5" /> },
    { id: 'buildings', label: 'Building data', icon: <BuildingOfficeIcon className="h-5 w-5" /> },
    { id: 'analysis', label: 'Heatmap & analysis', icon: <SunIcon className="h-5 w-5" /> },
    { id: 'style', label: 'Map style', icon: <GlobeAltIcon className="h-5 w-5" /> },
    { id: 'upload', label: 'Geo uploads', icon: <ArrowUpTrayIcon className="h-5 w-5" /> },
    { id: 'mobility', label: 'Mobility', icon: <MapPinIcon className="h-5 w-5" /> },
  ];

  const baseButtonClasses =
    'flex h-12 w-12 items-center justify-center rounded-xl border transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white shadow-lg';
  const activeButtonClasses = 'border-blue-500 bg-blue-600 text-white shadow-xl focus:ring-blue-300';
  const inactiveButtonClasses = 'border-transparent bg-white text-slate-600 hover:bg-slate-100 focus:ring-blue-200';

  return (
    <div className="pointer-events-none fixed left-6 bottom-24 z-40 flex flex-col gap-4">
      <div className="pointer-events-auto rounded-2xl border border-white/40 bg-white/95 p-3 shadow-2xl backdrop-blur">
        <div className="flex flex-col gap-4">
          {toolbarItems.map((item) => (
            <Popover
              key={item.id}
              trigger="click"
              placement="right"
              overlayClassName="shadow-map-toolbar-popover"
              styles={{ body: { width: 320, padding: 0 } }}
              overlayStyle={{ zIndex: 1400 }}
              open={openPanel === item.id}
              onOpenChange={(open) => handleOpenChange(item.id, open)}
              content={renderPanelContent(item.id)}
            >
              <Tooltip title={item.label} placement="right">
                <button
                  type="button"
                  onClick={() => handleOpenChange(item.id, openPanel !== item.id)}
                  className={`${baseButtonClasses} ${openPanel === item.id ? activeButtonClasses : inactiveButtonClasses}`}
                  aria-pressed={openPanel === item.id}
                >
                  {item.icon}
                </button>
              </Tooltip>
            </Popover>
          ))}
        </div>
      </div>

      {/* Hidden file input to support uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".tif,.tiff,.gpx,.kml,.json,.geojson"
        multiple
        className="hidden"
        style={{ display: 'none' }}
        data-role="trace-upload-input"
        onChange={handleFilesSelected}
      />
      <input
        ref={mobilityFileInputRef}
        type="file"
        accept=".csv"
        className="hidden"
        style={{ display: 'none' }}
        data-role="mobility-upload-input"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            const text = await file.text();
            const result = parseMobilityCsv(text);
            if (!result.rows.length) {
              const firstError = result.errors[0]?.message ?? 'No valid rows detected.';
              console.error('[Mobility Upload] Failed:', firstError, result.errors);
              addStatusMessage?.(`Mobility upload failed: ${firstError}`, 'error');
              return;
            }
            if (result.traceIds.length === 0) {
              console.warn('[Mobility Upload] No trace ids detected; check id column or aliases');
            }
            const sortedRows = [...result.rows].sort(
              (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
            );
            const datasetId = generateMobilityDatasetId();
            const fallbackBounds = result.bounds ?? {
              north: sortedRows[0].coordinates[1],
              south: sortedRows[0].coordinates[1],
              east: sortedRows[0].coordinates[0],
              west: sortedRows[0].coordinates[0],
            };
            const fallbackRange = result.timeRange ?? {
              start: sortedRows[0].timestamp,
              end: sortedRows[sortedRows.length - 1].timestamp,
            };
            const dataset: MobilityDataset = {
              id: datasetId,
              name: file.name,
              color: pickMobilityColor(mobilityDatasets.length),
              createdAt: new Date(),
              sourceFile: file.name,
              pointCount: result.rows.length,
              traceIds: result.traceIds,
              bounds: fallbackBounds,
              timeRange: fallbackRange,
              visible: true,
              errors: result.errors,
            };
            addMobilityDataset(dataset, sortedRows);
            setActiveMobilityDataset(dataset.id);
            if (result.errors.length > 0) {
              console.warn('[Mobility Upload] Loaded with warnings:', result.errors);
            }
            console.info('[Mobility Upload] Loaded', result.rows.length, 'points from', file.name);
            addStatusMessage?.(`Loaded mobility dataset (${result.rows.length} points).`, 'info');
            zoomToMobilityDataset(dataset.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[Mobility Upload] Exception:', message);
            addStatusMessage?.(`Mobility upload failed: ${message}`, 'error');
          } finally {
            event.target.value = '';
          }
        }}
      />
    </div>
  );
};

export default LeftIconToolbar;
