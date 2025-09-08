/**
 * 真实DEM数据下载和处理脚本
 * 从AWS Open Data下载Terrarium格式的地形数据
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');

// 配置
const DEM_DATA_DIR = path.join(__dirname, '../../data/dem');
const TERRARIUM_BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// 确保数据目录存在
async function ensureDataDirectory() {
    try {
        await fs.access(DEM_DATA_DIR);
    } catch {
        await fs.mkdir(DEM_DATA_DIR, { recursive: true });
        console.log(`📁 创建数据目录: ${DEM_DATA_DIR}`);
    }
}

// 下载单个DEM瓦片
async function downloadDEMTile(z: number, x: number, y: number): Promise<Buffer> {
    const url = `${TERRARIUM_BASE_URL}/${z}/${x}/${y}.png`;
    console.log(`🌐 下载DEM瓦片: ${url}`);
    
    return new Promise((resolve, reject) => {
        https.get(url, (response: any) => {
            if (response.statusCode !== 200) {
                reject(new Error(`下载失败: HTTP ${response.statusCode}`));
                return;
            }
            
            const chunks: Buffer[] = [];
            response.on('data', (chunk: any) => chunks.push(chunk));
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                console.log(`✅ 下载完成: ${buffer.length} bytes`);
                resolve(buffer);
            });
        }).on('error', reject);
    });
}

// 保存DEM瓦片到本地
async function saveDEMTile(z: number, x: number, y: number, buffer: Buffer): Promise<string> {
    const tileDir = path.join(DEM_DATA_DIR, z.toString(), x.toString());
    await fs.mkdir(tileDir, { recursive: true });
    
    const filePath = path.join(tileDir, `${y}.png`);
    await fs.writeFile(filePath, buffer);
    
    console.log(`💾 保存瓦片: ${filePath}`);
    return filePath;
}

// 检查本地是否已有瓦片
async function hasDEMTile(z: number, x: number, y: number): Promise<boolean> {
    const filePath = path.join(DEM_DATA_DIR, z.toString(), x.toString(), `${y}.png`);
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// 获取本地DEM瓦片
async function getLocalDEMTile(z: number, x: number, y: number): Promise<Buffer | null> {
    const filePath = path.join(DEM_DATA_DIR, z.toString(), x.toString(), `${y}.png`);
    try {
        const buffer = await fs.readFile(filePath);
        console.log(`📁 使用本地瓦片: ${filePath} (${buffer.length} bytes)`);
        return buffer;
    } catch {
        return null;
    }
}

// 批量下载区域DEM数据
async function downloadRegionDEM(
    centerLat: number, 
    centerLng: number, 
    zoom: number, 
    radius: number = 2
): Promise<void> {
    console.log(`🗺️ 下载区域DEM数据:`);
    console.log(`   中心: ${centerLat}, ${centerLng}`);
    console.log(`   缩放级别: ${zoom}`);
    console.log(`   半径: ${radius} 瓦片`);
    
    // 计算中心瓦片坐标
    const centerX = Math.floor((centerLng + 180) / 360 * Math.pow(2, zoom));
    const centerY = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    
    console.log(`   中心瓦片: ${zoom}/${centerX}/${centerY}`);
    
    let downloadCount = 0;
    let skipCount = 0;
    
    // 下载周围的瓦片
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            const x = centerX + dx;
            const y = centerY + dy;
            
            // 检查瓦片坐标是否有效
            if (x < 0 || y < 0 || x >= Math.pow(2, zoom) || y >= Math.pow(2, zoom)) {
                continue;
            }
            
            try {
                // 检查是否已存在
                if (await hasDEMTile(zoom, x, y)) {
                    console.log(`⏭️ 跳过已存在的瓦片: ${zoom}/${x}/${y}`);
                    skipCount++;
                    continue;
                }
                
                // 下载瓦片
                const buffer = await downloadDEMTile(zoom, x, y);
                await saveDEMTile(zoom, x, y, buffer);
                downloadCount++;
                
                // 避免请求过快
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                console.error(`❌ 下载失败 ${zoom}/${x}/${y}:`, error);
            }
        }
    }
    
    console.log(`📊 下载完成: ${downloadCount} 个新瓦片, ${skipCount} 个已存在`);
}

// 主函数 - 下载北京地区数据
async function downloadBeijingDEM() {
    console.log('🏛️ 开始下载北京地区DEM数据...');
    
    await ensureDataDirectory();
    
    // 北京天安门附近的坐标
    const beijingLat = 39.9042;
    const beijingLng = 116.4074;
    
    // 下载多个缩放级别的数据
    const zoomLevels = [10, 11, 12, 13, 14, 15];
    
    for (const zoom of zoomLevels) {
        console.log(`\n🔍 缩放级别 ${zoom}:`);
        await downloadRegionDEM(beijingLat, beijingLng, zoom, 3);
    }
    
    console.log('\n🎉 北京地区DEM数据下载完成！');
}

// 导出函数供其他模块使用
export {
    downloadDEMTile,
    saveDEMTile,
    hasDEMTile,
    getLocalDEMTile,
    downloadRegionDEM,
    downloadBeijingDEM
};

// 如果直接运行此脚本
if (require.main === module) {
    downloadBeijingDEM().catch(console.error);
}
