import React, { useMemo, useRef, useState } from 'react';
import { Button, Popover, Slider, Switch, Tooltip } from 'antd';
import {
  ClockCircleOutlined,
  BgColorsOutlined,
  GlobalOutlined,
  CloudUploadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { useShadowMapStore } from '../../store/shadowMapStore';

type PanelId = 'time' | 'shadow' | 'style' | 'upload' | null;

const presetHours = [
  { hour: 6, label: 'Sunrise' },
  { hour: 12, label: 'Noon' },
  { hour: 18, label: 'Sunset' },
];

const baseMapPresets = [
  { id: 'osm', name: 'OpenStreetMap', description: 'Balanced street map', badge: 'Default' },
  { id: 'satellite', name: 'Satellite', description: 'High-resolution imagery' },
  { id: 'terrain', name: 'Terrain', description: 'Topographic relief' },
  { id: 'dark', name: 'Dark Mode', description: 'Low-light friendly' },
];

export const LeftIconToolbar: React.FC = () => {
  const {
    currentDate,
    setCurrentDate,
    isAnimating,
    setIsAnimating,
    mapSettings,
    updateMapSettings,
    addStatusMessage,
  } = useShadowMapStore();

  const [openPanel, setOpenPanel] = useState<PanelId>(null);
  const [selectedBaseMap, setSelectedBaseMap] = useState<string>('osm');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const formattedDate = useMemo(
    () => new Date(currentDate).toLocaleString(undefined, { hour12: false }),
    [currentDate],
  );

  const handleOpenChange = (panelId: PanelId, nextOpen: boolean) => {
    setOpenPanel((prev) => {
      if (!nextOpen && prev === panelId) {
        return null;
      }
      return nextOpen ? panelId : prev;
    });
  };

  const setPresetHour = (hour: number) => {
    const next = new Date(currentDate);
    next.setHours(hour, 0, 0, 0);
    setCurrentDate(next);
  };

  const toggleAnimation = () => setIsAnimating(!isAnimating);

  const handleBaseMapChange = (mapId: string) => {
    setSelectedBaseMap(mapId);
    // TODO: Wire into map instance once baseMapManager is exposed here.
    const preset = baseMapPresets.find((item) => item.id === mapId);
    addStatusMessage?.(`Base map switched to ${preset?.name ?? mapId}`);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    const readableNames = files.map((file) => file.name).join(', ');
    addStatusMessage?.(`Files queued for import: ${readableNames}`);
    console.log('Selected overlay files', files);
    setOpenPanel(null);
  };

  const renderPanelContent = (panelId: Exclude<PanelId, null>): React.ReactNode => {
    if (panelId === 'time') {
      return (
        <div className="w-64 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Date & Time</span>
            <span className="text-xs text-gray-500">{formattedDate}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {presetHours.map((preset) => (
              <Button
                key={preset.hour}
                size="small"
                type="text"
                className="rounded-lg bg-slate-100 hover:bg-slate-200 text-gray-700"
                onClick={() => setPresetHour(preset.hour)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <Button
              type={isAnimating ? 'default' : 'primary'}
              icon={isAnimating ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={toggleAnimation}
            >
              {isAnimating ? 'Pause' : 'Animate'}
            </Button>
            <span className="text-xs text-gray-500">Timeline playback</span>
          </div>
        </div>
      );
    }

    if (panelId === 'shadow') {
      return (
        <div className="w-64 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Shadow Layer</span>
            <Switch
              size="small"
              checked={mapSettings.showShadowLayer}
              onChange={(checked) => updateMapSettings({ showShadowLayer: checked })}
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>Opacity</span>
              <span>{Math.round(mapSettings.shadowOpacity * 100)}%</span>
            </div>
            <Slider
              min={10}
              max={100}
              step={5}
              value={Math.round(mapSettings.shadowOpacity * 100)}
              onChange={(value) => updateMapSettings({ shadowOpacity: (value as number) / 100 })}
              tooltip={{ open: false }}
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Color</span>
            <input
              type="color"
              value={mapSettings.shadowColor}
              onChange={(event) => updateMapSettings({ shadowColor: event.target.value })}
              className="h-7 w-12 cursor-pointer rounded border border-gray-300"
            />
          </div>
        </div>
      );
    }

    if (panelId === 'style') {
      return (
        <div className="w-64 space-y-2">
          <span className="text-sm font-semibold text-gray-800">Base Map</span>
          {baseMapPresets.map((preset) => (
            <Button
              key={preset.id}
              block
              className={`text-left normal-case flex items-start justify-between rounded-xl border transition-colors ${
                selectedBaseMap === preset.id
                  ? 'border-blue-400 bg-blue-50 text-blue-700'
                  : 'border-transparent bg-slate-100 text-gray-700 hover:bg-slate-200'
              }`}
              onClick={() => handleBaseMapChange(preset.id)}
            >
              <span>
                <span className="block text-sm font-medium">{preset.name}</span>
                <span className="block text-xs text-gray-500">{preset.description}</span>
              </span>
              {preset.badge && (
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-600">{preset.badge}</span>
              )}
            </Button>
          ))}
          <span className="text-[11px] text-gray-400">Coming soon: direct Mapbox / custom style URL.</span>
        </div>
      );
    }

    return (
      <div className="w-72 space-y-3">
        <div>
          <span className="text-sm font-semibold text-gray-800">Add file to map</span>
          <p className="text-xs text-gray-500">Supported: .tif .tiff .gpx .kml .json .geojson</p>
        </div>
        <Button type="primary" icon={<CloudUploadOutlined />} onClick={handleUploadClick} className="w-full">
          Choose files
        </Button>
        <div className="rounded-lg bg-slate-50 p-3 text-[11px] text-gray-500">
          Drag & drop support and on-map placement tools are planned. For now we will auto-align the uploaded layer to the current viewport.
        </div>
      </div>
    );
  };

  const toolbarItems: Array<{
    id: Exclude<PanelId, null>;
    label: string;
    icon: React.ReactNode;
  }> = [
    { id: 'time', label: 'Time controls', icon: <ClockCircleOutlined /> },
    { id: 'shadow', label: 'Shadow settings', icon: <BgColorsOutlined /> },
    { id: 'style', label: 'Map style', icon: <GlobalOutlined /> },
    { id: 'upload', label: 'Add file to map', icon: <CloudUploadOutlined /> },
  ];

  return (
    <div
      className="fixed z-50"
      style={{ left: '1.5rem', bottom: '6rem' }}
    >
      <div className="rounded-2xl border border-white/50 bg-white/90 p-3 shadow-2xl backdrop-blur-md">
        <div className="flex flex-col gap-3">
          {toolbarItems.map((item) => (
            <Popover
              key={item.id}
              trigger="click"
              placement="right"
              overlayClassName="shadow-map-toolbar-popover"
              overlayStyle={{ zIndex: 1400 }}
              open={openPanel === item.id}
              onOpenChange={(open) => handleOpenChange(item.id, open)}
              content={renderPanelContent(item.id)}
            >
              <Tooltip title={item.label} placement="right">
                <button
                  type="button"
                  className={`flex h-12 w-12 items-center justify-center rounded-xl border transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white ${
                    openPanel === item.id
                      ? 'border-blue-400 bg-blue-600 text-white shadow-xl'
                      : 'border-transparent bg-white text-slate-600 shadow-lg hover:bg-slate-100'
                  }`}
                >
                  <span className="text-lg">{item.icon}</span>
                </button>
              </Tooltip>
            </Popover>
          ))}
        </div>
      </div>

      {/* Hidden file input to support uploads */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".tif,.tiff,.gpx,.kml,.json,.geojson"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />
    </div>
  );
};

export default LeftIconToolbar;
