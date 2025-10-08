/**
 * 坐标系统验证API
 * 诊断阴影与建筑物错位问题
 */

import express from 'express';
import { validateTileConsistency, validateSpatialAlignment, tileToBounds, demPixelToLatLng, calculateBuildingCenter } from '../utils/coordinateValidator';
import { buildingServiceMongoDB } from '../services/buildingServiceMongoDB';
import { getDEMTile } from '../services/demService';
import sharp from 'sharp';

const router = express.Router();

/**
 * GET /api/coord-validate/alignment/:z/:x/:y
 * 验证指定瓦片的DEM和建筑物数据对齐情况
 */
router.get('/alignment/:z/:x/:y', async (req, res) => {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);
    
    // 验证参数
    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      return res.status(400).json({
        error: '无效参数',
        message: 'z, x, y必须是有效整数'
      });
    }
    
    console.log(`🔍 验证坐标对齐: ${z}/${x}/${y}`);
    
    // 1. 获取瓦片边界信息
    const tileBounds = tileToBounds(x, y, z);
    
    // 2. 验证瓦片坐标一致性
    const consistencyCheck = validateTileConsistency(
      tileBounds.center.lat, 
      tileBounds.center.lng, 
      z
    );
    
    // 3. 获取建筑物数据
    let buildingData = null;
    let buildingError = null;
    try {
      buildingData = await buildingServiceMongoDB.getBuildingTile(z, x, y);
    } catch (error) {
      buildingError = error instanceof Error ? error.message : 'Unknown error';
    }
    
    // 4. 获取DEM数据
    let demData = null;
    let demError = null;
    try {
      const demBuffer = await getDEMTile(z, x, y);
      demData = {
        size: demBuffer.length,
        available: true
      };
      
      // 分析DEM数据质量
      const demAnalysis = await analyzeDEMData(demBuffer, x, y, z);
      demData.analysis = demAnalysis;
      
    } catch (error) {
      demError = error instanceof Error ? error.message : 'Unknown error';
    }
    
    // 5. 分析空间对齐
    let alignmentResults = null;
    if (buildingData && buildingData.features.length > 0 && demData) {
      alignmentResults = buildingData.features.slice(0, 5).map(building => {
        return validateSpatialAlignment(
          { z, x, y },
          building
        );
      });
    }
    
    // 6. 生成诊断报告
    const diagnosticReport = generateAlignmentReport(
      { z, x, y },
      tileBounds,
      consistencyCheck,
      buildingData,
      demData,
      alignmentResults,
      buildingError,
      demError
    );
    
    res.json({
      tile: `${z}/${x}/${y}`,
      bounds: tileBounds,
      consistency: consistencyCheck,
      building: {
        available: !!buildingData,
        count: buildingData?.features.length || 0,
        error: buildingError
      },
      dem: {
        available: !!demData,
        error: demError,
        ...demData
      },
      alignment: alignmentResults,
      diagnostic: diagnosticReport,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 坐标验证失败:', error);
    res.status(500).json({
      error: '坐标验证失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/coord-validate/fix-alignment
 * 尝试修复坐标对齐问题
 */
router.post('/fix-alignment', async (req, res) => {
  try {
    const { z, x, y, adjustmentType = 'automatic' } = req.body;
    
    console.log(`🔧 尝试修复坐标对齐: ${z}/${x}/${y} (${adjustmentType}模式)`);
    
    // 这里可以实现坐标修正逻辑
    // 目前返回建议的修复方案
    
    const fixSuggestions = [
      {
        issue: 'DEM和建筑物瓦片边界不对齐',
        solution: '统一使用标准Web Mercator瓦片切分',
        priority: 'high',
        implementation: '修改tileToBoundingBox函数，确保使用相同算法'
      },
      {
        issue: 'OSM坐标精度和DEM像素精度不匹配',
        solution: '在阴影计算前进行坐标精度对齐',
        priority: 'medium',
        implementation: '添加坐标重采样和对齐逻辑'
      },
      {
        issue: '不同数据源的投影系统差异',
        solution: '确保所有数据都使用Web Mercator (EPSG:3857)',
        priority: 'high',
        implementation: '在数据获取时统一坐标系转换'
      }
    ];
    
    res.json({
      tile: `${z}/${x}/${y}`,
      adjustmentType,
      suggestions: fixSuggestions,
      nextSteps: [
        '1. 运行坐标诊断工具确认具体偏移量',
        '2. 检查DEM和建筑物数据的投影系统',
        '3. 统一瓦片坐标转换算法',
        '4. 测试修复后的对齐效果'
      ],
      status: 'analysis_complete',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 坐标修复分析失败:', error);
    res.status(500).json({
      error: '修复分析失败',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * 分析DEM数据质量
 */
async function analyzeDEMData(demBuffer: Buffer, x: number, y: number, z: number): Promise<{
  validPixels: number;
  invalidPixels: number;
  elevationRange: { min: number; max: number };
  centerElevation: number;
  spatialResolution: number;
}> {
  try {
    // 使用sharp分析DEM数据
    const image = sharp(demBuffer);
    const metadata = await image.metadata();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    
    if (!metadata.width || !metadata.height || metadata.channels !== 3) {
      throw new Error('DEM数据格式错误');
    }
    
    let validPixels = 0;
    let invalidPixels = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;
    
    // 分析像素数据
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // AWS Terrarium格式解码
      const elevation = (r * 256 + g + b / 256) - 32768;
      
      if (elevation > -500 && elevation < 9000) { // 合理高程范围
        validPixels++;
        minElevation = Math.min(minElevation, elevation);
        maxElevation = Math.max(maxElevation, elevation);
      } else {
        invalidPixels++;
      }
    }
    
    // 计算中心点高程
    const centerX = Math.floor(metadata.width / 2);
    const centerY = Math.floor(metadata.height / 2);
    const centerIndex = (centerY * metadata.width + centerX) * 3;
    const centerElevation = (data[centerIndex] * 256 + data[centerIndex + 1] + data[centerIndex + 2] / 256) - 32768;
    
    // 计算空间分辨率（米/像素）
    const tileBounds = tileToBounds(x, y, z);
    const tileWidthMeters = calculateDistance(tileBounds.center.lat, tileBounds.west, tileBounds.center.lat, tileBounds.east);
    const spatialResolution = tileWidthMeters / metadata.width;
    
    return {
      validPixels,
      invalidPixels,
      elevationRange: { min: minElevation, max: maxElevation },
      centerElevation,
      spatialResolution
    };
    
  } catch (error) {
    console.error('❌ DEM数据分析失败:', error);
    return {
      validPixels: 0,
      invalidPixels: 0,
      elevationRange: { min: 0, max: 0 },
      centerElevation: 0,
      spatialResolution: 0
    };
  }
}

/**
 * 计算两点间距离
 */
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // 地球半径（米）
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

/**
 * 生成对齐诊断报告
 */
function generateAlignmentReport(
  tile: { z: number; x: number; y: number },
  bounds: any,
  consistency: any,
  buildingData: any,
  demData: any,
  alignmentResults: any,
  buildingError: string | null,
  demError: string | null
): {
  severity: 'ok' | 'warning' | 'error';
  summary: string;
  issues: string[];
  recommendations: string[];
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  let severity: 'ok' | 'warning' | 'error' = 'ok';
  
  // 检查数据可用性
  if (buildingError) {
    issues.push(`建筑物数据获取失败: ${buildingError}`);
    severity = 'error';
  }
  
  if (demError) {
    issues.push(`DEM数据获取失败: ${demError}`);
    severity = 'error';
  }
  
  // 检查坐标一致性
  if (!consistency.isConsistent) {
    issues.push('DEM和建筑物瓦片坐标计算不一致');
    severity = 'error';
    recommendations.push('统一瓦片坐标转换算法');
  }
  
  if (consistency.coordinateOffset.distanceMeters > 100) {
    issues.push(`坐标偏移过大: ${consistency.coordinateOffset.distanceMeters.toFixed(1)}米`);
    severity = severity === 'error' ? 'error' : 'warning';
    recommendations.push('检查投影系统和坐标精度配置');
  }
  
  // 检查空间对齐
  if (alignmentResults && alignmentResults.length > 0) {
    const alignedBuildings = alignmentResults.filter((result: any) => result.aligned).length;
    const alignmentRate = alignedBuildings / alignmentResults.length;
    
    if (alignmentRate < 0.5) {
      issues.push(`建筑物空间对齐率过低: ${(alignmentRate * 100).toFixed(1)}%`);
      severity = 'error';
      recommendations.push('检查建筑物坐标和DEM瓦片的空间对齐');
    } else if (alignmentRate < 0.8) {
      issues.push(`建筑物空间对齐率偏低: ${(alignmentRate * 100).toFixed(1)}%`);
      severity = severity === 'error' ? 'error' : 'warning';
    }
  }
  
  // 检查DEM数据质量
  if (demData?.analysis) {
    const analysis = demData.analysis;
    const validRate = analysis.validPixels / (analysis.validPixels + analysis.invalidPixels);
    
    if (validRate < 0.8) {
      issues.push(`DEM数据质量偏低: ${(validRate * 100).toFixed(1)}%有效像素`);
      severity = severity === 'error' ? 'error' : 'warning';
      recommendations.push('检查DEM数据来源和格式');
    }
    
    if (analysis.spatialResolution > 50) {
      issues.push(`DEM空间分辨率过低: ${analysis.spatialResolution.toFixed(1)}米/像素`);
      recommendations.push('考虑使用更高分辨率的DEM数据');
    }
  }
  
  // 生成总结
  let summary = '';
  if (severity === 'ok') {
    summary = '坐标系统对齐正常，阴影位置应该准确';
  } else if (severity === 'warning') {
    summary = '存在轻微对齐问题，可能影响阴影精度';
  } else {
    summary = '发现严重的坐标对齐问题，阴影位置可能严重错位';
  }
  
  return { severity, summary, issues, recommendations };
}

export default router;
