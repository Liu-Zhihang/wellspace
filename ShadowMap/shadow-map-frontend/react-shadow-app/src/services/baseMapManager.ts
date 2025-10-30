import L from 'leaflet';

export interface BaseMapOption {
  id: string;
  name: string;
  description: string;
  url: string;
  attribution: string;
  maxZoom: number;
  category: 'street' | 'satellite' | 'terrain' | 'dark' | 'light';
  preview?: string;
  requiresApiKey?: boolean;
  apiKey?: string;
}

export const BASE_MAPS: BaseMapOption[] = [
  {
    id: 'osm-standard',
    name: 'OpenStreetMap',
    description: '',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    category: 'street',
  },
  {
    id: 'osm-hot',
    name: 'OSM ',
    description: '',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors, Tiles style by Humanitarian OpenStreetMap Team',
    maxZoom: 17,
    category: 'street',
  },
  
  {
    id: 'cartodb-light',
    name: 'CartoDB ',
    description: '',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
    category: 'light',
  },
  {
    id: 'cartodb-dark',
    name: 'CartoDB ',
    description: '',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
    category: 'dark',
  },
  {
    id: 'cartodb-voyager',
    name: 'CartoDB Voyager',
    description: '',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
    category: 'street',
  },

  {
    id: 'esri-satellite',
    name: 'ESRI ',
    description: '',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 17,
    category: 'satellite',
  },
  
  {
    id: 'stamen-terrain',
    name: 'Stamen ',
    description: '',
    url: 'https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}{r}.png',
    attribution: '© Stadia Maps © Stamen Design © OpenStreetMap contributors',
    maxZoom: 18,
    category: 'terrain',
  },
  {
    id: 'stamen-toner',
    name: 'Stamen ',
    description: '',
    url: 'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}{r}.png',
    attribution: '© Stadia Maps © Stamen Design © OpenStreetMap contributors',
    maxZoom: 18,
    category: 'light',
  },

  {
    id: 'mapbox-streets',
    name: 'Mapbox ',
    description: 'Mapbox ',
    url: 'https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    category: 'street',
    requiresApiKey: false,
  },
  {
    id: 'mapbox-satellite',
    name: 'Mapbox ',
    description: 'Mapbox ',
    url: 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    category: 'satellite',
    requiresApiKey: false,
  },
  {
    id: 'mapbox-dark',
    name: 'Mapbox ',
    description: 'Mapbox ',
    url: 'https://api.mapbox.com/styles/v1/mapbox/dark-v10/tiles/{z}/{x}/{y}?access_token=pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    category: 'dark',
    requiresApiKey: false,
  },
];

export class BaseMapManager {
  private currentLayer: L.TileLayer | null = null;
  private map: L.Map | null = null;

  constructor(map?: L.Map) {
    if (map) {
      this.map = map;
    }
  }

  setMap(map: L.Map) {
    this.map = map;
  }

  switchBaseMap(mapId: string, apiKey?: string): boolean {
    if (!this.map) {
      return false;
    }

    const mapOption = BASE_MAPS.find(m => m.id === mapId);
    if (!mapOption) {
      return false;
    }

    if (mapOption.requiresApiKey && !apiKey) {
      return false;
    }

    try {
      if (this.currentLayer) {
        this.map.removeLayer(this.currentLayer);
      }

      let url = mapOption.url;
      if (mapOption.requiresApiKey && apiKey) {
        url = url.replace('{apiKey}', apiKey);
      }

      this.currentLayer = L.tileLayer(url, {
        attribution: mapOption.attribution,
        maxZoom: mapOption.maxZoom,
        crossOrigin: true,
      });

      this.currentLayer.addTo(this.map);

      return true;
    } catch (error) {
      return false;
    }
  }

  getCurrentBaseMap(): BaseMapOption | null {
    return null;
  }

  getBaseMapsByCategory(category: BaseMapOption['category']): BaseMapOption[] {
    return BASE_MAPS.filter(map => map.category === category);
  }

  getAllBaseMaps(): BaseMapOption[] {
    return BASE_MAPS;
  }

  getCategories(): Array<{id: BaseMapOption['category'], name: string, icon: string}> {
    return [
      { id: 'street', name: '', icon: '🛣️' },
      { id: 'satellite', name: '', icon: '🛰️' },
      { id: 'terrain', name: '', icon: '🏔️' },
      { id: 'light', name: '', icon: '☀️' },
      { id: 'dark', name: '', icon: '🌙' },
    ];
  }

  preloadBaseMap(mapId: string, _bounds: L.LatLngBounds, _zoom: number, _apiKey?: string): void {
    const mapOption = BASE_MAPS.find(m => m.id === mapId);
    if (!mapOption) return;

  }
}

export const baseMapManager = new BaseMapManager();
