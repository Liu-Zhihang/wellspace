/**
 */

export interface LayerStatus {
  layerId: string;
  exists: boolean;
  visible: boolean;
  sourceId?: string;
  sourceExists?: boolean;
  featureCount?: number;
}

export interface MapDiagnostics {
  mapReady: boolean;
  layers: LayerStatus[];
  sources: string[];
  zoom: number;
  pitch: number;
  bearing: number;
  center: [number, number];
}

export class LayerDiagnostics {
  /**
   */
  static diagnoseMap(map: any): MapDiagnostics {
    if (!map) {
      return {
        mapReady: false,
        layers: [],
        sources: [],
        zoom: 0,
        pitch: 0,
        bearing: 0,
        center: [0, 0]
      };
    }

    const layers: LayerStatus[] = [];
    const sources: string[] = [];

    const layerIds = [
      'wfs-buildings-fill',
      'wfs-buildings-outline', 
      'wfs-buildings-extrusion',
      'wfs-shadows-fill'
    ];

    layerIds.forEach(layerId => {
      const layer = map.getLayer(layerId);
      const exists = !!layer;
      let visible = false;
      let sourceId = '';
      let sourceExists = false;
      let featureCount = 0;

      if (exists) {
        visible = map.getLayoutProperty(layerId, 'visibility') !== 'none';
        sourceId = layer.source || '';
        sourceExists = !!map.getSource(sourceId);
        
        if (sourceExists && sourceId) {
          const source = map.getSource(sourceId);
          if (source && source._data && source._data.features) {
            featureCount = source._data.features.length;
          }
        }
      }

      layers.push({
        layerId,
        exists,
        visible,
        sourceId,
        sourceExists,
        featureCount
      });
    });

    const style = map.getStyle();
    if (style && style.sources) {
      Object.keys(style.sources).forEach(sourceId => {
        if (sourceId.startsWith('wfs-')) {
          sources.push(sourceId);
        }
      });
    }

    return {
      mapReady: true,
      layers,
      sources,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      center: [map.getCenter().lat, map.getCenter().lng]
    };
  }

  /**
   */
  static generateReport(diagnostics: MapDiagnostics): string {
    const { mapReady, layers, sources, zoom, pitch, bearing, center } = diagnostics;

    let report = `
🔍 
====================

📊 :
- : ${mapReady ? '✅' : '❌'}
- : ${zoom.toFixed(2)}
- : ${pitch.toFixed(1)}°
- : ${bearing.toFixed(1)}°
- : [${center[0].toFixed(4)}, ${center[1].toFixed(4)}]

📋 :
`;

    layers.forEach(layer => {
      const status = layer.exists ? (layer.visible ? '✅ ' : '⚠️ ') : '❌ ';
      const sourceStatus = layer.sourceExists ? '✅' : '❌';
      const featureInfo = layer.featureCount !== undefined ? ` (${layer.featureCount} )` : '';
      
      report += `- ${layer.layerId}: ${status}${featureInfo}\n`;
      if (layer.sourceId) {
        report += `  └─ : ${layer.sourceId} ${sourceStatus}\n`;
      }
    });

    report += `\n📦 :\n`;
    sources.forEach(sourceId => {
      report += `- ${sourceId}\n`;
    });

    return report.trim();
  }

  /**
   */
  static checkCommonIssues(diagnostics: MapDiagnostics): string[] {
    const issues: string[] = [];

    if (!diagnostics.mapReady) {
      issues.push('❌ ');
      return issues;
    }

    const buildingFill = diagnostics.layers.find(l => l.layerId === 'wfs-buildings-fill');
    if (!buildingFill || !buildingFill.exists) {
      issues.push('❌ ');
    } else if (!buildingFill.visible) {
      issues.push('⚠️ ');
    }

    const buildingExtrusion = diagnostics.layers.find(l => l.layerId === 'wfs-buildings-extrusion');
    if (!buildingExtrusion || !buildingExtrusion.exists) {
      issues.push('❌ 3D');
    }

    const shadowFill = diagnostics.layers.find(l => l.layerId === 'wfs-shadows-fill');
    if (!shadowFill || !shadowFill.exists) {
      issues.push('❌ ');
    } else if (!shadowFill.visible) {
      issues.push('⚠️ ');
    }

    if (diagnostics.sources.length === 0) {
      issues.push('❌ WFS');
    }

    if (diagnostics.zoom < 14) {
      issues.push('⚠️ ，');
    }

    return issues;
  }

  /**
   */
  static getFixSuggestions(issues: string[]): string[] {
    const suggestions: string[] = [];

    if (issues.some(i => i.includes(''))) {
      suggestions.push('🔄 ""');
    }

    if (issues.some(i => i.includes(''))) {
      suggestions.push('🌅 ""');
    }

    if (issues.some(i => i.includes(''))) {
      suggestions.push('🔍 15');
    }

    if (issues.some(i => i.includes('WFS'))) {
      suggestions.push('🔄 ""WFS');
    }

    if (suggestions.length === 0) {
      suggestions.push('✅ ');
    }

    return suggestions;
  }
}
