import { useEffect, useMemo, useRef } from 'react';
import { useShadowMapStore } from '../store/shadowMapStore';

const PLAYBACK_INTERVAL_MS = 250;
const PLAYBACK_TIMESTEP_MS = 15_000; // advance 15s of trace time per tick

export const useMobilityPlayback = () => {
  const {
    activeMobilityDatasetId,
    mobilityTraces,
    mobilityPlaybackTime,
    setMobilityPlaybackTime,
    isMobilityPlaying,
  } = useShadowMapStore();
  const playbackMsRef = useRef<number | null>(null);

  const currentRows = useMemo(() => {
    if (!activeMobilityDatasetId) {
      return [];
    }
    return mobilityTraces[activeMobilityDatasetId] ?? [];
  }, [activeMobilityDatasetId, mobilityTraces]);

  const playbackInstant = useMemo(() => {
    if (mobilityPlaybackTime) return mobilityPlaybackTime;
    if (!currentRows.length) return null;
    return currentRows[0].timestamp;
  }, [mobilityPlaybackTime, currentRows]);

  useEffect(() => {
    playbackMsRef.current = playbackInstant?.getTime() ?? null;
  }, [playbackInstant]);

  useEffect(() => {
    if (!currentRows.length) return;
    if (!playbackInstant) {
      setMobilityPlaybackTime(currentRows[0].timestamp);
      return;
    }
    const start = currentRows[0].timestamp.getTime();
    const end = currentRows[currentRows.length - 1].timestamp.getTime();
    const currentMs = playbackInstant.getTime();
    if (currentMs < start || currentMs > end) {
      setMobilityPlaybackTime(new Date(start));
    }
  }, [currentRows, playbackInstant, setMobilityPlaybackTime]);

  useEffect(() => {
    if (!isMobilityPlaying || !currentRows.length || !activeMobilityDatasetId) {
      return;
    }

    const start = currentRows[0].timestamp.getTime();
    const end = currentRows[currentRows.length - 1].timestamp.getTime();
    let latest = playbackMsRef.current ?? start;

    const interval = window.setInterval(() => {
      latest += PLAYBACK_TIMESTEP_MS;
      if (latest > end) {
        latest = start;
      }
      playbackMsRef.current = latest;
      setMobilityPlaybackTime(new Date(latest));
    }, PLAYBACK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    isMobilityPlaying,
    currentRows,
    activeMobilityDatasetId,
    setMobilityPlaybackTime,
  ]);

  useEffect(() => {
    return () => {
      const map = (window as any)?.__shadowMapInstance;
      if (!map) return;
      const heatmapLayer = map.getLayer?.('mobility-heatmap-layer');
      if (heatmapLayer) {
        map.removeLayer?.('mobility-heatmap-layer');
      }
      if (map.getSource?.('mobility-heatmap-source')) {
        map.removeSource?.('mobility-heatmap-source');
      }
    };
  }, []);
};
