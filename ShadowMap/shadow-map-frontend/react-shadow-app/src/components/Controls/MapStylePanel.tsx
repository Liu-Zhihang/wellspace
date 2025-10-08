import React, { useState } from 'react';
import { Button, Radio, Space } from 'antd';
import { GlobalOutlined, PictureOutlined } from '@ant-design/icons';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { baseMapManager } from '../../services/baseMapManager';

export const MapStylePanel: React.FC = () => {
  const [selectedMap, setSelectedMap] = useState('osm');
  const [isExpanded, setIsExpanded] = useState(false);

  const baseMaps = [
    { id: 'osm', name: 'OpenStreetMap', icon: '🗺️', desc: 'Standard map' },
    { id: 'satellite', name: 'Satellite', icon: '🛰️', desc: 'Aerial imagery' },
    { id: 'terrain', name: 'Terrain', icon: '⛰️', desc: 'Topographic' },
    { id: 'dark', name: 'Dark', icon: '🌙', desc: 'Dark theme' },
  ];

  const handleMapChange = (mapId: string) => {
    setSelectedMap(mapId);
    // TODO: Integrate with map instance
    console.log('Switching to map:', mapId);
  };

  return (
    <div className="bg-white backdrop-blur-sm rounded-lg p-4 shadow-lg border border-gray-200">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <GlobalOutlined />
          Map Style
        </h3>
        <Button
          type="text"
          size="small"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? 'Collapse' : 'Expand'}
        </Button>
      </div>

      {isExpanded ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Radio.Group
            value={selectedMap}
            onChange={(e) => handleMapChange(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              {baseMaps.map((map) => (
                <Radio
                  key={map.id}
                  value={map.id}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    background: selectedMap === map.id ? '#f0f9ff' : 'transparent',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{map.icon}</span>
                    <div>
                      <div className="text-sm font-medium">{map.name}</div>
                      <div className="text-xs text-gray-500">{map.desc}</div>
                    </div>
                  </div>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Space>
      ) : (
        <div className="flex items-center gap-2 p-2 bg-gray-50 rounded">
          <span className="text-lg">
            {baseMaps.find((m) => m.id === selectedMap)?.icon}
          </span>
          <div>
            <div className="text-sm font-medium">
              {baseMaps.find((m) => m.id === selectedMap)?.name}
            </div>
            <div className="text-xs text-gray-500">
              {baseMaps.find((m) => m.id === selectedMap)?.desc}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
