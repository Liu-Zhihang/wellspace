/**
 * 简化的控制面板
 * 解决用户找不到按钮的问题
 */

import React, { useState } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';

export const SimpleControlPanel: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore();
  const [isOpen, setIsOpen] = useState(false);

  const toggleBuildings = () => {
    updateMapSettings({ 
      showBuildingLayer: !mapSettings.showBuildingLayer,
      dataLayers: {
        ...mapSettings.dataLayers,
        buildings: {
          ...mapSettings.dataLayers.buildings,
          enabled: !mapSettings.showBuildingLayer
        }
      }
    });
  };

  const toggleShadows = () => {
    updateMapSettings({ 
      showShadowLayer: !mapSettings.showShadowLayer,
      dataLayers: {
        ...mapSettings.dataLayers,
        shadows: {
          ...mapSettings.dataLayers.shadows,
          enabled: !mapSettings.showShadowLayer
        }
      }
    });
  };

  return (
    <div className="fixed top-4 right-4 z-50">
      {/* 主控制按钮 - 大而明显 */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-16 h-16 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-2xl flex items-center justify-center text-2xl font-bold transition-all duration-200 hover:scale-110"
        title="打开控制面板"
      >
        ⚙️
      </button>

      {/* 控制面板 */}
      {isOpen && (
        <div className="absolute top-20 right-0 bg-white rounded-xl shadow-2xl border-2 border-gray-200 p-6 min-w-[300px]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-800">地图控制</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="text-gray-500 hover:text-gray-700 text-xl"
            >
              ✕
            </button>
          </div>

          {/* 建筑物控制 */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">🏢 建筑物图层</span>
              <button
                onClick={toggleBuildings}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mapSettings.showBuildingLayer
                    ? 'bg-green-100 text-green-800 border-2 border-green-300'
                    : 'bg-gray-100 text-gray-600 border-2 border-gray-300'
                }`}
              >
                {mapSettings.showBuildingLayer ? '已开启' : '已关闭'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {mapSettings.showBuildingLayer 
                ? '✅ 显示建筑物轮廓和高度信息' 
                : '❌ 隐藏建筑物图层'
              }
            </div>
          </div>

          {/* 阴影控制 */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">🌑 阴影图层</span>
              <button
                onClick={toggleShadows}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mapSettings.showShadowLayer
                    ? 'bg-green-100 text-green-800 border-2 border-green-300'
                    : 'bg-gray-100 text-gray-600 border-2 border-gray-300'
                }`}
              >
                {mapSettings.showShadowLayer ? '已开启' : '已关闭'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {mapSettings.showShadowLayer 
                ? '✅ 显示实时阴影效果' 
                : '❌ 隐藏阴影图层'
              }
            </div>
          </div>

          {/* 建筑物筛选控制 */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-700">🔍 建筑筛选</span>
              <button
                onClick={() => updateMapSettings({ enableBuildingFilter: !mapSettings.enableBuildingFilter })}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  mapSettings.enableBuildingFilter
                    ? 'bg-orange-100 text-orange-800 border-2 border-orange-300'
                    : 'bg-gray-100 text-gray-600 border-2 border-gray-300'
                }`}
              >
                {mapSettings.enableBuildingFilter ? '已开启' : '已关闭'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">
              {mapSettings.enableBuildingFilter 
                ? '🔧 只显示重要建筑，减少阴影密度' 
                : '🏗️ 显示所有建筑物，完整阴影效果'
              }
            </div>
          </div>

          {/* 状态信息 */}
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs text-gray-600">
              <div className="flex items-center mb-1">
                <div className={`w-2 h-2 rounded-full mr-2 ${mapSettings.showBuildingLayer ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                建筑物: {mapSettings.showBuildingLayer ? '显示中' : '已隐藏'}
              </div>
              <div className="flex items-center mb-1">
                <div className={`w-2 h-2 rounded-full mr-2 ${mapSettings.showShadowLayer ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                阴影: {mapSettings.showShadowLayer ? '显示中' : '已隐藏'}
              </div>
              <div className="flex items-center">
                <div className={`w-2 h-2 rounded-full mr-2 ${mapSettings.enableBuildingFilter ? 'bg-orange-500' : 'bg-gray-400'}`}></div>
                筛选: {mapSettings.enableBuildingFilter ? '已启用' : '已禁用'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SimpleControlPanel;
