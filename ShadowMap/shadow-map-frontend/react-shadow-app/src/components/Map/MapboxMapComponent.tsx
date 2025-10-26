import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature } from 'geojson';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { SmartShadowCalculator } from '../../utils/smartShadowCalculator';
import { shadowQualityController } from '../../utils/shadowQualityController';
import { MapboxShadowSync } from '../../utils/mapboxShadowSync';
import { localFirstBuildingService } from '../../services/localFirstBuildingService';
import { weatherService } from '../../services/weatherService';
import { BuildingLayerManager } from './BuildingLayerManager';
import type { BuildingFeature } from '../../types/index.ts';

const CLOUD_SOURCE_ID = 'shadowmap-cloud-attenuation';
const CLOUD_LAYER_ID = 'shadowmap-cloud-attenuation-layer';
const CLOUD_LAYER_MAX_OPACITY = 0.45;
const MIN_SHADOW_DARKNESS_FACTOR = 0.45;
const WEATHER_REFRESH_THROTTLE_MS = 2 * 60 * 1000;

const WORLD_CLOUD_MASK: Feature = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-180, -85],
        [180, -85],
        [180, 85],
        [-180, 85],
        [-180, -85]
      ]
    ]
  }
};

const computeEffectiveShadowOpacity = (
  baseOpacity: number,
  sunlightFactor: number,
  enforceMinimum: boolean
): number => {
  const factor = enforceMinimum
    ? MIN_SHADOW_DARKNESS_FACTOR + (1 - MIN_SHADOW_DARKNESS_FACTOR) * sunlightFactor
    : sunlightFactor;
  return Math.max(0, Math.min(1, baseOpacity * factor));
};

const calculateCloudOverlayOpacity = (cloudCover: number | null | undefined): number => {
  if (cloudCover == null || Number.isNaN(cloudCover)) {
    return 0;
  }
  return Math.max(0, Math.min(CLOUD_LAYER_MAX_OPACITY, cloudCover * CLOUD_LAYER_MAX_OPACITY));
};

// 🔧 正确导入mapbox-gl-shadow-simulator
declare global {
  interface Window {
    ShadeMap: any;
  }
}

// 检查阴影模拟器是否正确加载
function checkShadowSimulatorAvailability(): boolean {
  if (typeof window.ShadeMap === 'function') {
    console.log('✅ ShadeMap (window) 可用');
    return true;
  }
  
  // 检查是否有其他导入方式
  const globalShadeMap = (window as any).mapboxglShadowSimulator || (window as any).ShadowSimulator;
  if (globalShadeMap) {
    console.log('✅ 找到替代ShadeMap导入');
    window.ShadeMap = globalShadeMap;
    return true;
  }
  
  console.error('❌ ShadeMap插件未正确加载');
  console.log('💡 检查是否已加载: https://unpkg.com/mapbox-gl-shadow-simulator/dist/mapbox-gl-shadow-simulator.umd.min.js');
  return false;
}

interface MapboxMapComponentProps {
  className?: string;
}

