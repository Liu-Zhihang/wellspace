import React from 'react'
import { TimeControlPanel } from '../Controls/TimeControlPanel'
import { ShadowControlPanel } from '../Controls/ShadowControlPanel'
import { MapStylePanel } from '../Controls/MapStylePanel'

interface CleanControlPanelProps {
  className?: string
}

export const CleanControlPanel: React.FC<CleanControlPanelProps> = ({ className = '' }) => {
  return (
    <div
      className={`absolute z-40 w-80 max-w-[90vw] space-y-4 ${className}`}
      style={{ left: '1.5rem', bottom: '7rem' }}
    >
      <TimeControlPanel />
      <ShadowControlPanel />
      <MapStylePanel />
    </div>
  )
}
