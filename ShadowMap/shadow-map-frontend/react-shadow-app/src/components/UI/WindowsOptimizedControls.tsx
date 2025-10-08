import React, { useState } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const WindowsOptimizedControls: React.FC = () => {
  const {
    mapSettings,
    updateMapSettings,
    updateDataLayer,
  } = useShadowMapStore();

  const [expandedPanel, setExpandedPanel] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

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
      case 'buildings':
        updateMapSettings({ showBuildingLayer: !mapSettings.showBuildingLayer });
        break;
      case 'terrain':
        updateMapSettings({ showDEMLayer: !mapSettings.showDEMLayer });
        break;
    }
  };

  const updateOpacity = (layerId: string, opacity: number) => {
    switch (layerId) {
      case 'shadows':
        updateMapSettings({ shadowOpacity: opacity });
        break;
      case 'buildings':
        updateDataLayer('buildings', { opacity });
        break;
      case 'terrain':
        updateDataLayer('terrain', { opacity });
        break;
    }
  };

  if (minimized) {
    return (
      <div className="fixed right-4 top-20 z-50">
        <button
          onClick={() => setMinimized(false)}
          className="w-12 h-12 bg-blue-500 text-white rounded-full shadow-lg hover:bg-blue-600 transition-colors flex items-center justify-center"
          title="Expand Controls"
        >
          📊
        </button>
      </div>
    );
  }

  return (
    <div className="fixed right-4 top-20 z-50 max-w-[280px]">
      {/* Main control panel */}
      <div className="bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-4 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-lg">📊</span>
            <span className="font-semibold">Data Layers</span>
          </div>
          <button
            onClick={() => setMinimized(true)}
            className="text-white/80 hover:text-white text-sm"
            title="Minimize"
          >
            ─
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {dataLayers.map((layer) => (
            <div key={layer.id} className="border border-gray-200 rounded-lg overflow-hidden">
              {/* Layer toggle */}
              <button
                onClick={() => {
                  toggleLayer(layer.id);
                  setExpandedPanel(expandedPanel === layer.id ? null : layer.id);
                }}
                className={`w-full flex items-center space-x-3 p-3 transition-colors ${
                  layer.enabled
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span className="text-xl flex-shrink-0">{layer.icon}</span>
                <div className="flex-1 text-left">
                  <div className="font-medium text-sm">{layer.name}</div>
                  <div className="text-xs text-gray-500 truncate">{layer.description}</div>
                </div>
                <div className="flex items-center space-x-2">
                  <div className={`w-3 h-3 rounded-full ${
                    layer.enabled ? 'bg-green-400' : 'bg-gray-300'
                  }`} />
                  <span className="text-xs text-gray-400">
                    {expandedPanel === layer.id ? '▲' : '▼'}
                  </span>
                </div>
              </button>

              {/* Expanded controls */}
              {expandedPanel === layer.id && layer.enabled && (
                <div className="p-3 bg-gray-50 border-t border-gray-200">
                  <div className="space-y-3">
                    {/* Opacity control */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-600">Opacity</label>
                        <span className="text-sm text-gray-700 font-mono">
                          {Math.round(layer.opacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={layer.opacity}
                        onChange={(e) => updateOpacity(layer.id, parseFloat(e.target.value))}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer 
                                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 
                                   [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full 
                                   [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:cursor-pointer
                                   [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white
                                   [&::-webkit-slider-thumb]:shadow-lg"
                      />
                    </div>

                    {/* Status indicator */}
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">Status:</span>
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        layer.enabled 
                          ? 'bg-green-100 text-green-700' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {layer.enabled ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* Quick actions */}
          <div className="pt-3 border-t border-gray-200">
            <div className="text-sm font-medium text-gray-600 mb-2">Quick Actions</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  updateMapSettings({ 
                    showShadowLayer: true, 
                    showBuildingLayer: true,
                    showDEMLayer: false
                  });
                }}
                className="px-3 py-2 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 transition-colors"
              >
                🌆 Urban Mode
              </button>
              <button
                onClick={() => {
                  updateMapSettings({ 
                    showShadowLayer: false, 
                    showBuildingLayer: false,
                    showDEMLayer: false
                  });
                }}
                className="px-3 py-2 bg-gray-500 text-white text-xs rounded hover:bg-gray-600 transition-colors"
              >
                🗺️ Clear All
              </button>
            </div>
          </div>

          {/* Connection status */}
          <div className="pt-3 border-t border-gray-200">
            <div className="flex items-center space-x-2 text-xs">
              <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse" />
              <span className="text-gray-500">Backend: Disconnected</span>
            </div>
            <div className="text-xs text-gray-400 mt-1">
              Please start the backend server on localhost:3001
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
