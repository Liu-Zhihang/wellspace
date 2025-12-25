/**
 * 建筑物数据服务
 * 从OpenStreetMap获取建筑物数据并处理
 */

import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import { Building, BuildingTileData, TileUtils, BuildingHeightEstimator } from '../types/building';

// 建筑物数据目录
const BUILDING_DATA_DIR = path.join(__dirname, '../../data/buildings');

/**
 * Overpass API查询构建器
 */
export class OverpassQuery {
    private static readonly BASE_URL = 'https://overpass-api.de/api/interpreter';
    
    /**
     * 构建获取建筑物的Overpass查询
     */
    static buildBuildingQuery(bbox: [number, number, number, number]): string {
        const [south, west, north, east] = bbox;
        
        return `[out:json][timeout:25];
(
  way["building"](${south},${west},${north},${east});
  relation["building"](${south},${west},${north},${east});
);
out geom;`;
    }

    /**
     * 执行Overpass查询
     */
    static async executeQuery(query: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const postData = `data=${encodeURIComponent(query)}`;
            
            const options = {
                hostname: 'overpass-api.de',
                port: 443,
                path: '/api/interpreter',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'ShadowMap/1.0'
                }
            };

            const req = https.request(options, (res: any) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    return;
                }

                const chunks: Buffer[] = [];
                res.on('data', (chunk: any) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        const data = Buffer.concat(chunks).toString();
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }
}

/**
 * OSM数据转换器
 */
export class OSMConverter {
    /**
     * 将OSM way转换为Building对象
     */
    static convertWayToBuilding(way: any): Building | null {
        if (!way.geometry || way.geometry.length < 3) {
            return null; // 建筑物需要至少3个点形成封闭多边形
        }

        // 确保多边形是封闭的
        const coords = way.geometry.map((node: any) => [node.lon, node.lat]);
        if (coords[0][0] !== coords[coords.length - 1][0] || 
            coords[0][1] !== coords[coords.length - 1][1]) {
            coords.push(coords[0]); // 闭合多边形
        }

        const parsedLevels = way.tags?.['building:levels'] ? parseInt(way.tags['building:levels']) : undefined;
        const parsedName = way.tags?.name || undefined;
        const parsedHouseNumber = way.tags?.['addr:housenumber'] || undefined;
        const parsedStreet = way.tags?.['addr:street'] || undefined;

        const building: Building = {
            id: `way_${way.id}`,
            geometry: {
                type: 'Polygon',
                coordinates: [coords]
            },
            properties: {
                height: 0, // 临时值，下面会重新计算
                buildingType: way.tags?.building || 'yes',
                ...(parsedLevels !== undefined && { levels: parsedLevels }),
                ...(parsedName !== undefined && { name: parsedName }),
                ...(parsedHouseNumber !== undefined && { addr_housenumber: parsedHouseNumber }),
                ...(parsedStreet !== undefined && { addr_street: parsedStreet })
            }
        };

        // 估算高度
        building.properties.height = way.tags?.height ? 
            parseFloat(way.tags.height) : 
            BuildingHeightEstimator.estimateHeight(building);

        return building;
    }

    /**
     * 将OSM relation转换为Building对象
     */
    static convertRelationToBuilding(relation: any): Building | null {
        // 简化处理：暂时跳过复杂的relation，专注于way
        return null;
    }

    /**
     * 转换OSM数据为Building数组
     */
    static convertOSMData(osmData: any): Building[] {
        const buildings: Building[] = [];

        for (const element of osmData.elements || []) {
            let building: Building | null = null;

            if (element.type === 'way') {
                building = this.convertWayToBuilding(element);
            } else if (element.type === 'relation') {
                building = this.convertRelationToBuilding(element);
            }

            if (building) {
                buildings.push(building);
            }
        }

        return buildings;
    }
}

/**
 * 建筑物瓦片服务
 */
export class BuildingTileService {
    /**
     * 确保建筑物数据目录存在
     */
    private static async ensureDataDirectory(): Promise<void> {
        try {
            await fs.access(BUILDING_DATA_DIR);
        } catch {
            await fs.mkdir(BUILDING_DATA_DIR, { recursive: true });
        }
    }

