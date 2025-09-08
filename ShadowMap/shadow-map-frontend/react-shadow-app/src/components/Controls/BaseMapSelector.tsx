import React, { useState, useEffect } from 'react';
import { baseMapManager, type BaseMapOption } from '../../services/baseMapManager';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { useShadowMap } from '../../hooks/useShadowMap';

export const BaseMapSelector: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState<'street' | 'satellite' | 'terrain' | 'dark' | 'light'>('street');
  const [currentBaseMap, setCurrentBaseMap] = useState<string>('osm-standard');
  const [mapboxApiKey, setMapboxApiKey] = useState<string>('');
  const [isExpanded, setIsExpanded] = useState(false);
  
  const { addStatusMessage } = useShadowMapStore();
  const { mapRef } = useShadowMap();

  const categories = baseMapManager.getCategories();
  const availableMaps = baseMapManager.getBaseMapsByCategory(selectedCategory);

  // 设置地图管理器
  useEffect(() => {
    if (mapRef.current) {
      baseMapManager.setMap(mapRef.current);
    }
  }, [mapRef.current]);

  // 切换底图
  const handleBaseMapChange = (mapId: string) => {
    const success = baseMapManager.switchBaseMap(mapId, mapboxApiKey);
    if (success) {
      setCurrentBaseMap(mapId);
      const mapOption = baseMapManager.getAllBaseMaps().find(m => m.id === mapId);
      addStatusMessage(`已切换到: ${mapOption?.name}`, 'info');
    } else {
      addStatusMessage('底图切换失败', 'error');
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
      {/* 标题和展开控制 */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-gray-800">地图底图</h3>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          {isExpanded ? '收起' : '展开'}
        </button>
      </div>

      {/* 当前底图显示 */}
      <div className="bg-gray-50 rounded-lg p-3">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-green-500 rounded-full"></div>
          <div>
            <div className="font-medium text-sm text-gray-800">
              {baseMapManager.getAllBaseMaps().find(m => m.id === currentBaseMap)?.name || '标准地图'}
            </div>
            <div className="text-xs text-gray-600">
              {baseMapManager.getAllBaseMaps().find(m => m.id === currentBaseMap)?.description || '当前使用的地图'}
            </div>
          </div>
        </div>
      </div>

      {isExpanded && (
        <div className="space-y-4 fade-in">
          {/* 分类选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-600">地图类型</label>
            <div className="flex gap-1 overflow-x-auto">
              {categories.map((category) => (
                <button
                  key={category.id}
                  onClick={() => setSelectedCategory(category.id)}
                  className={`flex-shrink-0 px-3 py-2 text-sm rounded-lg transition-colors ${
                    selectedCategory === category.id
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                >
                  <span className="mr-1">{category.icon}</span>
                  {category.name}
                </button>
              ))}
            </div>
          </div>

          {/* 底图选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-600">选择底图</label>
            <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto">
              {availableMaps.map((mapOption) => (
                <button
                  key={mapOption.id}
                  onClick={() => handleBaseMapChange(mapOption.id)}
                  disabled={mapOption.requiresApiKey && !mapboxApiKey}
                  className={`p-3 text-left rounded-lg border transition-all hover:shadow-sm ${
                    currentBaseMap === mapOption.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                  } ${
                    mapOption.requiresApiKey && !mapboxApiKey
                      ? 'opacity-50 cursor-not-allowed'
                      : 'cursor-pointer'
                  }`}
                >
                  <div className="font-medium text-sm text-gray-800">{mapOption.name}</div>
                  <div className="text-xs text-gray-600 mt-1">{mapOption.description}</div>
                  {mapOption.requiresApiKey && (
                    <div className="text-xs text-orange-600 mt-1">🔑 需要API密钥</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Mapbox API密钥输入 */}
          {selectedCategory !== 'street' && selectedCategory !== 'light' && (
            <div className="space-y-2 pt-2 border-t">
              <label className="text-sm font-medium text-gray-600">
                Mapbox API密钥 (可选)
              </label>
              <input
                type="text"
                value={mapboxApiKey}
                onChange={(e) => setMapboxApiKey(e.target.value)}
                placeholder="pk.eyJ1..."
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500">
                输入Mapbox API密钥以使用高质量卫星地图
              </p>
            </div>
          )}

          {/* 快速切换 */}
          <div className="flex gap-2 pt-2 border-t">
            <button
              onClick={() => handleBaseMapChange('osm-standard')}
              className="flex-1 py-2 text-sm bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors"
            >
              🗺️ 标准
            </button>
            <button
              onClick={() => handleBaseMapChange('cartodb-light')}
              className="flex-1 py-2 text-sm bg-gray-50 hover:bg-gray-100 text-gray-700 rounded-lg transition-colors"
            >
              ☀️ 浅色
            </button>
            <button
              onClick={() => handleBaseMapChange('esri-satellite')}
              className="flex-1 py-2 text-sm bg-green-50 hover:bg-green-100 text-green-700 rounded-lg transition-colors"
            >
              🛰️ 卫星
            </button>
          </div>
        </div>
      )}
    </div>
  );
};