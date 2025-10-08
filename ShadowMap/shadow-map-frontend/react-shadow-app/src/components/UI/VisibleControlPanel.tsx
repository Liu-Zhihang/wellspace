/**
 * 可见控制面板 - 参考截图设计
 * 左侧垂直按钮栏，清晰可见
 */

import React, { useState } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const VisibleControlPanel: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore();
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const controlButtons = [
    {
      id: 'search',
      icon: '🔍',
      label: '搜索地点',
      color: 'blue',
      action: () => {
        const location = prompt('请输入地点名称或坐标:');
        if (location) {
          console.log('搜索地点:', location);
        }
      }
    },
    {
      id: 'map',
      icon: '🗺️',
      label: '地图样式',
      color: 'green',
      action: () => setActivePanel(activePanel === 'map' ? null : 'map')
    },
    {
      id: 'layers',
      icon: '🏗️',
      label: '图层控制',
      color: 'orange',
      action: () => setActivePanel(activePanel === 'layers' ? null : 'layers')
    },
    {
      id: 'buildings',
      icon: '🏢',
      label: '建筑筛选',
      color: 'purple',
      action: () => setActivePanel(activePanel === 'buildings' ? null : 'buildings')
    },
    {
      id: 'optimize',
      icon: '⚡',
      label: '自动优化',
      color: 'purple',
      action: () => setActivePanel(activePanel === 'optimize' ? null : 'optimize')
    },
    {
      id: 'info',
      icon: 'ℹ️',
      label: '信息',
      color: 'blue',
      action: () => setActivePanel(activePanel === 'info' ? null : 'info')
    }
  ];

  const getButtonColor = (color: string, isActive: boolean) => {
    const baseColors = {
      blue: 'bg-blue-500 hover:bg-blue-600',
      green: 'bg-green-500 hover:bg-green-600',
      orange: 'bg-orange-500 hover:bg-orange-600',
      purple: 'bg-purple-500 hover:bg-purple-600'
    };
    
    const activeColors = {
      blue: 'bg-blue-600 ring-2 ring-blue-300',
      green: 'bg-green-600 ring-2 ring-green-300',
      orange: 'bg-orange-600 ring-2 ring-orange-300',
      purple: 'bg-purple-600 ring-2 ring-purple-300'
    };

    return isActive ? activeColors[color as keyof typeof activeColors] : baseColors[color as keyof typeof baseColors];
  };

  return (
    <div className="fixed left-4 top-1/2 transform -translate-y-1/2 z-50">
      {/* 主控制按钮栏 */}
      <div className="flex flex-col space-y-3">
        {controlButtons.map((button) => (
          <div key={button.id} className="relative">
            <button
              onClick={button.action}
              className={`w-12 h-12 rounded-full flex items-center justify-center text-white text-xl font-bold shadow-lg transition-all duration-200 ${getButtonColor(button.color, activePanel === button.id)}`}
              title={button.label}
            >
              {button.icon}
            </button>
            
            {/* 标签 */}
            <div className="absolute left-14 top-1/2 transform -translate-y-1/2 bg-white/95 backdrop-blur-sm rounded-lg px-3 py-1 shadow-lg border border-gray-200 whitespace-nowrap">
              <span className="text-sm font-medium text-gray-800">{button.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* 展开面板 */}
      {activePanel && (
        <div className="absolute left-16 top-0 bg-white/95 backdrop-blur-sm rounded-lg shadow-xl border border-gray-200 p-4 min-w-[280px] max-w-[320px]">
          {activePanel === 'layers' && (
            <div>
              <h3 className="font-bold text-gray-800 mb-4 text-lg">图层控制</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">建筑物图层</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mapSettings.dataLayers.buildings.enabled}
                      onChange={(e) => updateMapSettings({
                        dataLayers: {
                          ...mapSettings.dataLayers,
                          buildings: {
                            ...mapSettings.dataLayers.buildings,
                            enabled: e.target.checked
                          }
                        }
                      })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">阴影图层</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mapSettings.dataLayers.shadows.enabled}
                      onChange={(e) => updateMapSettings({
                        dataLayers: {
                          ...mapSettings.dataLayers,
                          shadows: {
                            ...mapSettings.dataLayers.shadows,
                            enabled: e.target.checked
                          }
                        }
                      })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                <div className="pt-2 border-t border-gray-200">
                  <div className="text-xs text-gray-500">
                    {mapSettings.dataLayers.buildings.enabled ? 
                      '✅ 建筑物图层已启用，应该能看到建筑轮廓' : 
                      '❌ 建筑物图层已禁用，无法看到建筑轮廓'
                    }
                  </div>
                </div>
              </div>
            </div>
          )}

          {activePanel === 'buildings' && (
            <div>
              <h3 className="font-bold text-gray-800 mb-4 text-lg">建筑筛选</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">启用建筑筛选</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mapSettings.enableBuildingFilter}
                      onChange={(e) => updateMapSettings({ enableBuildingFilter: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
                
                <div className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg">
                  {mapSettings.enableBuildingFilter ? 
                    '🔧 只显示重要建筑，减少阴影密度' : 
                    '🏗️ 显示所有建筑物，完整阴影效果'
                  }
                </div>
              </div>
            </div>
          )}

          {activePanel === 'optimize' && (
            <div>
              <h3 className="font-bold text-gray-800 mb-4 text-lg">自动优化</h3>
              <div className="space-y-3">
                <div className="text-sm text-gray-600">
                  系统会自动优化阴影计算性能，根据当前视图调整建筑数量和阴影质量。
                </div>
                <div className="text-xs text-gray-500 p-3 bg-blue-50 rounded-lg">
                  💡 建议：在密集区域启用建筑筛选以获得更好的性能
                </div>
              </div>
            </div>
          )}

          {activePanel === 'info' && (
            <div>
              <h3 className="font-bold text-gray-800 mb-4 text-lg">系统信息</h3>
              <div className="space-y-2 text-sm text-gray-600">
                <div>🗺️ 地图引擎: Mapbox GL JS</div>
                <div>🌅 阴影模拟: ShadeMap</div>
                <div>🏢 建筑数据: OSM + 本地缓存</div>
                <div>📍 当前位置: 北京天安门</div>
              </div>
            </div>
          )}

          {activePanel === 'map' && (
            <div>
              <h3 className="font-bold text-gray-800 mb-4 text-lg">地图样式</h3>
              <div className="space-y-2">
                <button className="w-full text-left px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg">
                  🗺️ 街道地图
                </button>
                <button className="w-full text-left px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg">
                  🛰️ 卫星地图
                </button>
                <button className="w-full text-left px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg">
                  🌙 暗色主题
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default VisibleControlPanel;
