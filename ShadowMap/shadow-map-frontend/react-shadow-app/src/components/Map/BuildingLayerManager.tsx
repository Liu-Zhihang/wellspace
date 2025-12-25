/**
 * 建筑物图层管理器
 * 负责在地图上显示建筑物轮廓和高度信息
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GeoJSONSourceRaw } from 'mapbox-gl';
import type { BuildingFeature, BuildingFeatureCollection } from '../../types/index.ts';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { localFirstBuildingService } from '../../services/localFirstBuildingService';
import { wfsBuildingService } from '../../services/wfsBuildingService';

interface BuildingLayerManagerProps {
  map: mapboxgl.Map;
}

export const BuildingLayerManager = ({ map }: BuildingLayerManagerProps) => {
  const { mapSettings } = useShadowMapStore();
  const buildingSourceId = 'wfs-buildings-source';
  const buildingFillLayerId = 'wfs-buildings-fill';
  const buildingOutlineLayerId = 'wfs-buildings-outline';
  const buildingLabelsLayerId = 'wfs-buildings-labels';
  const isLayerAddedRef = useRef(false);

  // 移除建筑物图层
  const removeBuildingLayer = () => {
    if (!map) return;

    try {
      console.log('🗑️ 移除建筑物图层...');
      
      // 移除所有图层
      const layers = [buildingFillLayerId, buildingOutlineLayerId, buildingLabelsLayerId];
      layers.forEach(layerId => {
        if (map.getLayer(layerId)) {
          map.removeLayer(layerId);
          console.log(`  ✅ 移除图层: ${layerId}`);
        }
      });

      // 移除数据源
      if (map.getSource(buildingSourceId)) {
        map.removeSource(buildingSourceId);
        console.log(`  ✅ 移除数据源: ${buildingSourceId}`);
      }

      isLayerAddedRef.current = false;
      console.log('✅ 建筑物图层移除完成');

    } catch (error) {
      console.error('❌ 移除建筑物图层失败:', error);
    }
  };

  // 添加建筑物图层到地图
  const addBuildingLayer = async () => {
    if (!map) return;

    // 如果图层已存在，先移除再重新添加
    if (isLayerAddedRef.current) {
      removeBuildingLayer();
    }

    try {
      console.log('🏢 添加建筑物图层到地图...');

      // 获取当前视图的建筑物数据
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      
      console.log(`📍 当前视图: zoom=${zoom}, bounds=${JSON.stringify({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      })}`);
      
      // 首先尝试使用WFS数据
      console.log('🏢 尝试获取WFS建筑数据...');
      let buildingData: BuildingFeatureCollection | null = null;
      
      try {
        const wfsResponse = await wfsBuildingService.getWfsBuildings({
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        }, 2000);
        
        buildingData = wfsResponse.data;
        console.log(`✅ WFS 数据获取成功: ${buildingData.features.length} 个建筑物`);
        
      } catch (wfsError) {
        console.log('⚠️ WFS 数据获取失败，回退到本地数据:', wfsError);
        
        // 回退到本地数据
        const localData = await localFirstBuildingService.getBuildingData({
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest()
        }, zoom);
        buildingData = {
          type: 'FeatureCollection',
          features: (localData.features as BuildingFeature[]) ?? [],
        };
        console.log(`📊 本地数据: ${buildingData.features.length} 个建筑物`);

        if (buildingData.features.length === 0) {
          console.log('📭 当前区域无建筑物数据，尝试获取北京示例建筑数据...');
          
          try {
            const beijingSampleResponse = await wfsBuildingService.getBeijingSampleBuildings();
            buildingData = beijingSampleResponse.data;
            console.log(`🏙️ 北京示例数据: ${buildingData.features.length} 个建筑物`);
          } catch (beijingError) {
            console.log('❌ 北京示例数据也获取失败，尝试本地北京数据:', beijingError);
            
            // 最后尝试本地北京数据
            const beijingBounds = {
              north: 40.2,
              south: 39.4,
              east: 117.4,
              west: 115.7
            };
            
            const beijingData = await localFirstBuildingService.getBuildingData(beijingBounds, zoom);
            console.log(`🏙️ 本地北京数据: ${beijingData.features.length} 个建筑物`);
            
            if (beijingData.features.length === 0) {
              console.log('❌ 所有数据源都无建筑物数据');
              return;
            }
            
            buildingData = {
              type: 'FeatureCollection',
              features: (beijingData.features as BuildingFeature[]) ?? [],
            };
          }
        }
      }

      if (!buildingData) {
        console.warn('⚠️ 未获取到任何建筑数据，终止渲染流程');
        return;
      }

      console.log(`🏗️ 准备渲染 ${buildingData.features.length} 个建筑物`);

      // 创建GeoJSON数据源
      const processedFeatures = buildingData.features.map((feature: BuildingFeature) => {
        const baseHeight = feature.properties?.height ?? (
          feature.properties?.levels
            ? feature.properties.levels * 3.5
            : 10
        );

        const properties: BuildingFeature['properties'] = {
          ...feature.properties,
          height: baseHeight,
          buildingType: feature.properties?.buildingType || 'building',
          levels: feature.properties?.levels ?? Math.round(baseHeight / 3.5),
          render_height: baseHeight,
        };

        return {
          ...feature,
          properties,
        };
      }) as BuildingFeatureCollection['features'];

      const geojsonData: BuildingFeatureCollection = {
        type: 'FeatureCollection',
        features: processedFeatures
      };

      console.log(`📊 处理后的GeoJSON数据: ${geojsonData.features.length} 个建筑物`);

      // 添加数据源
      const sourceSpec: GeoJSONSourceRaw = {
        type: 'geojson',
        data: geojsonData
      };

      map.addSource(buildingSourceId, sourceSpec);
      console.log(`✅ 数据源添加成功: ${buildingSourceId}`);

      // 添加建筑物填充图层 - 浅灰色（参考ShadeMap）
      map.addLayer({
        id: buildingFillLayerId,
        type: 'fill',
        source: buildingSourceId,
        paint: {
          'fill-color': '#D3D3D3', // 浅灰色
          'fill-opacity': 0.8
        }
      });
      console.log(`✅ 填充图层添加成功: ${buildingFillLayerId}`);

      // 添加建筑物轮廓图层 - 深灰色
      map.addLayer({
        id: buildingOutlineLayerId,
        type: 'line',
        source: buildingSourceId,
        paint: {
          'line-color': '#A0A0A0', // 深灰色
          'line-width': 1,
          'line-opacity': 0.9
        }
      });
      console.log(`✅ 轮廓图层添加成功: ${buildingOutlineLayerId}`);

      // 不添加文本标签图层，避免显示"8"字
      // 如果你想要显示高度信息，可以取消注释下面的代码
      /*
      map.addLayer({
        id: buildingLabelsLayerId,
        type: 'symbol',
        source: buildingSourceId,
        layout: {
          'text-field': ['get', 'height'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': 12,
          'text-offset': [0, 0],
          'text-anchor': 'center',
          'visibility': zoom > 16 ? 'visible' : 'none'
        },
        paint: {
          'text-color': '#000000',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1
        }
      });
      */

      isLayerAddedRef.current = true;
      console.log('✅ 建筑物图层添加成功');

    } catch (error) {
      console.error('❌ 添加建筑物图层失败:', error);
    }
  };


  // 监听建筑物图层设置变化
  useEffect(() => {
    if (!map) return;

    console.log(`🔄 建筑物图层设置变化: enabled=${mapSettings.showBuildingLayer}`);

    if (mapSettings.showBuildingLayer) {
      // 延迟添加，确保地图完全加载
      const timer = setTimeout(() => {
        addBuildingLayer();
      }, 100);
      
      return () => clearTimeout(timer);
    } else {
      removeBuildingLayer();
    }
  }, [map, mapSettings.showBuildingLayer]);

  // 监听地图移动和缩放，更新建筑物数据
  useEffect(() => {
    if (!map || !mapSettings.showBuildingLayer) return;

    const handleMapMove = () => {
      if (map.getZoom() >= 14) {
        // 延迟更新，避免频繁请求
        setTimeout(() => {
          addBuildingLayer();
        }, 500);
      }
    };

    map.on('moveend', handleMapMove);
    map.on('zoomend', handleMapMove);

    return () => {
      map.off('moveend', handleMapMove);
      map.off('zoomend', handleMapMove);
    };
  }, [map, mapSettings.showBuildingLayer]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      removeBuildingLayer();
    };
  }, []);

  return null; // 这是一个无UI组件
};

export default BuildingLayerManager;
