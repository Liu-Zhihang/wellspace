import type mapboxgl from 'mapbox-gl';

type StyleSpecification = mapboxgl.Style;

export type BaseMapCategory = 'street' | 'satellite' | 'terrain' | 'dark' | 'light';

export interface BaseMapOption {
  id: string;
  name: string;
  description: string;
  category: BaseMapCategory;
  style?: string; // Mapbox style URL
  tiles?: string[];
  maxZoom?: number;
  attribution?: string;
}

export const BASE_MAPS: BaseMapOption[] = [
  {
    id: 'mapbox-streets',
    name: 'Mapbox Streets',
    description: 'Default Mapbox vector streets',
    category: 'street',
    style: 'mapbox://styles/mapbox/streets-v11',
  },
  {
    id: 'mapbox-satellite',
    name: 'Mapbox Satellite',
    description: 'High-resolution satellite imagery',
    category: 'satellite',
    style: 'mapbox://styles/mapbox/satellite-v9',
  },
  {
    id: 'mapbox-dark',
    name: 'Mapbox Dark',
    description: 'Low-light friendly vector style',
    category: 'dark',
    style: 'mapbox://styles/mapbox/dark-v11',
  },
  {
    id: 'osm-standard',
    name: 'OpenStreetMap',
    description: 'Community driven street map tiles',
    category: 'street',
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  {
    id: 'carto-light',
    name: 'Carto Light',
    description: 'Lightweight basemap from CARTO',
    category: 'light',
    tiles: [
      'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    ],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
  },
  {
    id: 'carto-dark',
    name: 'Carto Dark',
    description: 'Dark themed raster basemap',
    category: 'dark',
    tiles: [
      'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    ],
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
  },
  {
    id: 'esri-satellite',
    name: 'ESRI World Imagery',
    description: 'ArcGIS satellite tiles',
    category: 'satellite',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution:
      'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 17,
  },
  {
    id: 'stamen-terrain',
    name: 'Stamen Terrain',
    description: 'Terrain shaded basemap',
    category: 'terrain',
    tiles: [
      'https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}{r}.png',
    ],
    attribution: '© Stadia Maps © Stamen Design © OpenStreetMap contributors',
    maxZoom: 18,
  },
];

export const getBaseMapById = (id: string): BaseMapOption | undefined => {
  return BASE_MAPS.find((map) => map.id === id);
};

const buildRasterStyle = (option: BaseMapOption): StyleSpecification => {
  const tiles = option.tiles ?? [];
  return {
    version: 8,
    sources: {
      'custom-basemap': {
        type: 'raster',
        tiles,
        tileSize: 256,
        attribution: option.attribution,
        maxzoom: option.maxZoom ?? 19,
      },
    },
    layers: [
      {
        id: 'custom-basemap-layer',
        type: 'raster',
        source: 'custom-basemap',
      },
    ],
  };
};

export const getBaseMapStyle = (id: string): string | StyleSpecification => {
  const option = getBaseMapById(id) ?? BASE_MAPS[0];
  if (option.style) {
    return option.style;
  }
  if (option.tiles && option.tiles.length > 0) {
    return buildRasterStyle(option);
  }
  return BASE_MAPS[0].style ?? 'mapbox://styles/mapbox/streets-v11';
};

export const BASE_MAP_CATEGORIES: Array<{ id: BaseMapCategory; name: string; icon: string }> = [
  { id: 'street', name: 'Street', icon: '🛣️' },
  { id: 'satellite', name: 'Satellite', icon: '🛰️' },
  { id: 'terrain', name: 'Terrain', icon: '🏔️' },
  { id: 'light', name: 'Light', icon: '☀️' },
  { id: 'dark', name: 'Dark', icon: '🌙' },
];
