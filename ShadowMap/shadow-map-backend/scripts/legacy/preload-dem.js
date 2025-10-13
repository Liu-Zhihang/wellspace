#!/usr/bin/env node

/**
 * DEM数据预下载工具
 * 避免实时下载超时问题，预先下载指定区域的真实地形数据
 * 
 * 使用方法：
 *   node preload-dem.js region 39.9042 116.4074     # 预下载指定位置
 *   node preload-dem.js status                       # 查看本地DEM状态
 *   node preload-dem.js cities                       # 预下载热门城市
 */

const https = require('https');
const fs = require('fs').promises;
const path = require('path');

const DEM_DATA_DIR = path.join(__dirname, 'data', 'dem');
const TERRARIUM_BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// 热门城市坐标
const POPULAR_CITIES = [
  { name: '北京', lat: 39.9042, lng: 116.4074 },
  { name: '上海', lat: 31.2304, lng: 121.4737 },
  { name: '广州', lat: 23.1291, lng: 113.2644 },
  { name: '深圳', lat: 22.5431, lng: 114.0579 },
  { name: '杭州', lat: 30.2741, lng: 120.1551 },
  { name: '南京', lat: 32.0603, lng: 118.7969 },
];

// 经纬度转瓦片坐标
function latLngToTile(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI/180) + 1/Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * n);
  
  return { x: Math.max(0, Math.min(x, n-1)), y: Math.max(0, Math.min(y, n-1)) };
}

// 检查本地DEM瓦片是否存在
async function checkLocalTile(z, x, y) {
  const filePath = path.join(DEM_DATA_DIR, z.toString(), x.toString(), `${y}.png`);
  try {
    await fs.access(filePath);
    const stats = await fs.stat(filePath);
    return { exists: true, size: stats.size, path: filePath };
  } catch {
    return { exists: false, path: filePath };
  }
}

// 下载单个DEM瓦片
async function downloadDEMTile(z, x, y, maxRetries = 3) {
  const url = `${TERRARIUM_BASE_URL}/${z}/${x}/${y}.png`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🌐 下载DEM瓦片: ${z}/${x}/${y} (第${attempt}次尝试)`);
      
      const buffer = await new Promise((resolve, reject) => {
        const timeout = 15000 + (attempt - 1) * 5000; // 递增超时
        
        const request = https.get(url, { timeout }, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          
          const chunks = [];
          let totalSize = 0;
          
          response.on('data', (chunk) => {
            chunks.push(chunk);
            totalSize += chunk.length;
            
            if (totalSize > 1024 * 1024) { // 1MB上限
              reject(new Error('响应数据过大'));
              return;
            }
          });
          
          response.on('end', () => {
            if (totalSize < 100) {
              reject(new Error('响应数据过小'));
              return;
            }
            
            const buffer = Buffer.concat(chunks);
            
            // 验证PNG文件头
            const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            if (!buffer.subarray(0, 8).equals(pngHeader)) {
              reject(new Error('无效的PNG文件'));
              return;
            }
            
            resolve(buffer);
          });
        });
        
        request.on('error', reject);
        request.on('timeout', () => {
          request.destroy();
          reject(new Error(`超时 (${timeout}ms)`));
        });
        
        request.setTimeout(timeout);
      });
      
      console.log(`✅ 下载成功: ${buffer.length} bytes`);
      return buffer;
      
    } catch (error) {
      console.warn(`⚠️ 第${attempt}次尝试失败: ${error.message}`);
      
      if (attempt < maxRetries) {
        const delay = 1000 * attempt; // 递增延迟
        console.log(`⏳ ${delay}ms后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`下载失败: ${maxRetries}次重试全部超时`);
}