export const MapboxMapComponent: React.FC<MapboxMapComponentProps> = ({ className = '' }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const shadeMapRef = useRef<any>(null);
  const shadowCalculatorRef = useRef<SmartShadowCalculator | null>(null);
  const shadowSyncRef = useRef<MapboxShadowSync | null>(null);
  const weatherRequestRef = useRef<Promise<void> | null>(null);
  const lastWeatherKeyRef = useRef<string | null>(null);
  const lastReportedCloudRef = useRef<number | null>(null);
  
  const shadowStore = useShadowMapStore();
  const {
    mapSettings,
    shadowSettings: shadowSettingsState,
    currentDate,
    addStatusMessage,
    setMapView,
    currentWeather,
    setCurrentWeather,
  } = shadowStore;

  const ensureCloudOverlay = (map: mapboxgl.Map) => {
    if (map.getSource(CLOUD_SOURCE_ID)) {
      return;
    }

    map.addSource(CLOUD_SOURCE_ID, {
      type: 'geojson',
      data: WORLD_CLOUD_MASK,
    });

    map.addLayer({
      id: CLOUD_LAYER_ID,
      type: 'fill',
      source: CLOUD_SOURCE_ID,
      paint: {
        'fill-color': '#000000',
        'fill-opacity': 0,
      },
      layout: {
        visibility: 'visible',
      },
    });
  };

  const updateCloudLayerOpacity = (cloudCover: number | null | undefined) => {
    const map = mapRef.current;
    if (!map) return;

    ensureCloudOverlay(map);

    if (map.getLayer(CLOUD_LAYER_ID)) {
      map.setPaintProperty(CLOUD_LAYER_ID, 'fill-opacity', calculateCloudOverlayOpacity(cloudCover ?? null));
    }
  };

  const refreshWeatherData = (reason: string) => {
    if (!mapRef.current) return;
    if (!shadowSettingsState.autoCloudAttenuation) {
      return;
    }

    const now = Date.now();
    const center = mapRef.current.getCenter();
    const cacheKey = weatherService.buildCacheKey(center.lat, center.lng, currentDate);

    const lastFetched = currentWeather.fetchedAt ? currentWeather.fetchedAt.getTime() : 0;
    if (lastWeatherKeyRef.current === cacheKey && now - lastFetched < WEATHER_REFRESH_THROTTLE_MS) {
      return;
    }

    if (weatherRequestRef.current) {
      return;
    }

    weatherRequestRef.current = (async () => {
      try {
        const { snapshot } = await weatherService.getCurrentWeather(center.lat, center.lng, currentDate);
        const fetchedAt = snapshot.fetchedAt ?? new Date();

        setCurrentWeather({
          cloudCover: snapshot.cloudCover,
          sunlightFactor: snapshot.sunlightFactor,
          fetchedAt,
          raw: snapshot.raw ?? null,
        });

        lastWeatherKeyRef.current = cacheKey;

        const previousCloud = lastReportedCloudRef.current;
        if (snapshot.cloudCover != null) {
          if (previousCloud === null || Math.abs(snapshot.cloudCover - previousCloud) >= 0.05) {
            const cloudPct = Math.round(snapshot.cloudCover * 100);
            const sunlightPct = Math.round(snapshot.sunlightFactor * 100);
            addStatusMessage(`☁️ 云量约 ${cloudPct}% ，日照系数 ${sunlightPct}%`, 'info');
            lastReportedCloudRef.current = snapshot.cloudCover;
          }
        } else if (previousCloud !== null) {
          addStatusMessage('☀️ 云量数据缺失，使用默认晴空值', 'warning');
          lastReportedCloudRef.current = null;
        }
      } catch (error) {
        console.warn(`⚠️ 获取云量失败 (${reason}):`, error);

        if (!currentWeather.fetchedAt || now - lastFetched > WEATHER_REFRESH_THROTTLE_MS) {
          addStatusMessage('⚠️ 云量数据获取失败，使用默认晴空值', 'warning');
          setCurrentWeather({
            cloudCover: null,
            sunlightFactor: 1,
            fetchedAt: new Date(),
            raw: null,
          });
          lastReportedCloudRef.current = null;
        }
      } finally {
        weatherRequestRef.current = null;
        lastWeatherKeyRef.current = cacheKey;
      }
    })();
  };

  // 初始化Mapbox地图
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    console.log('🗺️ 初始化Mapbox GL地图...');

    // 设置Mapbox访问令牌
    mapboxgl.accessToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';

    // 创建Mapbox地图实例
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v11', // 默认街道样式
      center: [116.4074, 39.9042], // 北京天安门 [lng, lat]
      zoom: 15, // 提高初始缩放级别
      hash: true, // URL同步
      antialias: true, // 抗锯齿
    });

    mapRef.current = map;

    // 地图加载完成后初始化阴影模拟器
    map.on('load', () => {
      console.log('✅ Mapbox地图加载完成');
      initMapboxShadowSimulator(map);
      
      // 初始化智能阴影计算器
      initSmartShadowCalculator(map);
      ensureCloudOverlay(map);
      updateCloudLayerOpacity(currentWeather.cloudCover);
      refreshWeatherData('map-load');
      
      // 添加地图事件监听
      map.on('click', handleMapClick);
      
      // 🔧 优化的地图事件处理 - 使用智能计算器
      map.on('moveend', () => {
        const center = map.getCenter();
        const zoom = map.getZoom();
        setMapView([center.lat, center.lng], zoom);
        
        // 使用智能阴影计算器处理移动
        if (shadowCalculatorRef.current) {
          const bounds = map.getBounds();
          shadowCalculatorRef.current.requestCalculation(
            {
              north: bounds.getNorth(),
              south: bounds.getSouth(),
              east: bounds.getEast(),
              west: bounds.getWest()
            },
            zoom,
            currentDate,
            'move'
          );
        }

        refreshWeatherData('move');
      });
      
      // 处理缩放事件
      map.on('zoomend', () => {
        if (shadowCalculatorRef.current) {
          const bounds = map.getBounds();
          const zoom = map.getZoom();
          shadowCalculatorRef.current.requestCalculation(
            {
              north: bounds.getNorth(),
              south: bounds.getSouth(),
              east: bounds.getEast(),
              west: bounds.getWest()
            },
            zoom,
            currentDate,
            'zoom'
          );
        }

        refreshWeatherData('zoom');
      });
    });

    // 清理函数
    return () => {
      if (shadowSyncRef.current) {
        shadowSyncRef.current.destroy();
        shadowSyncRef.current = null;
      }
      if (shadowCalculatorRef.current) {
        shadowCalculatorRef.current.destroy();
        shadowCalculatorRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // 初始化Mapbox阴影模拟器
  const initMapboxShadowSimulator = async (map: mapboxgl.Map) => {
    try {
      console.log('🌅 初始化Mapbox阴影模拟器...');

      // 🔧 检查阴影模拟器插件是否正确加载
      if (!checkShadowSimulatorAvailability()) {
        console.error('❌ mapbox-gl-shadow-simulator 插件未加载或版本不兼容');
        addStatusMessage('❌ 阴影模拟器插件未加载', 'error');
        
        // 提供详细的诊断信息
        console.log('🔧 插件诊断:');
        console.log(`   Mapbox版本: ${mapboxgl.version}`);
        console.log(`   window.ShadeMap: ${typeof window.ShadeMap}`);
        console.log(`   插件文件检查: 确认HTML中是否包含阴影模拟器脚本`);
        
        return;
      }

      // 🎨 获取当前zoom级别的阴影质量配置
      const currentZoom = map.getZoom();
      const qualitySettings = mapSettings.enableDynamicQuality
        ? shadowQualityController.getOptimizedShadowSettings(currentZoom)
        : {
            opacity: mapSettings.shadowOpacity,
            color: mapSettings.shadowColor,
            resolution: 512, // Default resolution
            antiAliasing: true,
          };
      
      console.log(`🎨 阴影质量配置: zoom=${currentZoom.toFixed(1)}, 透明度=${qualitySettings.opacity}, 颜色=${qualitySettings.color}`);

      // 🔧 直接修复：确保阴影模拟器与Mapbox使用完全相同的坐标系
      console.log('🎯 配置阴影模拟器与Mapbox坐标系完全同步...');
      
      // 获取Mapbox地图的投影信息
      const mapProjection = map.getProjection();
      const mapCenter = map.getCenter();
      const mapZoom = map.getZoom();
      
      console.log(`📍 Mapbox地图状态: 中心(${mapCenter.lng.toFixed(6)}, ${mapCenter.lat.toFixed(6)}), zoom=${mapZoom.toFixed(2)}`);
      console.log(`🗺️ Mapbox投影: ${mapProjection?.name || 'Web Mercator (默认)'}`);

      // 🔧 按官方标准方式创建阴影模拟器 - 确保与Mapbox坐标系兼容
      console.log('🔧 按官方标准初始化阴影模拟器...');
      
      const shadeMap = new window.ShadeMap({
        date: currentDate,
        color: qualitySettings.color,        
        opacity: qualitySettings.opacity,    
        apiKey: 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6Imp3dTkyM0Bjb25uZWN0LmhrdXN0LWd6LmVkdS5jbiIsImNyZWF0ZWQiOjE3NTcyNDMxNzAxMzIsImlhdCI6MTc1NzI0MzE3MH0.Z7ejYmxcuKL3Le1Ydil1uRbP_EOS_wtLA6rsSewDUoA',
        terrainSource: {
          maxZoom: 15,
          tileSize: 256,
          // 🔧 多源DEM获取策略 - 优先使用可用数据源
          getSourceUrl: ({ x, y, z }: { x: number; y: number; z: number }) => {
            const safeZ = Math.floor(z);
            const safeX = Math.floor(x);
            const safeY = Math.floor(y);
            
            // 🔧 优先使用后端的多源DEM服务
            console.log(`🗻 请求多源DEM瓦片: ${safeZ}/${safeX}/${safeY}`);
            return `http://localhost:3500/api/dem/${safeZ}/${safeX}/${safeY}.png`;
          },
          // 🔧 通用高程解码 - 支持多种DEM格式
          getElevation: ({ r, g, b }: { r: number; g: number; b: number }) => {
            let elevation: number;
            
            // 🔧 智能格式检测和解码
            // 检测AWS Terrarium格式 (最常见)
            const terrariumElevation = (r * 256 + g + b / 256) - 32768;
            
            // 检测Mapbox Terrain RGB格式
            const mapboxElevation = -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
            
            // 智能选择更合理的解码结果
            if (Math.abs(terrariumElevation) < Math.abs(mapboxElevation) && 
                terrariumElevation > -500 && terrariumElevation < 9000) {
              elevation = terrariumElevation;
              // console.log(`🔧 使用Terrarium解码: ${elevation.toFixed(1)}m`);
            } else if (mapboxElevation > -500 && mapboxElevation < 9000) {
              elevation = mapboxElevation;
              // console.log(`🔧 使用Mapbox解码: ${elevation.toFixed(1)}m`);
            } else {
              console.warn(`⚠️ 无法解码高程值 (RGB: ${r},${g},${b}), 使用海平面`);
              elevation = 0; // 默认海平面
            }
            
            return elevation;
          },
          // 🔧 坐标系统配置
          projection: 'EPSG:3857', // Web Mercator
          tileAlignment: 'pixel-perfect', // 像素级对齐
          demFormat: 'auto-detect', // 自动检测DEM格式
        },
        // 🔧 阴影质量配置
        shadowResolution: qualitySettings.resolution,
        antiAliasing: qualitySettings.antiAliasing,
        getFeatures: async () => {
          const rawBuildings = await getCurrentViewBuildings(map);
          const currentMapZoom = map.getZoom();
          
          console.log(`🏗️ 原始建筑物数据: ${rawBuildings.length} 个`);
          
          // 🔧 可选的建筑物筛选 - 用户可控制
          let processedBuildings = rawBuildings;
          
          if (mapSettings.enableBuildingFilter) {
            const { filtered, stats } = shadowQualityController.filterBuildings(rawBuildings, currentMapZoom);
            processedBuildings = filtered;
            
            console.log(`🎯 建筑物筛选已启用: ${stats.original} → ${stats.filtered} 建筑物`);
            console.log(`   移除小型建筑: ${stats.removedSmall} 个`);
            console.log(`   移除低矮建筑: ${stats.removedLow} 个`);
            console.log(`   保留重要建筑: ${stats.keptLarge} 个`);
          } else {
            console.log(`🏗️ 建筑物筛选已禁用: 显示所有 ${rawBuildings.length} 个建筑物`);
          }
          
          // 🔧 坐标精度对齐处理 - 修复阴影错位
          const alignedBuildings = processedBuildings.map((building) => {
            const geometry = building.geometry;

            if (!geometry) {
              return building;
            }

            if (geometry.type !== 'Polygon') {
              // 当前仅处理Polygon，要支持MultiPolygon可在此扩展
              return building;
            }
            
            // 确保坐标精度一致（6位小数精度）
            const alignedCoordinates = geometry.coordinates.map((ring: number[][]) => {
              return ring.map((coord: number[]) => [
                Math.round(coord[0] * 1000000) / 1000000, // 经度6位小数
                Math.round(coord[1] * 1000000) / 1000000  // 纬度6位小数
              ]);
            });
            
            // 确保有render_height属性
            const height = building.properties?.height || 
                          (building.properties?.levels ? building.properties.levels * 3.5 : 8);
            
            return {
              ...building,
              geometry: {
                ...geometry,
                coordinates: alignedCoordinates
              },
              properties: {
                ...building.properties,
                height: height,
                render_height: height, // 阴影模拟器需要的属性
                // 🔧 添加坐标系统标识
                coordinate_system: 'EPSG:4326', // WGS84
                precision: 6 // 6位小数精度
              }
            };
          });
          
          console.log(`🎯 坐标对齐处理完成: ${alignedBuildings.length} 个建筑物`);
          
          // 如果处理后没有建筑物，返回一个测试建筑物
          if (alignedBuildings.length === 0 && rawBuildings.length === 0) {
            console.log('🔧 没有建筑物数据，创建测试建筑物以显示阴影效果');
            return [{
              type: 'Feature',
              geometry: {
                type: 'Polygon',
                coordinates: [[[116.406, 39.903], [116.408, 39.903], [116.408, 39.905], [116.406, 39.905], [116.406, 39.903]]]
              },
              properties: {
                height: 50,
                render_height: 50
              }
            }];
          }
          
          return alignedBuildings;
        },
        debug: (msg: string) => {
          console.log('🔧 Mapbox Shadow Simulator:', msg);
        },
      });

      // 添加到地图
      shadeMap.addTo(map);
      shadeMapRef.current = shadeMap;
      
      // 🔧 导出实例到window，便于浏览器验证
      (window as any).mapInstance = map;
      (window as any).shadeMapInstance = shadeMap;

      // 🔧 立即创建并应用Mapbox坐标同步
      console.log('🎯 创建Mapbox-阴影同步器...');
      shadowSyncRef.current = new MapboxShadowSync(map, shadeMap);
      
      // 🔧 强制初始同步
      shadowSyncRef.current.forceSynchronization();
      
      // 🔧 启用实时同步
      shadowSyncRef.current.enableRealtimeSync();
      
      // 🔧 验证同步效果
      const syncValidation = shadowSyncRef.current.validateSync();
      console.log(`🔍 初始同步验证: ${syncValidation.aligned ? '✅ 对齐' : '❌ 错位'} (偏移${syncValidation.offsetPixels.toFixed(1)}像素)`);

      console.log('✅ Mapbox阴影模拟器初始化成功');
      console.log('🔧 阴影模拟器配置:', {
        date: currentDate.toISOString(),
        color: mapSettings.shadowColor,
        opacity: mapSettings.shadowOpacity,
        showShadowLayer: mapSettings.showShadowLayer,
        showSunExposure: mapSettings.showSunExposure
      });
      
      addStatusMessage('✅ 阴影模拟器初始化成功', 'info');

      // 强制刷新阴影计算和显示
      setTimeout(() => {
        if (shadeMapRef.current) {
          console.log('🔄 强制刷新阴影计算...');
          shadeMapRef.current.setDate(currentDate);
          
          // 强制设置阴影可见
          if (mapSettings.showShadowLayer) {
            shadeMapRef.current.setOpacity(mapSettings.shadowOpacity);
            console.log(`🎨 强制显示阴影 (透明度: ${mapSettings.shadowOpacity})`);
          }
          
          // 如果开启了太阳曝光，强制启用
          if (mapSettings.showSunExposure) {
            enableSunExposure();
          }
        }
      }, 1000);

      // 根据设置启用太阳曝光分析
      if (mapSettings.showSunExposure) {
        await enableSunExposure();
      }

    } catch (error) {
      console.error('❌ Mapbox阴影模拟器初始化失败:', error);
      addStatusMessage('❌ 阴影模拟器初始化失败', 'error');
    }
  };

  // 初始化智能阴影计算器
  const initSmartShadowCalculator = (map: mapboxgl.Map) => {
    console.log('🧠 初始化智能阴影计算器...');
    
    // 创建阴影计算函数
    const performShadowCalculation = async (context: any) => {
      if (!shadeMapRef.current) return;
      
      try {
        // 获取原始建筑物数据
        const rawBuildings = await getCurrentViewBuildings(map);
        const currentZoom = map.getZoom();
        
        // 🔧 可选的建筑物筛选 - 与getFeatures保持一致
        let processedBuildings = rawBuildings;
        
        if (mapSettings.enableBuildingFilter) {
          const { filtered, stats } = shadowQualityController.filterBuildings(rawBuildings, currentZoom);
          processedBuildings = filtered;
          console.log(`🎯 智能计算筛选: ${stats.original} → ${stats.filtered} 建筑物 (zoom ${currentZoom.toFixed(1)})`);
        } else {
          console.log(`🏗️ 智能计算筛选已禁用: 使用所有 ${rawBuildings.length} 个建筑物`);
        }
        
        // 🔧 动态更新阴影设置
        const activeSunlightFactor = shadowSettingsState.autoCloudAttenuation
          ? (currentWeather.sunlightFactor ?? 1)
          : shadowSettingsState.manualSunlightFactor;

        if (mapSettings.enableDynamicQuality) {
            const dynamicSettings = shadowQualityController.getOptimizedShadowSettings(currentZoom);
            if (typeof shadeMapRef.current.setOpacity === 'function') {
                shadeMapRef.current.setOpacity(
                  computeEffectiveShadowOpacity(
                    dynamicSettings.opacity,
                    activeSunlightFactor,
                    shadowSettingsState.autoCloudAttenuation
                  )
                );
            }
            if (typeof shadeMapRef.current.setColor === 'function') {
                shadeMapRef.current.setColor(dynamicSettings.color);
            }
        } else if (typeof shadeMapRef.current.setOpacity === 'function') {
            shadeMapRef.current.setOpacity(
              computeEffectiveShadowOpacity(
                mapSettings.shadowOpacity,
                activeSunlightFactor,
                shadowSettingsState.autoCloudAttenuation
              )
            );
        }

        // 更新建筑物数据到阴影模拟器
        if (typeof shadeMapRef.current.updateBuildings === 'function') {
          shadeMapRef.current.updateBuildings(processedBuildings);
        }
        
        // 更新时间
        shadeMapRef.current.setDate(context.date);
        
        // 🔧 安全地强制重新渲染阴影
        try {
          if (typeof shadeMapRef.current._draw === 'function') {
            // 检查heightMapTex是否已初始化
            if (shadeMapRef.current._heightMapTex || shadeMapRef.current.heightMapTex) {
              shadeMapRef.current._draw();
            } else {
              console.warn('⚠️ heightMapTex未初始化，跳过_draw调用');
            }
          }
        } catch (drawError) {
          console.warn('⚠️ 阴影重绘失败:', drawError);
        }
        
        // 🔧 计算完成后立即同步坐标
        if (shadowSyncRef.current) {
          shadowSyncRef.current.forceSynchronization();
          
          // 验证同步效果
          const syncResult = shadowSyncRef.current.validateSync();
          if (!syncResult.aligned) {
            console.warn(`⚠️ 阴影仍有偏移: ${syncResult.offsetPixels.toFixed(1)}像素`);
            
            // 如果偏移大于10像素，再次尝试同步
            if (syncResult.offsetPixels > 10) {
              console.log('🔄 偏移过大，再次强制同步...');
              setTimeout(() => {
                shadowSyncRef.current?.forceSynchronization();
              }, 100);
            }
          } else {
            console.log('✅ Mapbox-阴影坐标同步成功');
          }
        }
        
        console.log(`✨ 智能阴影计算完成: ${processedBuildings.length} 个建筑物`);
        
      } catch (error) {
        console.error('❌ 智能阴影计算失败:', error);
      }
    };
    
    // 创建智能计算器实例
    shadowCalculatorRef.current = new SmartShadowCalculator(
      performShadowCalculation,
      {
        moveDelay: 800,        // 地图移动防抖
        zoomDelay: 500,        // 缩放防抖
        dateDelay: 300,        // 时间变化防抖
        minMovement: 0.001,    // 最小移动阈值
        minZoomChange: 0.2,    // 最小缩放阈值
        maxCalculationInterval: 30000 // 30秒强制刷新
      }
    );
    
    console.log('✅ 智能阴影计算器初始化完成');
  };

  // 启用太阳曝光分析
  const enableSunExposure = async () => {
    if (!shadeMapRef.current) return;

    try {
      const startDate = new Date(currentDate);
      startDate.setHours(6, 0, 0, 0);
      
      const endDate = new Date(currentDate);
      endDate.setHours(18, 0, 0, 0);

      await shadeMapRef.current.setSunExposure(true, {
        startDate,
        endDate,
        iterations: 24
      });

      console.log('✅ 太阳曝光分析已启用');
      addStatusMessage('✅ 热力图已开启', 'info');
    } catch (error) {
      console.error('❌ 启用太阳曝光分析失败:', error);
    }
  };

  // 禁用太阳曝光分析
  const disableSunExposure = async () => {
    if (!shadeMapRef.current) return;

    try {
      await shadeMapRef.current.setSunExposure(false);
      console.log('✅ 太阳曝光分析已禁用');
      addStatusMessage('✅ 热力图已关闭', 'info');
    } catch (error) {
      console.error('❌ 禁用太阳曝光分析失败:', error);
    }
  };

  // Get current view building data with local-first strategy
  const getCurrentViewBuildings = async (map: mapboxgl.Map): Promise<BuildingFeature[]> => {
    try {
      // Check if we're at an appropriate zoom level
      const currentZoom = map.getZoom();
      if (currentZoom < 14) {
        console.log(`📊 Zoom level ${currentZoom.toFixed(1)} too low for building data`);
        return [];
      }
      
      // 🔧 使用本地优先策略获取建筑物数据
      const bounds = map.getBounds();
      const buildingData = await localFirstBuildingService.getBuildingData({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      }, currentZoom);
      
      const buildings = buildingData.features;

      // Add building type validation and enhancement
      const enhancedBuildings = buildings.map((building) => {
        const baseHeight = building.properties?.height ?? (
          building.properties?.levels
            ? building.properties.levels * 3.5
            : estimateBuildingHeight(building.properties?.buildingType || 'building')
        );

        const properties: BuildingFeature['properties'] = {
          ...building.properties,
          height: baseHeight,
          render_height: baseHeight,
        };

        return {
          ...building,
          properties,
        };
      });

      console.log(`✅ Processed ${enhancedBuildings.length} buildings for shadow simulation`);
      return enhancedBuildings;

    } catch (error) {
      console.error('❌ Failed to get building data:', error);
      return [];
    }
  };

  // Estimate building height based on type
  const estimateBuildingHeight = (buildingType: string): number => {
    const heightMap: { [key: string]: number } = {
      'house': 6,
      'residential': 12,
      'apartments': 20,
      'commercial': 15,
      'retail': 8,
      'office': 25,
      'industrial': 10,
      'warehouse': 8,
      'hospital': 15,
      'school': 10,
      'church': 12,
      'tower': 50,
      'skyscraper': 100
    };
    
    return heightMap[buildingType] || 8;
  };

  // Enhanced building data retrieval with better error handling and retry logic
  const getBuildingsFromAPI = async (map: mapboxgl.Map, retryCount = 0): Promise<any[]> => {
    const maxRetries = 2;
    
    try {
      const bounds = map.getBounds();
      const zoom = Math.floor(Math.max(15, Math.min(map.getZoom(), 17))); // Force zoom 15+ and ensure integer
      
      console.log(`🔄 Fetching building data from API (zoom: ${zoom}, attempt: ${retryCount + 1})...`);
      
      // Calculate required tiles with proper bounds validation
      const tiles = [];
      const n = Math.pow(2, zoom);
      
      // Calculate tile coordinates
      let minTileX = Math.floor((bounds.getWest() + 180) / 360 * n);
      let maxTileX = Math.floor((bounds.getEast() + 180) / 360 * n);
      let minTileY = Math.floor((1 - Math.log(Math.tan(bounds.getNorth() * Math.PI/180) + 1/Math.cos(bounds.getNorth() * Math.PI/180)) / Math.PI) / 2 * n);
      let maxTileY = Math.floor((1 - Math.log(Math.tan(bounds.getSouth() * Math.PI/180) + 1/Math.cos(bounds.getSouth() * Math.PI/180)) / Math.PI) / 2 * n);
      
      // 🔧 关键修复：约束瓦片坐标到有效范围
      const maxTileCoord = n - 1; // 最大瓦片坐标
      minTileX = Math.max(0, Math.min(minTileX, maxTileCoord));
      maxTileX = Math.max(0, Math.min(maxTileX, maxTileCoord));
      minTileY = Math.max(0, Math.min(minTileY, maxTileCoord));
      maxTileY = Math.max(0, Math.min(maxTileY, maxTileCoord));
      
      // 验证坐标合理性
      if (minTileX > maxTileX || minTileY > maxTileY) {
        console.warn(`⚠️ 无效边界框: minX=${minTileX}, maxX=${maxTileX}, minY=${minTileY}, maxY=${maxTileY}`);
        return [];
      }
      
      console.log(`🗺️ 计算瓦片范围: zoom=${zoom}, x=${minTileX}-${maxTileX}, y=${minTileY}-${maxTileY}, 最大=${maxTileCoord}`);
      
      // Limit tile count for performance
      const maxTiles = 6; // Increased from 4
      let tileCount = 0;
      
      for (let x = minTileX; x <= maxTileX && tileCount < maxTiles; x++) {
        for (let y = minTileY; y <= maxTileY && tileCount < maxTiles; y++) {
          // 再次验证每个瓦片坐标
          if (x >= 0 && x <= maxTileCoord && y >= 0 && y <= maxTileCoord) {
            tiles.push({ z: Math.floor(zoom), x, y }); // 确保zoom是整数
            tileCount++;
          } else {
            console.warn(`⚠️ 跳过无效瓦片坐标: ${zoom}/${x}/${y} (最大: ${maxTileCoord})`);
          }
        }
      }
      
      console.log(`📊 Need to fetch ${tiles.length} tiles`);
      
      // Fetch building data with parallel requests and error handling
      const buildingPromises = tiles.map(async (tile) => {
        const maxTileRetries = 2;
        
        for (let attempt = 0; attempt <= maxTileRetries; attempt++) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout
            
            const response = await fetch(
              `http://localhost:3500/api/buildings/${Math.floor(tile.z)}/${tile.x}/${tile.y}.json`,
              { 
                signal: controller.signal,
                headers: {
                  'Cache-Control': 'max-age=300', // 5 minute cache
                }
              }
            );
            
            clearTimeout(timeoutId);
            
            if (response.ok) {
              const data = await response.json();
              if (data.features && Array.isArray(data.features)) {
                console.log(`✅ Tile ${tile.z}/${tile.x}/${tile.y}: ${data.features.length} buildings`);
                return data.features;
              }
            } else {
              console.warn(`⚠️ Tile ${tile.z}/${tile.x}/${tile.y} returned ${response.status}`);
            }
            
            // If first attempt failed but didn't throw, try again
            if (attempt < maxTileRetries) {
              await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); // Progressive delay
              continue;
            }
            
            return [];
            
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.warn(`⚠️ Tile ${tile.z}/${tile.x}/${tile.y} attempt ${attempt + 1} failed:`, errorMessage);
            
            if (attempt < maxTileRetries) {
              await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Progressive delay
              continue;
            }
            
            return [];
          }
        }
        
        return [];
      });
      
      // Wait for all requests with timeout
      const allResults = await Promise.allSettled(buildingPromises);
      const buildings = allResults
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value)
        .flat();
      
      console.log(`✅ API fetch complete: ${buildings.length} buildings from ${tiles.length} tiles`);
      
      // If we got no buildings and this is not a retry, try once more with different parameters
      if (buildings.length === 0 && retryCount < maxRetries) {
        console.log(`🔄 No buildings found, retrying with adjusted parameters...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return getBuildingsFromAPI(map, retryCount + 1);
      }
      
      return buildings;
      
    } catch (error) {
      console.error('❌ API building data fetch failed:', error);
      
      // Retry on network errors
      const errorMessage = error instanceof Error ? error.message : '';
      if (retryCount < maxRetries && (error instanceof TypeError || errorMessage.includes('fetch'))) {
        console.log(`🔄 Network error, retrying in ${(retryCount + 1) * 2} seconds...`);
        await new Promise(resolve => setTimeout(resolve, (retryCount + 1) * 2000));
        return getBuildingsFromAPI(map, retryCount + 1);
      }
      
      return [];
    }
  };

  // 处理地图点击事件
  const handleMapClick = (e: mapboxgl.MapMouseEvent) => {
    const { lng, lat } = e.lngLat;
    console.log(`📍 点击位置: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    
    // 执行阴影分析
    if (shadeMapRef.current && mapRef.current && typeof shadeMapRef.current.getHoursOfSun === 'function') {
      try {
        const point = mapRef.current.project([lng, lat]);
        const hoursOfSun = shadeMapRef.current.getHoursOfSun(point.x, point.y);
        
        addStatusMessage(`📊 分析结果: ${hoursOfSun.toFixed(1)}小时日照`, 'info');
        console.log(`📊 日照分析: ${hoursOfSun.toFixed(1)}小时`);
        
      } catch (error) {
        console.error('❌ 阴影分析失败:', error);
        addStatusMessage('❌ 阴影分析失败', 'error');
      }
    } else {
      addStatusMessage('⚠️ 请先开启日照分析功能', 'warning');
    }
  };

  // 监听太阳曝光设置变化
  useEffect(() => {
    if (shadeMapRef.current) {
      if (mapSettings.showSunExposure) {
        enableSunExposure();
      } else {
        disableSunExposure();
      }
    }
  }, [mapSettings.showSunExposure]);

  // 监听阴影设置变化
  useEffect(() => {
    if (!shadeMapRef.current) {
      return;
    }

    const sunlightFactor = shadowSettingsState.autoCloudAttenuation
      ? (currentWeather.sunlightFactor ?? 1)
      : shadowSettingsState.manualSunlightFactor;
    const effectiveOpacity = mapSettings.showShadowLayer
      ? computeEffectiveShadowOpacity(
          mapSettings.shadowOpacity,
          sunlightFactor,
          shadowSettingsState.autoCloudAttenuation
        )
      : 0;

    console.log(
      `🎨 更新阴影设置: 显示=${mapSettings.showShadowLayer}, ` +
      `基础透明度=${mapSettings.shadowOpacity}, 天气系数=${sunlightFactor.toFixed(2)}, ` +
      `实际透明度=${effectiveOpacity.toFixed(2)}`
    );
    
    try {
      if (typeof shadeMapRef.current.setOpacity === 'function') {
        shadeMapRef.current.setOpacity(effectiveOpacity);
      } else if (shadeMapRef.current.options) {
        shadeMapRef.current.options.opacity = effectiveOpacity;
      }
      
      if (typeof shadeMapRef.current.redraw === 'function') {
        shadeMapRef.current.redraw();
      }
      
      if (typeof shadeMapRef.current.setColor === 'function') {
        shadeMapRef.current.setColor(mapSettings.shadowColor);
      }
    } catch (error) {
      console.warn('更新阴影设置失败:', error);
    }
  }, [
    mapSettings.shadowColor,
    mapSettings.shadowOpacity,
    mapSettings.showShadowLayer,
    currentWeather.sunlightFactor,
    shadowSettingsState.autoCloudAttenuation,
    shadowSettingsState.manualSunlightFactor
  ]);

  useEffect(() => {
    const effectiveCover = shadowSettingsState.autoCloudAttenuation ? currentWeather.cloudCover : null;
    updateCloudLayerOpacity(effectiveCover);
  }, [currentWeather.cloudCover, shadowSettingsState.autoCloudAttenuation]);

  // 监听日期变化 - 使用智能计算器
  useEffect(() => {
    if (shadowCalculatorRef.current && mapRef.current) {
      const bounds = mapRef.current.getBounds();
      const zoom = mapRef.current.getZoom();
      
      shadowCalculatorRef.current.requestCalculation(
        {
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        },
        zoom,
        currentDate,
        'date'
      );
    } else if (shadeMapRef.current) {
      // 降级处理：如果智能计算器不可用，直接更新
      shadeMapRef.current.setDate(currentDate);
    }

    refreshWeatherData('date');
  }, [currentDate]);

  return (
    <div className={`relative w-full h-full ${className}`} style={{ minHeight: '400px' }}>
      {/* Mapbox地图容器 */}
      <div 
        ref={mapContainerRef} 
        className="w-full h-full"
      />
      
      {/* 建筑物图层管理器 */}
      {mapRef.current && (
        <BuildingLayerManager map={mapRef.current} />
      )}
      
      {/* 加载指示器 */}
      <div className="absolute top-4 right-4 bg-white bg-opacity-90 rounded-lg p-2 text-sm">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          <span>Mapbox GL + 阴影模拟器 + 建筑物图层</span>
        </div>
      </div>
    </div>
  );
};
