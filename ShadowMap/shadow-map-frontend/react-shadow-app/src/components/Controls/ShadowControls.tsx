import React from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { Slider, Switch, ColorPicker, Row, Col, Tooltip } from 'antd';
import { SunOutlined, EyeOutlined, HomeOutlined, ThunderboltOutlined } from '@ant-design/icons';

export const ShadowControls: React.FC = () => {
  const { mapSettings, updateMapSettings } = useShadowMapStore();

  const colorPresets = [
    {
      label: 'Shadow Presets',
      colors: ['#01112f', '#2d3748', '#553c9a', '#2f855a', '#744210', '#000000']
    }
  ];

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium text-gray-600 mb-1 block">
          Shadow Intensity
        </label>
        <Row align="middle" gutter={16}>
          <Col span={16}>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={mapSettings.shadowOpacity}
              onChange={(value) => updateMapSettings({ shadowOpacity: value })}
            />
          </Col>
          <Col span={8}>
            <div className="text-center text-sm font-semibold bg-gray-100 rounded-md py-1">
              {(mapSettings.shadowOpacity * 100).toFixed(0)}%
            </div>
          </Col>
        </Row>
      </div>

      <div>
        <label className="text-sm font-medium text-gray-600 mb-1 block">
          Shadow Color
        </label>
        <ColorPicker
          value={mapSettings.shadowColor}
          onChange={(color) => updateMapSettings({ shadowColor: color.toHexString() })}
          presets={colorPresets}
          showText
        />
      </div>

      <div className="space-y-3 pt-2">
        <Row align="middle" justify="space-between">
          <Col>
            <label className="flex items-center space-x-2">
              <EyeOutlined />
              <span className="text-sm text-gray-700">Shadow Layer</span>
            </label>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.showShadowLayer}
              onChange={(checked) => updateMapSettings({ showShadowLayer: checked })}
              size="small"
            />
          </Col>
        </Row>
        <Row align="middle" justify="space-between">
          <Col>
            <label className="flex items-center space-x-2">
              <SunOutlined />
              <span className="text-sm text-gray-700">Sun Exposure</span>
            </label>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.showSunExposure}
              onChange={(checked) => updateMapSettings({ showSunExposure: checked })}
              size="small"
            />
          </Col>
        </Row>
        <Row align="middle" justify="space-between">
          <Col>
            <label className="flex items-center space-x-2">
              <HomeOutlined />
              <span className="text-sm text-gray-700">Buildings</span>
            </label>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.showBuildingLayer}
              onChange={(checked) => updateMapSettings({ showBuildingLayer: checked })}
              size="small"
            />
          </Col>
        </Row>
        <Row align="middle" justify="space-between">
          <Col>
            <Tooltip title="Automatically adjust quality based on map zoom level for better performance.">
              <label className="flex items-center space-x-2 cursor-help">
                <ThunderboltOutlined />
                <span className="text-sm text-gray-700">Dynamic Quality</span>
              </label>
            </Tooltip>
          </Col>
          <Col>
            <Switch
              checked={mapSettings.enableDynamicQuality}
              onChange={(checked) => updateMapSettings({ enableDynamicQuality: checked })}
              size="small"
            />
          </Col>
        </Row>
      </div>
    </div>
  );
};
