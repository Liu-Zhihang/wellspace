/**
 * 参考专业网站的右侧控制面板设计
 * 学习参考网站的简洁控制布局
 */

import React, { useState } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const ReferenceInspiredControls: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore();
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const controlButtons = [
    { id: 'search', icon: '🔍', label: '搜索', color: 'blue' },
    { id: 'layers', icon: '🗺️', label: '图层', color: 'green' },
    { id: '3d', icon: '🏗️', label: '3D视图', color: 'purple' },
    { id: 'zoom-in', icon: '➕', label: '放大', color: 'gray' },
    { id: 'zoom-out', icon: '➖', label: '缩小', color: 'gray' },
    { id: 'info', icon: 'ℹ️', label: '信息', color: 'orange' }
  ];

  const handleControlClick = (controlId: string) => {
    if (controlId === 'zoom-in') {
      // 放大逻辑
      console.log('🔍 放大地图');
    } else if (controlId === 'zoom-out') {
      // 缩小逻辑
      console.log('🔍 缩小地图');
    } else if (controlId === '3d') {
      // 3D视图切换
      console.log('🏗️ 切换3D视图');
    } else {
      setActivePanel(activePanel === controlId ? null : controlId);
    }
  };

  const getButtonColor = (color: string, isActive: boolean) => {
    const colors = {
      blue: isActive ? 'bg-blue-500 hover:bg-blue-600' : 'bg-blue-100 hover:bg-blue-200 text-blue-600',
      green: isActive ? 'bg-green-500 hover:bg-green-600' : 'bg-green-100 hover:bg-green-200 text-green-600',
      purple: isActive ? 'bg-purple-500 hover:bg-purple-600' : 'bg-purple-100 hover:bg-purple-200 text-purple-600',
      gray: isActive ? 'bg-gray-500 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200 text-gray-600',
      orange: isActive ? 'bg-orange-500 hover:bg-orange-600' : 'bg-orange-100 hover:bg-orange-200 text-orange-600'
    };
    return colors[color as keyof typeof colors] || colors.gray;
  };

  return (
    <div className="fixed top-4 right-4 z-30 flex flex-col space-y-2">
      {/* 控制按钮 */}
      {controlButtons.map((button) => (
        <div key={button.id} className="relative">
          <button
            onClick={() => handleControlClick(button.id)}
            className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-all shadow-lg ${getButtonColor(button.color, activePanel === button.id)}`}
            title={button.label}
          >
            {button.icon}
          </button>

          {/* 展开面板 */}
          {activePanel === button.id && (
            <div className="absolute top-0 right-12 bg-white/95 backdrop-blur-sm rounded-lg shadow-xl border border-gray-200 p-4 min-w-[200px]">
              {button.id === 'layers' && (
                <div>
                  <h3 className="font-medium text-gray-800 mb-3">图层控制</h3>
                  <div className="space-y-2">
                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={mapSettings.enableBuildingFilter}
                        onChange={(e) => updateMapSettings({ enableBuildingFilter: e.target.checked })}
                        className="rounded"
                      />
                      <span className="text-sm text-gray-700">建筑筛选</span>
                    </label>
                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={mapSettings.autoOptimize}
                        onChange={(e) => updateMapSettings({ autoOptimize: e.target.checked })}
                        className="rounded"
                      />
                      <span className="text-sm text-gray-700">自动优化</span>
                    </label>
                  </div>
                </div>
              )}

              {button.id === 'info' && (
                <div>
                  <h3 className="font-medium text-gray-800 mb-3">应用信息</h3>
                  <div className="text-sm text-gray-600 space-y-1">
                    <div>版本: v2.0</div>
                    <div>阴影引擎: Mapbox GL</div>
                    <div>数据源: OSM + DEM</div>
                    <div>查询策略: 完整模式</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* 阴影质量快速控制 */}
      <div className="mt-4 bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 p-3">
        <div className="text-xs text-gray-600 mb-2">阴影质量</div>
        <div className="flex space-x-1">
          {[
            { opacity: 0.3, color: '#bdc3c7', label: '淡' },
            { opacity: 0.5, color: '#7f8c8d', label: '中' },
            { opacity: 0.7, color: '#2c3e50', label: '深' }
          ].map((preset, index) => (
            <button
              key={index}
              onClick={() => updateMapSettings({ 
                shadowOpacity: preset.opacity, 
                shadowColor: preset.color 
              })}
              className={`px-2 py-1 text-xs rounded transition-all ${
                Math.abs(mapSettings.shadowOpacity - preset.opacity) < 0.1
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
              }`}
              title={preset.label}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
