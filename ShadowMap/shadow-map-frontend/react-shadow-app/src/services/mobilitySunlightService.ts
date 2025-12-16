import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { shadowAnalysisClient } from './shadowAnalysisService';
import SunCalc from 'suncalc';
import { weatherService } from './weatherService';
import type {
  BoundingBox,
  MobilityCsvRecord,
  MobilitySunlightSample,
  MobilitySunlightProgress,
} from '../types/index.ts';

type PolygonGeometry = Polygon | MultiPolygon;

const buildBounds = (rows: MobilityCsvRecord[]): BoundingBox => {
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;

  rows.forEach(({ coordinates: [lng, lat] }) => {
    north = Math.max(north, lat);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    west = Math.min(west, lng);
  });

  return { north, south, east, west };
};

const ensureNonZeroBounds = (bounds: BoundingBox): BoundingBox => {
  const epsilon = 1e-5; // ~1m at mid-latitudes
  let { west, east, south, north } = bounds;
  if (east - west <= 0) {
    west -= epsilon;
    east += epsilon;
  }
  if (north - south <= 0) {
    south -= epsilon;
    north += epsilon;
  }
  return { west, east, south, north };
};

const isNighttimeError = (message: string) =>
  message.toLowerCase().includes('before sunrise') || message.toLowerCase().includes('after sunset');

const isNighttimeBucket = (bounds: BoundingBox, timestamp: Date): boolean => {
  const centerLat = (bounds.north + bounds.south) / 2;
  const centerLng = (bounds.east + bounds.west) / 2;
  const times = SunCalc.getTimes(timestamp, centerLat, centerLng);
  if (!times.sunrise || !times.sunset) return false;
  return timestamp < times.sunrise || timestamp > times.sunset;
};

const isDegenerateBounds = (bounds: BoundingBox): boolean => {
  const width = Math.abs(bounds.east - bounds.west);
  const height = Math.abs(bounds.north - bounds.south);
  const nearZero = Math.abs(bounds.east) < 1e-4 && Math.abs(bounds.west) < 1e-4 && Math.abs(bounds.north) < 1e-4 && Math.abs(bounds.south) < 1e-4;
  return width < 1e-6 || height < 1e-6 || nearZero;
};

const startOfMinuteIso = (date: Date): string => {
  const floored = new Date(date);
  floored.setSeconds(0, 0);
  return floored.toISOString();
};

const flattenPolygons = (layer?: FeatureCollection<PolygonGeometry>): PolygonGeometry[] => {
  if (!layer?.features?.length) return [];
  return layer.features
    .map((feature) => feature.geometry)
    .filter((geom): geom is PolygonGeometry => Boolean(geom));
};

