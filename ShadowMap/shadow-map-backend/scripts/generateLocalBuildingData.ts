/**
 * 生成本地建筑物数据文件
 * 将MongoDB中的预处理数据导出为前端可用的JSON文件
 */

import { buildingServiceMongoDB } from '../src/services/buildingServiceMongoDB';
import { connectDatabase } from '../src/config/database';
import * as fs from 'fs';
import * as path from 'path';

interface ExportConfig {
  outputDir: string;           // 输出目录
  zoomLevels: number[];        // 导出的缩放级别
  cities: Array<{             // 城市配置
    name: string;
    lat: number;
    lng: number;
    radius: number;           // 瓦片半径
  }>;
  batchSize: number;          // 批处理大小
}

const DEFAULT_CONFIG: ExportConfig = {
  outputDir: '../shadow-map-frontend/react-shadow-app/public/data/buildings',
  zoomLevels: [15, 16],
  cities: [
    { name: '北京', lat: 39.9042, lng: 116.4074, radius: 5 },
    { name: '上海', lat: 31.2304, lng: 121.4737, radius: 5 },
    { name: '广州', lat: 23.1291, lng: 113.2644, radius: 5 },
    { name: '深圳', lat: 22.5431, lng: 114.0579, radius: 5 },
    { name: '杭州', lat: 30.2741, lng: 120.1551, radius: 3 },
    { name: '南京', lat: 32.0603, lng: 118.7969, radius: 3 },
    { name: '武汉', lat: 30.5928, lng: 114.3055, radius: 3 },
    { name: '成都', lat: 30.6720, lng: 104.0633, radius: 3 }
  ],
  batchSize: 10
};

/**
 * 计算瓦片坐标
 */
function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * 生成城市瓦片列表
 */
function getCityTiles(city: ExportConfig['cities'][0], zoom: number): Array<{x: number, y: number, z: number}> {
  const tiles: Array<{x: number, y: number, z: number}> = [];
  const centerTile = latLngToTile(city.lat, city.lng, zoom);
  
  // 生成半径范围内的瓦片
  for (let dx = -city.radius; dx <= city.radius; dx++) {
    for (let dy = -city.radius; dy <= city.radius; dy++) {
      const x = centerTile.x + dx;
      const y = centerTile.y + dy;
      
      // 验证瓦片坐标有效性
      const maxTile = Math.pow(2, zoom) - 1;
      if (x >= 0 && x <= maxTile && y >= 0 && y <= maxTile) {
        tiles.push({ x, y, z: zoom });
      }
    }
  }
  
  return tiles;
}

/**
 * 导出单个瓦片数据
 */
async function exportTileData(z: number, x: number, y: number, outputDir: string): Promise<boolean> {
  try {
    // 从MongoDB获取数据
    const buildingData = await buildingServiceMongoDB.getBuildingTile(z, x, y);
    
    if (buildingData && buildingData.features && buildingData.features.length > 0) {
      // 确保目录存在
      const tileDir = path.join(outputDir, `${z}`);
      if (!fs.existsSync(tileDir)) {
        fs.mkdirSync(tileDir, { recursive: true });
      }
      
      // 保存JSON文件
      const filePath = path.join(tileDir, `${x}_${y}.json`);
      fs.writeFileSync(filePath, JSON.stringify(buildingData, null, 2));
      
      console.log(`✅ 导出瓦片: ${z}/${x}/${y} (${buildingData.features.length} 建筑物)`);
      return true;
    } else {
      console.log(`⚠️ 瓦片无数据: ${z}/${x}/${y}`);
      return false;
    }
  } catch (error) {
    console.error(`❌ 导出瓦片失败: ${z}/${x}/${y}`, error);
    return false;
  }
}

/**
 * 生成数据索引文件
 */
