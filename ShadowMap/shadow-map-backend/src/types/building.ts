/**
 * 建筑物数据服务
 * 处理OpenStreetMap建筑物数据，提供建筑物高度和轮廓信息
 */

export interface Building {
    id: string;
    geometry: {
        type: 'Polygon' | 'MultiPolygon';
        coordinates: number[][][] | number[][][][];
    };
    properties: {
        height: number;         // 建筑物高度(米) - 必填，通过估算得出
        levels?: number;        // 楼层数
        buildingType?: string;  // 建筑类型
        name?: string;          // 建筑名称
        addr_housenumber?: string;
        addr_street?: string;
    };
}

export interface BuildingTileData {
    type: 'FeatureCollection';
    features: Building[];
    bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
    tileInfo: {
        z: number;
        x: number;
        y: number;
        generatedAt: string;
    };
}

/**
 * 瓦片坐标转换工具
 */
export class TileUtils {
    /**
     * 将瓦片坐标转换为经纬度边界框
     */
    static tileToBBox(z: number, x: number, y: number): [number, number, number, number] {
        try {
            const n = Math.PI - 2.0 * Math.PI * y / Math.pow(2.0, z);
            const s = Math.PI - 2.0 * Math.PI * (y + 1) / Math.pow(2.0, z);
            
            const minLat = 180.0 / Math.PI * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)));
            const maxLat = 180.0 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
            
            const minLng = x / Math.pow(2.0, z) * 360.0 - 180.0;
            const maxLng = (x + 1) / Math.pow(2.0, z) * 360.0 - 180.0;
            
            // 验证计算结果
            if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLng) || isNaN(maxLng) ||
                !isFinite(minLat) || !isFinite(maxLat) || !isFinite(minLng) || !isFinite(maxLng)) {
                console.warn(`Invalid bbox calculation for tile ${z}/${x}/${y}`);
                return [0, 0, 0, 0]; // 返回默认值而不是崩溃
            }
            
            return [minLat, minLng, maxLat, maxLng]; // [south, west, north, east]
        } catch (error) {
            console.error(`Error calculating bbox for tile ${z}/${x}/${y}:`, error);
            return [0, 0, 0, 0]; // 出错时返回默认值
        }
    }

    /**
     * 经纬度转瓦片坐标
     */
    static lngLatToTile(lng: number, lat: number, z: number): [number, number] {
        const x = Math.floor((lng + 180) / 360 * Math.pow(2, z));
        const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
        return [x, y];
    }

    /**
     * 计算边界框覆盖的瓦片列表
     */
    static getBBoxTiles(bbox: [number, number, number, number], z: number): Array<[number, number]> {
        const [minLng, minLat, maxLng, maxLat] = bbox;
        const [minX, maxY] = this.lngLatToTile(minLng, minLat, z);
        const [maxX, minY] = this.lngLatToTile(maxLng, maxLat, z);
        
        const tiles: Array<[number, number]> = [];
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                tiles.push([x, y]);
            }
        }
        return tiles;
    }
}

/**
 * 建筑物高度估算
 */
export class BuildingHeightEstimator {
    /**
     * 根据楼层数估算建筑高度
     */
    static estimateHeightFromLevels(levels: number): number {
        // 平均每层3.5米
        return levels * 3.5;
    }

    /**
     * 根据建筑类型估算默认高度
     */
    static estimateHeightFromType(buildingType: string): number {
        const typeHeights: Record<string, number> = {
            'house': 6,           // 住宅
            'apartments': 25,     // 公寓
            'commercial': 12,     // 商业建筑
            'office': 30,         // 办公楼
            'industrial': 8,      // 工业建筑
            'retail': 4,          // 零售店
            'hotel': 35,          // 酒店
            'school': 12,         // 学校
            'hospital': 15,       // 医院
            'church': 15,         // 教堂
            'mosque': 10,         // 清真寺
            'temple': 8,          // 寺庙
            'warehouse': 10,      // 仓库
            'garage': 3,          // 车库
            'shed': 3,            // 棚屋
            'roof': 2,            // 顶层建筑
            'yes': 8,             // 通用建筑
        };

        return typeHeights[buildingType.toLowerCase()] || 8; // 默认8米
    }

    /**
     * 综合估算建筑高度
     */
    static estimateHeight(building: Building): number {
        const props = building.properties;

        // 优先级1: 明确的高度标签
        if (props.height && props.height > 0) {
            return props.height;
        }

        // 优先级2: 楼层数计算
        if (props.levels && props.levels > 0) {
            return this.estimateHeightFromLevels(props.levels);
        }

        // 优先级3: 建筑类型估算
        if (props.buildingType) {
            return this.estimateHeightFromType(props.buildingType);
        }

        // 默认: 2层住宅高度
        return 8;
    }
}
