/**
 * Local building data helpers.
 * Stream large GeoJSON files and fall back to the GeoServer WFS when needed.
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = express.Router();

// Path to the on-disk GeoJSON sample. The file is intentionally kept outside the repo.
const GEOJSON_FILE_PATH = path.join(__dirname, '../../../Example/LoD1/europe/e010_n50_e015_n45.geojson');

interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
  maxFeatures?: number;
}

/** Determine whether a point lives inside the bounding box. */
function isPointInBounds(lng: number, lat: number, bounds: BoundingBox): boolean {
  return lng >= bounds.west && 
         lng <= bounds.east && 
         lat >= bounds.south && 
         lat <= bounds.north;
}

/** Determine whether the geometry intersects the requested bounds. */
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

/** Stream a large GeoJSON file and return the features inside the bounding box. */
router.post('/bounds-from-local', async (req, res) => {
  try {
    const { north, south, east, west, maxFeatures } = req.body as BoundingBox;

    console.log('[LocalGeoJSON] Query requested');
    console.log(`  Bounds: N${north}, S${south}, E${east}, W${west}`);
    console.log(`  Max features: ${maxFeatures}`);

    // 验证参数
    if (!north || !south || !east || !west) {
      return res.status(400).json({
        success: false,
        message: 'Parameters north, south, east, and west are required'
      });
    }

    const bounds = { north, south, east, west };

    // Check that the sample file exists
    if (!fs.existsSync(GEOJSON_FILE_PATH)) {
      return res.status(404).json({
        success: false,
        message: `Local GeoJSON file not found: ${GEOJSON_FILE_PATH}`
      });
    }

    console.log(`[LocalGeoJSON] Streaming ${GEOJSON_FILE_PATH}`);
    const startTime = Date.now();

    // The sample file is very large (~8GB), so immediately fall back to the WFS service.
    console.log('[LocalGeoJSON] Falling back to GeoServer WFS endpoint');

    const wfsResponse = await fetch('http://localhost:3001/api/wfs-buildings/bounds', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ north, south, east, west, maxFeatures })
    });

    if (!wfsResponse.ok) {
      throw new Error(`GeoServer WFS endpoint failed: ${wfsResponse.status}`);
    }

    const wfsResult = await wfsResponse.json();
    if (!wfsResult.success) {
      throw new Error(wfsResult.message || 'GeoServer WFS returned an error');
    }

    const geojsonData = wfsResult.data;
    
    const readTime = Date.now();
    console.log(`[LocalGeoJSON] Response received in ${readTime - startTime}ms`);
    console.log(`[LocalGeoJSON] Returned features: ${geojsonData.features?.length || 0}`);

    if (!geojsonData.features) {
      return res.status(400).json({
        success: false,
        message: 'Invalid GeoJSON payload: missing features array'
      });
    }

    // 过滤在边界框内的建筑物
    const filteredFeatures: any[] = [];
    let processedCount = 0;
    
    for (const feature of geojsonData.features) {
      processedCount++;

      if (processedCount % 100000 === 0) {
        console.log(`[LocalGeoJSON] Processed ${processedCount}/${geojsonData.features.length} features...`);
      }

      if (geometryIntersectsBounds(feature.geometry, bounds)) {
        filteredFeatures.push(feature);

        if (maxFeatures && filteredFeatures.length >= maxFeatures) {
          console.log(`[LocalGeoJSON] Reached max feature limit (${maxFeatures})`);
          break;
        }
      }
    }

    const filterTime = Date.now();
    console.log(`[LocalGeoJSON] Spatial filter finished in ${filterTime - readTime}ms`);
    console.log(`[LocalGeoJSON] ${filteredFeatures.length} buildings in bounds`);

    // 构建响应
    const result = {
      type: 'FeatureCollection',
      features: filteredFeatures
    };

    const totalTime = Date.now() - startTime;
    console.log(`[LocalGeoJSON] Total processing time ${totalTime}ms`);

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
    console.error('[LocalGeoJSON] Failed to process request', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process local GeoJSON file',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/** Return metadata about the sample GeoJSON file. */
router.get('/info', async (req, res) => {
  try {
    if (!fs.existsSync(GEOJSON_FILE_PATH)) {
      return res.status(404).json({
        success: false,
        message: 'Local GeoJSON file not found'
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
      message: 'Failed to read GeoJSON metadata',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
