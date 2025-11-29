import { useEffect, useMemo, useRef } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { TripsLayer } from '@deck.gl/geo-layers';
import type mapboxgl from 'mapbox-gl';
import type { MobilityCsvRecord } from '../types/index.ts';
import { useShadowMapStore } from '../store/shadowMapStore';

type TripDatum = {
  id: string;
  path: [number, number, number][];
  timestamps: number[];
  intensity: number;
};

const DEFAULT_TRAIL_SECONDS = 900;
const MIN_TRAIL_SECONDS = 45;
const MAX_TRAIL_SECONDS = 240;
const BASELINE_ALTITUDE_METERS = 0;
const FLOW_WIDTH_MIN = 5;
const FLOW_WIDTH_MAX = 20;
const DEFAULT_SPEED_HINT = 18;
const FLOW_COLOR_STOPS: Array<{ stop: number; color: [number, number, number] }> = [
  { stop: 0, color: [255, 241, 193] }, // pale amber
  { stop: 0.45, color: [253, 186, 116] },
  { stop: 0.75, color: [251, 146, 60] },
  { stop: 1, color: [220, 38, 38] }, // molten core
];

const hexToRgb = (hex: string): [number, number, number] => {
  const sanitized = hex?.replace('#', '') ?? 'ffffff';
  const bigint = Number.parseInt(sanitized.padStart(6, '0'), 16);
  return [
    (bigint >> 16) & 255,
    (bigint >> 8) & 255,
    bigint & 255,
  ];
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const mixColor = (
  base: [number, number, number],
  target: [number, number, number],
  ratio: number,
): [number, number, number] => ([
  Math.round(lerp(base[0], target[0], ratio)),
  Math.round(lerp(base[1], target[1], ratio)),
  Math.round(lerp(base[2], target[2], ratio)),
]);

const interpolateGradient = (value: number) => {
  const clamped = clamp(value, 0, 1);
  for (let index = 0; index < FLOW_COLOR_STOPS.length - 1; index++) {
    const current = FLOW_COLOR_STOPS[index];
    const next = FLOW_COLOR_STOPS[index + 1];
    if (clamped >= next.stop) continue;
    const span = next.stop - current.stop;
    const localT = span > 0 ? (clamped - current.stop) / span : 0;
    return mixColor(current.color, next.color, localT);
  }
  return FLOW_COLOR_STOPS[FLOW_COLOR_STOPS.length - 1].color;
};

const computeGlowColor = (color: [number, number, number]) => mixColor(color, interpolateGradient(0.8), 0.4);

const computeTraceIntensity = (records: MobilityCsvRecord[]) => {
  if (!records.length) return 0.35;
  const avgSpeed = records.reduce((sum, record) => sum + (record.speedKmh ?? DEFAULT_SPEED_HINT), 0) / records.length;
  const spanMs = records[records.length - 1].timestamp.getTime() - records[0].timestamp.getTime();
  const cadence = spanMs > 0 ? (records.length / (spanMs / 1000)) : records.length;
  const normalizedSpeed = avgSpeed / 45;
  const normalizedCadence = clamp(cadence / 4, 0, 1);
  return clamp(normalizedSpeed * 0.7 + normalizedCadence * 0.3, 0.25, 1);
};

const buildTrips = (rows: MobilityCsvRecord[], startDate: Date): TripDatum[] => {
  if (!rows.length) return [];

  const baseSeconds = startDate.getTime() / 1000;
  const groups = new Map<string, MobilityCsvRecord[]>();
  rows.forEach((record) => {
    const bucket = groups.get(record.traceId) ?? [];
    bucket.push(record);
    groups.set(record.traceId, bucket);
  });

  return Array.from(groups.entries()).map(([traceId, records]) => {
    const sorted = records.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (sorted.length < 2) {
      return null;
    }

    const path = sorted.map((record) => ([
      record.coordinates[0],
      record.coordinates[1],
      BASELINE_ALTITUDE_METERS,
    ]));
    const timestamps = sorted.map((record) => (record.timestamp.getTime() / 1000) - baseSeconds);

    return {
      id: traceId,
      path,
      timestamps,
      intensity: computeTraceIntensity(sorted),
    };
  }).filter((trip): trip is TripDatum => Boolean(trip));
};

export const useDeckMobilityFlow = () => {
  const {
    mobilityDatasets,
    mobilityTraces,
    activeMobilityDatasetId,
    mobilityPlaybackTime,
  } = useShadowMapStore();

  const overlayRef = useRef<MapboxOverlay | null>(null);
  const lastFitDatasetRef = useRef<string | null>(null);

  const flowState = useMemo(() => {
    if (!activeMobilityDatasetId) {
      return null;
    }
    const dataset = mobilityDatasets.find((item) => item.id === activeMobilityDatasetId && item.visible);
    if (!dataset) {
      return null;
    }
    const rows = mobilityTraces[dataset.id] ?? [];
    if (!rows.length) {
      return null;
    }
    const baseColor = hexToRgb(dataset.color);
    const timeSpanSeconds = Math.max(
      (dataset.timeRange.end.getTime() - dataset.timeRange.start.getTime()) / 1000,
      1,
    );
    const computedTrail = clamp(timeSpanSeconds * 0.2, MIN_TRAIL_SECONDS, MAX_TRAIL_SECONDS);
    const trailLength = Number.isFinite(computedTrail) ? computedTrail : DEFAULT_TRAIL_SECONDS;
    const trips = buildTrips(rows, dataset.timeRange.start);
    if (!trips.length) {
      return null;
    }
    return {
      datasetId: dataset.id,
      color: baseColor,
      glowColor: computeGlowColor(baseColor),
      trips,
      playbackBase: dataset.timeRange.start,
      trailLength,
      bounds: dataset.bounds,
    };
  }, [activeMobilityDatasetId, mobilityDatasets, mobilityTraces]);

  useEffect(() => {
    const ensureOverlay = () => {
      const map = (window as any)?.__shadowMapInstance as mapboxgl.Map | undefined;
      if (!map || overlayRef.current) return;

      const attachOverlay = () => {
        if (overlayRef.current || !map.getStyle()) {
          return;
        }
        overlayRef.current = new MapboxOverlay({ layers: [] });
        map.addControl(overlayRef.current);
      };

      if (!map.isStyleLoaded()) {
        const handleStyle = () => {
          map.off('styledata', handleStyle);
          attachOverlay();
        };
        map.on('styledata', handleStyle);
        return;
      }

      attachOverlay();
    };

    ensureOverlay();
    window.addEventListener('shadow-map-ready', ensureOverlay);

    return () => {
      window.removeEventListener('shadow-map-ready', ensureOverlay);
      const map = (window as any)?.__shadowMapInstance as mapboxgl.Map | undefined;
      if (overlayRef.current && map) {
        map.removeControl(overlayRef.current);
        overlayRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = (window as any)?.__shadowMapInstance as mapboxgl.Map | undefined;
    const overlay = overlayRef.current;
    if (!map || !overlay) {
      return;
    }

    const renderTrips = () => {
      if (!flowState || !flowState.trips.length) {
        overlay.setProps({ layers: [] });
        return;
      }
      const baseSeconds = flowState.playbackBase.getTime() / 1000;
      const currentSeconds = (mobilityPlaybackTime?.getTime() ?? flowState.playbackBase.getTime()) / 1000;
      const effectiveTrail = flowState.trailLength ?? DEFAULT_TRAIL_SECONDS;

      const deriveTripColor = (trip: TripDatum) => {
        const intensity = clamp(trip.intensity, 0.25, 1);
        const gradientColor = interpolateGradient(intensity);
        const blended = mixColor(gradientColor, flowState.glowColor, 0.35);
        const alpha = Math.round(210 + intensity * 35);
        return [...blended, alpha] as [number, number, number, number];
      };

      const deriveTripWidth = (trip: TripDatum) => {
        const intensity = clamp(trip.intensity, 0.25, 1);
        return lerp(FLOW_WIDTH_MIN, FLOW_WIDTH_MAX, intensity);
      };

      const tripsLayer = new TripsLayer({
        id: `deck-mobility-flow-${flowState.datasetId}`,
        data: flowState.trips,
        getPath: (d: TripDatum) => d.path,
        getTimestamps: (d: TripDatum) => d.timestamps,
        getColor: (d: TripDatum) => deriveTripColor(d),
        getWidth: (d: TripDatum) => deriveTripWidth(d),
        widthUnits: 'pixels',
        opacity: 0.92,
        widthMinPixels: FLOW_WIDTH_MIN,
        widthMaxPixels: FLOW_WIDTH_MAX,
        jointRounded: true,
        capRounded: true,
        fadeTrail: true,
        trailLength: effectiveTrail,
        currentTime: currentSeconds - baseSeconds,
        shadowEnabled: false,
        material: {
          ambient: 0.6,
          diffuse: 0.6,
          shininess: 20,
          specularColor: [255, 224, 173],
        },
      });

      overlay.setProps({ layers: [tripsLayer] });
    };

    if (!map.isStyleLoaded()) {
      const handler = () => {
        map.off('styledata', handler);
        renderTrips();
      };
      map.on('styledata', handler);
      return () => {
        map.off('styledata', handler);
      };
    }

    renderTrips();
  }, [flowState, mobilityPlaybackTime]);

  useEffect(() => {
    const map = (window as any)?.__shadowMapInstance as mapboxgl.Map | undefined;
    if (!map || !flowState?.bounds) {
      return;
    }

    const fitToDataset = () => {
      if (!flowState?.bounds) return;
      if (lastFitDatasetRef.current === flowState.datasetId) return;
      const { west, south, east, north } = flowState.bounds;
      map.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 160, maxZoom: 15.5, duration: 1200 },
      );
      lastFitDatasetRef.current = flowState.datasetId;
    };

    if (!map.isStyleLoaded()) {
      const handleStyle = () => {
        map.off('styledata', handleStyle);
        fitToDataset();
      };
      map.on('styledata', handleStyle);
      return () => {
        map.off('styledata', handleStyle);
      };
    }

    fitToDataset();
  }, [flowState?.bounds, flowState?.datasetId]);
};
