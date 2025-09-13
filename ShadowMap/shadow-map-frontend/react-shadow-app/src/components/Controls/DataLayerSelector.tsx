import React from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';
import type { DataLayerType } from '../../types';

export const DataLayerSelector: React.FC = () => {
  const {
    mapSettings,
    toggleDataLayer,
    updateDataLayer,
    setActiveDataLayer,
    updateMapSettings,
  } = useShadowMapStore();

  const { dataLayers, activeDataLayer } = mapSettings;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center">
        🗂️ 数据层控制
      </h3>
      
      <div className="space-y-3">
        {Object.values(dataLayers).map((layer) => (
          <div
            key={layer.id}
            className={`p-3 rounded-lg border-2 transition-all cursor-pointer ${
              layer.enabled 
                ? 'border-blue-300 bg-blue-50' 
                : 'border-gray-200 bg-gray-50'
            } ${
              activeDataLayer === layer.id 
                ? 'ring-2 ring-blue-400 ring-opacity-50' 
                : ''
            }`}
            onClick={() => setActiveDataLayer(layer.id)}
          >
            {/* 图层头部 */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-2">
                <span className="text-xl">{layer.icon}</span>
                <div>
                  <h4 className="text-sm font-medium text-gray-800">{layer.name}</h4>
                  <p className="text-xs text-gray-500">{layer.description}</p>
                </div>
              </div>
              
              {/* 开关 */}
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={
                    layer.id === 'shadows' ? mapSettings.showShadowLayer :
                    layer.id === 'sunlight_hours' ? mapSettings.showSunExposure :
                    layer.id === 'buildings' ? mapSettings.showBuildingLayer :
                    layer.id === 'terrain' ? mapSettings.showDEMLayer :
                    layer.enabled
                  }
                  onChange={(e) => {
                    console.log(`🔄 切换图层: ${layer.name} -> ${e.target.checked}`);
                    
                    // 直接控制mapSettings
                    if (layer.id === 'shadows') {
                      updateMapSettings({ showShadowLayer: e.target.checked });
                    } else if (layer.id === 'sunlight_hours') {
                      updateMapSettings({ showSunExposure: e.target.checked });
                    } else if (layer.id === 'buildings') {
                      updateMapSettings({ showBuildingLayer: e.target.checked });
                    } else if (layer.id === 'terrain') {
                      updateMapSettings({ showDEMLayer: e.target.checked });
                    }
                  }}
                  className="mr-2 h-4 w-4 text-blue-600 rounded border-gray-300"
                />
                <span className="text-xs text-gray-500">
                  {layer.enabled ? '开启' : '关闭'}
                </span>
              </label>
            </div>

            {/* 图层控制（仅在启用时显示） */}
            {layer.enabled && (
              <div className="space-y-2 border-t border-gray-200 pt-2">
                {/* 透明度控制 */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">透明度</span>
                  <span className="text-xs text-gray-500">{Math.round(layer.opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.1"
                  value={layer.opacity}
                  onChange={(e) => {
                    e.stopPropagation();
                    updateDataLayer(layer.id, { opacity: parseFloat(e.target.value) });
                  }}
                  className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                
                {/* 颜色控制（仅对有颜色的图层） */}
                {layer.color && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-600">颜色</span>
                    <input
                      type="color"
                      value={layer.color}
                      onChange={(e) => {
                        e.stopPropagation();
                        updateDataLayer(layer.id, { color: e.target.value });
                      }}
                      className="w-8 h-6 rounded border border-gray-300 cursor-pointer"
                    />
                  </div>
                )}
                
                {/* 渲染模式指示 */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">渲染模式</span>
                  <span className="text-xs px-2 py-1 bg-gray-100 rounded text-gray-600">
                    {layer.renderMode === 'overlay' && '🎭 覆盖层'}
                    {layer.renderMode === 'heatmap' && '🌈 热力图'}
                    {layer.renderMode === 'vector' && '📐 矢量'}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      
      {/* 快速操作 */}
      <div className="mt-4 pt-3 border-t border-gray-200">
        <div className="flex gap-2">
          <button
            onClick={() => {
              // 全部启用
              Object.keys(dataLayers).forEach(layerId => {
                updateDataLayer(layerId as DataLayerType, { enabled: true });
              });
            }}
            className="flex-1 px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
          >
            全部启用
          </button>
          <button
            onClick={() => {
              // 全部禁用
              Object.keys(dataLayers).forEach(layerId => {
                updateDataLayer(layerId as DataLayerType, { enabled: false });
              });
            }}
            className="flex-1 px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
          >
            全部禁用
          </button>
        </div>
      </div>
      
      {/* 当前状态显示 */}
      <div className="mt-3 p-2 bg-gray-50 rounded text-xs text-gray-600">
        <div className="flex items-center justify-between">
          <span>当前活跃层:</span>
          <span className="font-medium">{dataLayers[activeDataLayer].icon} {dataLayers[activeDataLayer].name}</span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span>启用层数:</span>
          <span className="font-medium">{Object.values(dataLayers).filter(l => l.enabled).length}/5</span>
        </div>
      </div>
    </div>
  );
};
