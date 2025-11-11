import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { API_BASE_URL } from './apiService';
import type { ShadowServiceResponse } from '../types/index.ts';

export type ShadowAnalysisRequestOptions = {
  bbox: [number, number, number, number];
  timestamp: Date;
  geometry?: Feature<Geometry> | FeatureCollection<Geometry>;
  timeGranularityMinutes?: number;
  outputs?: {
    shadowPolygons?: boolean;
    sunlightGrid?: boolean;
    heatmap?: boolean;
  };
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

const SHADOW_ENDPOINT = `${API_BASE_URL}/analysis/shadow`;

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
    const controller = options.signal ? undefined : new AbortController();
    const signal = options.signal ?? controller?.signal;

    const granularity = clamp(options.timeGranularityMinutes ?? 15, 1, 1440);
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
      forceRefresh: options.forceRefresh ?? false,
    };

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
      return data;
    } catch (error) {
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
    return `${bboxKey}|${timestampKey}|${geometrySignature}|${outputsKey}`;
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
}

export const shadowAnalysisClient = new ShadowAnalysisClient();
