import { useShadowMapStore } from '../../store/shadowMapStore';
import type { DataLayer, DataLayerType, MapSettings } from '../../types/index.ts';

const getLayerEnabled = (layer: DataLayer, mapSettings: MapSettings) => {
  if (layer.id === 'shadows') return mapSettings.showShadowLayer;
  if (layer.id === 'sunlight_hours') return mapSettings.showSunExposure;
  if (layer.id === 'buildings') return mapSettings.showBuildingLayer;
  if (layer.id === 'terrain') return mapSettings.showDEMLayer;
  return layer.enabled;
};

export const DataLayerSelector = () => {
  const { mapSettings, updateDataLayer, setActiveDataLayer, updateMapSettings } = useShadowMapStore();
  const { dataLayers, activeDataLayer } = mapSettings;
  const layers = Object.values(dataLayers) as DataLayer[];

  const syncLayerState = (layerId: DataLayerType, enabled: boolean) => {
    if (layerId === 'shadows') {
      updateMapSettings({ showShadowLayer: enabled });
    } else if (layerId === 'sunlight_hours') {
      updateMapSettings({ showSunExposure: enabled });
    } else if (layerId === 'buildings') {
      updateMapSettings({ showBuildingLayer: enabled });
    } else if (layerId === 'terrain') {
      updateMapSettings({ showDEMLayer: enabled });
    }

    updateDataLayer(layerId, { enabled });
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h3 className="text-lg font-semibold text-gray-800 mb-4 flex items-center">
        🗂️ 数据层控制
      </h3>
      
      <div className="space-y-3">
        {layers.map((layer) => {
          const isActive = activeDataLayer === layer.id;
          const isEnabled = getLayerEnabled(layer, mapSettings);

          return (
            <div
              key={layer.id}
              className={`p-3 rounded-lg border-2 transition-all cursor-pointer ${
                isEnabled ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50'
              } ${
                isActive ? 'ring-2 ring-blue-400 ring-opacity-50' : ''
              }`}
              onClick={() => setActiveDataLayer(layer.id)}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2">
                  <span className="text-xl">{layer.icon}</span>
                  <div>
                    <h4 className="text-sm font-medium text-gray-800">{layer.name}</h4>
                    <p className="text-xs text-gray-500">{layer.description}</p>
                  </div>
                </div>
                
                <label className="relative inline-flex items-center cursor-pointer" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => syncLayerState(layer.id, e.target.checked)}
                    className="mr-2 h-4 w-4 text-blue-600 rounded border-gray-300"
                  />
                  <span className="text-xs text-gray-500">{isEnabled ? '开启' : '关闭'}</span>
                </label>
              </div>

              {isEnabled && (
                <div className="space-y-2 border-t border-gray-200 pt-2">
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
                    onChange={(e) => updateDataLayer(layer.id, { opacity: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />

                  {layer.color && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-600">颜色</span>
                      <input
                        type="color"
                        value={layer.color}
                        onChange={(e) => updateDataLayer(layer.id, { color: e.target.value })}
                        className="w-8 h-6 rounded border border-gray-300 cursor-pointer"
                      />
                    </div>
                  )}

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
          );
        })}
      </div>
      
      <div className="mt-4 pt-3 border-t border-gray-200">
        <div className="flex gap-2">
          <button
            onClick={() => {
              layers.forEach((layer) => syncLayerState(layer.id, true));
            }}
            className="flex-1 px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
          >
            全部启用
          </button>
          <button
            onClick={() => {
              layers.forEach((layer) => syncLayerState(layer.id, false));
            }}
            className="flex-1 px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
          >
            全部禁用
          </button>
        </div>
      </div>
      
      <div className="mt-3 p-2 bg-gray-50 rounded text-xs text-gray-600">
        <div className="flex items-center justify-between">
          <span>当前活跃层:</span>
          <span className="font-medium">{dataLayers[activeDataLayer].icon} {dataLayers[activeDataLayer].name}</span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span>启用层数:</span>
          <span className="font-medium">{layers.filter((layer) => getLayerEnabled(layer, mapSettings)).length}/{layers.length}</span>
        </div>
      </div>
    </div>
  );
};
