import React from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { useShadowMap } from '../../hooks/useShadowMap';

export const ShadowControls: React.FC = () => {
  const {
    mapSettings,
    shadowSettings,
    updateMapSettings,
    updateShadowSettings,
  } = useShadowMapStore();

  const { updateSunPosition } = useShadowMap();

  // 预设颜色选项
  const colorPresets = [
    { name: '深蓝', value: '#01112f', desc: '经典阴影' },
    { name: '深灰', value: '#2d3748', desc: '自然阴影' },
    { name: '紫色', value: '#553c9a', desc: '梦幻效果' },
    { name: '深绿', value: '#2f855a', desc: '森林感' },
    { name: '棕色', value: '#744210', desc: '古典风格' },
    { name: '黑色', value: '#000000', desc: '极致对比' },
  ];

  // 处理阴影颜色变化
  const handleColorChange = (color: string) => {
    updateMapSettings({ shadowColor: color });
  };

  // 处理透明度变化
  const handleOpacityChange = (opacity: number) => {
    updateMapSettings({ shadowOpacity: opacity });
  };

  // 处理阴影设置变化
  const handleShadowSettingChange = (key: keyof typeof shadowSettings, value: any) => {
    updateShadowSettings({ [key]: value });
    updateSunPosition();
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
      {/* 简洁标题 */}
      <h3 className="text-lg font-medium text-gray-800">阴影设置</h3>

      {/* 核心控制 */}
      <div className="space-y-4">
        {/* 透明度 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-gray-600">
            <span>阴影强度</span>
            <span className="font-medium">{(mapSettings.shadowOpacity * 100).toFixed(0)}%</span>
          </div>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={mapSettings.shadowOpacity}
            onChange={(e) => handleOpacityChange(parseFloat(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
          />
        </div>

        {/* 颜色预设 */}
        <div className="space-y-2">
          <span className="text-sm text-gray-600">阴影颜色</span>
          <div className="flex gap-2">
            {colorPresets.slice(0, 4).map((preset) => (
              <button
                key={preset.value}
                onClick={() => handleColorChange(preset.value)}
                className={`w-8 h-8 rounded-full border-2 transition-all ${
                  mapSettings.shadowColor === preset.value
                    ? 'border-blue-500 scale-110'
                    : 'border-gray-300 hover:scale-105'
                }`}
                style={{ backgroundColor: preset.value }}
                title={preset.name}
              />
            ))}
          </div>
        </div>

        {/* 图层开关 */}
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-gray-600">显示阴影</span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={mapSettings.showShadowLayer}
              onChange={(e) => updateMapSettings({ showShadowLayer: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>

        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-gray-600">显示建筑物</span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={mapSettings.showBuildingLayer}
              onChange={(e) => updateMapSettings({ showBuildingLayer: e.target.checked })}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
          </label>
        </div>
      </div>
    </div>
  );
};
