/**
 * 图层诊断工具
 * 用于检查和诊断地图图层状态
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
   * 诊断地图状态
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

    // 检查关键图层
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

    // 获取所有数据源
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
   * 生成诊断报告
   */
  static generateReport(diagnostics: MapDiagnostics): string {
    const { mapReady, layers, sources, zoom, pitch, bearing, center } = diagnostics;

    let report = `
🔍 地图图层诊断报告
====================

📊 基本状态:
- 地图就绪: ${mapReady ? '✅' : '❌'}
- 缩放级别: ${zoom.toFixed(2)}
- 俯仰角: ${pitch.toFixed(1)}°
- 方位角: ${bearing.toFixed(1)}°
- 中心点: [${center[0].toFixed(4)}, ${center[1].toFixed(4)}]

📋 图层状态:
`;

    layers.forEach(layer => {
      const status = layer.exists ? (layer.visible ? '✅ 显示' : '⚠️ 隐藏') : '❌ 不存在';
      const sourceStatus = layer.sourceExists ? '✅' : '❌';
      const featureInfo = layer.featureCount !== undefined ? ` (${layer.featureCount} 个要素)` : '';
      
      report += `- ${layer.layerId}: ${status}${featureInfo}\n`;
      if (layer.sourceId) {
        report += `  └─ 数据源: ${layer.sourceId} ${sourceStatus}\n`;
      }
    });

    report += `\n📦 数据源:\n`;
    sources.forEach(sourceId => {
      report += `- ${sourceId}\n`;
    });

    return report.trim();
  }

  /**
   * 检查常见问题
   */
  static checkCommonIssues(diagnostics: MapDiagnostics): string[] {
    const issues: string[] = [];

    if (!diagnostics.mapReady) {
      issues.push('❌ 地图未就绪');
      return issues;
    }

    // 检查建筑物图层
    const buildingFill = diagnostics.layers.find(l => l.layerId === 'wfs-buildings-fill');
    if (!buildingFill || !buildingFill.exists) {
      issues.push('❌ 建筑物填充图层不存在');
    } else if (!buildingFill.visible) {
      issues.push('⚠️ 建筑物填充图层被隐藏');
    }

    const buildingExtrusion = diagnostics.layers.find(l => l.layerId === 'wfs-buildings-extrusion');
    if (!buildingExtrusion || !buildingExtrusion.exists) {
      issues.push('❌ 建筑物3D挤出图层不存在');
    }

    // 检查阴影图层
    const shadowFill = diagnostics.layers.find(l => l.layerId === 'wfs-shadows-fill');
    if (!shadowFill || !shadowFill.exists) {
      issues.push('❌ 阴影填充图层不存在');
    } else if (!shadowFill.visible) {
      issues.push('⚠️ 阴影填充图层被隐藏');
    }

    // 检查数据源
    if (diagnostics.sources.length === 0) {
      issues.push('❌ 未找到WFS数据源');
    }

    // 检查缩放级别
    if (diagnostics.zoom < 14) {
      issues.push('⚠️ 缩放级别过低，可能影响建筑物显示');
    }

    return issues;
  }

  /**
   * 自动修复建议
   */
  static getFixSuggestions(issues: string[]): string[] {
    const suggestions: string[] = [];

    if (issues.some(i => i.includes('建筑物填充图层不存在'))) {
      suggestions.push('🔄 点击"强制刷新"按钮重新加载建筑物数据');
    }

    if (issues.some(i => i.includes('阴影填充图层不存在'))) {
      suggestions.push('🌅 点击"重新计算阴影"按钮生成阴影图层');
    }

    if (issues.some(i => i.includes('缩放级别过低'))) {
      suggestions.push('🔍 放大地图到15级或以上');
    }

    if (issues.some(i => i.includes('未找到WFS数据源'))) {
      suggestions.push('🔄 点击"强制刷新"按钮重新加载WFS数据');
    }

    if (suggestions.length === 0) {
      suggestions.push('✅ 所有图层状态正常');
    }

    return suggestions;
  }
}
