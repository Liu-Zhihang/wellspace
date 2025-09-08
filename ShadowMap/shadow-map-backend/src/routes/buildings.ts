/**
 * 建筑物数据API路由
 */

import express from 'express';
import { BuildingService } from '../services/buildingService_simple';

const router = express.Router();

/**
 * GET /api/buildings/:z/:x/:y.json
 * 获取建筑物瓦片数据
 */
router.get('/:z/:x/:y.json', async (req, res) => {
    try {
        const z = parseInt(req.params['z']!);
        const x = parseInt(req.params['x']!);
        const y = parseInt(req.params['y']!);

        // 验证参数
        if (isNaN(z) || isNaN(x) || isNaN(y)) {
            res.status(400).json({ 
                error: 'Invalid parameters', 
                message: 'z, x, y must be valid integers' 
            });
            return;
        }

        // 验证缩放级别范围
        if (z < 10 || z > 18) {
            res.status(400).json({ 
                error: 'Invalid zoom level', 
                message: 'Building data is only available for zoom levels 10-18' 
            });
            return;
        }

        console.log(`🏢 请求建筑物瓦片: ${z}/${x}/${y}`);

        // 获取建筑物数据
        let tileData;
        try {
            tileData = await BuildingService.getBuildingTile(z, x, y);
        } catch (serviceError) {
            console.error(`建筑物服务错误 ${z}/${x}/${y}:`, serviceError);
            // 返回空数据而不是抛出错误
            tileData = {
                type: 'FeatureCollection',
                features: [],
                bbox: [0, 0, 0, 0],
                tileInfo: { z, x, y, generatedAt: new Date().toISOString() }
            };
        }

        // 设置响应头
        res.set({
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=604800', // 缓存7天
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });

        // 返回瓦片数据
        res.json(tileData);

    } catch (error) {
        console.error('❌ 建筑物瓦片获取错误:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal server error',
                message: 'Failed to fetch building tile'
            });
        }
    }
});

/**
 * GET /api/buildings/info
 * 获取建筑物服务信息
 */
router.get('/info', (req, res) => {
    try {
        const info = {
            service: 'Building Tile Service',
            description: 'OpenStreetMap building data for shadow simulation',
            format: 'GeoJSON',
            dataSource: 'OpenStreetMap via Overpass API',
            supportedZoomLevels: '10-18',
            cacheTime: '7 days',
            estimatedHeights: true,
            lastUpdated: new Date().toISOString(),
            endpoints: {
                tile: '/api/buildings/{z}/{x}/{y}.json',
                info: '/api/buildings/info',
                preload: '/api/buildings/preload'
            }
        };
        
        res.json(info);
    } catch (error) {
        console.error('❌ 获取建筑物信息错误:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal server error',
                message: 'Failed to get building service info'
            });
        }
    }
});

/**
 * POST /api/buildings/preload
 * GET /api/buildings/preload (支持query string参数)
 * 预加载指定区域的建筑物数据
 */
router.all('/preload', async (req, res) => {
    try {
        // 支持从query string或body获取参数
        const lngParam = req.query['lng'] || req.body['lng'];
        const latParam = req.query['lat'] || req.body['lat'];
        const radiusParam = req.query['radius'] || req.body['radius'];
        const zoomParam = req.query['zoom'] || req.query['zoomLevel'] || req.body['zoomLevel'];

        const lng = parseFloat(lngParam as string);
        const lat = parseFloat(latParam as string);
        const radius = parseFloat(radiusParam as string);

        console.log(`🏗️ 预加载请求参数: lng=${lng}, lat=${lat}, radius=${radius}, zoom=${zoomParam}`);

        // 验证参数
        if (isNaN(lng) || isNaN(lat) || isNaN(radius)) {
            res.status(400).json({ 
                error: 'Invalid parameters', 
                message: 'lng, lat, radius must be valid numbers' 
            });
            return;
        }

        const zoom = parseInt(zoomParam as string) || 15;
        if (zoom < 10 || zoom > 18) {
            res.status(400).json({ 
                error: 'Invalid zoom level', 
                message: 'Zoom level must be between 10 and 18' 
            });
            return;
        }

        console.log(`🏗️ 开始预加载建筑物数据: [${lng}, ${lat}] 半径 ${radius}`);

        // 计算边界框（简化版本）
        const dlat = radius / 111.32; // 大约1度纬度 = 111.32公里
        const dlng = radius / (111.32 * Math.cos(lat * Math.PI / 180));
        const minLat = lat - dlat;
        const maxLat = lat + dlat;
        const minLng = lng - dlng;
        const maxLng = lng + dlng;

        // 异步预加载，不阻塞响应
        BuildingService.preloadRegion([minLng, minLat, maxLng, maxLat], zoom, zoom)
            .catch((error: any) => console.error('预加载失败:', error));

        res.json({
            message: 'Building preload started',
            center: [lng, lat],
            radius,
            zoomLevel: zoom,
            status: 'in_progress'
        });

    } catch (error) {
        console.error('❌ 建筑物预加载错误:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Internal server error',
                message: 'Failed to start building preload'
            });
        }
    }
});

/**
 * GET /api/buildings/debug
 * 建筑物服务调试信息
 */
router.get('/debug', async (req, res) => {
    try {
        const testTiles = [
            { z: 15, x: 26979, y: 12416 }, // 北京测试瓦片
            { z: 16, x: 53958, y: 24832 }, // 另一个测试瓦片
        ];
        
        const debugInfo = {
            service: 'Building Tile Debug',
            timestamp: new Date().toISOString(),
            testResults: []
        };
        
        for (const tile of testTiles) {
            const startTime = Date.now();
            try {
                const result = await BuildingService.getBuildingTile(tile.z, tile.x, tile.y);
                const duration = Date.now() - startTime;
                
                debugInfo.testResults.push({
                    tile: `${tile.z}/${tile.x}/${tile.y}`,
                    status: 'success',
                    duration: `${duration}ms`,
                    features: result.features?.length || 0
                });
            } catch (error) {
                const duration = Date.now() - startTime;
                debugInfo.testResults.push({
                    tile: `${tile.z}/${tile.x}/${tile.y}`,
                    status: 'error',
                    duration: `${duration}ms`,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        
        res.json(debugInfo);
    } catch (error) {
        console.error('建筑物调试信息获取失败:', error);
        res.status(500).json({ 
            error: 'Debug info failed',
            message: error instanceof Error ? error.message : String(error)
        });
    }
});

export default router;
