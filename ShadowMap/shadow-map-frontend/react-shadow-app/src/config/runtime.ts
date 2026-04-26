const normalizeOptionalValue = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeOrigin = (value: string | null | undefined, fallback: string): string =>
  (normalizeOptionalValue(value) ?? fallback).replace(/\/+$/, '');

export const BACKEND_ORIGIN = normalizeOrigin(
  normalizeOptionalValue(__SHADOWMAP_BACKEND_ORIGIN__) ??
    normalizeOptionalValue(import.meta.env.VITE_BACKEND_BASE_URL as string | undefined),
  'http://localhost:3001',
);

export const ENGINE_ORIGIN = normalizeOptionalValue(__SHADOWMAP_ENGINE_ORIGIN__);
export const MAPBOX_ACCESS_TOKEN =
  normalizeOptionalValue(__SHADOWMAP_MAPBOX_ACCESS_TOKEN__) ??
  normalizeOptionalValue(import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined);
export const CANOPY_RASTER_PATH =
  normalizeOptionalValue(__SHADOWMAP_CANOPY_RASTER_PATH__) ??
  normalizeOptionalValue(import.meta.env.VITE_CANOPY_RASTER_PATH as string | undefined);

export const API_BASE_URL = `${BACKEND_ORIGIN}/api`;
export const HEALTH_URL = `${API_BASE_URL}/health`;
export const BUILDINGS_INFO_URL = `${API_BASE_URL}/buildings/info`;
export const DEM_TILE_URL_TEMPLATE = `${API_BASE_URL}/dem/{z}/{x}/{y}.png`;
