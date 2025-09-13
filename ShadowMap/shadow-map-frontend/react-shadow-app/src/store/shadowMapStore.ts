import { create } from 'zustand';
import type { MapSettings, ShadowAnalysisResult, SunPosition, ShadowSettings, DataLayer, DataLayerType } from '../types';

interface ShadowMapState {
  // 当前日期时间
  currentDate: Date;
  setCurrentDate: (date: Date) => void;
  
  // 地图设置
  mapSettings: MapSettings;
  updateMapSettings: (settings: Partial<MapSettings>) => void;
  
  // 阴影设置
  shadowSettings: ShadowSettings;
  updateShadowSettings: (settings: Partial<ShadowSettings>) => void;
  
  // 太阳位置信息
  sunPosition: SunPosition;
  setSunPosition: (position: SunPosition) => void;
  
  // 阴影分析结果
  analysisResult: ShadowAnalysisResult | null;
  setAnalysisResult: (result: ShadowAnalysisResult | null) => void;
  
  // 统一的分析结果（兼容性）
  analysisResults: {
    sunPosition?: SunPosition;
    shadowArea?: number;
    analysisResult?: ShadowAnalysisResult | null;
  };
  setAnalysisResults: (results: Partial<ShadowMapState['analysisResults']>) => void;
  
  // 分析半径
  analysisRadius: number;
  setAnalysisRadius: (radius: number) => void;
  
  // 时间动画状态
  isAnimating: boolean;
  setIsAnimating: (animating: boolean) => void;
  
  // 地图中心和缩放
  mapCenter: [number, number];
  mapZoom: number;
  setMapView: (center: [number, number], zoom: number) => void;
  
  // 状态消息
  statusMessages: Array<{ id: string; message: string; type: 'info' | 'warning' | 'error'; timestamp: Date }>;
  addStatusMessage: (message: string, type?: 'info' | 'warning' | 'error') => void;
  removeStatusMessage: (id: string) => void;
  clearStatusMessages: () => void;
  
  // 数据层管理方法
  toggleDataLayer: (layerId: DataLayerType) => void;
  updateDataLayer: (layerId: DataLayerType, updates: Partial<DataLayer>) => void;
  setActiveDataLayer: (layerId: DataLayerType) => void;
  getEnabledLayers: () => DataLayer[];
}

export const useShadowMapStore = create<ShadowMapState>((set, get) => ({
  currentDate: new Date(),
  setCurrentDate: (date: Date) => set({ currentDate: date }),
  
  mapSettings: {
    // 传统设置（保持兼容性）
    shadowColor: '#01112f',
    shadowOpacity: 0.7,
    showShadowLayer: true,
    showBuildingLayer: true,
    showDEMLayer: false,
    showCacheStats: false,
    showSunExposure: false,
    
    // 新的数据层系统
    dataLayers: {
      shadows: {
        id: 'shadows',
        name: '实时阴影',
        description: '当前时刻的阴影覆盖情况',
        icon: '🌑',
        enabled: true, // 与showShadowLayer同步
        opacity: 0.7,
        color: '#01112f',
        renderMode: 'overlay'
      },
      sunlight_hours: {
        id: 'sunlight_hours',
        name: '日照时长',
        description: '一天内各区域的日照时长分析',
        icon: '☀️',
        enabled: false,
        opacity: 0.6,
        renderMode: 'heatmap'
      },
      annual_sunlight: {
        id: 'annual_sunlight',
        name: '年度日照',
        description: '全年日照强度和分布统计',
        icon: '🌞',
        enabled: false,
        opacity: 0.5,
        renderMode: 'heatmap'
      },
      buildings: {
        id: 'buildings',
        name: '建筑物',
        description: '建筑物轮廓和高度信息',
        icon: '🏢',
        enabled: true,
        opacity: 0.8,
        color: '#ff6b6b',
        renderMode: 'vector'
      },
      terrain: {
        id: 'terrain',
        name: '地形',
        description: '数字高程模型（DEM）',
        icon: '🗻',
        enabled: false,
        opacity: 0.5,
        renderMode: 'overlay'
      }
    } as { [K in DataLayerType]: DataLayer },
    
    activeDataLayer: 'shadows' as DataLayerType,
  },
  updateMapSettings: (settings: Partial<MapSettings>) => 
    set(state => {
      const newMapSettings = { ...state.mapSettings, ...settings };
      
      // 同步数据层状态
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
    showSunExposure: false, // 控制太阳曝光热力图显示
  },
  updateShadowSettings: (settings: Partial<ShadowSettings>) =>
    set(state => ({ shadowSettings: { ...state.shadowSettings, ...settings } })),
  
  sunPosition: { altitude: 0, azimuth: 0 },
  setSunPosition: (position: SunPosition) => {
    set({ sunPosition: position });
    // 同时更新 analysisResults 中的 sunPosition
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
  
  analysisRadius: 500,
  setAnalysisRadius: (radius: number) => set({ analysisRadius: radius }),
  
  isAnimating: false,
  setIsAnimating: (animating: boolean) => set({ isAnimating: animating }),
  
  mapCenter: [39.9042, 116.4074], // 北京
  mapZoom: 15,
  setMapView: (center: [number, number], zoom: number) => set({ mapCenter: center, mapZoom: zoom }),
  
  statusMessages: [],
  addStatusMessage: (message: string, type: 'info' | 'warning' | 'error' = 'info') => {
    const id = Date.now().toString();
    set(state => ({
      statusMessages: [
        { id, message, type, timestamp: new Date() },
        ...state.statusMessages.slice(0, 4) // 只保留最新的5条消息
      ]
    }));
  },
  removeStatusMessage: (id: string) => 
    set(state => ({ statusMessages: state.statusMessages.filter(msg => msg.id !== id) })),
  clearStatusMessages: () => set({ statusMessages: [] }),
  
  // 数据层管理方法实现
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
      
      // 同步到传统设置
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
  
  getEnabledLayers: () => {
    const state = get();
    return Object.values(state.mapSettings.dataLayers).filter(layer => layer.enabled);
  },
}));
