import { create } from 'zustand';
import type {
  MapSettings,
  ShadowAnalysisResult,
  SunPosition,
  ShadowSettings,
  DataLayer,
  DataLayerType,
  WeatherSnapshot,
  UploadedGeometry,
  GeometryAnalysis,
  ShadowServiceStatus,
  ShadowServiceResponse,
  MobilityDataset,
  MobilityCsvRecord,
  MobilitySunlightSample,
  MobilitySunlightProgress,
  BoundingBox,
} from '../types/index.ts';
import { computeMobilitySunlightForRows } from '../services/mobilitySunlightService';

type ViewportAction = (() => void) | (() => Promise<void>);

interface ViewportActions {
  loadBuildings?: ViewportAction;
  initShadowSimulator?: ViewportAction;
  clearBuildings?: () => void;
  fitToBounds?: (bounds: BoundingBox, options?: { padding?: number; maxZoom?: number }) => void;
}

export interface MobilityTracePoint {
  coordinates: [number, number];
  time: Date;
  timestampLabel: string;
}

interface ShadowMapState {
  // Current date-time state
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  
  // Mobility playback (independent from shadow timeline)
  mobilityPlaybackTime: Date | null;
  setMobilityPlaybackTime: (date: Date | null) => void;
  isMobilityPlaying: boolean;
  setMobilityPlaying: (playing: boolean) => void;
  
  // Map settings
  mapSettings: MapSettings;
  updateMapSettings: (settings: Partial<MapSettings>) => void;
  
  // Shadow settings
  shadowSettings: ShadowSettings;
  updateShadowSettings: (settings: Partial<ShadowSettings>) => void;
  
  // Sun position
  sunPosition: SunPosition;
  setSunPosition: (position: SunPosition) => void;
  
  // Legacy shadow analysis result
  analysisResult: ShadowAnalysisResult | null;
  setAnalysisResult: (result: ShadowAnalysisResult | null) => void;
  
  // Consolidated analysis results (legacy compatibility)
  analysisResults: {
    sunPosition?: SunPosition;
    shadowArea?: number;
    analysisResult?: ShadowAnalysisResult | null;
  };
  setAnalysisResults: (results: Partial<ShadowMapState['analysisResults']>) => void;
  shadowServiceStatus: ShadowServiceStatus;
  shadowServiceResult: ShadowServiceResponse | null;
  shadowServiceError: string | null;
  setShadowServiceStatus: (status: ShadowServiceStatus) => void;
  setShadowServiceResult: (result: ShadowServiceResponse | null) => void;
  setShadowServiceError: (error: string | null) => void;
  
  // Analysis radius
  analysisRadius: number;
  setAnalysisRadius: (radius: number) => void;
  
  // Time animation state
  isAnimating: boolean;
  setIsAnimating: (animating: boolean) => void;
  
  // Map view state
  mapCenter: [number, number];
  mapZoom: number;
  setMapView: (center: [number, number], zoom: number) => void;
  
  // Status messages
  statusMessages: Array<{ id: string; message: string; type: 'info' | 'warning' | 'error'; timestamp: Date }>;
  addStatusMessage: (message: string, type?: 'info' | 'warning' | 'error') => void;
  removeStatusMessage: (id: string) => void;
  clearStatusMessages: () => void;

  // Mobility datasets (CSV-driven traces)
  mobilityDatasets: MobilityDataset[];
  mobilityTraces: Record<string, MobilityCsvRecord[]>;
  addMobilityDataset: (dataset: MobilityDataset, rows: MobilityCsvRecord[]) => void;
  removeMobilityDataset: (datasetId: string) => void;
  setMobilityDatasetVisibility: (datasetId: string, visible: boolean) => void;
  clearMobilityDatasets: () => void;
  activeMobilityDatasetId: string | null;
  setActiveMobilityDataset: (datasetId: string | null) => void;
  mobilitySunlight: Record<string, MobilitySunlightSample[]>;
  mobilitySunlightProgress: Record<string, MobilitySunlightProgress>;
  mobilitySunlightStatus: Record<string, 'idle' | 'loading' | 'success' | 'error'>;
  mobilitySunlightError: Record<string, string | null>;
  computeMobilitySunlight: (datasetId: string) => Promise<void>;
  clearMobilitySunlight: (datasetId?: string) => void;
  exportMobilitySunlight: (datasetId: string, format: 'csv' | 'json') => void;

