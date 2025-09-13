import { useEffect, useRef } from 'react';
import L from 'leaflet';
// 导入 leaflet-shadow-simulator
import ShadeMap from 'leaflet-shadow-simulator';
import { useShadowMapStore } from '../store/shadowMapStore';
import { GeoUtils } from '../utils/geoUtils';
import { ApiService } from '../services/apiService';
import { shadowLayerManager } from '../services/shadowLayerManager';
import type { TerrainSource, DataLayerType } from '../types';

// 声明 leaflet-shadow-simulator 的类型
declare global {
  namespace L {
    function shadeMap(options: any): any;
  }
  interface Window {
    L: typeof L;
  }
}

// 确保插件正确注册到 Leaflet
if (typeof window !== 'undefined' && window.L && !window.L.shadeMap) {
  window.L.shadeMap = (options: any) => new ShadeMap(options);
}

export const useShadowMap = () => {
  const shadowOnlyRef = useRef<any>(null); // 纯阴影模拟器
  const heatmapOnlyRef = useRef<any>(null); // 纯热力图模拟器
  const shadeMapRef = useRef<any>(null); // 当前活跃的模拟器
  const mapRef = useRef<L.Map | null>(null);
  const {
    currentDate,
    mapSettings,
    setSunPosition,
    setAnalysisResult,
    setAnalysisResults,
    addStatusMessage,
    mapCenter,
    toggleDataLayer,
    updateDataLayer,
  } = useShadowMapStore();

  // 创建纯阴影模拟器
  const createShadowOnlySimulator = async (map: L.Map) => {
    const terrainSource = {
      tileSize: 256,
      maxZoom: 15,
      getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => {
        return ApiService.getDEMTileUrl(z, x, y);
      },
      getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
        return (r * 256 + g + b / 256) - 32768;
      },
    };

    const shadowSimulator = L.shadeMap({
      date: currentDate,
      color: mapSettings.shadowColor,
      opacity: mapSettings.shadowOpacity,
      apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imp3dTkyM0Bjb25uZWN0LmhrdXN0LWd6LmVkdS5jbiIsImNyZWF0ZWQiOjE3NTcyNDMxNzAxMzIsImlhdCI6MTc1NzI0MzE3MH0.Z7ejYmxcuKL3Le1Ydil1uRbP_EOS_wtLA6rsSewDUoA',
      showExposure: false, // 纯阴影，无热力图
      belowCanopy: false,
      terrainSource,
      getFeatures: async () => await getCurrentViewBuildings(map),
    });

    shadowSimulator.addTo(map);
    return shadowSimulator;
  };

  // 创建纯热力图模拟器
  const createHeatmapOnlySimulator = async (map: L.Map) => {
    const terrainSource = {
      tileSize: 256,
      maxZoom: 15,
      getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => {
        return ApiService.getDEMTileUrl(z, x, y);
      },
      getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
        return (r * 256 + g + b / 256) - 32768;
      },
    };

    const heatmapSimulator = L.shadeMap({
      date: currentDate,
      color: '#000000', // 阴影设为透明
      opacity: 0, // 阴影完全透明
      apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imp3dTkyM0Bjb25uZWN0LmhrdXN0LWd6LmVkdS5jbiIsImNyZWF0ZWQiOjE3NTcyNDMxNzAxMzIsImlhdCI6MTc1NzI0MzE3MH0.Z7ejYmxcuKL3Le1Ydil1uRbP_EOS_wtLA6rsSewDUoA',
      showExposure: true, // 只显示热力图
      belowCanopy: false,
      terrainSource,
      getFeatures: async () => await getCurrentViewBuildings(map),
    });

    // 启用太阳曝光分析
    await heatmapSimulator.setSunExposure(true, {
      startDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 6, 0, 0),
      endDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 18, 0, 0),
      iterations: 24
    });

    heatmapSimulator.addTo(map);
    return heatmapSimulator;
  };

  // 初始化阴影模拟器
  const initShadowSimulator = async (map: L.Map) => {
    try {
      console.log('🌅 开始初始化阴影模拟器...');
      
      // 确保地图完全加载
      await new Promise(resolve => {
        if (map.getContainer()) {
          // 等待地图容器渲染完成
          setTimeout(resolve, 500);
        } else {
          map.whenReady(() => {
            setTimeout(resolve, 500);
          });
        }
      });
      
      // 确保插件已经注册
      if (typeof window !== 'undefined' && window.L && !window.L.shadeMap) {
        console.log('📦 注册 ShadeMap 到全局 L 对象');
        window.L.shadeMap = (options: any) => new ShadeMap(options);
      }
      
      // 检查插件是否可用
      if (typeof window !== 'undefined' && window.L && typeof window.L.shadeMap === 'function') {
        console.log('✅ leaflet-shadow-simulator 插件已加载，开始初始化');
        
        // 创建地形数据源配置
        const terrainSource: TerrainSource = {
          tileSize: 256,
          maxZoom: 15,
          getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => {
            return ApiService.getDEMTileUrl(z, x, y);
          },
          getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
            // AWS Terrarium格式的高程解析
            return (r * 256 + g + b / 256) - 32768;
          },
        };

        // 初始化阴影地图
        console.log('🔧 开始创建阴影模拟器实例...');
        
        const shadeMap = L.shadeMap({
          date: currentDate,
          color: mapSettings.shadowColor,
          opacity: mapSettings.shadowOpacity,
          apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imp3dTkyM0Bjb25uZWN0LmhrdXN0LWd6LmVkdS5jbiIsImNyZWF0ZWQiOjE3NTcyNDMxNzAxMzIsImlhdCI6MTc1NzI0MzE3MH0.Z7ejYmxcuKL3Le1Ydil1uRbP_EOS_wtLA6rsSewDUoA',
          showExposure: mapSettings.showSunExposure, // 动态控制太阳曝光计算
          belowCanopy: false, // 不考虑树冠遮挡
          terrainSource,
          getFeatures: async () => {
            // 确保地图已经完全加载后再获取建筑物数据
            if (!map._loaded) {
              console.log('等待地图完全加载...');
              await new Promise(resolve => {
                if (map._loaded) {
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
        
        console.log('🔧 阴影模拟器实例已创建:', typeof shadeMap);
        console.log('🔧 检查关键方法:');
        console.log('  - addTo:', typeof shadeMap.addTo);
        console.log('  - remove:', typeof shadeMap.remove);
        console.log('  - setColor:', typeof shadeMap.setColor);
        console.log('  - setOpacity:', typeof shadeMap.setOpacity);

        // 直接添加阴影图层到地图
        try {
          console.log('🔄 添加阴影图层到地图...');
          shadeMap.addTo(map);
          console.log('✅ 阴影图层已成功添加到地图');
          addStatusMessage('✅ 阴影图层加载完成', 'info');
        } catch (addError) {
          console.error('❌ 添加阴影图层失败:', addError);
          // 如果addTo失败，尝试手动设置地图引用
          if (shadeMap._map !== map) {
            shadeMap._map = map;
            console.log('🔧 手动设置阴影模拟器的地图引用');
          }
          addStatusMessage('⚠️ 阴影图层可能未完全加载', 'warning');
        }

        // 根据设置决定是否启用太阳曝光分析
        if (mapSettings.showSunExposure) {
          try {
            const startDate = new Date(currentDate);
            startDate.setHours(6, 0, 0, 0); // 从早上6点开始
            
            const endDate = new Date(currentDate);
            endDate.setHours(18, 0, 0, 0); // 到晚上6点结束
            
            console.log('🌅 启用太阳曝光分析:', startDate, '到', endDate);
            
            // 启用太阳曝光计算
            await shadeMap.setSunExposure(true, {
              startDate,
              endDate,
              iterations: 24 // 每小时一次采样
            });
            
            console.log('✅ 太阳曝光分析已启用');
          } catch (exposureError) {
            console.warn('启用太阳曝光分析失败:', exposureError);
          }
        } else {
          try {
            // 禁用太阳曝光分析
            await shadeMap.setSunExposure(false);
            console.log('🌑 太阳曝光分析已禁用');
          } catch (exposureError) {
            console.warn('禁用太阳曝光分析失败:', exposureError);
          }
        }

        shadeMapRef.current = shadeMap;
        
        // 验证阴影模拟器是否正确初始化（使用正确的方法检查）
        const isValidShadowSimulator = shadeMap && 
                                      typeof shadeMap.addTo === 'function' &&
                                      typeof shadeMap.onRemove === 'function';
        
        if (isValidShadowSimulator) {
          console.log('✅ 阴影模拟器验证通过');
          addStatusMessage('✅ 阴影模拟器初始化成功', 'info');
        } else {
          console.error('❌ 阴影模拟器验证失败');
          addStatusMessage('⚠️ 阴影模拟器初始化异常', 'warning');
        }
        
        console.log('🎉 阴影模拟器初始化完成');
      } else {
        console.error('❌ leaflet-shadow-simulator 插件加载失败');
        console.log('ShadeMap 类型:', typeof ShadeMap);
        console.log('window.L.shadeMap 类型:', typeof (window.L && window.L.shadeMap));
        addStatusMessage('⚠️ leaflet-shadow-simulator 插件未加载，跳过初始化', 'warning');
      }
    } catch (error) {
      console.error('❌ 阴影模拟器初始化失败:', error);
      addStatusMessage(`❌ 阴影模拟器初始化失败: ${error}`, 'error');
    }
  };

  // 获取当前视图的建筑物数据（优化版）
  const getCurrentViewBuildings = async (map: L.Map) => {
    try {
      // 检查地图是否已经完全初始化
      if (!map || !map.getContainer() || !map._loaded) {
        console.warn('地图尚未完全初始化，跳过建筑物数据获取');
        return [];
      }

      const zoom = map.getZoom();
      
      // 根据缩放级别调整建筑物数据详细程度
      if (zoom < 13) {
        return []; // 低缩放级别不显示建筑物
      }

      // 安全地获取地图边界
      let bounds;
      try {
        bounds = map.getBounds();
      } catch (boundsError) {
        console.warn('无法获取地图边界:', boundsError);
        // 使用地图中心点创建一个小范围的边界
        const center = map.getCenter();
        const offset = 0.01; // 大约1公里的偏移
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

      // 智能瓦片限制策略（MongoDB缓存后可以更激进）
      const maxZoom = Math.min(zoom, 17);
      const tiles = GeoUtils.getTilesInBounds(mapBounds, maxZoom);
      
      // MongoDB缓存优化：可以加载更多瓦片
      let maxTiles = 9;  // 基础瓦片数提升
      if (zoom >= 15) maxTiles = 6;  // 高缩放级别加载更多
      if (zoom >= 16) maxTiles = 4;  // 极高缩放级别仍然限制
      
      // 检查网络状况，调整加载策略
      const connectionType = (navigator as any).connection?.effectiveType;
      if (connectionType === 'slow-2g' || connectionType === '2g') {
        maxTiles = Math.min(maxTiles, 2); // 慢网络下进一步限制
      }
      
      const limitedTiles = tiles.slice(0, maxTiles);
      
      // 如果瓦片数量过多，给用户提示
      if (tiles.length > maxTiles) {
        console.log(`⚡ 网络优化: 原需加载 ${tiles.length} 个瓦片，已优化为 ${maxTiles} 个`);
      }
      
      console.log(`🔍 准备加载 ${limitedTiles.length} 个建筑物瓦片 (缩放级别: ${zoom})`);
      
      // 添加加载状态提示
      addStatusMessage(`🔄 正在加载 ${limitedTiles.length} 个建筑物瓦片...`, 'info');
      
      // 使用批量获取提升性能
      const startTime = Date.now();
      const tileDataList = await ApiService.getBuildingTilesBatch(limitedTiles);
      const loadTime = Date.now() - startTime;
      
      const buildings: any[] = [];
      let totalFeatures = 0;
      
      tileDataList.forEach((data) => {
        if (data.features && Array.isArray(data.features)) {
          const processedFeatures = data.features
            .filter((feature: any) => feature && feature.properties && feature.geometry) // 先过滤有效数据
            .map((feature: any) => {
              // 智能高度估算算法
              let height = feature.properties.height;
              
              if (!height || height <= 0) {
                if (feature.properties.levels) {
                  // 基于楼层数计算（每层3米）
                  height = feature.properties.levels * 3;
                } else if (feature.properties.buildingType) {
                  // 基于建筑类型估算
                  height = getBuildingHeightByType(feature.properties.buildingType);
                } else {
                  // 基于建筑面积估算（面积越大，建筑可能越高）
                  try {
                    const area = calculatePolygonArea(feature.geometry);
                    height = Math.max(6, Math.min(50, Math.sqrt(area) * 0.1));
                  } catch (areaError) {
                    height = 8; // 默认高度
                  }
                }
              }
              
              // 确保高度在合理范围内
              height = Math.max(3, Math.min(300, height));
              
              // 创建符合leaflet-shadow-simulator要求的干净对象
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

      console.log(`🏢 成功获取 ${totalFeatures} 个建筑物用于阴影计算 (来自 ${limitedTiles.length} 个瓦片)`);
      addStatusMessage(`✅ 建筑物数据加载完成：${totalFeatures} 个建筑物 (${loadTime}ms)`, 'info');
      
      // 验证建筑物数据完整性
      const validBuildings = buildings.filter(building => {
        return building && 
               building.type === 'Feature' &&
               building.geometry && 
               building.geometry.coordinates &&
               building.properties && 
               typeof building.properties.height === 'number';
      });
      
      if (validBuildings.length !== buildings.length) {
        console.warn(`⚠️ 过滤掉 ${buildings.length - validBuildings.length} 个无效建筑物`);
        addStatusMessage(`⚠️ 过滤掉 ${buildings.length - validBuildings.length} 个无效建筑物`, 'warning');
      }
      
      // 如果没有获取到建筑物数据，提示用户
      if (validBuildings.length === 0) {
        if (zoom < 14) {
          addStatusMessage('请放大地图查看建筑物数据 (缩放级别需 ≥ 14)', 'info');
        } else {
          addStatusMessage('当前区域暂无建筑物数据或网络连接问题', 'warning');
        }
      }
      
      // 更新分析结果
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
              无阴影: 0,
              轻微阴影: 0,
              中等阴影: 0,
              重度阴影: 0,
              极重阴影: 0,
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
      console.error('获取建筑物数据失败:', error);
      addStatusMessage(`获取建筑物数据失败: ${error}`, 'error');
      return [];
    }
  };

  // 根据建筑类型估算高度
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
      'yes': 12, // 通用建筑物
    };
    
    return heightMap[buildingType.toLowerCase()] || 12;
  };

  // 计算多边形面积（简化版）
  const calculatePolygonArea = (geometry: any): number => {
    if (!geometry || geometry.type !== 'Polygon' || !geometry.coordinates?.[0]) {
      return 100; // 默认面积
    }
    
    const coords = geometry.coordinates[0];
    let area = 0;
    
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i];
      const [x2, y2] = coords[i + 1];
      area += (x1 * y2 - x2 * y1);
    }
    
    return Math.abs(area / 2) * 111000 * 111000; // 近似转换为平方米
  };

  // 更新太阳位置
  const updateSunPosition = () => {
    if (!mapRef.current) return;

    const center = mapRef.current.getCenter();
    const sunPosition = GeoUtils.getSunPosition(currentDate, center.lat, center.lng);
    setSunPosition(sunPosition);
  };

  // 当日期改变时更新阴影地图
  useEffect(() => {
    if (shadeMapRef.current) {
      shadeMapRef.current.setDate(currentDate);
      updateSunPosition();
    }
  }, [currentDate]);

  // 当地图设置改变时更新阴影地图
  useEffect(() => {
    if (shadeMapRef.current && mapRef.current) {
      try {
        // 安全地更新阴影模拟器设置
        if (typeof shadeMapRef.current.setColor === 'function') {
          shadeMapRef.current.setColor(mapSettings.shadowColor);
        }
        if (typeof shadeMapRef.current.setOpacity === 'function') {
          shadeMapRef.current.setOpacity(mapSettings.shadowOpacity);
        }

        // 控制阴影图层显示（使用透明度）
        if (mapSettings.showShadowLayer) {
          // 显示阴影：恢复设定的透明度
          shadeMapRef.current.setOpacity(mapSettings.shadowOpacity);
          console.log(`✅ 阴影图层已显示 (透明度: ${mapSettings.shadowOpacity})`);
        } else {
          // 隐藏阴影：设置完全透明
          shadeMapRef.current.setOpacity(0);
          console.log('✅ 阴影图层已隐藏 (透明度: 0)');
        }
      } catch (error) {
        console.error('❌ 更新阴影图层失败:', error);
      }
    }
  }, [mapSettings.shadowColor, mapSettings.shadowOpacity, mapSettings.showShadowLayer]);

  // 当太阳曝光设置改变时切换模拟器模式
  useEffect(() => {
    if (mapRef.current && shadeMapRef.current) {
      console.log(`🌈 太阳曝光热力图设置变更: ${mapSettings.showSunExposure ? '开启' : '关闭'}`);
      
      // 直接切换太阳曝光分析，不重新创建
      try {
        if (typeof shadeMapRef.current.setSunExposure === 'function') {
          if (mapSettings.showSunExposure) {
            // 开启热力图
            shadeMapRef.current.setSunExposure(true, {
              startDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 6, 0, 0),
              endDate: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 18, 0, 0),
              iterations: 24
            });
            console.log('✅ 热力图已开启');
          } else {
            // 关闭热力图
            shadeMapRef.current.setSunExposure(false);
            console.log('✅ 热力图已关闭');
          }
        } else {
          console.warn('⚠️ setSunExposure 方法不可用，需要重新初始化');
          // 只有在方法不可用时才重新初始化
          setTimeout(() => {
            if (mapRef.current) {
              initShadowSimulator(mapRef.current);
            }
          }, 100);
        }
      } catch (error) {
        console.error('❌ 切换热力图失败:', error);
      }
    }
  }, [mapSettings.showSunExposure]);

  // 当地图中心改变时更新太阳位置
  useEffect(() => {
    updateSunPosition();
  }, [mapCenter]);

  const resetSimulation = () => {
    if (shadeMapRef.current) {
      try {
        // 重置阴影模拟器状态
        shadeMapRef.current.remove();
        if (mapRef.current) {
          initShadowSimulator(mapRef.current);
        }
        
        // 重置store状态
        setSunPosition({ altitude: 0, azimuth: 0 });
        setAnalysisResult(null);
        setAnalysisResults({});
        
        addStatusMessage('阴影模拟已重置', 'info');
      } catch (error) {
        console.error('重置模拟失败:', error);
        addStatusMessage('重置模拟失败', 'error');
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
