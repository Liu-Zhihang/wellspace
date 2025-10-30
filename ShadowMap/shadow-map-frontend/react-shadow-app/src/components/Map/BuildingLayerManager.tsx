/**
 */

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { GeoJSONSourceRaw } from 'mapbox-gl';
import type { BuildingFeature, BuildingFeatureCollection } from '../../types/index.ts';
import { useShadowMapStore } from '../../store/shadowMapStore';
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

  const removeBuildingLayer = () => {
    if (!map) return;

    try {
      const layers = [buildingFillLayerId, buildingOutlineLayerId, buildingLabelsLayerId];
      layers.forEach((layerId) => {
        if (map.getLayer(layerId)) {
          map.removeLayer(layerId);
        }
      });

      if (map.getSource(buildingSourceId)) {
        map.removeSource(buildingSourceId);
      }

      isLayerAddedRef.current = false;
    } catch (error) {
      console.error('Failed to remove building layer:', error);
    }
  };

  const addBuildingLayer = async () => {
    if (!map) return;

    if (isLayerAddedRef.current) {
      removeBuildingLayer();
    }

    try {
      const bounds = map.getBounds();

      const wfsResponse = await wfsBuildingService.getWfsBuildings({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      }, 2000);

      const buildingData: BuildingFeatureCollection = wfsResponse.data;

      if (!buildingData.features.length) {
        removeBuildingLayer();
        return;
      }


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

      const sourceSpec: GeoJSONSourceRaw = {
        type: 'geojson',
        data: geojsonData
      };

      map.addSource(buildingSourceId, sourceSpec);

      map.addLayer({
        id: buildingFillLayerId,
        type: 'fill',
        source: buildingSourceId,
        paint: {
          'fill-color': '#D3D3D3',
          'fill-opacity': 0.8
        }
      });

      map.addLayer({
        id: buildingOutlineLayerId,
        type: 'line',
        source: buildingSourceId,
        paint: {
          'line-color': '#A0A0A0',
          'line-width': 1,
          'line-opacity': 0.9
        }
      });

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
    } catch (error) {
      console.error('Failed to add building layer:', error);
    }
  };


  useEffect(() => {
    if (!map) return;


    if (mapSettings.showBuildingLayer) {
      const timer = setTimeout(() => {
        addBuildingLayer();
      }, 100);
      
      return () => clearTimeout(timer);
    } else {
      removeBuildingLayer();
    }
  }, [map, mapSettings.showBuildingLayer]);

  useEffect(() => {
    if (!map || !mapSettings.showBuildingLayer) return;

    const handleMapMove = () => {
      if (map.getZoom() >= 14) {
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

  useEffect(() => {
    return () => {
      removeBuildingLayer();
    };
  }, []);

  return null;
};

export default BuildingLayerManager;