const pointInRing = (point: [number, number], ring: number[][]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > point[1] !== yj > point[1]
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const pointInPolygon = (point: [number, number], geometry: PolygonGeometry): boolean => {
  if (geometry.type === 'Polygon') {
    const [outerRing, ...holes] = geometry.coordinates;
    if (!outerRing) return false;
    if (!pointInRing(point, outerRing)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  }

  // MultiPolygon: inside any polygon and not inside its holes
  return geometry.coordinates.some((polygon) => {
    const [outerRing, ...holes] = polygon;
    if (!outerRing) return false;
    if (!pointInRing(point, outerRing)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  });
};

type SunlightOptions = {
  onProgress?: (progress: MobilitySunlightProgress) => void;
  includeCanopy?: boolean;
  canopyRasterPath?: string;
  debug?: boolean;
  includeCloud?: boolean;
  includeRadiation?: boolean;
};

const DEFAULT_CANOPY_RASTER_PATH = (import.meta.env.VITE_CANOPY_RASTER_PATH as string | undefined) ?? undefined;
const DEBUG_ENV =
  (import.meta.env.VITE_MOBILITY_DEBUG as string | undefined) === '1' ||
  (import.meta.env.VITE_SHADOW_DEBUG as string | undefined) === '1';
const DEFAULT_DURATION_FALLBACK = 60; // seconds for last/invalid interval

export const computeMobilitySunlightForRows = async (
  rows: MobilityCsvRecord[],
  options?: SunlightOptions,
): Promise<MobilitySunlightSample[]> => {
  if (!rows.length) return [];

  const debug = options?.debug ?? DEBUG_ENV;
  const logDebug = (...args: unknown[]) => {
    if (debug) console.debug(...args);
  };
  const includeCloud = options?.includeCloud ?? true;
  const includeRadiation = options?.includeRadiation ?? true;

  const bucketMap = new Map<string, MobilityCsvRecord[]>();
  rows.forEach((row) => {
    const key = startOfMinuteIso(row.timestamp);
    const bucket = bucketMap.get(key) ?? [];
    bucket.push(row);
    bucketMap.set(key, bucket);
  });

  const samples: MobilitySunlightSample[] = [];
  const totalBuckets = bucketMap.size;
  let completed = 0;
  options?.onProgress?.({ completed, total: totalBuckets });

  for (const [bucketStart, bucketRows] of bucketMap.entries()) {
    let response: Awaited<ReturnType<typeof shadowAnalysisClient.requestAnalysis>> | null = null;
    const bucketStartDate = new Date(bucketStart);
    const bucketEndDate = new Date(bucketStartDate.getTime() + 60_000);
    const bounds = ensureNonZeroBounds(buildBounds(bucketRows));
    const includeCanopy = options?.includeCanopy ?? true;
    const canopyRasterPath = options?.canopyRasterPath ?? DEFAULT_CANOPY_RASTER_PATH;
    const metadata: Record<string, unknown> = { includeCanopy };
    if (includeCanopy && canopyRasterPath) {
      metadata.canopyRasterPath = canopyRasterPath;
    }
    const nighttime = isNighttimeBucket(bounds, bucketStartDate);
    let cloudCover: number | null = null;
    let sunlightFactor = 1;
    let solarIrradianceWm2: number | null = null;

    if (includeCloud || includeRadiation) {
      const centerLat = (bounds.north + bounds.south) / 2;
      const centerLng = (bounds.east + bounds.west) / 2;
      try {
        const weather = await weatherService.getCurrentWeather(centerLat, centerLng, bucketStartDate);
        cloudCover = weather.snapshot.cloudCover;
        sunlightFactor = weather.snapshot.sunlightFactor ?? 1;
        solarIrradianceWm2 = includeRadiation ? weather.snapshot.solarIrradianceWm2 ?? null : null;
        logDebug('[MobilitySunlight][bucket][weather]', {
          bucketStart,
          cloudCover,
          sunlightFactor,
          solarIrradianceWm2,
        });
      } catch (error) {
        logDebug('[MobilitySunlight][bucket][weather-error]', {
          bucketStart,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const applyCloud = (sunlitValue: number) => {
      const factor = Math.min(Math.max(sunlightFactor ?? 1, 0), 1);
      const sunlitEffective = sunlitValue * factor;
      const shadowPercentEffective = Math.min(100, Math.max(0, 100 - sunlitEffective * 100));
      // dswrf 已包含云量影响，这里只做阴影掩码：阴影=0，日照=dswrf
      const irradianceEffective =
        solarIrradianceWm2 != null ? Math.max(0, sunlitValue === 0 ? 0 : solarIrradianceWm2) : null;
      return { sunlitEffective, shadowPercentEffective, irradianceEffective };
    };

    logDebug('[MobilitySunlight][bucket][request]', {
      bucketStart,
      rows: bucketRows.length,
      bbox: bounds,
      includeCanopy,
      canopyRasterPath: includeCanopy ? canopyRasterPath : null,
      metadataKeys: Object.keys(metadata),
    });

    // Pre-filter: if bucket is nighttime, skip engine and mark as no sunlight
    if (nighttime) {
      logDebug('[MobilitySunlight][bucket][nighttime-precheck]', { bucketStart, bbox: bounds });
      console.warn('[Mobility Sunlight] Nighttime bucket (pre-check) for', bucketStart, '- marking as no sunlight');
      bucketRows.forEach((row) => {
        const { sunlitEffective, shadowPercentEffective, irradianceEffective } = applyCloud(0);
        samples.push({
          ...row,
          sunlit: 0,
          shadowPercent: 100,
          bucketStart: bucketStartDate.toISOString(),
          bucketEnd: bucketEndDate.toISOString(),
          source: 'fallback_night',
          cloudCover,
          sunlightFactor,
          sunlitEffective,
          shadowPercentEffective,
          solarIrradianceWm2,
          irradianceEffective,
        });
      });
      completed += 1;
      options?.onProgress?.({ completed, total: totalBuckets });
      continue;
    }

    // Degenerate/zero bounds: mark as error and skip engine
    if (isDegenerateBounds(bounds)) {
      logDebug('[MobilitySunlight][bucket][degenerate]', { bucketStart, bbox: bounds });
      console.warn('[Mobility Sunlight] Degenerate bounds for', bucketStart, bounds, '- marking as error');
      bucketRows.forEach((row) => {
        const { sunlitEffective, shadowPercentEffective, irradianceEffective } = applyCloud(0);
        samples.push({
          ...row,
          sunlit: 0,
          shadowPercent: 0,
          bucketStart: bucketStartDate.toISOString(),
          bucketEnd: bucketEndDate.toISOString(),
          source: 'fallback_error',
          cloudCover,
          sunlightFactor,
          sunlitEffective,
          shadowPercentEffective,
          solarIrradianceWm2,
          irradianceEffective,
        });
      });
      completed += 1;
      options?.onProgress?.({ completed, total: totalBuckets });
      continue;
    }

    try {
      logDebug('[MobilitySunlight][bucket][engine-request]', {
        bucketStart,
        request: {
          bbox: bounds,
          timestamp: bucketStartDate.toISOString(),
          outputs: { shadowPolygons: true, sunlightGrid: true, heatmap: false },
          metadata,
        },
      });
      response = await shadowAnalysisClient.requestAnalysis({
        bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
        timestamp: bucketStartDate,
        timeGranularityMinutes: 1,
        outputs: { shadowPolygons: true, sunlightGrid: true, heatmap: false },
        metadata,
      });
      logDebug('[MobilitySunlight][bucket][engine-response]', {
        bucketStart,
        cacheHit: response.cache.hit,
        cacheKey: response.cache.key,
        bucketStartIso: response.bucketStart,
        bucketEndIso: response.bucketEnd,
        metrics: response.metrics,
        warnings: response.warnings?.length ?? 0,
        metadata: response.metadata,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const noBuildings = message.includes('No building features returned');
      const isNight = isNighttimeError(message);
      logDebug('[MobilitySunlight][bucket][error]', {
        bucketStart,
        message,
        noBuildings,
        isNight,
        metadata,
      });
      if (!noBuildings && !isNight) {
        console.warn('[Mobility Sunlight] Engine error for', bucketStart, message);
        bucketRows.forEach((row) => {
          const { sunlitEffective, shadowPercentEffective, irradianceEffective } = applyCloud(0);
          samples.push({
            ...row,
            sunlit: 0,
            shadowPercent: 0,
            bucketStart: bucketStartDate.toISOString(),
            bucketEnd: bucketEndDate.toISOString(),
            source: 'fallback_error',
            cloudCover,
            sunlightFactor,
            sunlitEffective,
            shadowPercentEffective,
            solarIrradianceWm2,
            irradianceEffective,
          });
        });
        completed += 1;
        options?.onProgress?.({ completed, total: totalBuckets });
        continue;
      }
      if (noBuildings) {
        console.warn('[Mobility Sunlight] No buildings for bbox at', bucketStart, '- marking as sunlit');
        bucketRows.forEach((row) => {
          const { sunlitEffective, shadowPercentEffective, irradianceEffective } = applyCloud(1);
          samples.push({
            ...row,
            sunlit: 1,
            shadowPercent: 0,
            bucketStart: bucketStartDate.toISOString(),
            bucketEnd: bucketEndDate.toISOString(),
            source: 'fallback_no_buildings',
            cloudCover,
            sunlightFactor,
            sunlitEffective,
            shadowPercentEffective,
            solarIrradianceWm2,
            irradianceEffective,
          });
        });
      } else if (isNight) {
        console.warn('[Mobility Sunlight] Nighttime for', bucketStart, '- marking as no sunlight');
        bucketRows.forEach((row) => {
          const { sunlitEffective, shadowPercentEffective, irradianceEffective } = applyCloud(0);
          samples.push({
            ...row,
            sunlit: 0,
            shadowPercent: 100,
            bucketStart: bucketStartDate.toISOString(),
            bucketEnd: bucketEndDate.toISOString(),
            source: 'fallback_night',
            cloudCover,
            sunlightFactor,
            sunlitEffective,
            shadowPercentEffective,
            solarIrradianceWm2,
            irradianceEffective,
          });
        });
      }
      completed += 1;
      options?.onProgress?.({ completed, total: totalBuckets });
      continue;
    }

    const polygons = flattenPolygons(response.data.shadows as FeatureCollection<PolygonGeometry> | undefined);
    const fallbackShadowPercent = Math.max(0, Math.min(100, response.metrics.avgShadowPercent));
    const bucketEnd = response.bucketEnd ?? response.bucketStart;

    bucketRows.forEach((row) => {
      const inShadow = polygons.some((polygon) => pointInPolygon(row.coordinates, polygon));
      const shadowPercent = polygons.length ? (inShadow ? 100 : 0) : fallbackShadowPercent;
      const { sunlitEffective, shadowPercentEffective, irradianceEffective } = applyCloud(inShadow ? 0 : 1);
      samples.push({
        ...row,
        sunlit: inShadow ? 0 : 1,
        shadowPercent,
        bucketStart: response!.bucketStart,
        bucketEnd,
        source: 'engine',
        cloudCover,
        sunlightFactor,
        sunlitEffective,
        shadowPercentEffective,
        solarIrradianceWm2,
        irradianceEffective,
      });
    });

    completed += 1;
    options?.onProgress?.({ completed, total: totalBuckets });
  }

  // 按时间排序并计算相邻时间片时长与积分
  const sorted = samples.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    let durationSeconds = DEFAULT_DURATION_FALLBACK;
    if (next) {
      const diff = (next.timestamp.getTime() - current.timestamp.getTime()) / 1000;
      if (Number.isFinite(diff) && diff > 0) {
        durationSeconds = Math.min(diff, 300); // 上限 5 分钟，避免长间隔放大
      }
    }

    const effectiveSunlit = current.sunlitEffective ?? current.sunlit ?? 0;
    const effectiveShadowPercent = clampPercent(current.shadowPercentEffective ?? current.shadowPercent ?? 0);
    const irradianceEffective = current.irradianceEffective;

    current.durationSeconds = durationSeconds;
    current.sunlightSeconds = effectiveSunlit * durationSeconds;
    current.shadowSeconds = (effectiveShadowPercent / 100) * durationSeconds;
    current.irradianceJ =
      irradianceEffective != null ? Math.max(0, irradianceEffective) * durationSeconds : null;
  }

  return sorted;
};
