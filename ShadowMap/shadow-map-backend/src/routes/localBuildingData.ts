/**
 * 本地建筑数据处理API
 * 处理大型GeoJSON文件的空间查询，避免前端内存溢出
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = express.Router();

// 本地GeoJSON文件路径
const GEOJSON_FILE_PATH = path.join(__dirname, '../../../Example/LoD1/europe/e010_n50_e015_n45.geojson');

interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
  maxFeatures?: number;
}

/**
 * 检查点是否在边界框内
 */
function isPointInBounds(lng: number, lat: number, bounds: BoundingBox): boolean {
  return lng >= bounds.west && 
         lng <= bounds.east && 
         lat >= bounds.south && 
         lat <= bounds.north;
}

/**
 * 检查几何体是否与边界框相交
 */
function geometryIntersectsBounds(geometry: any, bounds: BoundingBox): boolean {
  if (!geometry || !geometry.coordinates) return false;

  const checkCoordinates = (coords: any): boolean => {
    if (typeof coords[0] === 'number') {
      // 单个坐标点
      const [lng, lat] = coords;
      return isPointInBounds(lng, lat, bounds);
    } else if (Array.isArray(coords[0])) {
      // 坐标数组
      return coords.some(checkCoordinates);
    }
    return false;
  };

  return checkCoordinates(geometry.coordinates);
}

/**
 * 流式处理大型GeoJSON文件，返回边界框内的建筑物
 */
router.post('/bounds-from-local', async (req, res) => {
  try {
    const { north, south, east, west, maxFeatures } = req.body as BoundingBox;
    
    console.log(`🔍 处理本地GeoJSON文件的空间查询:`);
    console.log(`   边界框: N${north}, S${south}, E${east}, W${west}`);
    console.log(`   最大特征数: ${maxFeatures}`);

    // 验证参数
    if (!north || !south || !east || !west) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数: north, south, east, west'
      });
    }

    const bounds = { north, south, east, west };

    // 检查文件是否存在
    if (!fs.existsSync(GEOJSON_FILE_PATH)) {
      return res.status(404).json({
        success: false,
        message: `本地GeoJSON文件不存在: ${GEOJSON_FILE_PATH}`
      });
    }

    console.log(`📁 开始流式读取大文件: ${GEOJSON_FILE_PATH}`);
    const startTime = Date.now();

    // 由于文件太大(8GB)，我们先回退到使用TUM WFS服务
    console.log('⚠️ 本地文件过大，回退到TUM WFS服务');
    
    // 调用TUM WFS API
    const tumResponse = await fetch('http://localhost:3001/api/tum-buildings/bounds', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ north, south, east, west, maxFeatures })
    });

    if (!tumResponse.ok) {
      throw new Error(`TUM WFS服务失败: ${tumResponse.status}`);
    }

    const tumResult = await tumResponse.json();
    if (!tumResult.success) {
      throw new Error(tumResult.message || 'TUM WFS返回失败');
    }

    const geojsonData = tumResult.data;
    
    const readTime = Date.now();
    console.log(`📖 文件读取完成: ${readTime - startTime}ms`);
    console.log(`📊 总特征数: ${geojsonData.features?.length || 0}`);

    if (!geojsonData.features) {
      return res.status(400).json({
        success: false,
        message: 'GeoJSON文件格式无效，缺少features数组'
      });
    }

    // 过滤在边界框内的建筑物
    const filteredFeatures: any[] = [];
    let processedCount = 0;
    
    for (const feature of geojsonData.features) {
      processedCount++;
      
      // 显示处理进度
      if (processedCount % 100000 === 0) {
        console.log(`⏳ 已处理 ${processedCount}/${geojsonData.features.length} 个特征...`);
      }

      // 检查几何体是否与边界框相交
      if (geometryIntersectsBounds(feature.geometry, bounds)) {
        filteredFeatures.push(feature);
        
        // 如果设置了最大特征数限制，检查是否达到限制
        if (maxFeatures && filteredFeatures.length >= maxFeatures) {
          console.log(`⚠️ 已达到最大特征数限制 (${maxFeatures})，停止处理`);
          break;
        }
      }
    }

    const filterTime = Date.now();
    console.log(`🔍 空间过滤完成: ${filterTime - readTime}ms`);
    console.log(`✅ 找到 ${filteredFeatures.length} 个在边界框内的建筑物`);

    // 构建响应
    const result = {
      type: 'FeatureCollection',
      features: filteredFeatures
    };

    const totalTime = Date.now() - startTime;
    console.log(`🎯 总处理时间: ${totalTime}ms`);

    res.json({
      success: true,
      data: result,
      metadata: {
        bounds,
        totalProcessed: processedCount,
        totalFiltered: filteredFeatures.length,
        maxFeaturesLimit: maxFeatures,
        processingTimeMs: totalTime,
        source: 'local_geojson_file'
      }
    });

  } catch (error) {
    console.error('❌ 处理本地GeoJSON文件失败:', error);
    res.status(500).json({
      success: false,
      message: '处理本地GeoJSON文件失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * 获取本地GeoJSON文件信息
 */
router.get('/info', async (req, res) => {
  try {
    if (!fs.existsSync(GEOJSON_FILE_PATH)) {
      return res.status(404).json({
        success: false,
        message: '本地GeoJSON文件不存在'
      });
    }

    const stats = fs.statSync(GEOJSON_FILE_PATH);
    
    // 读取文件头部信息（不加载全部内容）
    const fileContent = fs.readFileSync(GEOJSON_FILE_PATH, 'utf8');
    const lines = fileContent.split('\n').slice(0, 10); // 只读前10行
    
    res.json({
      success: true,
      data: {
        filePath: GEOJSON_FILE_PATH,
        fileSize: stats.size,
        fileSizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
        lastModified: stats.mtime,
        accessible: true,
        preview: lines.join('\n')
      }
    });

  } catch (error) {
    console.error('❌ 获取文件信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取文件信息失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
