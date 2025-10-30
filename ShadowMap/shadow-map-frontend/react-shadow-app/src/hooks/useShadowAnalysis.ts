import { useRef } from 'react';
import L from 'leaflet';
import { useShadowMapStore } from '../store/shadowMapStore';
import type { ShadowAnalysisResult, ShadowAnalysisPoint } from '../types/index.ts';

type CachedSample = {
  hoursOfSun: number;
  shadowPercent: number;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const useShadowAnalysis = () => {
  const analysisMarkerRef = useRef<L.Marker | null>(null);
  const analysisCircleRef = useRef<L.Circle | null>(null);
  const analysisCache = useRef<Map<string, CachedSample>>(new Map());

  const {
    currentDate,
    analysisRadius,
    setAnalysisResult,
    addStatusMessage,
  } = useShadowMapStore();

  const analyzePointShadow = async (
    map: L.Map,
    lat: number,
    lng: number,
    shadeMapInstance: any
  ): Promise<void> => {
    try {
      addStatusMessage?.(`🔍 Analysing shadow at ${lat.toFixed(4)}°, ${lng.toFixed(4)}°`, 'info');

      if (!shadeMapInstance || !shadeMapInstance._map) {
        addStatusMessage?.('⚠️ ShadeMap instance is not ready; initialise the simulator first.', 'warning');
        return;
      }

      addStatusMessage?.('ℹ️ Sampling sun exposure layer…', 'info');
      await delay(200);

      if (analysisMarkerRef.current) {
        map.removeLayer(analysisMarkerRef.current);
      }
      if (analysisCircleRef.current) {
        map.removeLayer(analysisCircleRef.current);
      }

      const marker = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'analysis-marker',
          html: '<div style="background:#ff4444;width:12px;height:12px;border-radius:50%;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
      });
      marker.addTo(map);
      analysisMarkerRef.current = marker;

      const circle = L.circle([lat, lng], {
        radius: analysisRadius,
        fillColor: '#3388ff',
        fillOpacity: 0.1,
        color: '#3388ff',
        weight: 2,
        dashArray: '5, 5',
      });
      circle.addTo(map);
      analysisCircleRef.current = circle;

      const samplePoints = generateSamplePoints(lat, lng, analysisRadius, 16);
      const analysisResults: ShadowAnalysisPoint[] = await Promise.all(
        samplePoints.map(async (point) => {
          const sample = await analyzeSinglePoint(point.lat, point.lng, shadeMapInstance);
          return {
            lat: point.lat,
            lng: point.lng,
            hoursOfSun: sample.hoursOfSun,
            shadowPercent: sample.shadowPercent,
          };
        })
      );

      const stats = calculateShadowStats(analysisResults);
      const result: ShadowAnalysisResult = {
        center: [lat, lng],
        radius: analysisRadius,
        samplePoints: analysisResults,
        stats,
        metadata: {
          date: currentDate,
          sampleCount: analysisResults.length,
        },
      };

      setAnalysisResult(result);
      showAnalysisPopup(map, lat, lng, result);

      addStatusMessage?.(
        `✅ Avg sunlight ${stats.avgHoursOfSun.toFixed(1)} h · coverage ${stats.avgShadowPercent.toFixed(1)}%`,
        'info'
      );
    } catch (error) {
      console.error('❌ Shadow analysis failed:', error);

      if (error instanceof Error) {
        if (error.message.includes('sun exposure')) {
          addStatusMessage?.('❌ Enable the “Sun Exposure” layer to run the analysis.', 'error');
        } else if (error.message.includes('ShadeMap')) {
          addStatusMessage?.('❌ ShadeMap simulator is not initialised.', 'error');
        } else {
          addStatusMessage?.(`❌ Shadow analysis failed: ${error.message}`, 'error');
        }
      } else {
        addStatusMessage?.('❌ Shadow analysis failed due to an unknown error.', 'error');
      }
    }
  };

  const generateSamplePoints = (centerLat: number, centerLng: number, radius: number, count: number) => {
    const points = [{ lat: centerLat, lng: centerLng }];

    for (let i = 0; i < count; i++) {
      const angle = (i * 2 * Math.PI) / count;
      const distance = radius * 0.8;

      const offsetLat = (distance * Math.cos(angle)) / 111_000;
      const offsetLng =
        (distance * Math.sin(angle)) / (111_000 * Math.cos((centerLat * Math.PI) / 180));

      points.push({
        lat: centerLat + offsetLat,
        lng: centerLng + offsetLng,
      });
    }

    return points;
  };

  const analyzeSinglePoint = async (lat: number, lng: number, shadeMapInstance: any) => {
    const cacheKey = `${lat.toFixed(6)}_${lng.toFixed(6)}_${currentDate.toISOString().split('T')[0]}`;

    if (analysisCache.current.has(cacheKey)) {
      console.log(`📋 Using cached sample for ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
      return analysisCache.current.get(cacheKey)!;
    }

    const map = shadeMapInstance._map || (window as any).mapInstance;
    if (!map) {
      throw new Error('ShadeMap map instance is unavailable.');
    }

    const pixelPoint = map.latLngToContainerPoint([lat, lng]);
    console.log(
      `🔍 Sampling ${lat.toFixed(4)}, ${lng.toFixed(4)} -> pixel ${pixelPoint.x}, ${pixelPoint.y}`
    );

    if (typeof shadeMapInstance.getHoursOfSun !== 'function') {
      throw new Error('ShadeMap.getHoursOfSun is not available.');
    }

    const exposureEnabled = shadeMapInstance.options?.sunExposure?.enabled ?? false;
    if (!exposureEnabled) {
      throw new Error('sun exposure layer disabled');
    }

    let accumulatedHours = 0;
    let validSamples = 0;
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await delay(150 + attempt * 50);

      const value = shadeMapInstance.getHoursOfSun(pixelPoint.x, pixelPoint.y);
      if (typeof value === 'number' && !Number.isNaN(value) && value >= 0) {
        accumulatedHours += value;
        validSamples++;
        console.log(
          `📊 getHoursOfSun sample ${attempt + 1}: ${value} (pixel ${pixelPoint.x}, ${pixelPoint.y})`
        );
      }
    }

    if (validSamples === 0) {
      throw new Error(`No sun exposure samples after ${maxAttempts} attempts.`);
    }

    const avgHours = accumulatedHours / validSamples;
    console.log(
      `✅ Sun exposure average ${avgHours.toFixed(2)} h (${validSamples}/${maxAttempts} samples)`
    );

    const result: CachedSample = {
      hoursOfSun: Math.max(0, avgHours),
      shadowPercent: Math.max(0, Math.min(100, ((12 - avgHours) / 12) * 100)),
    };

    analysisCache.current.set(cacheKey, result);
    return result;
  };

  const calculateShadowStats = (points: ShadowAnalysisPoint[]) => {
    const hoursOfSunValues = points.map((p) => p.hoursOfSun);
    const shadowPercentValues = points.map((p) => p.shadowPercent);

    const avgHoursOfSun =
      hoursOfSunValues.reduce((sum, val) => sum + val, 0) / Math.max(points.length, 1);
    const avgShadowPercent =
      shadowPercentValues.reduce((sum, val) => sum + val, 0) / Math.max(points.length, 1);
    const maxShadowPercent = Math.max(...shadowPercentValues);
    const minShadowPercent = Math.min(...shadowPercentValues);

    const variance =
      shadowPercentValues.reduce(
        (sum, val) => sum + Math.pow(val - avgShadowPercent, 2),
        0
      ) / Math.max(points.length, 1);
    const stdDev = Math.sqrt(variance);

    const shadowLevels = {
      noShadow: points.filter((p) => p.shadowPercent < 10).length,
      lightShadow: points.filter((p) => p.shadowPercent >= 10 && p.shadowPercent < 30).length,
      moderateShadow: points.filter((p) => p.shadowPercent >= 30 && p.shadowPercent < 60).length,
      heavyShadow: points.filter((p) => p.shadowPercent >= 60 && p.shadowPercent < 80).length,
      extremeShadow: points.filter((p) => p.shadowPercent >= 80).length,
    };

    return {
      avgHoursOfSun,
      avgShadowPercent,
      maxShadowPercent,
      minShadowPercent,
      stdDev,
      shadowLevels,
    };
  };

  const showAnalysisPopup = (map: L.Map, lat: number, lng: number, result: ShadowAnalysisResult) => {
    L.popup({
      maxWidth: 300,
      className: 'shadow-analysis-popup',
    })
      .setLatLng([lat, lng])
      .setContent(`
      <div class="p-3">
        <h3 class="font-bold text-lg mb-2">🌅 Shadow Analysis</h3>
        <div class="space-y-2 text-sm">
          <div class="flex justify-between"><span>Location</span><span>${lat.toFixed(
            4
          )}°, ${lng.toFixed(4)}°</span></div>
          <div class="flex justify-between"><span>Avg sunlight</span><span>${result.stats.avgHoursOfSun.toFixed(
            1
          )} h</span></div>
          <div class="flex justify-between"><span>Shadow coverage</span><span>${result.stats.avgShadowPercent.toFixed(
            1
          )}%</span></div>
          <div class="flex justify-between"><span>Captured</span><span>${result.metadata.date.toLocaleTimeString(
            undefined,
            { hour: '2-digit', minute: '2-digit' }
          )}</span></div>
          <div class="mt-3 pt-2 border-t text-xs text-gray-600">
            <div>Samples: ${result.metadata.sampleCount}</div>
            <div>Radius: ${Math.round(result.radius)} m</div>
          </div>
        </div>
      </div>
    `)
      .openOn(map);
  };

  const clearAnalysis = (map: L.Map) => {
    if (analysisMarkerRef.current) {
      map.removeLayer(analysisMarkerRef.current);
      analysisMarkerRef.current = null;
    }
    if (analysisCircleRef.current) {
      map.removeLayer(analysisCircleRef.current);
      analysisCircleRef.current = null;
    }
    setAnalysisResult(null);
  };

  const clearAnalysisCache = () => {
    analysisCache.current.clear();
    console.log('🧹 Shadow analysis cache cleared');
  };

  return {
    analyzePointShadow,
    clearAnalysis,
    clearAnalysisCache,
  };
};
