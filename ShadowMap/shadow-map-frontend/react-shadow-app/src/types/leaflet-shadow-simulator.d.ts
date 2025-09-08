declare module 'leaflet-shadow-simulator' {
  export interface TerrainSource {
    maxZoom: number;
    tileSize: number;
    getSourceUrl: (params: {
      x: number;
      y: number;
      z: number;
    }) => string;
    getElevation: (params: {
      r: number;
      g: number;
      b: number;
      a?: number;
    }) => number;
  }

  export interface ShadeMapOptions {
    date?: Date;
    color?: string;
    opacity?: number;
    belowCanopy?: boolean;
    showExposure?: boolean;
    terrainSource?: TerrainSource;
    getFeatures?: () => Promise<any[]>;
    apiKey: string;
    getSize?: () => { width: number; height: number };
    debug?: (msg: string) => void;
  }

  export interface SunExposureOptions {
    startDate: Date;
    endDate: Date;
    iterations?: number;
  }

  export default class ShadeMap {
    constructor(options: ShadeMapOptions);
    addTo(map: any): this;
    onAdd(map: any): this;
    onRemove(): this;
    setDate(date: Date): this;
    setColor(color: string): this;
    setOpacity(opacity: number): this;
    setTerrainSource(terrainSource: TerrainSource): this;
    setSunExposure(enabled: boolean, options?: SunExposureOptions): Promise<this>;
    getHoursOfSun(x: number, y: number): number;
    readPixel(x: number, y: number): Uint8Array;
    remove(): void;
  }
}

declare global {
  namespace L {
    function shadeMap(options: import('leaflet-shadow-simulator').ShadeMapOptions): import('leaflet-shadow-simulator').default;
  }
}