  // Uploaded geometries & analysis
  uploadedGeometries: UploadedGeometry[];
  addUploadedGeometry: (geometry: UploadedGeometry) => void;
  removeUploadedGeometry: (geometryId: string) => void;
  clearUploadedGeometries: () => void;
  selectedGeometryId: string | null;
  selectGeometry: (geometryId: string | null) => void;
  geometryAnalyses: Record<string, GeometryAnalysis>;
  setGeometryAnalysis: (analysis: GeometryAnalysis) => void;
  clearGeometryAnalyses: (geometryId?: string) => void;
  exportGeometryAnalysis: (geometryId: string, format: 'json' | 'csv') => void;

  // Mobility trace
  mobilityTrace: MobilityTracePoint[];
  currentTraceIndex: number;
  isTracePlaying: boolean;
  setMobilityTrace: (points: MobilityTracePoint[]) => void;
  clearMobilityTrace: () => void;
  setCurrentTraceIndex: (index: number) => void;
  setTracePlaying: (playing: boolean) => void;
  advanceTraceIndex: () => void;
  
  // Data layer helpers
  toggleDataLayer: (layerId: DataLayerType) => void;
  updateDataLayer: (layerId: DataLayerType, updates: Partial<DataLayer>) => void;
  setActiveDataLayer: (layerId: DataLayerType) => void;
  getEnabledLayers: () => DataLayer[];

  // Weather snapshot
  currentWeather: WeatherSnapshot;
  setCurrentWeather: (snapshot: Partial<WeatherSnapshot>) => void;

  buildingsLoaded: boolean;
  setBuildingsLoaded: (loaded: boolean) => void;
  isLoadingBuildings: boolean;
  setIsLoadingBuildings: (loading: boolean) => void;
  shadowSimulatorReady: boolean;
  setShadowSimulatorReady: (ready: boolean) => void;
  isInitialisingShadow: boolean;
  setIsInitialisingShadow: (loading: boolean) => void;
  autoLoadBuildings: boolean;
  setAutoLoadBuildings: (enabled: boolean) => void;
  viewportActions: ViewportActions;
  setViewportActions: (actions: Partial<ViewportActions>) => void;
}

