/**
 */

import mapboxgl from 'mapbox-gl';

export class MapboxShadowSync {
  private map: mapboxgl.Map;
  private shadeMap: any;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(map: mapboxgl.Map, shadeMap: any) {
    this.map = map;
    this.shadeMap = shadeMap;
  }

  /**
   */
  forceSynchronization(): void {

    try {
      const mapWithTransform = this.map as mapboxgl.Map & { transform: unknown };
      const mapboxTransform = mapWithTransform.transform;
      const mapboxCenter = this.map.getCenter();
      const mapboxZoom = this.map.getZoom();
      const mapboxBearing = this.map.getBearing();
      const mapboxPitch = this.map.getPitch();


      if (this.shadeMap && typeof this.shadeMap.syncMapTransform === 'function') {
        this.shadeMap.syncMapTransform({
          center: [mapboxCenter.lng, mapboxCenter.lat],
          zoom: mapboxZoom,
          bearing: mapboxBearing,
          pitch: mapboxPitch,
          transform: mapboxTransform
        });
      }

      const mapboxBounds = this.map.getBounds();
      if (this.shadeMap && typeof this.shadeMap.setBounds === 'function') {
        this.shadeMap.setBounds([
          [mapboxBounds.getWest(), mapboxBounds.getSouth()],
          [mapboxBounds.getEast(), mapboxBounds.getNorth()]
        ]);
      }

      if (this.shadeMap && typeof this.shadeMap.setPixelRatio === 'function') {
        const pixelRatio = window.devicePixelRatio || 1;
        this.shadeMap.setPixelRatio(pixelRatio);
      }

      try {
        if (typeof this.shadeMap.redraw === 'function') {
          this.shadeMap.redraw();
        } else if (this.shadeMap && typeof this.shadeMap._draw === 'function') {
          if (this.shadeMap._heightMapTex || this.shadeMap.heightMapTex) {
            this.shadeMap._draw();
          } else {
          }
        }
      } catch (drawError) {
      }

    } catch (error) {
    }
  }

  /**
   */
  enableRealtimeSync(): void {

    this.map.on('move', () => {
      this.syncOnMapChange('move');
    });

    this.map.on('zoom', () => {
      this.syncOnMapChange('zoom');
    });

    this.map.on('rotate', () => {
      this.syncOnMapChange('rotate');
    });

  }

  /**
   */
  private syncOnMapChange(_changeType: string): void {
    if (!this.shadeMap) return;

    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
    this.syncTimeout = setTimeout(() => {
      this.forceSynchronization();
    }, 100);
  }

  /**
   */
  validateSync(): {
    mapboxBounds: any;
    shadowBounds: any;
    aligned: boolean;
    offsetPixels: number;
  } {
    const mapboxBounds = this.map.getBounds();
    const mapboxCenter = this.map.getCenter();
    
    let shadowBounds = null;
    let aligned = false;
    let offsetPixels = 0;

    try {
      if (this.shadeMap && typeof this.shadeMap.getBounds === 'function') {
        shadowBounds = this.shadeMap.getBounds();
        
        const shadowCenter = {
          lng: (shadowBounds.getWest() + shadowBounds.getEast()) / 2,
          lat: (shadowBounds.getNorth() + shadowBounds.getSouth()) / 2
        };
        
        const mapboxPixel = this.map.project([mapboxCenter.lng, mapboxCenter.lat]);
        const shadowPixel = this.map.project([shadowCenter.lng, shadowCenter.lat]);
        
        offsetPixels = Math.sqrt(
          Math.pow(mapboxPixel.x - shadowPixel.x, 2) + 
          Math.pow(mapboxPixel.y - shadowPixel.y, 2)
        );
        
        aligned = offsetPixels < 5;
        
      }
    } catch (error) {
    }

    return {
      mapboxBounds,
      shadowBounds,
      aligned,
      offsetPixels
    };
  }

  /**
   */
  destroy(): void {
    clearTimeout((this as any).syncTimeout);
  }
}
