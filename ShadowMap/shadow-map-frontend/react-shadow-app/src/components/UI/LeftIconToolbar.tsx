import React, { useMemo, useRef, useState } from 'react'
import { Button, Popover, Slider, Switch, Tooltip } from 'antd'
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
} from '@heroicons/react/24/outline'
import { useShadowMapStore } from '../../store/shadowMapStore'
import type { MobilityTracePoint } from '../../store/shadowMapStore'
import type { Feature, Geometry } from 'geojson'

type PanelId = 'time' | 'shadow' | 'style' | 'upload' | 'buildings' | 'analysis' | null;

const presetHours = [
  { hour: 6, label: 'Sunrise' },
  { hour: 12, label: 'Noon' },
  { hour: 18, label: 'Sunset' },
];

const baseMapPresets = [
  { id: 'osm', name: 'OpenStreetMap', description: 'Balanced street map', badge: 'Default' },
  { id: 'satellite', name: 'Satellite', description: 'High-resolution imagery' },
  { id: 'terrain', name: 'Terrain', description: 'Topographic relief' },
  { id: 'dark', name: 'Dark Mode', description: 'Low-light friendly' },
];

export const LeftIconToolbar: React.FC = () => {
  const {
    currentDate,
    setCurrentDate,
    isAnimating,
    setIsAnimating,
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
  } = useShadowMapStore();

  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [selectedBaseMap, setSelectedBaseMap] = useState<string>('osm');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const handleBaseMapChange = (mapId: string) => {
    setSelectedBaseMap(mapId);
    // TODO: Wire into map instance once baseMapManager is exposed here.
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
              {preset.badge && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-600">{preset.badge}</span>
              )}
            </Button>
          ))}
          <span className="text-[11px] text-gray-400">Coming soon: direct Mapbox / custom style URL.</span>
        </div>
      );
    }

    return (
      <div className="w-full space-y-4 p-4 text-slate-700">
        <div>
          <span className="text-sm font-semibold text-slate-900">Add file to map</span>
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
          Drag & drop support and on-map placement tools are coming soon. For now, uploaded layers align to the current viewport.
        </p>
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
    { id: 'upload', label: 'Add file to map', icon: <ArrowUpTrayIcon className="h-5 w-5" /> },
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
              overlayInnerStyle={{ width: 320, padding: 0 }}
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
    </div>
  );
};

export default LeftIconToolbar;
