import { Router } from 'express';
import { shadowAnalysisService } from '../services/shadowAnalysisService';
import type { ShadowAnalysisRequestBody, BoundingBox } from '../types/shadowAnalysis';
import { ShadowAnalysisError } from '../types/shadowAnalysis';

const router: Router = Router();

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }
    if (value.toLowerCase() === 'false') {
      return false;
    }
  }

  return undefined;
};

const toFiniteNumber = (value: unknown, label: string): number => {
  const numeric = Number(value);
  if (Number.isNaN(numeric) || !Number.isFinite(numeric)) {
    throw new ShadowAnalysisError(`bbox ${label} must be numeric`, 400);
  }
  return numeric;
};

const normalizeBoundingBox = (raw: unknown): BoundingBox => {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return normalizeBoundingBox(parsed);
    } catch {
      throw new ShadowAnalysisError('bbox string must be valid JSON', 400);
    }
  }

  if (Array.isArray(raw) && raw.length === 4) {
    return {
      west: toFiniteNumber(raw[0], 'west'),
      south: toFiniteNumber(raw[1], 'south'),
      east: toFiniteNumber(raw[2], 'east'),
      north: toFiniteNumber(raw[3], 'north'),
    };
  }

  if (raw && typeof raw === 'object') {
    const candidate = raw as Record<string, unknown>;
    return {
      west: toFiniteNumber(candidate['west'], 'west'),
      south: toFiniteNumber(candidate['south'], 'south'),
      east: toFiniteNumber(candidate['east'], 'east'),
      north: toFiniteNumber(candidate['north'], 'north'),
    };
  }

  throw new ShadowAnalysisError('bbox must be either [west,south,east,north] or an object', 400);
};

const normalizeBody = (raw: unknown) => {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new ShadowAnalysisError(
        `Request body must be valid JSON (${error instanceof Error ? error.message : 'Unknown error'})`,
        400,
      );
    }
  }

  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }

  return {};
};

router.post('/shadow', async (req, res, next) => {
  try {
    const body = normalizeBody(req.body ?? {});
    const bbox = normalizeBoundingBox(body.bbox ?? body.bounds ?? body.boundingBox);

    const outputsCandidate = typeof body.outputs === 'object' && body.outputs !== null ? body.outputs : undefined;
    let outputs: ShadowAnalysisRequestBody['outputs'] | undefined;
    if (outputsCandidate) {
      outputs = {};
      const shadowPolygons = normalizeBoolean((outputsCandidate as any)['shadowPolygons']);
      const sunlightGrid = normalizeBoolean((outputsCandidate as any)['sunlightGrid']);
      const heatmap = normalizeBoolean((outputsCandidate as any)['heatmap']);
      if (shadowPolygons !== undefined) outputs.shadowPolygons = shadowPolygons;
      if (sunlightGrid !== undefined) outputs.sunlightGrid = sunlightGrid;
      if (heatmap !== undefined) outputs.heatmap = heatmap;
    }

    const forceRefresh = normalizeBoolean(body.forceRefresh);

    const payload: ShadowAnalysisRequestBody = {
      bbox,
      timestamp: body.timestamp,
    };

    if (typeof body.timeGranularityMinutes === 'number') {
      payload.timeGranularityMinutes = body.timeGranularityMinutes;
    } else if (typeof body.granularityMinutes === 'number') {
      payload.timeGranularityMinutes = body.granularityMinutes;
    }

    if (body.geometry) {
      payload.geometry = body.geometry;
    }

    if (outputs) {
      payload.outputs = outputs;
    }

    if (forceRefresh !== undefined) {
      payload.forceRefresh = forceRefresh;
    }

    if (body.metadata) {
      payload.metadata = body.metadata;
    }

    const response = await shadowAnalysisService.run(payload);
    res.status(response.cache.hit ? 200 : 201).json(response);
  } catch (error) {
    if (error instanceof ShadowAnalysisError) {
      res.status(error.statusCode).json({
        error: 'ShadowAnalysisError',
        message: error.message,
        details: error.details,
      });
      return;
    }

    next(error);
  }
});

export default router;