    /**
     * 获取瓦片的本地缓存路径
     */
    private static getTileCachePath(z: number, x: number, y: number): string {
        return path.join(BUILDING_DATA_DIR, `${z}_${x}_${y}.json`);
    }

    /**
     * 检查瓦片缓存是否存在且有效
     */
    private static async isTileCacheValid(z: number, x: number, y: number): Promise<boolean> {
        const cachePath = this.getTileCachePath(z, x, y);
        try {
            const stats = await fs.stat(cachePath);
            // 缓存7天有效
            const maxAge = 7 * 24 * 60 * 60 * 1000;
            return Date.now() - stats.mtime.getTime() < maxAge;
        } catch {
            return false;
        }
    }

    /**
     * 从缓存读取瓦片数据
     */
    private static async readTileFromCache(z: number, x: number, y: number): Promise<BuildingTileData | null> {
        try {
            const cachePath = this.getTileCachePath(z, x, y);
            const data = await fs.readFile(cachePath, 'utf-8');
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    /**
     * 将瓦片数据写入缓存
     */
    private static async writeTileToCache(z: number, x: number, y: number, tileData: BuildingTileData): Promise<void> {
        await this.ensureDataDirectory();
        const cachePath = this.getTileCachePath(z, x, y);
        await fs.writeFile(cachePath, JSON.stringify(tileData, null, 2));
    }

    /**
     * 从OSM获取建筑物瓦片数据
     */
    static async fetchBuildingTile(z: number, x: number, y: number): Promise<BuildingTileData> {
        // 检查缓存
        if (await this.isTileCacheValid(z, x, y)) {
            const cachedData = await this.readTileFromCache(z, x, y);
            if (cachedData) {
                console.log(`🏠 返回缓存建筑物数据: ${z}/${x}/${y}`);
                return cachedData;
            }
        }

        console.log(`🌐 从OSM获取建筑物数据: ${z}/${x}/${y}`);

        // 计算瓦片边界框
        const bbox = TileUtils.tileToBBox(z, x, y);
        console.log(`📦 瓦片边界框 ${z}/${x}/${y}:`, bbox);
        
        // 构建Overpass查询
        const query = OverpassQuery.buildBuildingQuery(bbox);
        console.log(`🔍 Overpass查询:`, query);
        
        try {
            // 执行查询
            const osmData = await OverpassQuery.executeQuery(query);
            
            // 转换数据
            const buildings = OSMConverter.convertOSMData(osmData);
            
            // 构建瓦片数据
            const tileData: BuildingTileData = {
                type: 'FeatureCollection',
                features: buildings,
                bbox,
                tileInfo: {
                    z, x, y,
                    generatedAt: new Date().toISOString()
                }
            };

            // 缓存结果
            await this.writeTileToCache(z, x, y, tileData);

            console.log(`✅ 建筑物数据获取完成: ${buildings.length} 栋建筑`);
            return tileData;

        } catch (error) {
            console.error(`❌ 建筑物数据获取失败: ${error}`);
            
            // 返回空瓦片
            return {
                type: 'FeatureCollection',
                features: [],
                bbox,
                tileInfo: {
                    z, x, y,
                    generatedAt: new Date().toISOString()
                }
            };
        }
    }

    /**
     * 批量预加载区域的建筑物数据
     */
    static async preloadBuildingsForRegion(
        centerLng: number, 
        centerLat: number, 
        radius: number, 
        zoomLevel: number = 15
    ): Promise<void> {
        // 计算覆盖区域的瓦片
        const bbox: [number, number, number, number] = [
            centerLng - radius,
            centerLat - radius,
            centerLng + radius,
            centerLat + radius
        ];

        const tiles = TileUtils.getBBoxTiles(bbox, zoomLevel);
        
        console.log(`🏗️ 预加载建筑物数据: ${tiles.length} 个瓦片`);

        for (const [x, y] of tiles) {
            try {
                await this.fetchBuildingTile(zoomLevel, x, y);
                // 避免请求过快，休息100ms
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error(`预加载瓦片 ${zoomLevel}/${x}/${y} 失败:`, error);
            }
        }

        console.log(`🎉 区域建筑物数据预加载完成`);
    }
}
