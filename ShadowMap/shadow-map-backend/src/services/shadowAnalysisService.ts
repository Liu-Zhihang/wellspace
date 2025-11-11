import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import axios from 'axios';
import { config } from '../config';
import {
  NormalizedShadowRequest,
  ShadowAnalysisError,
  ShadowAnalysisRequestBody,
  ShadowAnalysisResponse,
  ShadowAnalysisLayer,
} from '../types/shadowAnalysis';

type EnginePayload = {
  requestId: string;
  data: ShadowAnalysisResponse['data'];
  metrics: Omit<ShadowAnalysisResponse['metrics'], 'source'>;
  warnings?: string[];
  metadata?: Record<string, unknown>;
};

type CacheEntry = {
  key: string;
  payload: EnginePayload;
  expiresAt: number;
  lastAccessed: number;
  bucketStart: string;
  bucketEnd: string;
  bucketSizeMinutes: number;
  dimensions: string[];
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

class ShadowAnalysisService {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<EnginePayload>>();

  async run(request: ShadowAnalysisRequestBody): Promise<ShadowAnalysisResponse> {
    const normalized = this.normalizeRequest(request);
    const cacheMeta = this.buildCacheMetadata(normalized);
    const now = Date.now();

    if (!request.forceRefresh) {
      const cached = this.cache.get(cacheMeta.key);
      if (cached && cached.expiresAt > now) {
        cached.lastAccessed = now;
        return this.toResponse(normalized, cached.payload, {
          cacheHit: true,
          cacheKey: cached.key,
          bucketStart: new Date(cached.bucketStart),
          bucketEnd: new Date(cached.bucketEnd),
          bucketSizeMinutes: cached.bucketSizeMinutes,
          dimensions: cached.dimensions,
          expiresAt: cached.expiresAt,
        });
      }
    }

    const payload = await this.resolvePayload(normalized, cacheMeta.key, cacheMeta.dimensions);
    const ttl = Math.max(config.analysis.cacheTtlMs, 0);
    const expiresAt = ttl > 0 ? Date.now() + ttl : Date.now();

    if (ttl > 0) {
      this.cache.set(cacheMeta.key, {
        key: cacheMeta.key,
        payload,
        expiresAt,
        lastAccessed: Date.now(),
        bucketStart: normalized.bucketStart.toISOString(),
        bucketEnd: normalized.bucketEnd.toISOString(),
        bucketSizeMinutes: normalized.timeGranularityMinutes,
        dimensions: cacheMeta.dimensions,
      });
      this.trimCache();
    }

    return this.toResponse(normalized, payload, {
      cacheHit: false,
      cacheKey: cacheMeta.key,
      bucketStart: normalized.bucketStart,
      bucketEnd: normalized.bucketEnd,
      bucketSizeMinutes: normalized.timeGranularityMinutes,
      dimensions: cacheMeta.dimensions,
      expiresAt,
    });
  }

  private async resolvePayload(
    normalized: NormalizedShadowRequest,
    cacheKey: string,
    dimensions: string[],
  ): Promise<EnginePayload> {
    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const execution = this.invokeEngine(normalized, cacheKey, dimensions);
    this.inFlight.set(cacheKey, execution);

    try {
      const payload = await execution;
      return payload;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private toResponse(
    normalized: NormalizedShadowRequest,
    payload: EnginePayload,
    meta: {
      cacheHit: boolean;
      cacheKey: string;
      bucketStart: Date;
      bucketEnd: Date;
      bucketSizeMinutes: number;
      dimensions: string[];
      expiresAt: number;
    },
  ): ShadowAnalysisResponse {
    const response: ShadowAnalysisResponse = {
      requestId: payload.requestId,
      bbox: normalized.bbox,
      timestamp: normalized.timestampDate.toISOString(),
      bucketStart: meta.bucketStart.toISOString(),
      bucketEnd: meta.bucketEnd.toISOString(),
      timeGranularityMinutes: normalized.timeGranularityMinutes,
      cache: {
        key: meta.cacheKey,
        hit: meta.cacheHit,
        expiresAt: new Date(meta.expiresAt).toISOString(),
        bucketStart: meta.bucketStart.toISOString(),
        bucketSizeMinutes: meta.bucketSizeMinutes,
        dimensions: meta.dimensions,
      },
      metrics: {
        ...payload.metrics,
        source: meta.cacheHit ? 'cache' : 'engine',
      },
      data: payload.data,
      metadata: {
        ...(payload.metadata ?? {}),
        deploymentMode: config.analysis.deploymentMode,
      },
    };

    if (payload.warnings && payload.warnings.length > 0) {
      response.warnings = payload.warnings;
    }

    return response;
  }

  private normalizeRequest(request: ShadowAnalysisRequestBody): NormalizedShadowRequest {
    if (!request || typeof request !== 'object') {
      throw new ShadowAnalysisError('Missing request body', 400);
    }

    const bbox = request.bbox;
    if (
      !bbox ||
      typeof bbox.west !== 'number' ||
      typeof bbox.south !== 'number' ||
      typeof bbox.east !== 'number' ||
      typeof bbox.north !== 'number'
    ) {
      throw new ShadowAnalysisError('Invalid bounding box; expected {west,south,east,north}', 400);
    }

    if (bbox.east <= bbox.west || bbox.north <= bbox.south) {
      throw new ShadowAnalysisError('Bounding box coordinates are inverted or zero-area', 400);
    }

    if (!request.timestamp) {
      throw new ShadowAnalysisError('timestamp is required', 400);
    }

    const timestampDate = new Date(request.timestamp);
    if (Number.isNaN(timestampDate.getTime())) {
      throw new ShadowAnalysisError('timestamp must be an ISO-8601 string', 400);
    }

    const granularity = clamp(request.timeGranularityMinutes ?? 15, 1, 1440);
    const bucketSizeMs = granularity * 60 * 1000;
    const bucketStartMs = Math.floor(timestampDate.getTime() / bucketSizeMs) * bucketSizeMs;
    const bucketEndMs = bucketStartMs + bucketSizeMs;

    const normalizedOutputs = {
      shadowPolygons: request.outputs?.shadowPolygons ?? true,
      sunlightGrid: request.outputs?.sunlightGrid ?? true,
      heatmap: request.outputs?.heatmap ?? false,
    };

    return {
      ...request,
      bbox: {
        west: bbox.west,
        south: bbox.south,
        east: bbox.east,
        north: bbox.north,
      },
      outputs: normalizedOutputs,
      timestampDate,
      bucketStart: new Date(bucketStartMs),
      bucketEnd: new Date(bucketEndMs),
      timeGranularityMinutes: granularity,
      geometryHash: this.hashGeometry(request.geometry),
    };
  }

  private buildCacheMetadata(normalized: NormalizedShadowRequest) {
    const dimensions = [
      `bbox:${normalized.bbox.west.toFixed(6)},${normalized.bbox.south.toFixed(6)},${normalized.bbox.east.toFixed(6)},${normalized.bbox.north.toFixed(6)}`,
      `bucket:${normalized.bucketStart.toISOString()}`,
      `granularity:${normalized.timeGranularityMinutes}`,
      `geometry:${normalized.geometryHash ?? 'none'}`,
      `outputs:${Object.entries(normalized.outputs)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key)
        .sort()
        .join('+') || 'none'}`,
    ];

    return {
      key: dimensions.join('|'),
      dimensions,
    };
  }

  private trimCache() {
    const maxEntries = config.analysis.maxCacheEntries;
    if (this.cache.size <= maxEntries) {
      return;
    }

    const entries = [...this.cache.entries()].sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
    const surplus = this.cache.size - maxEntries;
    for (let i = 0; i < surplus && i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) {
        continue;
      }
      const [key] = entry;
      this.cache.delete(key);
    }
  }

  private hashGeometry(geometry: ShadowAnalysisRequestBody['geometry']): string | null {
    if (!geometry) {
      return null;
    }

    try {
      const serialized = JSON.stringify(geometry);
      return crypto.createHash('sha1').update(serialized).digest('hex').slice(0, 16);
    } catch (error) {
      console.warn('[ShadowAnalysis] Failed to hash geometry payload', error);
      return null;
    }
  }

  private async invokeEngine(
    normalized: NormalizedShadowRequest,
    cacheKey: string,
    dimensions: string[],
  ): Promise<EnginePayload> {
    const startedAt = Date.now();
    try {
      const payload = config.analysis.engineBaseUrl
        ? await this.callExternalEngine(normalized)
        : config.analysis.localScriptPath
          ? await this.callLocalScript(normalized)
          : await this.simulateEngineResponse(normalized, cacheKey, dimensions);

      return {
        ...payload,
        metrics: {
          ...payload.metrics,
          engineLatencyMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      if (error instanceof ShadowAnalysisError) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new ShadowAnalysisError(
            `Shadow engine timed out after ${config.analysis.requestTimeoutMs} ms`,
            504,
          );
        }

        const status = error.response?.status ?? 502;
        throw new ShadowAnalysisError(
          `Shadow engine responded with ${status}`,
          status,
          error.response?.data ?? error.message,
        );
      }

      throw new ShadowAnalysisError(
        'Shadow engine invocation failed',
        500,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async callExternalEngine(normalized: NormalizedShadowRequest): Promise<EnginePayload> {
    if (!config.analysis.engineBaseUrl) {
      throw new ShadowAnalysisError('No shadow engine base URL configured', 503);
    }

    const url = `${config.analysis.engineBaseUrl.replace(/\/$/, '')}/shadow`;
    const response = await axios.post(
      url,
      {
        bbox: normalized.bbox,
        timestamp: normalized.timestampDate.toISOString(),
        granularityMinutes: normalized.timeGranularityMinutes,
        outputs: normalized.outputs,
        geometry: normalized.geometry,
      },
      { timeout: config.analysis.requestTimeoutMs },
    );

    const payload = response.data;
    if (!payload?.data) {
      throw new ShadowAnalysisError('Shadow engine returned an empty response body', 502);
    }

    return {
      requestId: payload.requestId ?? crypto.randomUUID(),
      data: payload.data,
      metrics: {
        sampleCount: payload.metrics?.sampleCount ?? 0,
        avgShadowPercent: payload.metrics?.avgShadowPercent ?? 0,
        avgSunlightHours: payload.metrics?.avgSunlightHours ?? 0,
        engineLatencyMs: payload.metrics?.engineLatencyMs ?? 0,
        engineVersion: payload.metrics?.engineVersion ?? 'external',
      },
      warnings: payload.warnings,
      metadata: payload.metadata,
    };
  }

  private async callLocalScript(normalized: NormalizedShadowRequest): Promise<EnginePayload> {
    if (!config.analysis.localScriptPath) {
      throw new ShadowAnalysisError('Local shadow engine script path is not configured', 500);
    }

    const payload = {
      bbox: normalized.bbox,
      timestamp: normalized.timestampDate.toISOString(),
      timezone: config.analysis.timezone,
      backendUrl: config.analysis.backendBaseUrl,
      maxFeatures: config.analysis.maxFeatures,
      geometry: normalized.geometry ?? undefined,
      samples: { grid: 8 },
    };

    const scriptPath = path.isAbsolute(config.analysis.localScriptPath)
      ? config.analysis.localScriptPath
      : path.resolve(__dirname, '../../', config.analysis.localScriptPath);

    const child = spawn(config.analysis.pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutPromise = this.collectStream(child.stdout);
    const stderrPromise = this.collectStream(child.stderr);

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? 0));
    });

    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;

    if (exitCode !== 0) {
      throw new ShadowAnalysisError(
        `Shadow engine script failed with exit code ${exitCode}: ${stderr || 'Unknown error'}`,
        502,
      );
    }

    try {
      const parsed = JSON.parse(stdout) as EnginePayload;
      return parsed;
    } catch (error) {
      throw new ShadowAnalysisError(
        'Failed to parse shadow engine script output',
        500,
        stdout || (error instanceof Error ? error.message : error),
      );
    }
  }

  private async collectStream(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      stream.setEncoding('utf-8');
      stream.on('data', (chunk) => {
        buffer += chunk;
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(buffer.trim()));
    });
  }

  private async simulateEngineResponse(
    normalized: NormalizedShadowRequest,
    cacheKey: string,
    dimensions: string[],
  ): Promise<EnginePayload> {
    const digest = crypto.createHash('md5').update(cacheKey).digest('hex');
    const seed = parseInt(digest.slice(0, 8), 16);
    const variance = (seed % 1000) / 1000;

    const sampleCount = 512;
    const avgSunlightHours = 4 + variance * 6; // between 4h and 10h
    const avgShadowPercent = Math.max(0, Math.min(100, 100 - (avgSunlightHours / 12) * 100));

    const polygon = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [normalized.bbox.west, normalized.bbox.south],
            [normalized.bbox.east, normalized.bbox.south],
            [normalized.bbox.east, normalized.bbox.north],
            [normalized.bbox.west, normalized.bbox.north],
            [normalized.bbox.west, normalized.bbox.south],
          ],
        ],
      },
      properties: {
        kind: 'shadow-envelope',
        avgShadowPercent,
        bucketStart: normalized.bucketStart.toISOString(),
        bucketEnd: normalized.bucketEnd.toISOString(),
        hash: digest.slice(0, 8),
      },
    };

    const sunlightPoints = Array.from({ length: 5 }).map((_, index) => {
      const factor = 0.1 + (index + variance) / 10;
      const lng = normalized.bbox.west + (normalized.bbox.east - normalized.bbox.west) * factor;
      const lat = normalized.bbox.south + (normalized.bbox.north - normalized.bbox.south) * (1 - factor);
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lng, lat],
        },
        properties: {
          hoursOfSun: avgSunlightHours * (0.8 + variance / 5),
          shadowPercent: avgShadowPercent * (0.9 + variance / 10),
        },
      };
    });

    const data: ShadowAnalysisResponse['data'] = {};
    const warnings: string[] = [];

    if (normalized.outputs.shadowPolygons) {
      data.shadows = {
        type: 'FeatureCollection',
        features: [polygon],
        metadata: {
          generator: 'pybdshadow-sim',
          dimensions,
        },
      } satisfies ShadowAnalysisLayer;
    } else {
      warnings.push('Shadow polygon output disabled in request');
    }

    if (normalized.outputs.sunlightGrid) {
      data.sunlight = {
        type: 'FeatureCollection',
        features: sunlightPoints,
        metadata: {
          generator: 'pybdshadow-sim',
        },
      } satisfies ShadowAnalysisLayer;
    }

    if (normalized.outputs.heatmap) {
      data.heatmap = {
        type: 'FeatureCollection',
        features: sunlightPoints.map((feature) => ({
          ...feature,
          properties: {
            intensity: feature.properties?.hoursOfSun ?? avgSunlightHours,
          },
        })),
      } satisfies ShadowAnalysisLayer;
    }

    const payload: EnginePayload = {
      requestId: `sim-${digest.slice(0, 12)}`,
      data,
      metrics: {
        sampleCount,
        avgShadowPercent,
        avgSunlightHours,
        engineLatencyMs: 0,
        engineVersion: 'pybdshadow-sim',
      },
      metadata: {
        simulator: 'pybdshadow-prototype',
      },
    };

    if (warnings.length > 0) {
      payload.warnings = warnings;
    }

    return payload;
  }
}

export const shadowAnalysisService = new ShadowAnalysisService();