// 保存DEM瓦片到本地
async function saveDEMTile(z, x, y, buffer) {
  const tileDir = path.join(DEM_DATA_DIR, z.toString(), x.toString());
  await fs.mkdir(tileDir, { recursive: true });
  
  const filePath = path.join(tileDir, `${y}.png`);
  await fs.writeFile(filePath, buffer);
  
  console.log(`💾 保存成功: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

// 预下载指定区域的DEM数据
async function preloadRegionDEM(lat, lng, zoomLevels = [10, 11, 12, 13, 14, 15], radius = 2) {
  console.log(`🗺️ 预下载区域DEM: (${lat}, ${lng})`);
  console.log(`   缩放级别: [${zoomLevels.join(', ')}]`);
  console.log(`   瓦片半径: ${radius}`);
  
  const stats = {
    total: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    totalSize: 0
  };
  
  for (const zoom of zoomLevels) {
    console.log(`\n🔍 缩放级别 ${zoom}:`);
    const centerTile = latLngToTile(lat, lng, zoom);
    
    const tiles = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const x = centerTile.x + dx;
        const y = centerTile.y + dy;
        const n = Math.pow(2, zoom);
        
        if (x >= 0 && x < n && y >= 0 && y < n) {
          tiles.push({ z: zoom, x, y });
        }
      }
    }
    
    console.log(`📍 需要处理 ${tiles.length} 个瓦片`);
    stats.total += tiles.length;
    
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      
      try {
        console.log(`[${i+1}/${tiles.length}] 处理瓦片 ${tile.z}/${tile.x}/${tile.y}`);
        
        // 检查是否已存在
        const localCheck = await checkLocalTile(tile.z, tile.x, tile.y);
        if (localCheck.exists) {
          console.log(`⏭️ 跳过已存在的瓦片 (${localCheck.size} bytes)`);
          stats.skipped++;
          stats.totalSize += localCheck.size;
          continue;
        }
        
        // 下载瓦片
        const buffer = await downloadDEMTile(tile.z, tile.x, tile.y);
        await saveDEMTile(tile.z, tile.x, tile.y, buffer);
        
        stats.downloaded++;
        stats.totalSize += buffer.length;
        
        // 避免请求过快
        if (i < tiles.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (error) {
        console.error(`❌ 瓦片处理失败 ${tile.z}/${tile.x}/${tile.y}: ${error.message}`);
        stats.failed++;
      }
    }
  }
  
  console.log('\n📊 预下载完成统计:');
  console.log(`   总瓦片数: ${stats.total}`);
  console.log(`   新下载: ${stats.downloaded}`);
  console.log(`   已存在: ${stats.skipped}`);
  console.log(`   失败: ${stats.failed}`);
  console.log(`   总大小: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
  
  return stats;
}

// 预下载热门城市
async function preloadCities() {
  console.log(`🌍 开始预下载热门城市DEM数据 (${POPULAR_CITIES.length} 个城市)...`);
  
  const globalStats = {
    total: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    totalSize: 0,
    citiesProcessed: 0
  };
  
  for (const city of POPULAR_CITIES) {
    try {
      console.log(`\n🏙️ === ${city.name} ===`);
      
      const cityStats = await preloadRegionDEM(city.lat, city.lng, [12, 13, 14, 15], 3);
      
      globalStats.total += cityStats.total;
      globalStats.downloaded += cityStats.downloaded;
      globalStats.skipped += cityStats.skipped;
      globalStats.failed += cityStats.failed;
      globalStats.totalSize += cityStats.totalSize;
      globalStats.citiesProcessed++;
      
      console.log(`✅ ${city.name} 预下载完成`);
      
      // 城市间延迟
      if (globalStats.citiesProcessed < POPULAR_CITIES.length) {
        console.log('\n⏸️ 城市间延迟 3秒...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
    } catch (error) {
      console.error(`❌ ${city.name} 预下载失败: ${error.message}`);
      globalStats.failed++;
    }
  }
  
  console.log('\n🎉 全球城市DEM预下载完成!');
  console.log(`📊 总计统计:`);
  console.log(`   处理城市: ${globalStats.citiesProcessed}/${POPULAR_CITIES.length}`);
  console.log(`   总瓦片数: ${globalStats.total}`);
  console.log(`   新下载: ${globalStats.downloaded}`);
  console.log(`   已存在: ${globalStats.skipped}`);
  console.log(`   失败: ${globalStats.failed}`);
  console.log(`   总大小: ${(globalStats.totalSize / 1024 / 1024).toFixed(2)} MB`);
}

// 分析本地DEM状态
async function analyzeDEMStatus() {
  console.log('📊 分析本地DEM数据状态...');
  
  try {
    const stats = {
      totalFiles: 0,
      totalSize: 0,
      zoomLevels: {},
      oldestFile: null,
      newestFile: null
    };
    
    // 递归扫描DEM目录
    async function scanDir(dirPath, currentPath = '') {
      try {
        const items = await fs.readdir(dirPath);
        
        for (const item of items) {
          const itemPath = path.join(dirPath, item);
          const stat = await fs.stat(itemPath);
          
          if (stat.isDirectory()) {
            await scanDir(itemPath, path.join(currentPath, item));
          } else if (item.endsWith('.png')) {
            stats.totalFiles++;
            stats.totalSize += stat.size;
            
            // 解析缩放级别
            const pathParts = currentPath.split(path.sep);
            if (pathParts.length >= 1) {
              const zoomLevel = pathParts[0];
              stats.zoomLevels[zoomLevel] = (stats.zoomLevels[zoomLevel] || 0) + 1;
            }
            
            // 记录最新和最旧文件
            if (!stats.oldestFile || stat.mtime < stats.oldestFile.time) {
              stats.oldestFile = { path: itemPath, time: stat.mtime };
            }
            if (!stats.newestFile || stat.mtime > stats.newestFile.time) {
              stats.newestFile = { path: itemPath, time: stat.mtime };
            }
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.warn(`⚠️ 扫描目录失败 ${dirPath}: ${error.message}`);
        }
      }
    }
    
    await scanDir(DEM_DATA_DIR);
    
    console.log('\n📊 本地DEM数据统计:');
    console.log(`   DEM文件数: ${stats.totalFiles.toLocaleString()}`);
    console.log(`   总大小: ${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`);
    
    console.log('\n🔍 缩放级别分布:');
    Object.entries(stats.zoomLevels)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .forEach(([zoom, count]) => {
        console.log(`   级别 ${zoom}: ${count} 个瓦片`);
      });
    
    if (stats.oldestFile) {
      console.log(`\n📅 时间信息:`);
      console.log(`   最旧文件: ${stats.oldestFile.time.toLocaleString()}`);
      console.log(`   最新文件: ${stats.newestFile.time.toLocaleString()}`);
    }
    
    if (stats.totalFiles === 0) {
      console.log('\n💡 建议: 运行以下命令开始预下载DEM数据:');
      console.log('   node preload-dem.js cities              # 预下载热门城市');
      console.log('   node preload-dem.js region 39.9042 116.4074  # 预下载指定位置');
    }
    
  } catch (error) {
    console.error('❌ 状态分析失败:', error.message);
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
🗻 ShadowMap DEM数据预下载工具

解决DEM下载超时问题，预先下载真实地形数据到本地

使用方法:
  node preload-dem.js cities                    # 预下载热门城市DEM数据
  node preload-dem.js region <lat> <lng>        # 预下载指定位置  
  node preload-dem.js status                    # 分析本地DEM状态

示例:
  node preload-dem.js cities
  node preload-dem.js region 39.9042 116.4074
  node preload-dem.js status

优势:
✅ 避免实时下载超时问题
✅ 多重试机制，提高成功率
✅ 智能跳过已存在的瓦片
✅ 详细的下载进度和统计
    `);
    return;
  }
  
  const command = args[0];
  
  try {
    switch (command) {
      case 'cities':
        await preloadCities();
        break;
        
      case 'region':
        if (args.length < 3) {
          console.error('❌ 缺少参数: 需要提供纬度和经度');
          console.log('使用方法: node preload-dem.js region <lat> <lng>');
          return;
        }
        
        const lat = parseFloat(args[1]);
        const lng = parseFloat(args[2]);
        
        if (isNaN(lat) || isNaN(lng)) {
          console.error('❌ 无效参数: 纬度和经度必须是数字');
          return;
        }
        
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          console.error('❌ 坐标超出范围: 纬度[-90,90], 经度[-180,180]');
          return;
        }
        
        await preloadRegionDEM(lat, lng);
        break;
        
      case 'status':
        await analyzeDEMStatus();
        break;
        
      default:
        console.error(`❌ 未知命令: ${command}`);
        console.log('支持的命令: cities, region, status');
    }
  } catch (error) {
    console.error('❌ 命令执行失败:', error.message);
    process.exit(1);
  }
}

// 运行主函数
main().catch(console.error);
