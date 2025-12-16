import { useEffect, useMemo, useRef } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { TripsLayer, PathLayer, ScatterplotLayer } from 'deck.gl';
import type mapboxgl from 'mapbox-gl';
import type { MobilityCsvRecord, MobilitySunlightSample } from '../types/index.ts';
import { useShadowMapStore } from '../store/shadowMapStore';

type TripDatum = {
  id: string;
  path: [number, number, number][];
  timestamps: number[];
  intensity: number;
  sourceRows: number[];
};

type SegmentDatum = {
  id: string;
  path: [number, number, number][];
  intensity: number;
  startRow: number;
  endRow: number;
  sunlit?: 0 | 1;
};

type RenderablePathDatum = {
  id: string;
  path: [number, number, number][];
  color: [number, number, number, number];
  width: number;
};

const DEFAULT_TRAIL_SECONDS = 900;
const MIN_TRAIL_SECONDS = 45;
const MAX_TRAIL_SECONDS = 240;
const BASELINE_ALTITUDE_METERS = 0;
const FLOW_WIDTH_MIN = 5;
const FLOW_WIDTH_MAX = 20;
const DEFAULT_SPEED_HINT = 18;
const PATH_WIDTH_MIN = 3;
const PATH_WIDTH_MAX = 9;
const PATH_OUTER_HALO_EXTRA = 10;
const PATH_INNER_HALO_EXTRA = 6;
const MARKER_RADIUS_PX = 6;
const BUILDING_QUERY_LAYER_ID = 'clean-buildings-extrusion';
const BUILDING_QUERY_TOLERANCE_PX = 2;
const INDOOR_DASH_LENGTH_METERS = 14;
const INDOOR_GAP_LENGTH_METERS = 10;
const SUNLIT_BASE_COLOR: [number, number, number] = [245, 158, 11]; // #f59e0b
const SHADOW_BASE_COLOR: [number, number, number] = [56, 189, 248]; // #38bdf8
const INDOOR_NEUTRAL_COLOR: [number, number, number] = [148, 163, 184]; // #94a3b8
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

const approximateDistanceMeters = (a: [number, number], b: [number, number]) => {
  const metersPerDegreeLat = 111_320;
  const meanLatRad = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(meanLatRad);
  const dx = (b[0] - a[0]) * metersPerDegreeLon;
  const dy = (b[1] - a[1]) * metersPerDegreeLat;
  return Math.sqrt(dx * dx + dy * dy);
};

const interpolateLngLat = (a: [number, number], b: [number, number], t: number): [number, number] => ([
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
]);

const dashifySegment = (
  start: [number, number],
  end: [number, number],
  dashMeters: number,
  gapMeters: number,
): Array<[number, number, number][]> => {
  const total = approximateDistanceMeters(start, end);
  if (!Number.isFinite(total) || total <= 0) {
    return [[
      [start[0], start[1], BASELINE_ALTITUDE_METERS],
      [end[0], end[1], BASELINE_ALTITUDE_METERS],
    ]];
  }
  if (total < dashMeters * 1.25) {
    return [[
      [start[0], start[1], BASELINE_ALTITUDE_METERS],
      [end[0], end[1], BASELINE_ALTITUDE_METERS],
    ]];
  }

  const stride = dashMeters + gapMeters;
  const segments: Array<[number, number, number][]> = [];
  let travelled = 0;
  while (travelled < total) {
    const dashStart = travelled;
    const dashEnd = Math.min(travelled + dashMeters, total);
    const t0 = dashStart / total;
    const t1 = dashEnd / total;
    const p0 = interpolateLngLat(start, end, t0);
    const p1 = interpolateLngLat(start, end, t1);
    segments.push([
      [p0[0], p0[1], BASELINE_ALTITUDE_METERS],
      [p1[0], p1[1], BASELINE_ALTITUDE_METERS],
    ]);
    travelled += stride;
  }
  return segments;
};

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
    const sourceRows = sorted.map((record) => record.sourceRow);

    return {
      id: traceId,
      path,
      timestamps,
      intensity: computeTraceIntensity(sorted),
      sourceRows,
    };
  }).filter((trip): trip is TripDatum => Boolean(trip));
};

