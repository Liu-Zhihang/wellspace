import { useEffect, useRef } from 'react';
import L from 'leaflet';
import ShadeMap from 'leaflet-shadow-simulator';
import { useShadowMapStore } from '../store/shadowMapStore';
import { GeoUtils } from '../utils/geoUtils';
import { localDemService } from '../services/localDemService';

// Ensure plugin is registered
declare global {
  namespace L {
    function shadeMap(options: any): any;
  }
  interface Window {
    L: typeof L;
  }
}

if (typeof window !== 'undefined' && window.L && !window.L.shadeMap) {
  window.L.shadeMap = (options: any) => new ShadeMap(options);
}

export const useShadowMapWithLocalDEM = () => {
  const shadeMapRef = useRef<any>(null);
  const mapRef = useRef<L.Map | null>(null);
  const demDataRef = useRef<{
    data: Float32Array;
    width: number;
    height: number;
    bounds: [number, number, number, number];
  } | null>(null);

  const {
    currentDate,
    mapSettings,
    setSunPosition,
    addStatusMessage,
  } = useShadowMapStore();

  /**
   * Load DEM data from local TIF file
   */
  const loadLocalDEM = async (bounds: [number, number, number, number]) => {
    try {
      console.log('📊 Loading local DEM data for bounds:', bounds);
      const demData = await localDemService.loadDemData(bounds);
      
      if (demData) {
        demDataRef.current = demData;
        console.log('✅ Local DEM data loaded:', {
          width: demData.width,
          height: demData.height,
          dataPoints: demData.data.length,
          minElevation: Math.min(...demData.data),
          maxElevation: Math.max(...demData.data),
        });
        addStatusMessage('✅ Local DEM data loaded successfully', 'info');
        return demData;
      } else {
        console.warn('⚠️ No local DEM data available for this area');
        addStatusMessage('⚠️ No local DEM data for this area', 'warning');
        return null;
      }
    } catch (error) {
      console.error('❌ Failed to load local DEM:', error);
      addStatusMessage('❌ Failed to load DEM data', 'error');
      return null;
    }
  };

  /**
   * Create terrain source using local DEM data
   */
  const createLocalTerrainSource = (demData: typeof demDataRef.current) => {
    if (!demData) {
      console.warn('No DEM data available, using default terrain source');
      return {
        tileSize: 256,
        maxZoom: 15,
        getSourceUrl: () => '', // No URL needed for local data
        getElevation: () => 0, // Default flat terrain
      };
    }

    const { data, width, height, bounds } = demData;
    const [west, south, east, north] = bounds;

    return {
      tileSize: 256,
      maxZoom: 15,
      getSourceUrl: () => '', // Local data, no URL
      getElevation: ({ lat, lng }: { lat: number; lng: number }) => {
        // Convert lat/lng to pixel coordinates
        const x = Math.floor(((lng - west) / (east - west)) * width);
        const y = Math.floor(((north - lat) / (north - south)) * height);

        // Check bounds
        if (x < 0 || x >= width || y < 0 || y >= height) {
          return 0; // Out of bounds, return sea level
        }

        // Get elevation from data array
        const index = y * width + x;
        const elevation = data[index];
        
        return isNaN(elevation) ? 0 : elevation;
      },
    };
  };

  /**
   * Initialize shadow simulator with local DEM
   */
  const initShadowSimulator = async (map: L.Map) => {
    try {
      console.log('🌅 Initializing shadow simulator with local DEM...');
      mapRef.current = map;

      // Wait for map to be ready
      await new Promise(resolve => {
        if (map.getContainer()) {
          setTimeout(resolve, 300);
        } else {
          map.whenReady(() => setTimeout(resolve, 300));
        }
      });

      // Get current map bounds
      const bounds = map.getBounds();
      const boundsArray: [number, number, number, number] = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ];

      // Load local DEM data
      const demData = await loadLocalDEM(boundsArray);
      
      // Create terrain source (with or without DEM data)
      const terrainSource = createLocalTerrainSource(demData);

      // Ensure plugin is available
      if (typeof window !== 'undefined' && window.L && typeof window.L.shadeMap === 'function') {
        console.log('✅ Shadow simulator plugin ready');

        // Create shadow simulator
        const shadeMap = L.shadeMap({
          date: currentDate,
          color: mapSettings.shadowColor,
          opacity: mapSettings.shadowOpacity,
          apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imp3dTkyM0Bjb25uZWN0LmhrdXN0LWd6LmVkdS5jbiIsImNyZWF0ZWQiOjE3NTcyNDMxNzAxMzIsImlhdCI6MTc1NzI0MzE3MH0.Z7ejYmxcuKL3Le1Ydil1uRbP_EOS_wtLA6rsSewDUoA',
          showExposure: mapSettings.showSunExposure,
          terrainSource,
          getFeatures: async () => {
            // Return empty features for now (no buildings)
            // TODO: Integrate building data
            return {
              type: 'FeatureCollection',
              features: [],
            };
          },
          debug: (msg: string) => {
            console.log('🔧 Shadow Simulator:', msg);
          },
        });

        // Add to map
        shadeMap.addTo(map);
        shadeMapRef.current = shadeMap;

        // Update sun position
        const sunPos = GeoUtils.getSunPosition(
          currentDate,
          bounds.getCenter().lat,
          bounds.getCenter().lng
        );
        setSunPosition(sunPos);

        console.log('✅ Shadow simulator initialized successfully');
        addStatusMessage('✅ Shadow layer loaded', 'info');

        return shadeMap;
      } else {
        throw new Error('Shadow simulator plugin not available');
      }
    } catch (error) {
      console.error('❌ Failed to initialize shadow simulator:', error);
      addStatusMessage('❌ Failed to initialize shadow layer', 'error');
      return null;
    }
  };

  /**
   * Update shadow simulator when settings change
   */
  useEffect(() => {
    if (shadeMapRef.current && mapRef.current) {
      const shadeMap = shadeMapRef.current;

      // Update color
      if (shadeMap.setColor) {
        shadeMap.setColor(mapSettings.shadowColor);
      }

      // Update opacity
      if (shadeMap.setOpacity) {
        shadeMap.setOpacity(mapSettings.shadowOpacity);
      }

      // Update date
      if (shadeMap.setDate) {
        shadeMap.setDate(currentDate);
      }

      // Update sun position
      const bounds = mapRef.current.getBounds();
      const sunPos = GeoUtils.getSunPosition(
        currentDate,
        bounds.getCenter().lat,
        bounds.getCenter().lng
      );
      setSunPosition(sunPos);

      console.log('🔄 Shadow simulator updated:', {
        color: mapSettings.shadowColor,
        opacity: mapSettings.shadowOpacity,
        date: currentDate,
      });
    }
  }, [currentDate, mapSettings.shadowColor, mapSettings.shadowOpacity, mapSettings.showSunExposure]);

  /**
   * Update sun position manually
   */
  const updateSunPosition = () => {
    if (mapRef.current) {
      const bounds = mapRef.current.getBounds();
      const sunPos = GeoUtils.getSunPosition(
        currentDate,
        bounds.getCenter().lat,
        bounds.getCenter().lng
      );
      setSunPosition(sunPos);
      console.log('☀️ Sun position updated:', sunPos);
    }
  };

  /**
   * Reload DEM data for current view
   */
  const reloadDEM = async () => {
    if (mapRef.current) {
      const bounds = mapRef.current.getBounds();
      const boundsArray: [number, number, number, number] = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ];
      
      await loadLocalDEM(boundsArray);
      
      // Reinitialize shadow simulator with new DEM
      if (shadeMapRef.current) {
        shadeMapRef.current.remove();
      }
      await initShadowSimulator(mapRef.current);
    }
  };

  return {
    initShadowSimulator,
    updateSunPosition,
    reloadDEM,
    demData: demDataRef.current,
  };
};