export const useShadowMapStore = create<ShadowMapState>((set, get) => ({
  currentDate: new Date(), // Default to now; avoids stale weather lookups
  setCurrentDate: (date: Date) => {
    // ✅ Validate date to prevent invalid values
    if (!date || isNaN(date.getTime())) {
      console.error('❌ Invalid date provided to setCurrentDate:', date);
      return;
    }
    console.log('⏰ Setting current date:', date);
    set({ currentDate: new Date(date) });
  },

  mobilityPlaybackTime: null,
  setMobilityPlaybackTime: (date: Date | null) => {
    if (date && isNaN(date.getTime())) {
      console.error('❌ Invalid date provided to setMobilityPlaybackTime:', date);
      return;
    }
    set({ mobilityPlaybackTime: date ? new Date(date) : null });
  },
  isMobilityPlaying: false,
  setMobilityPlaying: (playing: boolean) => set({ isMobilityPlaying: playing }),
  
  mapSettings: {
    // Legacy settings (for compatibility)
    shadowColor: '#01112f',
    shadowOpacity: 0.7,
    showShadowLayer: true,
    showBuildingLayer: true,
    showDEMLayer: false,
    showCacheStats: false,
    showSunExposure: false,
    // Building filter controls
    enableBuildingFilter: false, // Disabled by default; show all buildings
    // Dynamic quality controls
    enableDynamicQuality: true, // Enable adaptive quality by default
    autoOptimize: false,
    
    // Data layer registry
    dataLayers: {
      shadows: {
        id: 'shadows',
        name: 'Live Shadows',
        description: 'Real-time shadow overlay for the current timestamp',
        icon: '🌑',
        enabled: true, // Mirrors showShadowLayer flag
        opacity: 0.7,
        color: '#01112f',
        renderMode: 'overlay'
      },
      sunlight_hours: {
        id: 'sunlight_hours',
        name: 'Sunlight Hours',
        description: 'Displays sampled sunlight duration heatmap',
        icon: '☀️',
        enabled: false,
        opacity: 0.6,
        renderMode: 'heatmap'
      },
      annual_sunlight: {
        id: 'annual_sunlight',
        name: 'Annual Sunlight',
        description: 'Annual sunlight distribution summary',
        icon: '🌞',
        enabled: false,
        opacity: 0.5,
        renderMode: 'heatmap'
      },
      buildings: {
        id: 'buildings',
        name: 'Buildings',
        description: 'Building footprints and height attributes',
        icon: '🏢',
        enabled: true,
        opacity: 0.8,
        color: '#ff6b6b',
        renderMode: 'vector'
      },
      terrain: {
        id: 'terrain',
        name: 'Terrain',
        description: 'Digital elevation model (DEM)',
        icon: '🗻',
        enabled: false,
        opacity: 0.5,
        renderMode: 'overlay'
      }
    } as { [K in DataLayerType]: DataLayer },
    
    activeDataLayer: 'shadows' as DataLayerType,
    baseMapId: 'mapbox-streets',
  },
  updateMapSettings: (settings: Partial<MapSettings>) => 
    set(state => {
      const newMapSettings = { ...state.mapSettings, ...settings };
      
      // Sync derived layer flags
      if (settings.showShadowLayer !== undefined) {
        newMapSettings.dataLayers.shadows.enabled = settings.showShadowLayer;
      }
      if (settings.showSunExposure !== undefined) {
        newMapSettings.dataLayers.sunlight_hours.enabled = settings.showSunExposure;
      }
      if (settings.showBuildingLayer !== undefined) {
        newMapSettings.dataLayers.buildings.enabled = settings.showBuildingLayer;
      }
      if (settings.showDEMLayer !== undefined) {
        newMapSettings.dataLayers.terrain.enabled = settings.showDEMLayer;
      }
      
      return { mapSettings: newMapSettings };
    }),
  
  shadowSettings: {
    shadowResolution: 200,
    shadowOpacity: 0.7,
    buildingHeightMultiplier: 1.0,
    enableSunPath: true,
    shadowColor: '#01112f',
    shadowBlur: 2,
    enableShadowAnimation: false,
    showSunExposure: false,
    autoCloudAttenuation: true,
    manualSunlightFactor: 1,
  },
  updateShadowSettings: (settings: Partial<ShadowSettings>) =>
    set(state => ({ shadowSettings: { ...state.shadowSettings, ...settings } })),
  
  sunPosition: { altitude: 0, azimuth: 0 },
  setSunPosition: (position: SunPosition) => {
    set({ sunPosition: position });
    // Keep consolidated analysis sun position in sync
    const current = get();
    set({ 
      analysisResults: { 
        ...current.analysisResults, 
        sunPosition: position 
      } 
    });
  },
  
  analysisResult: null,
  setAnalysisResult: (result: ShadowAnalysisResult | null) => set({ analysisResult: result }),
  
  analysisResults: {},
  setAnalysisResults: (results: Partial<ShadowMapState['analysisResults']>) =>
    set(state => ({ analysisResults: { ...state.analysisResults, ...results } })),
  shadowServiceStatus: 'idle',
  shadowServiceResult: null,
  shadowServiceError: null,
  setShadowServiceStatus: (status) => set({ shadowServiceStatus: status }),
  setShadowServiceResult: (result) => set({ shadowServiceResult: result }),
  setShadowServiceError: (error) => set({ shadowServiceError: error ?? null }),
  
  analysisRadius: 500,
  setAnalysisRadius: (radius: number) => set({ analysisRadius: radius }),
  
  isAnimating: false,
  setIsAnimating: (animating: boolean) => set({ isAnimating: animating }),
  
  mapCenter: [114.1694, 22.3193], // Hong Kong default (lng, lat)
  mapZoom: 16,
  setMapView: (center: [number, number], zoom: number) => set({ mapCenter: center, mapZoom: zoom }),

  mobilityTrace: [],
  currentTraceIndex: 0,
  isTracePlaying: false,
  setMobilityTrace: (points: MobilityTracePoint[]) => {
    set({
      mobilityTrace: points,
      currentTraceIndex: 0,
      isTracePlaying: points.length > 1,
    });
    if (points.length > 0) {
      const firstTimestamp = points[0].timestampLabel;
      get().addStatusMessage?.(
        `Loaded mobility trace with ${points.length} waypoints (start ${firstTimestamp})`,
        'info',
      );
    }
  },
  clearMobilityTrace: () => set({ mobilityTrace: [], currentTraceIndex: 0, isTracePlaying: false }),
  setCurrentTraceIndex: (index: number) => set({ currentTraceIndex: index }),
  setTracePlaying: (playing: boolean) => set({ isTracePlaying: playing }),
  advanceTraceIndex: () => {
    const state = get();
    if (!state.mobilityTrace.length) return;
    const nextIndex = (state.currentTraceIndex + 1) % state.mobilityTrace.length;
    set({ currentTraceIndex: nextIndex });
  },
  
  statusMessages: [],
  addStatusMessage: (message: string, type: 'info' | 'warning' | 'error' = 'info') => {
    const id = Date.now().toString();
    set(state => ({
      statusMessages: [
        { id, message, type, timestamp: new Date() },
        ...state.statusMessages.slice(0, 4) // Keep newest five entries
      ]
    }));
  },
  removeStatusMessage: (id: string) => 
    set(state => ({ statusMessages: state.statusMessages.filter(msg => msg.id !== id) })),
  clearStatusMessages: () => set({ statusMessages: [] }),

  mobilityDatasets: [],
  mobilityTraces: {},
  mobilitySunlight: {},
  mobilitySunlightProgress: {},
  mobilitySunlightStatus: {},
  mobilitySunlightError: {},
  addMobilityDataset: (dataset, rows) =>
    set(state => ({
      mobilityDatasets: [...state.mobilityDatasets, dataset],
      mobilityTraces: { ...state.mobilityTraces, [dataset.id]: rows },
    })),
  removeMobilityDataset: (datasetId) =>
    set(state => {
      const { [datasetId]: _removed, ...rest } = state.mobilityTraces;
      const remainingDatasets = state.mobilityDatasets.filter(dataset => dataset.id !== datasetId);
      const removedWasActive = state.activeMobilityDatasetId === datasetId;
      const nextDatasetId = removedWasActive ? (remainingDatasets[0]?.id ?? null) : state.activeMobilityDatasetId;
      const nextDataset = remainingDatasets.find(dataset => dataset.id === nextDatasetId) ?? null;
      return {
        mobilityDatasets: remainingDatasets,
        mobilityTraces: rest,
        mobilitySunlight: Object.fromEntries(
          Object.entries(state.mobilitySunlight).filter(([key]) => key !== datasetId),
        ),
        mobilitySunlightProgress: Object.fromEntries(
          Object.entries(state.mobilitySunlightProgress).filter(([key]) => key !== datasetId),
        ),
        mobilitySunlightStatus: Object.fromEntries(
          Object.entries(state.mobilitySunlightStatus).filter(([key]) => key !== datasetId),
        ),
        mobilitySunlightError: Object.fromEntries(
          Object.entries(state.mobilitySunlightError).filter(([key]) => key !== datasetId),
        ),
        activeMobilityDatasetId: nextDatasetId,
        mobilityPlaybackTime: removedWasActive
          ? nextDataset
            ? new Date(nextDataset.timeRange.start)
            : null
          : state.mobilityPlaybackTime,
        isMobilityPlaying: removedWasActive ? false : state.isMobilityPlaying,
      };
    }),
  setMobilityDatasetVisibility: (datasetId, visible) =>
    set(state => ({
      mobilityDatasets: state.mobilityDatasets.map(dataset =>
        dataset.id === datasetId ? { ...dataset, visible } : dataset
      ),
    })),
  clearMobilityDatasets: () =>
    set({
      mobilityDatasets: [],
      mobilityTraces: {},
      mobilitySunlight: {},
      mobilitySunlightProgress: {},
      mobilitySunlightStatus: {},
      mobilitySunlightError: {},
      activeMobilityDatasetId: null,
      mobilityPlaybackTime: null,
      isMobilityPlaying: false,
    }),
  activeMobilityDatasetId: null,
  setActiveMobilityDataset: (datasetId: string | null) =>
    set(state => {
      if (!datasetId) {
        return { activeMobilityDatasetId: null, mobilityPlaybackTime: null, isMobilityPlaying: false };
      }
      if (state.activeMobilityDatasetId === datasetId) {
        return {};
      }
      const nextDataset = state.mobilityDatasets.find(dataset => dataset.id === datasetId) ?? null;
      return {
        activeMobilityDatasetId: datasetId,
        mobilityPlaybackTime: nextDataset ? new Date(nextDataset.timeRange.start) : null,
        isMobilityPlaying: false,
      };
    }),

  computeMobilitySunlight: async (datasetId: string) => {
    const state = get();
    const rows = state.mobilityTraces[datasetId];
    if (!rows || !rows.length) {
      state.addStatusMessage?.('No mobility points available for sunlight analysis.', 'warning');
      return;
    }

    set(current => ({
      mobilitySunlightStatus: { ...current.mobilitySunlightStatus, [datasetId]: 'loading' },
      mobilitySunlightProgress: { ...current.mobilitySunlightProgress, [datasetId]: { completed: 0, total: 0 } },
      mobilitySunlightError: { ...current.mobilitySunlightError, [datasetId]: null },
    }));

    try {
      let lastProgress: MobilitySunlightProgress | null = null;
      const samples = await computeMobilitySunlightForRows(rows, {
        onProgress: (progress) => {
          lastProgress = progress;
          set(current => ({
            mobilitySunlightProgress: { ...current.mobilitySunlightProgress, [datasetId]: progress },
          }));
        },
      });
      const finalProgress: MobilitySunlightProgress = lastProgress
        ? { completed: lastProgress.total, total: lastProgress.total }
        : { completed: samples.length, total: samples.length || 1 };
      set(current => ({
        mobilitySunlight: { ...current.mobilitySunlight, [datasetId]: samples },
        mobilitySunlightProgress: { ...current.mobilitySunlightProgress, [datasetId]: finalProgress },
        mobilitySunlightStatus: { ...current.mobilitySunlightStatus, [datasetId]: 'success' },
      }));
      state.addStatusMessage?.(`Sunlight states ready (${samples.length} points).`, 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set(current => ({
        mobilitySunlightStatus: { ...current.mobilitySunlightStatus, [datasetId]: 'error' },
        mobilitySunlightError: { ...current.mobilitySunlightError, [datasetId]: message },
      }));
      state.addStatusMessage?.(`Sunlight computation failed: ${message}`, 'error');
    }
  },

  clearMobilitySunlight: (datasetId?: string) => {
    if (!datasetId) {
      set({ mobilitySunlight: {}, mobilitySunlightProgress: {}, mobilitySunlightStatus: {}, mobilitySunlightError: {} });
      return;
    }
    set(state => {
      const { [datasetId]: _removed, ...restSunlight } = state.mobilitySunlight;
      const { [datasetId]: _progressRemoved, ...restProgress } = state.mobilitySunlightProgress;
      const { [datasetId]: _statusRemoved, ...restStatus } = state.mobilitySunlightStatus;
      const { [datasetId]: _errorRemoved, ...restError } = state.mobilitySunlightError;
      return {
        mobilitySunlight: restSunlight,
        mobilitySunlightProgress: restProgress,
        mobilitySunlightStatus: restStatus,
        mobilitySunlightError: restError,
      };
    });
  },

  exportMobilitySunlight: (datasetId: string, format: 'csv' | 'json' = 'csv') => {
    const state = get();
    const samples = state.mobilitySunlight[datasetId];
    if (!samples || !samples.length) {
      state.addStatusMessage?.('⚠️ No sunlight samples to export.', 'warning');
      return;
    }

    if (typeof window === 'undefined') return;

    const dataset = state.mobilityDatasets.find(item => item.id === datasetId) ?? null;
    const filenameBase = (dataset?.name || 'mobility').replace(/\s+/g, '_').toLowerCase();

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(samples, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filenameBase}-sunlight.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      state.addStatusMessage?.('📄 Exported sunlight samples (JSON).', 'info');
      return;
    }

    const header = 'traceId,time,lng,lat,sunlit,shadowPercent,bucketStart,bucketEnd\n';
    const rows = samples
      .map(sample => (
        [
          sample.traceId,
          sample.timestamp.toISOString(),
          sample.coordinates[0],
          sample.coordinates[1],
          sample.sunlit,
          sample.shadowPercent,
          sample.bucketStart,
          sample.bucketEnd,
        ].join(',')
      ))
      .join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filenameBase}-sunlight.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    state.addStatusMessage?.('📄 Exported sunlight samples (CSV).', 'info');
  },

  uploadedGeometries: [],
  addUploadedGeometry: (geometry: UploadedGeometry) => {
    const prevState = get();
    set({
      uploadedGeometries: [...prevState.uploadedGeometries, geometry],
      selectedGeometryId: geometry.id,
    });

    get().addStatusMessage?.(`Uploaded geometry "${geometry.name}"`, 'info');
  },
  removeUploadedGeometry: (geometryId: string) => {
    set(state => {
      const remaining = state.uploadedGeometries.filter(item => item.id !== geometryId);
      const { [geometryId]: _removed, ...restAnalyses } = state.geometryAnalyses;
      const nextSelected = state.selectedGeometryId === geometryId ? (remaining[0]?.id ?? null) : state.selectedGeometryId;
      return {
        uploadedGeometries: remaining,
        selectedGeometryId: nextSelected,
        geometryAnalyses: restAnalyses,
      };
    });
  },
  clearUploadedGeometries: () => {
    set({ uploadedGeometries: [], selectedGeometryId: null, geometryAnalyses: {} });
  },
  selectedGeometryId: null,
  selectGeometry: (geometryId: string | null) => {
    set({ selectedGeometryId: geometryId });
  },
  geometryAnalyses: {},
  setGeometryAnalysis: (analysis: GeometryAnalysis) => {
    set(state => ({
      geometryAnalyses: {
        ...state.geometryAnalyses,
        [analysis.geometryId]: analysis,
      },
    }));
  },
  clearGeometryAnalyses: (geometryId?: string) => {
    if (!geometryId) {
      set({ geometryAnalyses: {} });
      return;
    }
    set(state => {
      const { [geometryId]: _removed, ...rest } = state.geometryAnalyses;
      return { geometryAnalyses: rest };
    });
  },
  exportGeometryAnalysis: (geometryId: string, format: 'json' | 'csv') => {
    const state = get();
    const analysis = state.geometryAnalyses[geometryId];
    const geometry = state.uploadedGeometries.find(item => item.id === geometryId);

    if (!analysis || !geometry) {
      state.addStatusMessage?.('⚠️ No analysis data available for export.', 'warning');
      return;
    }

    if (typeof window === 'undefined') {
      return;
    }

    const filenameBase = (geometry.name || 'geometry').replace(/\s+/g, '_').toLowerCase();

    if (format === 'json') {
      const payload = {
        geometry: geometry.feature,
        stats: analysis.stats,
        samples: analysis.samples ?? [],
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${filenameBase}-analysis.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      state.addStatusMessage?.('📄 Exported analysis as JSON.', 'info');
      return;
    }

    const samples = analysis.samples ?? [];
    if (!samples.length) {
      state.addStatusMessage?.('⚠️ No sample data available for CSV export.', 'warning');
      return;
    }

    const header = 'lat,lng,shadowPercent,hoursOfSun\n';
    const rows = samples
      .map(sample => `${sample.lat},${sample.lng},${sample.shadowPercent},${sample.hoursOfSun}`)
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filenameBase}-analysis.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    state.addStatusMessage?.('📄 Exported analysis as CSV.', 'info');
  },
  
  // Data layer helper implementation (derived state)
  toggleDataLayer: (layerId: DataLayerType) => {
    set(state => {
      const newEnabled = !state.mapSettings.dataLayers[layerId].enabled;
      const newMapSettings = {
        ...state.mapSettings,
        dataLayers: {
          ...state.mapSettings.dataLayers,
          [layerId]: {
            ...state.mapSettings.dataLayers[layerId],
            enabled: newEnabled
          }
        }
      };
      
      // Sync to legacy flags
      if (layerId === 'shadows') {
        newMapSettings.showShadowLayer = newEnabled;
      } else if (layerId === 'sunlight_hours') {
        newMapSettings.showSunExposure = newEnabled;
      } else if (layerId === 'buildings') {
        newMapSettings.showBuildingLayer = newEnabled;
      } else if (layerId === 'terrain') {
        newMapSettings.showDEMLayer = newEnabled;
      }
      
      return { mapSettings: newMapSettings };
    });
  },
  
  updateDataLayer: (layerId: DataLayerType, updates: Partial<DataLayer>) => {
    set(state => ({
      mapSettings: {
        ...state.mapSettings,
        dataLayers: {
          ...state.mapSettings.dataLayers,
          [layerId]: {
            ...state.mapSettings.dataLayers[layerId],
            ...updates
          }
        }
      }
    }));
  },
  
  setActiveDataLayer: (layerId: DataLayerType) => {
    set(state => ({
      mapSettings: {
        ...state.mapSettings,
        activeDataLayer: layerId
      }
    }));
  },

  buildingsLoaded: false,
  setBuildingsLoaded: (loaded: boolean) => set({ buildingsLoaded: loaded }),
  isLoadingBuildings: false,
  setIsLoadingBuildings: (loading: boolean) => set({ isLoadingBuildings: loading }),
  shadowSimulatorReady: false,
  setShadowSimulatorReady: (ready: boolean) => set({ shadowSimulatorReady: ready }),
  isInitialisingShadow: false,
  setIsInitialisingShadow: (loading: boolean) => set({ isInitialisingShadow: loading }),
  autoLoadBuildings: true,
  setAutoLoadBuildings: (enabled: boolean) => set({ autoLoadBuildings: enabled }),
  viewportActions: {},
  setViewportActions: (actions: Partial<ViewportActions>) =>
    set(state => ({ viewportActions: { ...state.viewportActions, ...actions } })),

  currentWeather: {
    cloudCover: null,
    sunlightFactor: 1,
    fetchedAt: null,
    source: undefined,
    raw: null
  },
  setCurrentWeather: (snapshot: Partial<WeatherSnapshot>) => {
    set(state => ({
      currentWeather: {
        ...state.currentWeather,
        ...snapshot
      }
    }));
  },
  
  getEnabledLayers: () => {
    const state = get();
    return Object.values(state.mapSettings.dataLayers).filter(layer => layer.enabled);
  },
}));
