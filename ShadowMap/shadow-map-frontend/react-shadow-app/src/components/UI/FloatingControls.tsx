import React, { useState } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const FloatingControls: React.FC = () => {
  const {
    mapSettings,
    updateMapSettings,
    updateDataLayer,
  } = useShadowMapStore();

  const [expandedLayer, setExpandedLayer] = useState<string | null>(null);

  // Data layer configuration
  const dataLayers = [
    {
      id: 'shadows',
      name: 'Shadows',
      icon: '🌑',
      color: '#1a1a2e',
      enabled: mapSettings.showShadowLayer,
      opacity: mapSettings.shadowOpacity,
      description: 'Real-time shadow coverage'
    },
    {
      id: 'sunlight_hours',
      name: 'Hours in the sun',
      icon: '☀️',
      color: '#ffeb3b',
      enabled: mapSettings.showSunExposure,
      opacity: mapSettings.dataLayers.sunlight_hours.opacity,
      description: 'Daily sunlight duration analysis'
    },
    {
      id: 'annual_sunlight',
      name: 'Annual sunlight',
      icon: '🌞',
      color: '#ff9800',
      enabled: mapSettings.dataLayers.annual_sunlight.enabled,
      opacity: mapSettings.dataLayers.annual_sunlight.opacity,
      description: 'Yearly solar radiation statistics'
    },
    {
      id: 'buildings',
      name: 'Buildings',
      icon: '🏢',
      color: '#2196f3',
      enabled: mapSettings.showBuildingLayer,
      opacity: mapSettings.dataLayers.buildings.opacity,
      description: '3D building geometries'
    },
    {
      id: 'terrain',
      name: 'Terrain',
      icon: '🗻',
      color: '#4caf50',
      enabled: mapSettings.showDEMLayer,
      opacity: mapSettings.dataLayers.terrain.opacity,
      description: 'Digital elevation model'
    }
  ];

  const toggleLayer = (layerId: string) => {
    switch (layerId) {
      case 'shadows':
        updateMapSettings({ showShadowLayer: !mapSettings.showShadowLayer });
        break;
      case 'sunlight_hours':
        updateMapSettings({ showSunExposure: !mapSettings.showSunExposure });
        break;
      case 'buildings':
        updateMapSettings({ showBuildingLayer: !mapSettings.showBuildingLayer });
        break;
      case 'terrain':
        updateMapSettings({ showDEMLayer: !mapSettings.showDEMLayer });
        break;
      default:
        updateDataLayer(layerId as any, { enabled: !mapSettings.dataLayers[layerId as keyof typeof mapSettings.dataLayers]?.enabled });
    }
  };

  const updateOpacity = (layerId: string, opacity: number) => {
    switch (layerId) {
      case 'shadows':
        updateMapSettings({ shadowOpacity: opacity });
        break;
      case 'sunlight_hours':
        updateDataLayer('sunlight_hours', { opacity });
        break;
      case 'buildings':
        updateDataLayer('buildings', { opacity });
        break;
      case 'terrain':
        updateDataLayer('terrain', { opacity });
        break;
      default:
        updateDataLayer(layerId as any, { opacity });
    }
  };

  return (
    <div className="fixed right-4 top-20 z-50 floating-controls max-h-[calc(100vh-200px)] overflow-y-auto">
      {/* Data layer control panel - Windows optimized */}
      <div className="bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200/50 p-3 space-y-2 min-w-[220px]">
        <div className="text-sm font-semibold text-gray-700 px-1 py-2 text-center border-b border-gray-200">
          📊 Data Layers
        </div>
        
        {dataLayers.map((layer) => (
          <div key={layer.id} className="relative">
            {/* 主按钮 */}
            <button
              onClick={() => toggleLayer(layer.id)}
              onMouseEnter={() => setExpandedLayer(layer.id)}
              onMouseLeave={() => setExpandedLayer(null)}
              className={`w-12 h-12 rounded-lg flex items-center justify-center text-lg transition-all duration-200 hover:scale-105 relative ${
                layer.enabled
                  ? 'bg-blue-500 text-white shadow-md'
                  : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
              }`}
              title={layer.name}
            >
              {layer.icon}
              
              {/* 透明度指示器 */}
              {layer.enabled && (
                <div 
                  className="absolute bottom-0 left-0 h-1 bg-white/80 rounded-b-lg transition-all duration-200"
                  style={{ width: `${layer.opacity * 100}%` }}
                />
              )}
            </button>

            {/* 悬浮详情面板 */}
            {expandedLayer === layer.id && (
              <div className="absolute right-14 top-0 bg-white/95 backdrop-blur-md rounded-lg shadow-xl border border-white/20 p-3 min-w-48 z-10">
                <div className="flex items-center space-x-2 mb-2">
                  <span className="text-lg">{layer.icon}</span>
                  <div>
                    <div className="font-medium text-sm text-gray-800">{layer.name}</div>
                    <div className="text-xs text-gray-500">{layer.description}</div>
                  </div>
                </div>
                
                {layer.enabled && (
                  <div className="space-y-2">
                    {/* 透明度控制 */}
                    <div>
                      <div className="flex justify-between items-center text-xs text-gray-600 mb-1">
                        <span>Opacity</span>
                        <span>{Math.round(layer.opacity * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="1"
                        step="0.1"
                        value={layer.opacity}
                        onChange={(e) => updateOpacity(layer.id, parseFloat(e.target.value))}
                        className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
                        style={{
                          background: `linear-gradient(to right, ${layer.color} 0%, ${layer.color} ${layer.opacity * 100}%, #e5e7eb ${layer.opacity * 100}%, #e5e7eb 100%)`
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Base map controls */}
      <div className="mt-4 bg-white/95 backdrop-blur-md rounded-xl shadow-xl border border-gray-200/50 p-3">
        <div className="text-sm font-semibold text-gray-700 px-1 py-2 text-center border-b border-gray-200 mb-3">
          🗺️ Base Map
        </div>
        
        {/* Base map toggle buttons */}
        <div className="space-y-2">
          <button className="w-full h-10 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors flex items-center justify-center space-x-2" title="Street Map">
            <span>🌍</span>
            <span>Street</span>
          </button>
          <button className="w-full h-10 rounded-lg bg-slate-500 text-white text-sm font-medium hover:bg-slate-600 transition-colors flex items-center justify-center space-x-2" title="Satellite">
            <span>🛰️</span>
            <span>Satellite</span>
          </button>
        </div>
      </div>
    </div>
  );
};
