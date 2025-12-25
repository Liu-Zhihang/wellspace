import React from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { useShadowMap } from '../../hooks/useShadowMap';

export const ControlPanel: React.FC = () => {
  const {
    mapSettings,
    currentDate,
    shadowSettings,
    analysisResults,
    updateMapSettings,
    updateShadowSettings,
    setCurrentDate,
    clearStatusMessages,
  } = useShadowMapStore();

  const { updateSunPosition, resetSimulation } = useShadowMap();

  // 处理日期时间变化
  const handleDateChange = (date: Date) => {
    setCurrentDate(date);
    updateSunPosition();
  };

  // 处理地图设置变化
  const handleMapSettingChange = (key: keyof typeof mapSettings, value: any) => {
    updateMapSettings({ [key]: value });
  };

  // 处理阴影设置变化
  const handleShadowSettingChange = (key: keyof typeof shadowSettings, value: any) => {
    updateShadowSettings({ [key]: value });
    updateSunPosition();
  };

  // 格式化日期时间为本地输入格式
  const formatDateForInput = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // 从输入值解析日期
  const parseDateFromInput = (value: string): Date => {
    return new Date(value);
  };

  return (
    <div className="bg-white shadow-lg rounded-lg p-4 space-y-6 max-h-screen overflow-y-auto">
      <div className="border-b pb-4">
        <h2 className="text-xl font-bold text-gray-800 mb-2">🎛️ 控制面板</h2>
        <div className="flex gap-2">
          <button
            onClick={() => clearStatusMessages()}
            className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 rounded transition-colors"
          >
            清除消息
          </button>
          <button
            onClick={resetSimulation}
            className="px-3 py-1 text-sm bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
          >
            重置模拟
          </button>
        </div>
      </div>

      {/* 日期时间控制 */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-gray-700">⏰ 时间设置</h3>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-600">
            日期和时间
          </label>
          <input
            type="datetime-local"
            value={formatDateForInput(currentDate)}
            onChange={(e) => handleDateChange(parseDateFromInput(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => handleDateChange(new Date())}
            className="px-3 py-2 text-sm bg-green-100 hover:bg-green-200 text-green-700 rounded transition-colors"
          >
            当前时间
          </button>
          <button
            onClick={() => {
              const noon = new Date(currentDate);
              noon.setHours(12, 0, 0, 0);
              handleDateChange(noon);
            }}
            className="px-3 py-2 text-sm bg-yellow-100 hover:bg-yellow-200 text-yellow-700 rounded transition-colors"
          >
            正午时分
          </button>
        </div>
      </div>

      {/* 地图图层控制 */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-gray-700">🗺️ 地图图层</h3>
        <div className="space-y-2">
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={mapSettings.showBuildingLayer}
              onChange={(e) => handleMapSettingChange('showBuildingLayer', e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">显示建筑物图层</span>
          </label>
          
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={mapSettings.showDEMLayer}
              onChange={(e) => handleMapSettingChange('showDEMLayer', e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">显示地形图层</span>
          </label>
          
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={mapSettings.showShadowLayer}
              onChange={(e) => handleMapSettingChange('showShadowLayer', e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">显示阴影图层</span>
          </label>
        </div>
      </div>

      {/* 阴影模拟设置 */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-gray-700">🌅 阴影设置</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              阴影精度: {shadowSettings.shadowResolution}px
            </label>
            <input
              type="range"
              min="50"
              max="500"
              step="50"
              value={shadowSettings.shadowResolution}
              onChange={(e) => handleShadowSettingChange('shadowResolution', parseInt(e.target.value))}
              className="w-full"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              阴影透明度: {(shadowSettings.shadowOpacity * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.1"
              value={shadowSettings.shadowOpacity}
              onChange={(e) => handleShadowSettingChange('shadowOpacity', parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              建筑物高度系数: {shadowSettings.buildingHeightMultiplier}x
            </label>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.1"
              value={shadowSettings.buildingHeightMultiplier}
              onChange={(e) => handleShadowSettingChange('buildingHeightMultiplier', parseFloat(e.target.value))}
              className="w-full"
            />
          </div>
          
          <label className="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={shadowSettings.enableSunPath}
              onChange={(e) => handleShadowSettingChange('enableSunPath', e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">显示太阳轨迹</span>
          </label>
        </div>
      </div>

      {/* 太阳位置信息 */}
      <div className="space-y-3">
        <h3 className="text-lg font-semibold text-gray-700">☀️ 太阳位置</h3>
        <div className="bg-gray-50 rounded-lg p-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">海拔高度角:</span>
            <span className="font-medium">
              {analysisResults.sunPosition?.altitude?.toFixed(1) || '-'}°
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">方位角:</span>
            <span className="font-medium">
              {analysisResults.sunPosition?.azimuth?.toFixed(1) || '-'}°
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">日照状态:</span>
            <span className={`font-medium ${
              (analysisResults.sunPosition?.altitude || 0) > 0 
                ? 'text-yellow-600' 
                : 'text-gray-500'
            }`}>
              {(analysisResults.sunPosition?.altitude || 0) > 0 ? '白天' : '夜晚'}
            </span>
          </div>
        </div>
      </div>

      {/* 分析统计 */}
      {analysisResults.shadowArea && (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-gray-700">📊 阴影分析</h3>
          <div className="bg-gray-50 rounded-lg p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">阴影面积:</span>
              <span className="font-medium">
                {analysisResults.shadowArea.toFixed(0)} m²
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">覆盖率:</span>
              <span className="font-medium">
                {((analysisResults.shadowArea / 10000) * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
