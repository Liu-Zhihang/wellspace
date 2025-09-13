/**
 * 建筑物数据API路由 - MongoDB版本
 */

import express from 'express';
import { buildingServiceMongoDB } from '../services/buildingServiceMongoDB';
import { dbManager } from '../config/database';

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
        const startTime = Date.now();

        // 使用MongoDB建筑物服务获取数据
        const tileData = await buildingServiceMongoDB.getBuildingTile(z, x, y);
        
        const processingTime = Date.now() - startTime;
        console.log(`⏱️  处理时间: ${processingTime}ms, 建筑物数量: ${tileData.features.length}`);

        // 设置响应头
        res.set({
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600', // 1小时缓存
            'X-Processing-Time': `${processingTime}ms`,
            'X-Building-Count': tileData.features.length.toString(),
            'X-Data-Source': tileData.fromDatabase ? 'mongodb' : 'osm-api',
            'X-Cached': tileData.cached.toString()
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
router.get('/info', async (req, res) => {
    try {
        // 获取MongoDB服务信息和统计
        const [dbStatus, stats] = await Promise.all([
            dbManager.healthCheck(),
            buildingServiceMongoDB.getStatistics()
        ]);

        const info = {
            service: 'Building Data Service with MongoDB',
            version: '2.0.0',
            description: 'OpenStreetMap building data with MongoDB caching',
            format: 'GeoJSON',
            dataSource: 'MongoDB + OSM Overpass API fallback',
            supportedZoomLevels: '10-18',
            cacheTime: 'Intelligent MongoDB caching',
            estimatedHeights: true,
            lastUpdated: new Date().toISOString(),
            database: {
                status: dbStatus.status,
                connection: dbManager.getConnectionStatus()
            },
            statistics: stats,
            endpoints: {
                tile: '/api/buildings/{z}/{x}/{y}.json',
                info: '/api/buildings/info',
                preload: '/api/buildings/preload',
                stats: '/api/buildings/stats',
                cleanup: '/api/buildings/cleanup'
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

        // 计算需要预加载的瓦片
        const tiles = [];
        const tileSize = 256;
        const n = Math.pow(2, zoom);
        
        const minTileX = Math.floor((minLng + 180) / 360 * n);
        const maxTileX = Math.floor((maxLng + 180) / 360 * n);
        const minTileY = Math.floor((1 - Math.log(Math.tan(maxLat * Math.PI/180) + 1/Math.cos(maxLat * Math.PI/180)) / Math.PI) / 2 * n);
        const maxTileY = Math.floor((1 - Math.log(Math.tan(minLat * Math.PI/180) + 1/Math.cos(minLat * Math.PI/180)) / Math.PI) / 2 * n);
        
        for (let x = minTileX; x <= maxTileX; x++) {
            for (let y = minTileY; y <= maxTileY; y++) {
                tiles.push({ z: zoom, x, y });
            }
        }

        console.log(`🔄 开始预加载 ${tiles.length} 个建筑物瓦片...`);
        const startTime = Date.now();

        const results = await buildingServiceMongoDB.preloadBuildingData(tiles);
        
        const totalTime = Date.now() - startTime;
        console.log(`✅ 预加载完成: ${results.success} 成功, ${results.failed} 失败, 耗时 ${totalTime}ms`);

        res.json({
            message: 'Building preload completed',
            center: [lng, lat],
            radius,
            zoomLevel: zoom,
            results: {
                total: tiles.length,
                success: results.success,
                failed: results.failed,
                processingTime: totalTime
            }
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
            testResults: [] as Array<{
                tile: string;
                status: string;
                duration: string;
                features?: number;
                error?: string;
            }>
        };
        
        for (const tile of testTiles) {
            const startTime = Date.now();
            try {
                const result = await buildingServiceMongoDB.getBuildingTile(tile.z, tile.x, tile.y);
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
