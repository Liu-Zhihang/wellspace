import React, { useState } from 'react'
import { Popover, Tooltip } from 'antd'
import { ClockIcon, SwatchIcon, GlobeAltIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { TimeControlPanel } from '../Controls/TimeControlPanel'
import { ShadowControlPanel } from '../Controls/ShadowControlPanel'
import { MapStylePanel } from '../Controls/MapStylePanel'

type PanelKey = 'time' | 'shadow' | 'style' | 'upload' | null

interface CleanControlPanelProps {
  className?: string
}

export const CleanControlPanel: React.FC<CleanControlPanelProps> = ({ className = '' }) => {
  const [openPanel, setOpenPanel] = useState<PanelKey>(null)

  const panelConfigs: Array<{
    id: Exclude<PanelKey, null>
    label: string
    icon: React.ReactNode
    content: React.ReactNode
  }> = [
    { id: 'time', label: 'Time controls', icon: <ClockIcon className="h-5 w-5" />, content: <TimeControlPanel /> },
    { id: 'shadow', label: 'Shadow settings', icon: <SwatchIcon className="h-5 w-5" />, content: <ShadowControlPanel /> },
    { id: 'style', label: 'Map style', icon: <GlobeAltIcon className="h-5 w-5" />, content: <MapStylePanel /> },
    {
      id: 'upload',
      label: 'Upload mobility trace',
      icon: <ArrowUpTrayIcon className="h-5 w-5" />,
      content: (
        <div className="w-64 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Upload mobility trace</h3>
            <p className="text-xs text-gray-500">
              Provide a GeoJSON FeatureCollection with timestamped points or a LineString so the simulator can replay the route.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>('input[data-role=\"trace-upload-input\"]')
              input?.click()
            }}
            className="w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-600 transition hover:border-slate-400 hover:bg-slate-100"
          >
            Select GeoJSON file…
          </button>
          <ul className="space-y-1 text-xs text-gray-500">
            <li>• Supports Point, MultiPoint, or LineString geometries</li>
            <li>• Each point must include a timestamp (ISO string or milliseconds)</li>
            <li>• Playback will interpolate map view and shadow time for each waypoint</li>
          </ul>
        </div>
      ),
    },
  ]

  const handleOpenChange = (panelId: Exclude<PanelKey, null>, visible: boolean) => {
    setOpenPanel((current) => {
      if (!visible && current === panelId) {
        return null
      }
      return visible ? panelId : current
    })
  }

  const handleButtonClick = (panelId: Exclude<PanelKey, null>) => {
    setOpenPanel((current) => (current === panelId ? null : panelId))
  }

  return (
    <div
      className={`pointer-events-auto absolute z-40 inline-flex flex-col gap-4 ${className}`}
      style={{ left: '1.5rem', bottom: '7rem', width: 'fit-content' }}
    >
      {panelConfigs.map((panel) => (
        <Popover
          key={panel.id}
          trigger="click"
          placement="right"
          open={openPanel === panel.id}
          onOpenChange={(visible) => handleOpenChange(panel.id, visible)}
          overlayClassName="shadow-map-toolbar-popover"
          overlayStyle={{ width: 340, maxWidth: 'calc(100vw - 4rem)' }}
          content={panel.content}
        >
          <Tooltip title={panel.label} placement="right">
            <button
              type="button"
              onClick={() => handleButtonClick(panel.id)}
              className={`flex h-12 w-12 items-center justify-center rounded-xl border transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white ${
                openPanel === panel.id
                  ? 'border-blue-400 bg-blue-600 text-white shadow-xl focus:ring-blue-300'
                  : 'border-transparent bg-white text-slate-600 shadow-lg hover:bg-slate-100 focus:ring-blue-200'
              }`}
              aria-pressed={openPanel === panel.id}
            >
              {panel.icon}
            </button>
          </Tooltip>
        </Popover>
      ))}
    </div>
  )
}
