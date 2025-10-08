/**
 * TUM GeoJSON 数据导入脚本
 * 将下载的TUM GlobalBuildingAtlas GeoJSON文件导入到MongoDB数据库
 */

import * as fs from 'fs';
import * as path from 'path';
import { connectDatabase, dbManager } from '../src/config/database';
import { Building } from '../src/models/Building';
import { TileInfo } from '../src/types/types';

// 配置
const GEOJSON_FILE_PATH = path.join(__dirname, '../../Example/LoD1/europe/e010_n50_e015_n45.geojson');
const BATCH_SIZE = 500; // 每批插入数据库的建筑数量

/**
 * 将经纬度坐标转换为瓦片坐标
 */
function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor((lng + 180) / 360 * n);
    const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    return { x, y };
}

/**
 * 计算要素的边界框
 * @param geometry GeoJSON几何对象
 * @returns [minLng, minLat, maxLng, maxLat]
 */
function calculateFeatureBoundingBox(geometry: any): [number, number, number, number] {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;

    const processCoordinates = (coords: any[]) => {
        if (typeof coords[0] === 'number') {
            const [lng, lat] = coords;
            minLng = Math.min(minLng, lng);
            minLat = Math.min(minLat, lat);
            maxLng = Math.max(maxLng, lng);
            maxLat = Math.max(maxLat, lat);
        } else {
            coords.forEach(processCoordinates);
        }
    };

    processCoordinates(geometry.coordinates);
    return [minLng, minLat, maxLng, maxLat];
}


/**
 * 主导入函数
 */
async function importTumData() {
    console.log('🚀 开始导入TUM GeoJSON数据...');
    
    // 1. 连接数据库
    await connectDatabase();
    console.log('✅ 数据库连接成功');

    // 2. 读取GeoJSON文件
    if (!fs.existsSync(GEOJSON_FILE_PATH)) {
        console.error(`❌ 文件未找到: ${GEOJSON_FILE_PATH}`);
        console.error('请确认已将TUM慕尼黑示例数据解压到正确的位置。');
        await dbManager.close();
        return;
    }
    const geojsonData = JSON.parse(fs.readFileSync(GEOJSON_FILE_PATH, 'utf-8'));
    const features = geojsonData.features;
    console.log(`✅ 文件读取成功，总计 ${features.length} 个建筑物`);

    // 3. 转换并分批插入数据
    let totalImported = 0;
    for (let i = 0; i < features.length; i += BATCH_SIZE) {
        const batch = features.slice(i, i + BATCH_SIZE);
        const buildingsToInsert = batch.map((feature: any) => {
            const properties = feature.properties;
            const geometry = feature.geometry;
            const bbox = calculateFeatureBoundingBox(geometry);
            
            // 使用中心点来计算所属瓦片（对于大数据导入这是一种简化）
            const centerLng = (bbox[0] + bbox[2]) / 2;
            const centerLat = (bbox[1] + bbox[3]) / 2;
            const zoom = 16; // 设定一个默认的瓦片级别
            const tileCoords = latLngToTile(centerLat, centerLng, zoom);

            const tileInfo: TileInfo = {
                z: zoom,
                x: tileCoords.x,
                y: tileCoords.y
            };

            return {
                geometry: geometry,
                properties: {
                    id: properties.id,
                    buildingType: 'building', // 默认类型
                    height: properties.height_mean,
                    levels: properties.height_mean ? Math.round(properties.height_mean / 3) : undefined,
                    source: 'TUM_GlobalBuildingAtlas'
                },
                tile: tileInfo,
                bbox: bbox,
                last_updated: new Date(),
                created_at: new Date()
            };
        });

        try {
            await Building.insertMany(buildingsToInsert, { ordered: false });
            totalImported += buildingsToInsert.length;
            console.log(`🔄 已导入 ${totalImported} / ${features.length} 个建筑物...`);
        } catch (error: any) {
            // 忽略重复键错误 (code 11000)，但打印其他错误
            if (error.code !== 11000) {
                console.error('❌ 批量插入失败:', error);
            } else {
                // 如果是重复错误，我们可以计算实际插入了多少
                totalImported += error.result.nInserted;
                console.log(`⚠️  检测到重复数据，已跳过。当前导入总数: ${totalImported}`);
            }
        }
    }

    console.log(`\n🎉 TUM数据导入完成!`);
    console.log(`   总计处理: ${features.length}`);
    console.log(`   成功导入: ${totalImported}`);

    // 4. 关闭数据库连接
    await dbManager.close();
    console.log('✅ 数据库连接已关闭');
}

// 运行导入脚本
importTumData().catch(error => {
    console.error('❌ 导入过程中发生严重错误:', error);
    process.exit(1);
});
