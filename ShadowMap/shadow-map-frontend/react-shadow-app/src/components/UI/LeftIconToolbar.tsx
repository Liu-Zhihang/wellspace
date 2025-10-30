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
  BoltIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { useShadowMapStore } from '../../store/shadowMapStore'
import type { MobilityTracePoint } from '../../store/shadowMapStore'
import type { Feature, Geometry } from 'geojson'

type PanelId = 'time' | 'shadow' | 'style' | 'upload' | 'buildings' | 'shadowOps' | null;

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
    isInitialisingShadow,
    autoLoadBuildings,
    setAutoLoadBuildings,
    viewportActions,
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

      if (polygonFeatures.length > 0) {
        const baseOffset = uploadedGeometries.length;
        const createdIds = polygonFeatures.map((feature, index) =>
          createUploadedGeometry(feature, geoJsonFile.name, baseOffset + index)
        );

        if (createdIds[0]) {
          selectGeometry(createdIds[0]);
        }

        clearMobilityTrace();

        addStatusMessage?.(`✅ Uploaded ${polygonFeatures.length} polygon feature(s) for analysis.`, 'info');
        setOpenPanel(null);
      } else {
        const tracePoints = parseMobilityTraceGeoJson(parsed);
        setMobilityTrace(tracePoints);
        addStatusMessage?.(`Mobility trace ready (${tracePoints.length} points)`, 'info');
        setOpenPanel(null);
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
        <div className="w-64 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Date & Time</span>
            <span className="text-xs text-gray-500">{formattedDate}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {presetHours.map((preset) => (
              <Button
                key={preset.hour}
                size="small"
                type="text"
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-gray-700"
                onClick={() => setPresetHour(preset.hour)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Button
              type={isAnimating ? 'default' : 'primary'}
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
            <span className="text-xs text-gray-500">Timeline playback</span>
          </div>
        </div>
      );
    }

    if (panelId === 'shadow') {
      return (
        <div className="w-64 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Shadow Layer</span>
            <Switch
              size="small"
              checked={mapSettings.showShadowLayer}
              onChange={(checked) => updateMapSettings({ showShadowLayer: checked })}
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-gray-500">
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
            <span className="text-xs text-gray-500">Color</span>
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
        <div className="w-64 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Building data</span>
            <span className={`text-xs font-medium ${statusClass}`}>{statusLabel}</span>
          </div>

          <Button
            type="primary"
            icon={<BuildingOfficeIcon className="h-4 w-4" />}
            block
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

          <div className="flex items-center justify-between text-xs text-gray-600">
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

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-gray-500">
            Building footprints are refreshed for the current viewport. Toggle auto-load if you
            prefer manual control while exploring the map.
          </div>
        </div>
      );
    }

    if (panelId === 'shadowOps') {
      const readyClass = shadowSimulatorReady ? 'text-emerald-600' : 'text-gray-500';

      return (
        <div className="w-64 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Shadow simulator</span>
            <span className={`text-xs font-medium ${readyClass}`}>
              {shadowSimulatorReady ? 'Ready' : 'Idle'}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs text-gray-600">
            <span>Sun exposure heatmap</span>
            <Switch
              size="small"
              checked={mapSettings.showSunExposure}
              onChange={(checked) => updateMapSettings({ showSunExposure: checked })}
            />
          </div>

          <Button
            type="primary"
            icon={<BoltIcon className="h-4 w-4" />}
            block
            loading={isInitialisingShadow}
            disabled={!viewportActions.initShadowSimulator || !buildingsLoaded}
            onClick={() =>
              invokeViewportAction(
                buildingsLoaded
                  ? viewportActions.initShadowSimulator
                  : undefined,
                buildingsLoaded
                  ? 'Shadow simulator is not ready yet.'
                  : 'Load buildings before initialising shadows.',
              )
            }
          >
            {shadowSimulatorReady ? 'Recalculate shadows' : 'Initialise shadows'}
          </Button>

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-gray-500">
            Enable the sun exposure layer to populate geometry analytics. Initialisation may take a
            few seconds for dense urban scenes.
          </div>
        </div>
      );
    }

    if (panelId === 'style') {
      return (
        <div className="w-64 space-y-2">
          <span className="text-sm font-semibold text-gray-800">Base Map</span>
          {baseMapPresets.map((preset) => (
            <Button
              key={preset.id}
              block
              className={`text-left normal-case flex items-start justify-between rounded-xl border transition-colors ${
                selectedBaseMap === preset.id
                  ? 'border-blue-400 bg-blue-50 text-blue-700'
                  : 'border-transparent bg-slate-100 text-gray-700 hover:bg-slate-200'
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
      <div className="w-72 space-y-3">
        <div>
          <span className="text-sm font-semibold text-gray-800">Add file to map</span>
          <p className="text-xs text-gray-500">Supported: .tif .tiff .gpx .kml .json .geojson</p>
        </div>
        <Button
          type="primary"
          icon={<ArrowUpTrayIcon className="h-4 w-4" />}
          onClick={handleUploadClick}
          className="w-full"
        >
          Choose files
        </Button>
        <div className="rounded-lg bg-slate-50 p-3 text-[11px] text-gray-500">
          Drag & drop support and on-map placement tools are planned. For now we will auto-align the uploaded layer to the current viewport.
        </div>
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
    { id: 'shadowOps', label: 'Shadow simulator', icon: <SunIcon className="h-5 w-5" /> },
    { id: 'style', label: 'Map style', icon: <GlobeAltIcon className="h-5 w-5" /> },
    { id: 'upload', label: 'Add file to map', icon: <ArrowUpTrayIcon className="h-5 w-5" /> },
  ];

  return (
    <div
      className="fixed z-50 inline-flex flex-col gap-4"
      style={{ left: '1.5rem', bottom: '6rem', width: 'fit-content' }}
    >
      <div className="rounded-2xl border border-white/40 bg-white/95 p-3 shadow-2xl">
        <div className="flex flex-col gap-4">
          {toolbarItems.map((item) => (
            <Popover
              key={item.id}
              trigger="click"
              placement="right"
              overlayClassName="shadow-map-toolbar-popover"
              overlayStyle={{ zIndex: 1400 }}
              open={openPanel === item.id}
              onOpenChange={(open) => handleOpenChange(item.id, open)}
              content={renderPanelContent(item.id)}
            >
              <Tooltip title={item.label} placement="right">
                <button
                  type="button"
                  onClick={() => handleOpenChange(item.id, openPanel !== item.id)}
                  className={`flex h-12 w-12 items-center justify-center rounded-xl border transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white ${
                    openPanel === item.id
                      ? 'border-blue-400 bg-blue-600 text-white shadow-xl focus:ring-blue-300'
                      : 'border-transparent bg-white text-slate-600 shadow-lg hover:bg-slate-100 focus:ring-blue-200'
                  }`}
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
        data-role="trace-upload-input"
        onChange={handleFilesSelected}
      />
    </div>
  );
};

export default LeftIconToolbar;
