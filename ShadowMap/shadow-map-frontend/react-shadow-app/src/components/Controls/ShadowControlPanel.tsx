import React from 'react';
import { Slider, Switch, ColorPicker, Row, Col, Divider } from 'antd';
import { EyeOutlined, HomeOutlined } from '@ant-design/icons';
// import { SunOutlined, ThunderboltOutlined } from '@ant-design/icons'; // TODO: 后期实现时取消注释
import { useShadowMapStore } from '../../store/shadowMapStore';
import type { Color } from 'antd/es/color-picker';

export const ShadowControlPanel: React.FC = () => {
  const {
    mapSettings,
    updateMapSettings,
    shadowSettings,
    updateShadowSettings,
    currentWeather,
  } = useShadowMapStore();

  const colorPresets = [
    {
      label: 'Shadow Presets',
      colors: ['#01112f', '#2d3748', '#553c9a', '#2f855a', '#744210', '#000000'],
    },
  ];

  const handleColorChange = (color: Color) => {
    updateMapSettings({ shadowColor: color.toHexString() });
  };

  return (
    <div className="bg-white backdrop-blur-sm rounded-lg p-4 space-y-4 shadow-lg border border-gray-200">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Shadow Settings</h3>

      {/* Shadow Intensity */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-600">Shadow Intensity</label>
          <span className="text-xs font-semibold bg-gray-100 px-2 py-0.5 rounded">
            {(mapSettings.shadowOpacity * 100).toFixed(0)}%
          </span>
        </div>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={mapSettings.shadowOpacity}
          onChange={(value) => updateMapSettings({ shadowOpacity: value })}
          tooltip={{ formatter: (value) => `${((value || 0) * 100).toFixed(0)}%` }}
        />
      </div>

      {/* Shadow Color */}
      <div>
        <label className="text-xs text-gray-600 block mb-2">Shadow Color</label>
        <ColorPicker
          value={mapSettings.shadowColor}
          onChange={handleColorChange}
          presets={colorPresets}
          showText
          size="middle"
          style={{ width: '100%' }}
        />
      </div>

      {/* Cloud Attenuation */}
      <div>
        <label className="text-xs text-gray-600 block mb-2">Cloud Attenuation</label>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-500">Auto cloud-based attenuation</span>
          <Switch
            size="small"
            checked={shadowSettings.autoCloudAttenuation}
            onChange={(checked) => updateShadowSettings({ autoCloudAttenuation: checked })}
          />
        </div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-600">Manual factor</span>
          <span className="text-xs font-semibold bg-gray-100 px-2 py-0.5 rounded">
            {Math.round(
              (shadowSettings.autoCloudAttenuation
                ? (currentWeather.sunlightFactor ?? 1)
                : shadowSettings.manualSunlightFactor) * 100,
            )}
            %
          </span>
        </div>
        <Slider
          min={0}
          max={1}
          step={0.05}
          disabled={shadowSettings.autoCloudAttenuation}
          value={shadowSettings.manualSunlightFactor}
          onChange={(value) => {
            const numericValue = Array.isArray(value) ? value[0] : value;
            updateShadowSettings({ manualSunlightFactor: numericValue });
          }}
          tooltip={{ formatter: (value) => `${Math.round((value || 0) * 100)}%` }}
        />
      </div>

      <Divider style={{ margin: '12px 0' }} />

      {/* Layer Toggles */}
      <div className="space-y-2.5">
        <Row align="middle" justify="space-between">
          <Col>
            <div className="flex items-center gap-2">
              <EyeOutlined className="text-gray-500" />
              <span className="text-xs text-gray-700">Shadow Layer</span>
            </div>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.showShadowLayer}
              onChange={(checked) => updateMapSettings({ showShadowLayer: checked })}
              size="small"
            />
          </Col>
        </Row>

        {/* TODO: 后期实现 Sun Exposure 功能
        <Row align="middle" justify="space-between">
          <Col>
            <div className="flex items-center gap-2">
              <SunOutlined className="text-orange-500" />
              <span className="text-xs text-gray-700">Sun Exposure</span>
            </div>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.showSunExposure}
              onChange={(checked) => updateMapSettings({ showSunExposure: checked })}
              size="small"
            />
          </Col>
        </Row>
        */}

        <Row align="middle" justify="space-between">
          <Col>
            <div className="flex items-center gap-2">
              <HomeOutlined className="text-blue-500" />
              <span className="text-xs text-gray-700">Buildings</span>
            </div>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.showBuildingLayer}
              onChange={(checked) => updateMapSettings({ showBuildingLayer: checked })}
              size="small"
            />
          </Col>
        </Row>

        {/* TODO: 后期实现 Dynamic Quality 功能
        <Row align="middle" justify="space-between">
          <Col>
            <div className="flex items-center gap-2">
              <ThunderboltOutlined className="text-purple-500" />
              <span className="text-xs text-gray-700">Dynamic Quality</span>
            </div>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.enableDynamicQuality}
              onChange={(checked) => updateMapSettings({ enableDynamicQuality: checked })}
              size="small"
            />
          </Col>
        </Row>
        */}
      </div>
    </div>
  );
};