const findTripPositionAtTime = (trip: TripDatum, relativeSeconds: number): [number, number] | null => {
  if (!trip.timestamps.length || !trip.path.length) return null;
  const clampedTime = clamp(relativeSeconds, trip.timestamps[0], trip.timestamps[trip.timestamps.length - 1]);

  let low = 0;
  let high = trip.timestamps.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (trip.timestamps[mid] < clampedTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const index = clamp(low, 0, trip.path.length - 1);
  return [trip.path[index][0], trip.path[index][1]];
};

export const useDeckMobilityFlow = () => {
  const {
    mobilityDatasets,
    mobilityTraces,
    mobilitySunlight,
    activeMobilityDatasetId,
    mobilityPlaybackTime,
    mobilityFlowStyle,
    figureModeEnabled,
    mobilityColorBySunlight,
    mobilityInferIndoor,
    mobilityDashIndoor,
    mobilityPathWidthScale,
  } = useShadowMapStore();

  const overlayRef = useRef<MapboxOverlay | null>(null);
  const lastFitDatasetRef = useRef<string | null>(null);
  const indoorCacheRef = useRef<Map<number, boolean>>(new Map());
  const indoorCacheDatasetRef = useRef<string | null>(null);

  const sunlightBySourceRow = useMemo(() => {
    if (!activeMobilityDatasetId) return null;
    const samples = mobilitySunlight[activeMobilityDatasetId];
    if (!samples?.length) return null;
    const map = new Map<number, MobilitySunlightSample>();
    samples.forEach((sample) => map.set(sample.sourceRow, sample));
    return map;
  }, [activeMobilityDatasetId, mobilitySunlight]);

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

  const segmentBlueprint = useMemo(() => {
    if (!flowState?.trips?.length) return null;
    const wantsSunColoring = mobilityColorBySunlight && Boolean(sunlightBySourceRow?.size);
    const shouldSegment = wantsSunColoring || mobilityInferIndoor;
    if (!shouldSegment) return null;

    const segments: SegmentDatum[] = [];
    flowState.trips.forEach((trip) => {
      for (let index = 0; index < trip.path.length - 1; index++) {
        const startRow = trip.sourceRows[index];
        const endRow = trip.sourceRows[index + 1];
        const sunlit = wantsSunColoring ? sunlightBySourceRow?.get(startRow)?.sunlit : undefined;
        segments.push({
          id: `${trip.id}-${index}`,
          path: [trip.path[index], trip.path[index + 1]],
          intensity: trip.intensity,
          startRow,
          endRow,
          sunlit,
        });
      }
    });

    return { datasetId: flowState.datasetId, segments, wantsSunColoring };
  }, [flowState, mobilityColorBySunlight, mobilityInferIndoor, sunlightBySourceRow]);

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

      const derivePathWidth = (trip: TripDatum) => {
        const intensity = clamp(trip.intensity, 0.25, 1);
        return lerp(PATH_WIDTH_MIN, PATH_WIDTH_MAX, intensity) * (mobilityPathWidthScale ?? 1);
      };

      const renderMode = figureModeEnabled ? 'path' : (mobilityFlowStyle ?? 'trips');
      if (renderMode === 'trips') {
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
        return;
      }

      const markerData: Array<{
        kind: 'start' | 'end' | 'current';
        position: [number, number];
      }> = [];

      const currentRelativeSeconds = currentSeconds - baseSeconds;
      flowState.trips.forEach((trip) => {
        if (trip.path.length) {
          markerData.push({ kind: 'start', position: [trip.path[0][0], trip.path[0][1]] });
          const last = trip.path[trip.path.length - 1];
          markerData.push({ kind: 'end', position: [last[0], last[1]] });
        }
        const currentPosition = findTripPositionAtTime(trip, currentRelativeSeconds);
        if (currentPosition) {
          markerData.push({ kind: 'current', position: currentPosition });
        }
      });

      if (indoorCacheDatasetRef.current !== flowState.datasetId) {
        indoorCacheRef.current.clear();
        indoorCacheDatasetRef.current = flowState.datasetId;
      }

      const widthScale = mobilityPathWidthScale ?? 1;
      const isRenderablePathDatum = (datum: TripDatum | RenderablePathDatum): datum is RenderablePathDatum =>
        typeof (datum as any).width === 'number';

      const buildRenderablePathData = (): TripDatum[] | RenderablePathDatum[] => {
        if (!segmentBlueprint?.segments?.length || segmentBlueprint.datasetId !== flowState.datasetId) {
          return flowState.trips;
        }

        const wantsSunColoring = segmentBlueprint.wantsSunColoring;
        const wantsIndoor = mobilityInferIndoor;
        const dashIndoor = mobilityDashIndoor && mobilityInferIndoor;
        const queryLayers = map.getLayer(BUILDING_QUERY_LAYER_ID) ? [BUILDING_QUERY_LAYER_ID] : [];

        const isIndoorPoint = (rowId: number, position: [number, number]): boolean => {
          const cached = indoorCacheRef.current.get(rowId);
          if (typeof cached === 'boolean') return cached;
          if (!wantsIndoor || !queryLayers.length) {
            indoorCacheRef.current.set(rowId, false);
            return false;
          }
          try {
            const projected = map.project(position);
            const features = map.queryRenderedFeatures(
              [
                [projected.x - BUILDING_QUERY_TOLERANCE_PX, projected.y - BUILDING_QUERY_TOLERANCE_PX],
                [projected.x + BUILDING_QUERY_TOLERANCE_PX, projected.y + BUILDING_QUERY_TOLERANCE_PX],
              ],
              { layers: queryLayers },
            );
            const indoor = features.length > 0;
            indoorCacheRef.current.set(rowId, indoor);
            return indoor;
          } catch {
            indoorCacheRef.current.set(rowId, false);
            return false;
          }
        };

        const deriveSegmentColor = (segment: SegmentDatum): [number, number, number, number] => {
          const intensity = clamp(segment.intensity, 0.25, 1);
          const base = wantsSunColoring && typeof segment.sunlit === 'number'
            ? (segment.sunlit === 1 ? SUNLIT_BASE_COLOR : SHADOW_BASE_COLOR)
            : interpolateGradient(intensity);
          const blended = mixColor(base, [255, 255, 255], 0.12);
          const alpha = Math.round(200 + intensity * 45);
          return [...blended, alpha] as [number, number, number, number];
        };

        const output: RenderablePathDatum[] = [];
        segmentBlueprint.segments.forEach((segment) => {
          const start: [number, number] = [segment.path[0][0], segment.path[0][1]];
          const end: [number, number] = [segment.path[1][0], segment.path[1][1]];
          const indoorStart = isIndoorPoint(segment.startRow, start);
          const indoorEnd = isIndoorPoint(segment.endRow, end);
          const indoor = wantsIndoor && (indoorStart || indoorEnd);

          const intensity = clamp(segment.intensity, 0.25, 1);
          const width = lerp(PATH_WIDTH_MIN, PATH_WIDTH_MAX, intensity) * widthScale;
          const baseColor = deriveSegmentColor(segment);
          const color = indoor
            ? ([
                ...mixColor(baseColor.slice(0, 3) as [number, number, number], INDOOR_NEUTRAL_COLOR, 0.55),
                Math.round(baseColor[3] * 0.7),
              ] as [number, number, number, number])
            : baseColor;

          if (indoor && dashIndoor) {
            const pieces = dashifySegment(start, end, INDOOR_DASH_LENGTH_METERS, INDOOR_GAP_LENGTH_METERS);
            pieces.forEach((piece, index) => {
              output.push({
                id: `${segment.id}-dash-${index}`,
                path: piece,
                color,
                width,
              });
            });
            return;
          }

          output.push({
            id: segment.id,
            path: segment.path,
            color,
            width,
          });
        });

        return output;
      };

      const renderData = buildRenderablePathData();

      const outerHaloLayer = new PathLayer({
        id: `deck-mobility-path-halo-outer-${flowState.datasetId}`,
        data: renderData,
        getPath: (d: TripDatum | RenderablePathDatum) => d.path,
        getColor: (_d: TripDatum | RenderablePathDatum) => [0, 0, 0, 140],
        getWidth: (d: TripDatum | RenderablePathDatum) =>
          (isRenderablePathDatum(d) ? d.width : derivePathWidth(d as TripDatum)) + PATH_OUTER_HALO_EXTRA,
        widthUnits: 'pixels',
        opacity: 0.9,
        widthMinPixels: PATH_WIDTH_MIN * widthScale + PATH_OUTER_HALO_EXTRA,
        widthMaxPixels: PATH_WIDTH_MAX * widthScale + PATH_OUTER_HALO_EXTRA,
        jointRounded: true,
        capRounded: true,
        pickable: false,
        parameters: { depthTest: false },
      });

      const innerHaloLayer = new PathLayer({
        id: `deck-mobility-path-halo-inner-${flowState.datasetId}`,
        data: renderData,
        getPath: (d: TripDatum | RenderablePathDatum) => d.path,
        getColor: (_d: TripDatum | RenderablePathDatum) => [255, 255, 255, 170],
        getWidth: (d: TripDatum | RenderablePathDatum) =>
          (isRenderablePathDatum(d) ? d.width : derivePathWidth(d as TripDatum)) + PATH_INNER_HALO_EXTRA,
        widthUnits: 'pixels',
        opacity: 0.9,
        widthMinPixels: PATH_WIDTH_MIN * widthScale + PATH_INNER_HALO_EXTRA,
        widthMaxPixels: PATH_WIDTH_MAX * widthScale + PATH_INNER_HALO_EXTRA,
        jointRounded: true,
        capRounded: true,
        pickable: false,
        parameters: { depthTest: false },
      });

      const mainPathLayer = new PathLayer({
        id: `deck-mobility-path-${flowState.datasetId}`,
        data: renderData,
        getPath: (d: TripDatum | RenderablePathDatum) => d.path,
        getColor: (d: TripDatum | RenderablePathDatum) =>
          isRenderablePathDatum(d) ? d.color : deriveTripColor(d as TripDatum),
        getWidth: (d: TripDatum | RenderablePathDatum) =>
          isRenderablePathDatum(d) ? d.width : derivePathWidth(d as TripDatum),
        widthUnits: 'pixels',
        opacity: 0.98,
        widthMinPixels: PATH_WIDTH_MIN * widthScale,
        widthMaxPixels: PATH_WIDTH_MAX * widthScale,
        jointRounded: true,
        capRounded: true,
        pickable: false,
        parameters: { depthTest: false },
      });

      const markersLayer = new ScatterplotLayer({
        id: `deck-mobility-markers-${flowState.datasetId}`,
        data: markerData,
        getPosition: (d: { position: [number, number] }) => d.position,
        getRadius: () => MARKER_RADIUS_PX,
        radiusUnits: 'pixels',
        radiusMinPixels: MARKER_RADIUS_PX,
        stroked: true,
        filled: true,
        lineWidthUnits: 'pixels',
        getLineWidth: () => 2,
        getLineColor: () => [15, 23, 42, 220],
        getFillColor: (d: { kind: 'start' | 'end' | 'current' }) => {
          if (d.kind === 'start') return [34, 197, 94, 230];
          if (d.kind === 'end') return [239, 68, 68, 230];
          return [250, 204, 21, 245];
        },
        pickable: false,
        parameters: { depthTest: false },
      });

      overlay.setProps({ layers: [outerHaloLayer, innerHaloLayer, mainPathLayer, markersLayer] });
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
  }, [
    flowState,
    mobilityPlaybackTime,
    mobilityFlowStyle,
    figureModeEnabled,
    segmentBlueprint,
    mobilityInferIndoor,
    mobilityDashIndoor,
    mobilityPathWidthScale,
  ]);

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
        {
          padding: 160,
          maxZoom: 15.5,
          duration: 1200,
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        },
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
