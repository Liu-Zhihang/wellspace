import React from 'react';
import { TimeControlPanel } from '../Controls/TimeControlPanel';
import { ShadowControlPanel } from '../Controls/ShadowControlPanel';
import { MapStylePanel } from '../Controls/MapStylePanel';

interface CleanControlPanelProps {
  className?: string;
}

export const CleanControlPanel: React.FC<CleanControlPanelProps> = ({ className = '' }) => {
  return (
    <div className={`absolute top-20 left-4 z-50 w-80 max-w-[90vw] space-y-3 ${className}`}>
      {/* Time Control Panel */}
      <TimeControlPanel />
      
      {/* Shadow Control Panel */}
      <ShadowControlPanel />
      
      {/* Map Style Panel */}
      <MapStylePanel />
    </div>
  );
};
