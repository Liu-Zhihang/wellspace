import { create } from 'zustand';
import type { MapSettings, ShadowAnalysisResult, SunPosition, ShadowSettings } from '../types';

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
}

export const useShadowMapStore = create<ShadowMapState>((set, get) => ({
  currentDate: new Date(),
  setCurrentDate: (date: Date) => set({ currentDate: date }),
  
  mapSettings: {
    shadowColor: '#01112f',
    shadowOpacity: 0.7,
    showShadowLayer: true,
    showBuildingLayer: true,
    showDEMLayer: false,
    showCacheStats: false,
  },
  updateMapSettings: (settings: Partial<MapSettings>) => 
    set(state => ({ mapSettings: { ...state.mapSettings, ...settings } })),
  
  shadowSettings: {
    shadowResolution: 200,
    shadowOpacity: 0.7,
    buildingHeightMultiplier: 1.0,
    enableSunPath: true,
    shadowColor: '#01112f',
    shadowBlur: 2,
    enableShadowAnimation: false,
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
}));
