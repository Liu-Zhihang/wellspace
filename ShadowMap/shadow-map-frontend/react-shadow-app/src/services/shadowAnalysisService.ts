import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { API_BASE_URL } from './apiService';
import type { ShadowServiceResponse } from '../types/index.ts';

const SHADOW_DEBUG_ENABLED = (import.meta.env.VITE_SHADOW_DEBUG as string | undefined) === '1';
const debugLog = (...args: unknown[]) => {
  if (SHADOW_DEBUG_ENABLED) {
    console.debug(...args);
  }
};

export type ShadowAnalysisRequestOptions = {
  bbox: [number, number, number, number];
  timestamp: Date;
  geometry?: Feature<Geometry> | FeatureCollection<Geometry>;
  timeGranularityMinutes?: number;
  includeCanopy?: boolean;
  canopyRasterPath?: string;
  metadata?: Record<string, unknown>;
  outputs?: {
    shadowPolygons?: boolean;
    sunlightGrid?: boolean;
    heatmap?: boolean;
  };
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

const SHADOW_ENDPOINT = `${API_BASE_URL}/analysis/shadow`;
const DEFAULT_CANOPY_RASTER_PATH = (import.meta.env.VITE_CANOPY_RASTER_PATH as string | undefined) ?? undefined;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const normalizeOutputs = (outputs?: ShadowAnalysisRequestOptions['outputs']) => ({
  shadowPolygons: outputs?.shadowPolygons ?? true,
  sunlightGrid: outputs?.sunlightGrid ?? true,
  heatmap: outputs?.heatmap ?? true,
});

export class ShadowAnalysisClient {
  private inflight = new Map<string, Promise<ShadowServiceResponse>>();

  async requestAnalysis(options: ShadowAnalysisRequestOptions): Promise<ShadowServiceResponse> {
    const requestKey = this.buildRequestKey(options);
    const shouldReuse = !options.forceRefresh && this.inflight.has(requestKey);
    if (shouldReuse) {
      return this.inflight.get(requestKey)!;
    }

    const execution = this.execute(options);
    this.inflight.set(requestKey, execution);
    try {
      const response = await execution;
      return response;
    } finally {
      this.inflight.delete(requestKey);
    }
  }

  private async execute(options: ShadowAnalysisRequestOptions): Promise<ShadowServiceResponse> {
    const requestKey = this.buildRequestKey(options);
    const controller = options.signal ? undefined : new AbortController();
    const signal = options.signal ?? controller?.signal;

    const granularity = clamp(options.timeGranularityMinutes ?? 15, 1, 1440);
    const includeCanopy = options.includeCanopy ?? true;
    const canopyPath = options.canopyRasterPath ?? DEFAULT_CANOPY_RASTER_PATH;
    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    if (includeCanopy && canopyPath) {
      metadata.canopyRasterPath = canopyPath;
    }

    const payload = {
      bbox: {
        west: options.bbox[0],
        south: options.bbox[1],
        east: options.bbox[2],
        north: options.bbox[3],
      },
      timestamp: options.timestamp.toISOString(),
      timeGranularityMinutes: granularity,
      geometry: options.geometry,
      outputs: normalizeOutputs(options.outputs),
      metadata: Object.keys(metadata).length ? metadata : undefined,
      forceRefresh: options.forceRefresh ?? false,
    };

    debugLog('[ShadowClient][request]', {
      requestKey,
      bbox: payload.bbox,
      timestamp: payload.timestamp,
      granularity,
      outputs: payload.outputs,
      geometry: options.geometry ? 'provided' : 'none',
      includeCanopy,
      canopyRasterPath: includeCanopy ? canopyPath : null,
      metadataKeys: payload.metadata ? Object.keys(payload.metadata) : [],
    });

    try {
      const response = await fetch(SHADOW_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(`Shadow analysis failed (${response.status}): ${message || response.statusText}`);
      }

      const data = (await response.json()) as ShadowServiceResponse;
      if (!data || !data.cache || !data.metrics) {
        throw new Error('Shadow analysis response missing required fields.');
      }
      debugLog('[ShadowClient][response]', {
        requestKey,
        cacheHit: data.cache.hit,
        cacheKey: data.cache.key,
        bucketStart: data.bucketStart,
        bucketEnd: data.bucketEnd,
        metrics: data.metrics,
        warnings: data.warnings?.length ?? 0,
        metadata: data.metadata,
      });
      return data;
    } catch (error) {
      debugLog('[ShadowClient][error]', {
        requestKey,
        message: error instanceof Error ? error.message : String(error),
      });
      if ((error as Error).name === 'AbortError') {
        throw error;
      }
      throw new Error(
        error instanceof Error ? error.message : 'Shadow analysis request failed unexpectedly.',
      );
    } finally {
      controller?.abort();
    }
  }

  private buildRequestKey(options: ShadowAnalysisRequestOptions) {
    const bboxKey = options.bbox.map((value) => value.toFixed(5)).join(',');
    const timestampKey = options.timestamp.toISOString().slice(0, 16);
    const geometrySignature = this.hashGeometry(options.geometry);
    const outputs = normalizeOutputs(options.outputs);
    const outputsKey = Object.entries(outputs)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key)
      .sort()
      .join('+');
    const includeCanopy = options.includeCanopy ?? true;
    const canopyKey = includeCanopy
      ? options.canopyRasterPath ?? DEFAULT_CANOPY_RASTER_PATH ?? 'canopy-default'
      : 'no-canopy';
    const metadataKey =
      options.metadata && Object.keys(options.metadata).length > 0
        ? this.hashString(JSON.stringify(options.metadata))
        : 'nometa';
    return `${bboxKey}|${timestampKey}|${geometrySignature}|${outputsKey}|${canopyKey}|${metadataKey}`;
  }

  private hashGeometry(geometry?: Feature<Geometry> | FeatureCollection<Geometry>) {
    if (!geometry) return 'none';
    try {
      const serialized = JSON.stringify(geometry);
      let hash = 0;
      for (let i = 0; i < serialized.length; i++) {
        const code = serialized.charCodeAt(i);
        hash = (hash << 5) - hash + code;
        hash |= 0;
      }
      return `g${Math.abs(hash)}`;
    } catch {
      return 'geom';
    }
  }

  private hashString(value: string) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return `m${Math.abs(hash)}`;
  }
}

export const shadowAnalysisClient = new ShadowAnalysisClient();
