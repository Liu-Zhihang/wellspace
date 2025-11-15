import { useEffect } from 'react';
import { useShadowMapStore } from '../store/shadowMapStore';

export const useMobilityPlayback = () => {
  const { activeMobilityDatasetId, mobilityTraces, isAnimating, currentDate } = useShadowMapStore();

  useEffect(() => {
    if (!activeMobilityDatasetId) {
      return;
    }

    const rows = mobilityTraces[activeMobilityDatasetId];
    if (!rows || !rows.length) {
      return;
    }

    // TODO: implement animation sync / heatmap calculations
  }, [activeMobilityDatasetId, mobilityTraces, isAnimating, currentDate]);
};
