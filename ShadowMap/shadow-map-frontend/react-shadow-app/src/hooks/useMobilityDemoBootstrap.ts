import { useEffect, useRef } from 'react';
import type { MobilityDataset } from '../types/index.ts';
import { parseMobilityCsv } from '../utils/mobilityCsv';
import demoCsv from '../../../../data/samples/mobility-demo.csv?raw';
import { useShadowMapStore } from '../store/shadowMapStore';

export const useMobilityDemoBootstrap = () => {
  const {
    mobilityDatasets,
    addMobilityDataset,
    setActiveMobilityDataset,
    setMobilityPlaybackTime,
    setMobilityPlaying,
    addStatusMessage,
  } = useShadowMapStore();
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (typeof window === 'undefined') return;
    if (mobilityDatasets.length > 0) return;
    if (!import.meta.env.DEV) return;

    const result = parseMobilityCsv(demoCsv);
    if (!result.rows.length) {
      console.warn('Mobility demo bootstrap failed: no rows parsed');
      return;
    }

    const sortedRows = [...result.rows].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    const fallbackBounds = result.bounds ?? {
      north: sortedRows[0].coordinates[1],
      south: sortedRows[0].coordinates[1],
      east: sortedRows[0].coordinates[0],
      west: sortedRows[0].coordinates[0],
    };
    const fallbackRange = result.timeRange ?? {
      start: sortedRows[0].timestamp,
      end: sortedRows[sortedRows.length - 1].timestamp,
    };

    const dataset: MobilityDataset = {
      id: 'mobility-demo',
      name: 'Mobility demo (HK)',
      color: '#fb923c',
      createdAt: new Date(),
      sourceFile: 'mobility-demo.csv',
      pointCount: sortedRows.length,
      traceIds: result.traceIds,
      bounds: fallbackBounds,
      timeRange: fallbackRange,
      visible: true,
      errors: result.errors,
    };

    addMobilityDataset(dataset, sortedRows);
    setActiveMobilityDataset(dataset.id);
    setMobilityPlaybackTime(dataset.timeRange.start);
    setMobilityPlaying(true);
    addStatusMessage?.('Loaded demo mobility dataset for preview.', 'info');
    bootstrappedRef.current = true;
  }, [
    mobilityDatasets.length,
    addMobilityDataset,
    setActiveMobilityDataset,
    setMobilityPlaybackTime,
    setMobilityPlaying,
    addStatusMessage,
  ]);
};
