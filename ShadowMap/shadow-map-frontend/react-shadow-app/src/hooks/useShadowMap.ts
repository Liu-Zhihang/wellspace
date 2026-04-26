import { useEffect, useRef } from 'react';
import L from 'leaflet';
import ShadeMap from 'leaflet-shadow-simulator';
import { useShadowMapStore } from '../store/shadowMapStore';
import { GeoUtils } from '../utils/geoUtils';
import { ApiService } from '../services/apiService';
import type { TerrainSource } from '../types/index.ts';

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

export const useShadowMap = () => {
  const shadeMapRef = useRef<any>(null); //
  const mapRef = useRef<L.Map | null>(null);
  const {
    currentDate,
    mapSettings,
    setSunPosition,
    setAnalysisResult,
    setAnalysisResults,
    addStatusMessage,
    mapCenter,
  } = useShadowMapStore();

  const initShadowSimulator = async (map: L.Map) => {
    try {
      console.log('🌅 Initialising ShadeMap instance…');

      await new Promise(resolve => {
        if (map.getContainer()) {
          setTimeout(resolve, 500);
        } else {
          map.whenReady(() => {
            setTimeout(resolve, 500);
          });
        }
      });

      if (typeof window !== 'undefined' && window.L && !window.L.shadeMap) {
        console.log('📦 Registering ShadeMap factory on Leaflet');
        window.L.shadeMap = (options: any) => new ShadeMap(options);
      }

      if (typeof window !== 'undefined' && window.L && typeof window.L.shadeMap === 'function') {
        console.log('✅ leaflet-shadow-simulator detected');

        const terrainSource: TerrainSource = {
          tileSize: 256,
          maxZoom: 15,
          getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => {
            return ApiService.getDEMTileUrl(z, x, y);
          },
          getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
            return (r * 256 + g + b / 256) - 32768;
          },
        };

        console.log('🔧 Creating ShadeMap instance');

        const shadeMap = L.shadeMap({
          date: currentDate,
          color: mapSettings.shadowColor,
          opacity: mapSettings.shadowOpacity,
          apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imp3dTkyM0Bjb25uZWN0LmhrdXN0LWd6LmVkdS5jbiIsImNyZWF0ZWQiOjE3NTcyNDMxNzAxMzIsImlhdCI6MTc1NzI0MzE3MH0.Z7ejYmxcuKL3Le1Ydil1uRbP_EOS_wtLA6rsSewDUoA',
          showExposure: mapSettings.showSunExposure,
          belowCanopy: false,
          terrainSource,
          getFeatures: async () => {
            const mapWithLoadState = map as L.Map & { _loaded?: boolean };
            if (!mapWithLoadState._loaded) {
              console.log('⌛ Waiting for map to finish loading…');
              await new Promise(resolve => {
                if (mapWithLoadState._loaded) {
                  resolve(true);
                } else {
                  map.whenReady(() => resolve(true));
                }
              });
            }
            return await getCurrentViewBuildings(map);
          },
          debug: (msg: string) => {
            console.log('🔧 Shadow Simulator Debug:', msg);
          },
        });

        console.log('🔧 ShadeMap capabilities:', {
          hasAddTo: typeof shadeMap.addTo,
          hasRemove: typeof shadeMap.remove,
          hasSetColor: typeof shadeMap.setColor,
          hasSetOpacity: typeof shadeMap.setOpacity,
        });

        try {
          console.log('🔄 Attaching ShadeMap to map');
          shadeMap.addTo(map);
          console.log('✅ ShadeMap attached');
          addStatusMessage?.('✅ ShadeMap ready', 'info');
        } catch (addError) {
          console.error('❌ Failed to attach ShadeMap:', addError);
          if (shadeMap._map !== map) {
            shadeMap._map = map;
            console.log('🔧 Forced ShadeMap map reference');
          }
          addStatusMessage?.('⚠️ ShadeMap attachment hit an error', 'warning');
        }

        if (mapSettings.showSunExposure) {
          try {
            const startDate = new Date(currentDate);
            startDate.setHours(6, 0, 0, 0);

            const endDate = new Date(currentDate);
            endDate.setHours(18, 0, 0, 0);

            console.log('🌅 Enabling sun exposure heatmap', { startDate, endDate });

            await shadeMap.setSunExposure(true, {
              startDate,
              endDate,
              iterations: 24,
            });

            console.log('✅ Sun exposure heatmap enabled');
          } catch (exposureError) {
            console.warn('⚠️ Failed to enable sun exposure:', exposureError);
          }
        } else {
          try {
            await shadeMap.setSunExposure(false);
            console.log('🌑 Sun exposure heatmap disabled');
          } catch (exposureError) {
            console.warn('⚠️ Failed to disable sun exposure:', exposureError);
          }
        }

        shadeMapRef.current = shadeMap;

        const isValidShadowSimulator = shadeMap &&
                                      typeof shadeMap.addTo === 'function' &&
                                      typeof shadeMap.onRemove === 'function';

        if (isValidShadowSimulator) {
          console.log('✅ ShadeMap reports ready state');
          addStatusMessage?.('✅ ShadeMap reports ready state', 'info');
        } else {
          console.error('❌ ShadeMap did not expose expected APIs');
          addStatusMessage?.('⚠️ ShadeMap API is incomplete', 'warning');
        }

        console.log('🎉 ShadeMap initialised successfully');
      } else {
        console.error('❌ leaflet-shadow-simulator factory is missing');
        console.log('ShadeMap :', typeof ShadeMap);
        console.log('window.L.shadeMap :', typeof (window.L && window.L.shadeMap));
        addStatusMessage?.('⚠️ Failed to initialise leaflet-shadow-simulator.', 'warning');
      }
    } catch (error) {
      console.error('❌ ShadeMap initialisation failed:', error);
      addStatusMessage?.(`❌ ShadeMap initialisation failed: ${error}`, 'error');
    }
  };

  const getCurrentViewBuildings = async (map: L.Map) => {
    try {
      const mapWithLoadState = map as L.Map & { _loaded?: boolean };
      if (!map || !map.getContainer() || !mapWithLoadState._loaded) {
        console.warn('⚠️ Map is not ready; aborting building fetch');
        return [];
      }

      const zoom = map.getZoom();

      if (zoom < 13) {
        return [];
      }

      let bounds;
      try {
        bounds = map.getBounds();
      } catch (boundsError) {
        console.warn('⚠️ Unable to read map bounds:', boundsError);
        const center = map.getCenter();
        const offset = 0.01;
        bounds = L.latLngBounds(
          [center.lat - offset, center.lng - offset],
          [center.lat + offset, center.lng + offset]
        );
      }

      const mapBounds = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      };

      const maxZoom = Math.min(zoom, 17);
      const tiles = GeoUtils.getTilesInBounds(mapBounds, maxZoom);

      let maxTiles = 9;
      if (zoom >= 15) maxTiles = 6;
      if (zoom >= 16) maxTiles = 4;

      const connectionType = (navigator as any).connection?.effectiveType;
      if (connectionType === 'slow-2g' || connectionType === '2g') {
        maxTiles = Math.min(maxTiles, 2);
      }

      const limitedTiles = tiles.slice(0, maxTiles);

      if (tiles.length > maxTiles) {
        console.log(
          `⚡ Limiting building tiles from ${tiles.length} to ${maxTiles} to reduce load`
        );
      }

      console.log(`🔍 Fetching ${limitedTiles.length} tiles for zoom ${zoom}`);

      addStatusMessage?.(`🔄 Fetching ${limitedTiles.length} building tiles…`, 'info');

      const startTime = Date.now();
      const tileDataList = await ApiService.getBuildingTilesBatch(limitedTiles);
      const loadTime = Date.now() - startTime;

      const buildings: any[] = [];
      let totalFeatures = 0;

      tileDataList.forEach((data) => {
        if (data.features && Array.isArray(data.features)) {
          const processedFeatures = data.features
            .filter((feature: any) => feature && feature.properties && feature.geometry)
            .map((feature: any) => {
              let height = feature.properties.height;

              if (!height || height <= 0) {
                if (feature.properties.levels) {
                  height = feature.properties.levels * 3;
                } else if (feature.properties.buildingType) {
                  height = getBuildingHeightByType(feature.properties.buildingType);
                } else {
                  try {
                    const area = calculatePolygonArea(feature.geometry);
                    height = Math.max(6, Math.min(50, Math.sqrt(area) * 0.1));
                  } catch (areaError) {
                    height = 8;
                  }
                }
              }

              height = Math.max(3, Math.min(300, height));

              return {
                type: 'Feature',
                geometry: feature.geometry,
                properties: {
                  height: height,
                  render_height: height,
                  elevation: 0,
                  buildingType: feature.properties.buildingType || 'building',
                  id: feature.properties.id || `building_${Math.random().toString(36).substr(2, 9)}`
                }
              };
            });

          buildings.push(...processedFeatures);
          totalFeatures += processedFeatures.length;
        }
      });

      console.log(`🏢 Processed ${totalFeatures} buildings from ${limitedTiles.length} tiles`);
      addStatusMessage?.(`✅ Loaded ${totalFeatures} buildings in ${loadTime} ms`, 'info');

      const validBuildings = buildings.filter(building => {
        return building &&
               building.type === 'Feature' &&
               building.geometry &&
               building.geometry.coordinates &&
               building.properties &&
               typeof building.properties.height === 'number';
      });

      if (validBuildings.length !== buildings.length) {
        const skipped = buildings.length - validBuildings.length;
        console.warn(`⚠️ Filtered out ${skipped} invalid building features`);
        addStatusMessage?.(`⚠️ Filtered out ${skipped} invalid building features`, 'warning');
      }

      if (validBuildings.length === 0) {
        if (zoom < 14) {
          addStatusMessage?.('ℹ️ Zoom 14 or above is required to render buildings.', 'info');
        } else {
          addStatusMessage?.('⚠️ ShadeMap is not initialised.', 'warning');
        }
      }

      if (validBuildings.length > 0) {
        const heights = validBuildings.map(b => b.properties.height);
        setAnalysisResult({
          center: [map.getCenter().lat, map.getCenter().lng],
          radius: 1000,
          samplePoints: [],
          buildingCount: validBuildings.length,
          averageHeight: heights.reduce((sum, h) => sum + h, 0) / heights.length,
          maxHeight: Math.max(...heights),
          minHeight: Math.min(...heights),
          stats: {
            avgHoursOfSun: 8,
            avgShadowPercent: 30,
            maxShadowPercent: 80,
            minShadowPercent: 10,
          stdDev: 15,
          shadowLevels: {
              noShadow: 0,
              lightShadow: 0,
              moderateShadow: 0,
              heavyShadow: 0,
              extremeShadow: 0,
            },
          },
          metadata: {
            date: currentDate,
            sampleCount: validBuildings.length,
          },
        });
      }

      return validBuildings;
    } catch (error) {
      console.error('Failed to load buildings for current view:', error);
      addStatusMessage?.(`Failed to load buildings: ${error}`, 'error');
      return [];
    }
  };

  const getBuildingHeightByType = (buildingType: string): number => {
    const heightMap: { [key: string]: number } = {
      'residential': 15,
      'commercial': 20,
      'office': 25,
      'industrial': 12,
      'hotel': 30,
      'hospital': 18,
      'school': 12,
      'house': 8,
      'apartments': 20,
      'retail': 6,
      'warehouse': 8,
      'church': 15,
      'civic': 12,
      'public': 15,
      'yes': 12,
    };

    return heightMap[buildingType.toLowerCase()] || 12;
  };

  const calculatePolygonArea = (geometry: any): number => {
    if (!geometry || geometry.type !== 'Polygon' || !geometry.coordinates?.[0]) {
      return 100;
    }

    const coords = geometry.coordinates[0];
    let area = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      area += (x1 * y2 - x2 * y1);
    }

    return Math.abs(area / 2) * 111_000 * 111_000;
  };

  const updateSunPosition = () => {
    if (!mapRef.current) return;

    const center = mapRef.current.getCenter();
    const sunPosition = GeoUtils.getSunPosition(currentDate, center.lat, center.lng);
    setSunPosition(sunPosition);
  };

  useEffect(() => {
    if (shadeMapRef.current) {
      shadeMapRef.current.setDate(currentDate);
      updateSunPosition();
    }
  }, [currentDate]);

  useEffect(() => {
    if (mapRef.current) {
      if (shadeMapRef.current) {
        try {
          shadeMapRef.current.remove();
          console.log('♻️ Removed existing ShadeMap instance');
        } catch (e) {
          console.error('⚠️ Failed to remove ShadeMap instance:', e);
        }
      }
      console.log('🔄 Re-initialising ShadeMap due to settings change…');
      initShadowSimulator(mapRef.current);
    }
  }, [mapSettings.shadowColor, mapSettings.shadowOpacity, mapSettings.showShadowLayer, currentDate]);

  useEffect(() => {
    if (mapRef.current && shadeMapRef.current) {
      console.log(`🌈 Sun exposure toggle: ${mapSettings.showSunExposure ? 'enabled' : 'disabled'}`);

      try {
        if (typeof shadeMapRef.current.setSunExposure === 'function') {
          if (mapSettings.showSunExposure) {
            shadeMapRef.current.setSunExposure(true, {
              startDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 6, 0, 0),
              endDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 18, 0, 0),
              iterations: 24
            });
            console.log('✅ Sun exposure heatmap activated');
          } else {
            shadeMapRef.current.setSunExposure(false);
            console.log('✅ Sun exposure heatmap disabled');
          }
        } else {
          console.warn('⚠️ ShadeMap#setSunExposure is unavailable; reinitialising simulator');
          setTimeout(() => {
            if (mapRef.current) {
              initShadowSimulator(mapRef.current);
            }
          }, 100);
        }
      } catch (error) {
        console.error('❌ Failed to toggle sun exposure:', error);
      }
    }
  }, [mapSettings.showSunExposure]);

  useEffect(() => {
    updateSunPosition();
  }, [mapCenter]);

  const resetSimulation = () => {
    if (shadeMapRef.current) {
      try {
        shadeMapRef.current.remove();
        if (mapRef.current) {
          initShadowSimulator(mapRef.current);
        }

        setSunPosition({ altitude: 0, azimuth: 0 });
        setAnalysisResult(null);
        setAnalysisResults({});

        addStatusMessage?.('ℹ️ ShadeMap reset complete.', 'info');
      } catch (error) {
        console.error('❌ ShadeMap reset failed:', error);
        addStatusMessage?.('❌ ShadeMap reset failed.', 'error');
      }
    }
  };


  return {
    shadeMapRef,
    mapRef,
    initShadowSimulator,
    getCurrentViewBuildings,
    updateSunPosition,
    resetSimulation,
  };
};
