import React, { useState } from 'react'
import { Popover, Tooltip } from 'antd'
import { ClockIcon, SwatchIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { TimeControlPanel } from '../Controls/TimeControlPanel'
import { ShadowControlPanel } from '../Controls/ShadowControlPanel'
import { MapStylePanel } from '../Controls/MapStylePanel'

type PanelKey = 'time' | 'shadow' | 'style' | null

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