async function generateIndex(outputDir: string, exportedTiles: Array<{z: number, x: number, y: number, count: number}>): Promise<void> {
  const index = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    tiles: exportedTiles.length,
    totalBuildings: exportedTiles.reduce((sum, tile) => sum + tile.count, 0),
    zoomLevels: [...new Set(exportedTiles.map(tile => tile.z))].sort(),
    cities: DEFAULT_CONFIG.cities.map(city => ({
      name: city.name,
      lat: city.lat,
      lng: city.lng,
      tiles: exportedTiles.filter(tile => {
        const centerTile = latLngToTile(city.lat, city.lng, tile.z);
        const distance = Math.sqrt(Math.pow(tile.x - centerTile.x, 2) + Math.pow(tile.y - centerTile.y, 2));
        return distance <= city.radius;
      }).length
    })),
    tiles: exportedTiles
  };
  
  const indexPath = path.join(outputDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  
  console.log(`📋 生成索引文件: ${indexPath}`);
  console.log(`   总瓦片数: ${index.tiles}`);
  console.log(`   总建筑物数: ${index.totalBuildings.toLocaleString()}`);
  console.log(`   缩放级别: [${index.zoomLevels.join(', ')}]`);
}

/**
 * 主导出函数
 */
async function exportLocalBuildingData(config: ExportConfig = DEFAULT_CONFIG): Promise<void> {
  console.log('🚀 开始导出本地建筑物数据...');
  console.log(`   输出目录: ${config.outputDir}`);
  console.log(`   缩放级别: [${config.zoomLevels.join(', ')}]`);
  console.log(`   城市数量: ${config.cities.length}`);
  
  // 连接数据库
  await connectDatabase();
  
  // 确保输出目录存在
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }
  
  const exportedTiles: Array<{z: number, x: number, y: number, count: number}> = [];
  let processedTiles = 0;
  let totalTiles = 0;
  
  // 计算总瓦片数
  for (const city of config.cities) {
    for (const zoom of config.zoomLevels) {
      const tiles = getCityTiles(city, zoom);
      totalTiles += tiles.length;
    }
  }
  
  console.log(`📊 预计导出瓦片数: ${totalTiles}`);
  
  // 导出每个城市的数据
  for (const city of config.cities) {
    console.log(`\n🏙️ 处理城市: ${city.name}`);
    
    for (const zoom of config.zoomLevels) {
      console.log(`   缩放级别: ${zoom}`);
      const tiles = getCityTiles(city, zoom);
      
      // 批量处理瓦片
      for (let i = 0; i < tiles.length; i += config.batchSize) {
        const batch = tiles.slice(i, i + config.batchSize);
        const promises = batch.map(tile => 
          exportTileData(tile.z, tile.x, tile.y, config.outputDir)
            .then(success => success ? { ...tile, count: 0 } : null)
        );
        
        const results = await Promise.allSettled(promises);
        
        for (const result of results) {
          processedTiles++;
          if (result.status === 'fulfilled' && result.value) {
            exportedTiles.push(result.value);
          }
          
          // 显示进度
          if (processedTiles % 50 === 0 || processedTiles === totalTiles) {
            const progress = ((processedTiles / totalTiles) * 100).toFixed(1);
            console.log(`   进度: ${processedTiles}/${totalTiles} (${progress}%)`);
          }
        }
        
        // 避免过载，添加小延迟
        if (i + config.batchSize < tiles.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }
  
  // 生成索引文件
  await generateIndex(config.outputDir, exportedTiles);
  
  console.log('\n✅ 本地建筑物数据导出完成!');
  console.log(`   导出瓦片数: ${exportedTiles.length}`);
  console.log(`   总建筑物数: ${exportedTiles.reduce((sum, tile) => sum + tile.count, 0).toLocaleString()}`);
  console.log(`   输出目录: ${config.outputDir}`);
}

// 如果直接运行此脚本
if (require.main === module) {
  exportLocalBuildingData()
    .then(() => {
      console.log('🎉 导出完成');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ 导出失败:', error);
      process.exit(1);
    });
}

export { exportLocalBuildingData, DEFAULT_CONFIG };
