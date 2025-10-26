import type { WeatherApiResponse, WeatherMetrics, WeatherSnapshot } from '../types/index.ts';

const WEATHER_API_BASE = 'http://localhost:3500/api/weather';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_SUNLIGHT_FACTOR = 0.15;
const MAX_ATTENUATION_FACTOR = 0.85; // how much cloud cover reduces sunlight

type CacheEntry = {
  snapshot: WeatherSnapshot;
  response: WeatherApiResponse;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

const toFixedKey = (value: number, decimals = 2): string =>
  value.toFixed(decimals);

const normaliseCloudCover = (value: number | undefined): number | null => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value > 1 && value <= 100) {
    // Handle percentage input defensively
    return Math.min(Math.max(value / 100, 0), 1);
  }
  return Math.min(Math.max(value, 0), 1);
};

const buildCacheKey = (lat: number, lng: number, date: Date): string => {
  const hourBucket = new Date(date);
  hourBucket.setMinutes(0, 0, 0);
  return `${toFixedKey(lat)}|${toFixedKey(lng)}|${hourBucket.toISOString()}`;
};

const computeSunlightFactor = (cloudCover: number | null | undefined): number => {
  if (cloudCover == null) {
    return 1;
  }
  const clamped = Math.min(Math.max(cloudCover, 0), 1);
  const intensity = 1 - clamped * MAX_ATTENUATION_FACTOR;
  return Math.max(MIN_SUNLIGHT_FACTOR, Math.min(1, intensity));
};

const buildSnapshot = (weather: WeatherMetrics, timestamp: string | Date): WeatherSnapshot => {
  const cloudCover = normaliseCloudCover(weather.cloud_cover);
  const sunlightFactor = computeSunlightFactor(cloudCover);

  return {
    cloudCover,
    sunlightFactor,
    fetchedAt: timestamp ? new Date(timestamp) : new Date(),
    raw: weather,
  };
};

const fetchWeather = async (lat: number, lng: number, isoTimestamp: string): Promise<WeatherApiResponse> => {
  const url = `${WEATHER_API_BASE}/current?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&timestamp=${encodeURIComponent(isoTimestamp)}`;
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Weather request failed (${response.status} ${response.statusText})`);
  }

  return response.json() as Promise<WeatherApiResponse>;
};

export const weatherService = {
  async getCurrentWeather(lat: number, lng: number, date: Date): Promise<{ snapshot: WeatherSnapshot; response: WeatherApiResponse }> {
    const cacheKey = buildCacheKey(lat, lng, date);
    const cached = cache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return { snapshot: cached.snapshot, response: cached.response };
    }

    const isoTimestamp = date.toISOString();
    const response = await fetchWeather(lat, lng, isoTimestamp);
    const snapshot = buildSnapshot(response.weather, response.timestamp ?? isoTimestamp);

    cache.set(cacheKey, {
      snapshot,
      response,
      expiresAt: now + CACHE_TTL_MS,
    });

    return { snapshot, response };
  },

  computeSunlightFactor,

  clearCache: () => cache.clear(),

  buildCacheKey,
};
