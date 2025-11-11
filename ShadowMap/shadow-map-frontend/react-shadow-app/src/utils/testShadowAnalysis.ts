import { shadowAnalysisClient } from '../services/shadowAnalysisService';

export interface ShadowTestResult {
  success: boolean;
  error?: string;
  durationMs: number;
  bounds: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  date: Date;
  zoom: number;
}

export async function runShadowAnalysisSmokeTest(): Promise<ShadowTestResult> {
  const start = performance.now();

  const bounds = {
    north: 39.92,
    south: 39.9,
    east: 116.42,
    west: 116.4
  };

  const date = new Date();
  const zoom = 15;

  console.log('[ShadowTest] Starting smoke test', { bounds, isoTime: date.toISOString(), zoom });

  try {
    const response = await shadowAnalysisClient.requestAnalysis({
      bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
      timestamp: date,
      timeGranularityMinutes: 15,
    });

    console.log('[ShadowTest] Completed', {
      cache: response.cache.hit ? 'hit' : 'miss',
      samples: response.metrics.sampleCount,
      avgShadow: response.metrics.avgShadowPercent,
      avgSunlight: response.metrics.avgSunlightHours
    });

    return {
      success: true,
      durationMs: performance.now() - start,
      bounds,
      date,
      zoom
    };
  } catch (error) {
    console.error('[ShadowTest] Failed', error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: performance.now() - start,
      bounds,
      date,
      zoom
    };
  }
}

export function verifyBoundsConversion(): boolean {
  console.log('[ShadowTest] Validating bounds conversion');

  const mockBounds = {
    getNorth: () => 39.92,
    getSouth: () => 39.9,
    getEast: () => 116.42,
    getWest: () => 116.4
  };

  try {
    const converted = {
      north: mockBounds.getNorth(),
      south: mockBounds.getSouth(),
      east: mockBounds.getEast(),
      west: mockBounds.getWest()
    };

    if (Object.values(converted).some(value => typeof value !== 'number')) {
      throw new Error('Converted bounds contain non-numeric values');
    }

    if (converted.north <= converted.south || converted.east <= converted.west) {
      throw new Error('Converted bounds are invalid');
    }

    console.log('[ShadowTest] Bounds conversion passed');
    return true;
  } catch (error) {
    console.error('[ShadowTest] Bounds conversion failed', error);
    return false;
  }
}

export async function runShadowTestSuite(): Promise<void> {
  console.log('[ShadowTest] Running shadow analysis test suite');

  const conversionOk = verifyBoundsConversion();
  console.log(`[ShadowTest] Bounds conversion: ${conversionOk ? 'pass' : 'fail'}`);

  const shadowResult = await runShadowAnalysisSmokeTest();
  console.log(`[ShadowTest] Shadow analysis: ${shadowResult.success ? 'pass' : 'fail'}`);

  if (!shadowResult.success && shadowResult.error) {
    console.error('[ShadowTest] Shadow analysis error', shadowResult.error);
  }

  console.log('[ShadowTest] Test suite finished');
}

if (process.env.NODE_ENV === 'development') {
  setTimeout(() => {
    runShadowTestSuite().catch(error => {
      console.error('[ShadowTest] Test suite crashed', error);
    });
  }, 2000);
}
