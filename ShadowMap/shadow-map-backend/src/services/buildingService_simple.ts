/**
 * 建筑物数据服务 - 完整版
 * 从OpenStreetMap获取真实建筑物数据
 */

import https from 'https';
import fs from 'fs/promises';
import path from 'path';

// 建筑物数据目录
const BUILDING_DATA_DIR = path.join(__dirname, '../../data/buildings');

export interface BuildingTileData {
    type: 'FeatureCollection';
    features: Building[];
    bbox: [number, number, number, number];
    tileInfo: {
        z: number;
        x: number;
        y: number;
        generatedAt: string;
    };
}

export interface Building {
    type: 'Feature';
    geometry: {
        type: 'Polygon';
        coordinates: number[][][];
    };
    properties: {
        id: string;
        buildingType: string;
        height: number;
        levels?: number;
        area?: number;
    };
}

/**
 * 瓦片坐标转换工具
 */
export class TileUtils {
    /**
     * 将瓦片坐标转换为经纬度边界框（使用标准算法）
     */
    static tileToBBox(z: number, x: number, y: number): [number, number, number, number] {
        try {
            console.log(`🔍 计算瓦片边界框: z=${z}, x=${x}, y=${y}`);
            
            // 使用标准Web Mercator瓦片转换算法
            const west = (x / Math.pow(2, z)) * 360 - 180;
            const east = ((x + 1) / Math.pow(2, z)) * 360 - 180;
            
            const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) * 180 / Math.PI;
            const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / Math.pow(2, z)))) * 180 / Math.PI;
            
            console.log(`📊 计算结果: south=${south}, west=${west}, north=${north}, east=${east}`);
            
            // 验证计算结果
            if (isNaN(south) || isNaN(north) || isNaN(west) || isNaN(east) ||
                !isFinite(south) || !isFinite(north) || !isFinite(west) || !isFinite(east)) {
                console.warn(`❌ Invalid bbox calculation for tile ${z}/${x}/${y}`);
                return [0, 0, 0, 0];
            }
            
            const result = [south, west, north, east] as [number, number, number, number];
            console.log(`✅ 最终边界框: [${result.join(', ')}]`);
            return result; // [south, west, north, east]
        } catch (error) {
            console.error(`❌ Error calculating bbox for tile ${z}/${x}/${y}:`, error);
            return [0, 0, 0, 0];
        }
    }
}

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
        
        return `[out:json][timeout:15];
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
        console.log(`🔍 执行Overpass查询:`, query);
        
        return new Promise((resolve, reject) => {
            const postData = `data=${encodeURIComponent(query)}`;
            console.log(`📤 发送数据长度: ${postData.length} 字节`);
            
            const options = {
                hostname: 'overpass-api.de',
                port: 443,
                path: '/api/interpreter',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'ShadowMap/2.0'
                }
            };

            console.log(`🌐 连接到: ${options.hostname}${options.path}`);

            const req = https.request(options, (res: any) => {
                console.log(`📡 HTTP状态码: ${res.statusCode}`);
                
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    return;
                }

                const chunks: Buffer[] = [];
                res.on('data', (chunk: any) => {
                    chunks.push(chunk);
                    console.log(`📥 接收数据块: ${chunk.length} 字节`);
                });
                
                res.on('end', () => {
                    try {
                        const data = Buffer.concat(chunks).toString();
                        console.log(`📊 总接收数据: ${data.length} 字节`);
                        console.log(`📋 响应内容前200字符:`, data.substring(0, 200));
                        
                        const json = JSON.parse(data);
                        console.log(`✅ JSON解析成功`);
                        resolve(json);
                    } catch (error) {
                        console.error(`❌ JSON解析失败:`, error);
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                console.error(`❌ 请求错误:`, error);
                reject(error);
            });

            req.on('timeout', () => {
                console.error(`❌ 请求超时`);
                req.abort();
                reject(new Error('Request timeout'));
            });

            console.log(`📤 发送查询请求...`);
            req.write(postData);
            req.end();
        });
    }
}

/**
 * 建筑物高度估算器
 */
export class BuildingHeightEstimator {
    /**
     * 基于建筑类型和楼层数估算高度
     */
    static estimateHeight(building: Building): number {
        const props = building.properties;
        
        // 如果已有楼层信息，按每层3米估算
        if (props.levels && props.levels > 0) {
            return props.levels * 3;
        }
        
        // 根据建筑类型估算
        const typeHeights: { [key: string]: number } = {
            'house': 6,
            'residential': 12,
            'apartments': 25,
            'commercial': 15,
            'office': 20,
            'industrial': 8,
            'warehouse': 6,
            'school': 10,
            'hospital': 15,
            'hotel': 30,
            'yes': 10  // 默认值
        };
        
        return typeHeights[props.buildingType] || 10;
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
        if (!way.geometry || !way.geometry.length) {
            return null;
        }

        // 转换坐标格式
        const coordinates = way.geometry.map((node: any) => [node.lon, node.lat]);
        
        // 确保多边形闭合
        if (coordinates.length > 0) {
            const first = coordinates[0];
            const last = coordinates[coordinates.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                coordinates.push([...first]);
            }
        }

        const parsedLevels = way.tags?.['building:levels'] ? parseInt(way.tags['building:levels']) : undefined;

        const building: Building = {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [coordinates]
            },
            properties: {
                id: `way_${way.id}`,
                buildingType: way.tags?.building || 'yes',
                height: 0, // 将在下面设置
                ...(parsedLevels && { levels: parsedLevels })
            }
        };

        // 估算高度
        building.properties.height = way.tags?.height ? 
            parseFloat(way.tags.height) : 
            BuildingHeightEstimator.estimateHeight(building);

        return building;
    }

    /**
     * 转换OSM数据为Building数组
     */
    static convertOSMData(osmData: any): Building[] {
        const buildings: Building[] = [];

        for (const element of osmData.elements || []) {
            if (element.type === 'way') {
                const building = this.convertWayToBuilding(element);
                if (building) {
                    buildings.push(building);
                }
            }
            // TODO: 处理relation类型的建筑物
        }

        return buildings;
    }
}

/**
 * 建筑物数据服务
 */
export class BuildingService {
    /**
     * 确保建筑物数据目录存在
     */
    private static async ensureBuildingDataDir(): Promise<void> {
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
    private static async readTileFromCache(z: number, x: number, y: number): Promise<BuildingTileData> {
        const cachePath = this.getTileCachePath(z, x, y);
        const content = await fs.readFile(cachePath, 'utf-8');
        return JSON.parse(content);
    }

    /**
     * 保存瓦片数据到缓存
     */
    private static async saveTileToCache(z: number, x: number, y: number, tileData: BuildingTileData): Promise<void> {
        const cachePath = this.getTileCachePath(z, x, y);
        await fs.writeFile(cachePath, JSON.stringify(tileData, null, 2));
    }

    /**
     * 获取建筑物瓦片数据
     */
    static async getBuildingTile(z: number, x: number, y: number): Promise<BuildingTileData> {
        await this.ensureBuildingDataDir();

        // 检查缓存
        if (await this.isTileCacheValid(z, x, y)) {
            console.log(`📦 从缓存加载建筑物瓦片: ${z}/${x}/${y}`);
            return await this.readTileFromCache(z, x, y);
        }

        console.log(`🏢 请求建筑物瓦片: ${z}/${x}/${y}`);
        console.log(`🌐 从OSM获取建筑物数据: ${z}/${x}/${y}`);

        // 计算瓦片边界框
        const bbox = TileUtils.tileToBBox(z, x, y);
        console.log(`📦 瓦片边界框 ${z}/${x}/${y}:`, bbox);
        
        // 构建Overpass查询
        const query = OverpassQuery.buildBuildingQuery(bbox);
        console.log(`🔍 Overpass查询准备就绪`);
        
        try {
            // 执行查询
            console.log(`🚀 开始查询OSM数据...`);
            const osmData = await OverpassQuery.executeQuery(query);
            console.log(`✅ OSM数据获取成功，elements: ${osmData.elements?.length || 0}`);
            
            // 转换数据
            const buildings = OSMConverter.convertOSMData(osmData);
            console.log(`🔄 数据转换完成，buildings: ${buildings.length}`);
            
            // 构建瓦片数据
            const tileData: BuildingTileData = {
                type: 'FeatureCollection',
                features: buildings,
                bbox,
                tileInfo: {
                    z,
                    x,
                    y,
                    generatedAt: new Date().toISOString()
                }
            };

            // 保存到缓存
            await this.saveTileToCache(z, x, y, tileData);
            console.log(`✅ 建筑物瓦片生成完成: ${z}/${x}/${y}, ${buildings.length} 个建筑物`);
            
            return tileData;
        } catch (error) {
            console.error(`❌ 建筑物数据获取失败:`, error);
            console.error(`❌ 查询内容:`, query);
            console.error(`❌ 边界框:`, bbox);
            
            // 重新抛出错误，不使用后备方案
            throw error;
        }
    }

    /**
     * 生成模拟建筑物数据（用于测试和后备）
     */
    private static generateMockBuildings(bbox: [number, number, number, number], zoom: number): Building[] {
        const [south, west, north, east] = bbox;
        const buildings: Building[] = [];
        
        // 只在高缩放级别生成建筑物
        if (zoom < 14) {
            return [];
        }
        
        // 根据缩放级别决定建筑物密度
        const density = Math.min(zoom - 12, 5);
        const count = Math.max(1, density * 2);
        
        for (let i = 0; i < count; i++) {
            // 在边界框内随机生成建筑物位置
            const lat = south + (north - south) * Math.random();
            const lng = west + (east - west) * Math.random();
            
            // 生成简单的矩形建筑物
            const size = 0.0001 * (1 + Math.random()); // 建筑物大小
            const height = 10 + Math.random() * 40; // 10-50米高度
            
            buildings.push({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [[
                        [lng - size, lat - size],
                        [lng + size, lat - size],
                        [lng + size, lat + size],
                        [lng - size, lat + size],
                        [lng - size, lat - size]
                    ]]
                },
                properties: {
                    buildingType: 'residential',
                    height: Math.round(height),
                    levels: Math.ceil(height / 3),
                    id: `mock_${zoom}_${i}_${Date.now()}`
                }
            });
        }
        
        return buildings;
    }

    /**
     * 获取建筑物服务信息
     */
    static getServiceInfo() {
        return {
            service: 'building-data',
            version: '2.0.0',
            status: 'active',
            description: 'Real building data from OpenStreetMap via Overpass API',
            features: [
                'Real OSM building data',
                'Intelligent caching system',
                'Height estimation',
                'Mock data fallback',
                'Tile-based querying'
            ],
            endpoints: {
                tile: '/api/buildings/:z/:x/:y.json',
                info: '/api/buildings/info',
                preload: '/api/buildings/preload'
            },
            dataSource: 'OpenStreetMap via Overpass API',
            cachePolicy: '7 days'
        };
    }

    /**
     * 预加载区域建筑物数据
     */
    static async preloadRegion(bbox: [number, number, number, number], minZoom: number, maxZoom: number): Promise<{ status: string; message: string; stats: any }> {
        console.log(`🏗️ 预加载区域建筑物数据: bbox=${bbox}, zoom=${minZoom}-${maxZoom}`);
        
        const stats = {
            totalTiles: 0,
            processedTiles: 0,
            cachedTiles: 0,
            newTiles: 0,
            errors: 0
        };
        
        try {
            // 计算需要处理的瓦片
            for (let z = minZoom; z <= maxZoom; z++) {
                const tiles = this.getTilesInBBox(bbox, z);
                stats.totalTiles += tiles.length;
                
                for (const [x, y] of tiles) {
                    try {
                        if (await this.isTileCacheValid(z, x, y)) {
                            stats.cachedTiles++;
                        } else {
                            // 异步处理，不阻塞
                            this.getBuildingTile(z, x, y).then(() => {
                                stats.newTiles++;
                            }).catch(() => {
                                stats.errors++;
                            });
                        }
                        stats.processedTiles++;
                    } catch (error) {
                        stats.errors++;
                        console.error(`Error processing tile ${z}/${x}/${y}:`, error);
                    }
                }
            }
            
            return {
                status: 'success',
                message: `预加载请求已提交: ${stats.totalTiles} 个瓦片`,
                stats
            };
        } catch (error) {
            console.error('预加载过程中出错:', error);
            return {
                status: 'error',
                message: `预加载失败: ${error}`,
                stats
            };
        }
    }

    /**
     * 计算边界框内的瓦片列表
     */
    private static getTilesInBBox(bbox: [number, number, number, number], z: number): Array<[number, number]> {
        const [south, west, north, east] = bbox;
        const tiles: Array<[number, number]> = [];
        
        // 将经纬度转换为瓦片坐标
        const minX = Math.floor((west + 180) / 360 * Math.pow(2, z));
        const maxX = Math.floor((east + 180) / 360 * Math.pow(2, z));
        const minY = Math.floor((1 - Math.log(Math.tan(north * Math.PI / 180) + 1 / Math.cos(north * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
        const maxY = Math.floor((1 - Math.log(Math.tan(south * Math.PI / 180) + 1 / Math.cos(south * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
        
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                tiles.push([x, y]);
            }
        }
        
        return tiles;
    }
}
