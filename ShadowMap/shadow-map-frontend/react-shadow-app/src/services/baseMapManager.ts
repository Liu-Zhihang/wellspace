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
  // 街道地图
  {
    id: 'osm-standard',
    name: 'OpenStreetMap',
    description: '开源标准地图',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    category: 'street',
  },
  {
    id: 'osm-hot',
    name: 'OSM 人道主义',
    description: '高对比度街道地图',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors, Tiles style by Humanitarian OpenStreetMap Team',
    maxZoom: 17,
    category: 'street',
  },
  
  // CartoDB 地图
  {
    id: 'cartodb-light',
    name: 'CartoDB 浅色',
    description: '简洁的浅色地图',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
    category: 'light',
  },
  {
    id: 'cartodb-dark',
    name: 'CartoDB 深色',
    description: '现代深色主题地图',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
    category: 'dark',
  },
  {
    id: 'cartodb-voyager',
    name: 'CartoDB Voyager',
    description: '探索者风格地图',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
    category: 'street',
  },

  // 卫星地图
  {
    id: 'esri-satellite',
    name: 'ESRI 卫星',
    description: '高清卫星影像',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 17,
    category: 'satellite',
  },
  
  // 地形地图 (修复 Stamen 链接)
  {
    id: 'stamen-terrain',
    name: 'Stamen 地形',
    description: '地形轮廓地图',
    url: 'https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}{r}.png',
    attribution: '© Stadia Maps © Stamen Design © OpenStreetMap contributors',
    maxZoom: 18,
    category: 'terrain',
  },
  {
    id: 'stamen-toner',
    name: 'Stamen 黑白',
    description: '高对比度黑白地图',
    url: 'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}{r}.png',
    attribution: '© Stadia Maps © Stamen Design © OpenStreetMap contributors',
    maxZoom: 18,
    category: 'light',
  },

  // Mapbox 样式 (使用预配置的API密钥)
  {
    id: 'mapbox-streets',
    name: 'Mapbox 街道',
    description: 'Mapbox 精美街道地图',
    url: 'https://api.mapbox.com/styles/v1/mapbox/streets-v11/tiles/{z}/{x}/{y}?access_token=pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    category: 'street',
    requiresApiKey: false, // 已预配置
  },
  {
    id: 'mapbox-satellite',
    name: 'Mapbox 卫星',
    description: 'Mapbox 高清卫星影像',
    url: 'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    category: 'satellite',
    requiresApiKey: false, // 已预配置
  },
  {
    id: 'mapbox-dark',
    name: 'Mapbox 深色',
    description: 'Mapbox 深色主题地图',
    url: 'https://api.mapbox.com/styles/v1/mapbox/dark-v10/tiles/{z}/{x}/{y}?access_token=pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    category: 'dark',
    requiresApiKey: false, // 已预配置
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

  // 设置地图实例
  setMap(map: L.Map) {
    this.map = map;
  }

  // 切换底图
  switchBaseMap(mapId: string, apiKey?: string): boolean {
    if (!this.map) {
      console.error('地图实例未设置');
      return false;
    }

    const mapOption = BASE_MAPS.find(m => m.id === mapId);
    if (!mapOption) {
      console.error(`未找到底图配置: ${mapId}`);
      return false;
    }

    // 检查是否需要API密钥
    if (mapOption.requiresApiKey && !apiKey) {
      console.error(`底图 ${mapOption.name} 需要API密钥`);
      return false;
    }

    try {
      // 移除当前底图
      if (this.currentLayer) {
        this.map.removeLayer(this.currentLayer);
      }

      // 处理URL中的API密钥
      let url = mapOption.url;
      if (mapOption.requiresApiKey && apiKey) {
        url = url.replace('{apiKey}', apiKey);
      }

      // 创建新的底图图层
      this.currentLayer = L.tileLayer(url, {
        attribution: mapOption.attribution,
        maxZoom: mapOption.maxZoom,
        crossOrigin: true,
      });

      // 添加到地图
      this.currentLayer.addTo(this.map);

      console.log(`✅ 已切换到底图: ${mapOption.name}`);
      return true;
    } catch (error) {
      console.error(`切换底图失败:`, error);
      return false;
    }
  }

  // 获取当前底图信息
  getCurrentBaseMap(): BaseMapOption | null {
    // 这里可以根据当前图层URL来判断
    return null;
  }

  // 根据分类获取底图选项
  getBaseMapsByCategory(category: BaseMapOption['category']): BaseMapOption[] {
    return BASE_MAPS.filter(map => map.category === category);
  }

  // 获取所有底图选项
  getAllBaseMaps(): BaseMapOption[] {
    return BASE_MAPS;
  }

  // 获取分类列表
  getCategories(): Array<{id: BaseMapOption['category'], name: string, icon: string}> {
    return [
      { id: 'street', name: '街道地图', icon: '🛣️' },
      { id: 'satellite', name: '卫星地图', icon: '🛰️' },
      { id: 'terrain', name: '地形地图', icon: '🏔️' },
      { id: 'light', name: '浅色主题', icon: '☀️' },
      { id: 'dark', name: '深色主题', icon: '🌙' },
    ];
  }

  // 预加载底图瓦片
  preloadBaseMap(mapId: string, bounds: L.LatLngBounds, zoom: number, apiKey?: string): void {
    const mapOption = BASE_MAPS.find(m => m.id === mapId);
    if (!mapOption) return;

    // 这里可以实现瓦片预加载逻辑
    console.log(`🔄 预加载底图 ${mapOption.name} 的瓦片`);
  }
}

// 导出默认实例
export const baseMapManager = new BaseMapManager();