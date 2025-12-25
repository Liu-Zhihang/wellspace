/**
 * DEM (Digital Elevation Model) 服务
 * 处理数字高程模型数据，提供地形高度信息
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import https from 'https';
import http from 'http';

// DEM数据目录
const DEM_DATA_DIR = path.join(__dirname, '../../data/dem');
const TERRARIUM_BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// GeoServer配置
const GEOSERVER_BASE_URL = process.env['GEOSERVER_BASE_URL'] || 'http://10.13.12.164:8080/geoserver/shadowmap';
const GEOSERVER_LAYER = process.env['GEOSERVER_DEM_LAYER'] || 'shadowmap:dem_munich';
const GEOSERVER_BBOX = {
    minLng: 11.4,
    minLat: 48.0,
    maxLng: 11.6,
    maxLat: 48.2
};

/**
 * 将瓦片坐标转换为地理坐标（Web Mercator）
 */
function tile2bbox(z: number, x: number, y: number): { minLng: number; minLat: number; maxLng: number; maxLat: number } {
    const n = Math.pow(2, z);
    const minLng = (x / n) * 360 - 180;
    const maxLng = ((x + 1) / n) * 360 - 180;
    
    function tile2lat(y: number, z: number): number {
        const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
        return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }
    
    const minLat = tile2lat(y + 1, z);
    const maxLat = tile2lat(y, z);
    
    return { minLng, minLat, maxLng, maxLat };
}

/**
 * 从GeoServer WMS获取DEM瓦片
 */
async function downloadFromGeoServer(z: number, x: number, y: number): Promise<Buffer | null> {
    try {
        // 将瓦片坐标转换为地理坐标
        const bbox = tile2bbox(z, x, y);
        
        // 检查瓦片是否在GeoServer数据范围内
        if (bbox.maxLng < GEOSERVER_BBOX.minLng || bbox.minLng > GEOSERVER_BBOX.maxLng ||
            bbox.maxLat < GEOSERVER_BBOX.minLat || bbox.minLat > GEOSERVER_BBOX.maxLat) {
            console.log(`⏭️ 瓦片 ${z}/${x}/${y} 不在GeoServer数据范围内`);
            return null;
        }
        
        // 构建WMS GetMap请求URL
        const params = new URLSearchParams({
            service: 'WMS',
            version: '1.1.0',
            request: 'GetMap',
            layers: GEOSERVER_LAYER,
            bbox: `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`,
            width: '256',
            height: '256',
            srs: 'EPSG:4326',
            format: 'image/png'
        });
        
        const url = `${GEOSERVER_BASE_URL}/wms?${params.toString()}`;
        console.log(`🗺️ 从GeoServer获取DEM: ${z}/${x}/${y}`);
        
        return await new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const request = client.get(url, { timeout: 10000 }, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`GeoServer返回HTTP ${response.statusCode}`));
                    return;
                }
                
                const chunks: Buffer[] = [];
                
                response.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                });
                
                response.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    
                    // 检查是否是PNG图像
                    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
                        console.log(`✅ GeoServer返回有效PNG: ${buffer.length} bytes`);
                        resolve(buffer);
                    } else {
                        // 可能是XML错误信息
                        console.warn(`⚠️ GeoServer返回非PNG数据: ${buffer.toString('utf8', 0, 200)}`);
                        reject(new Error('GeoServer返回非PNG数据'));
                    }
                });
            });
            
            request.on('error', reject);
            request.on('timeout', () => {
                request.destroy();
                reject(new Error('GeoServer请求超时'));
            });
        });
        
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`❌ GeoServer获取失败: ${errorMsg}`);
        return null;
    }
}

/**
 * 检查本地DEM瓦片是否存在
 */
async function checkLocalTile(z: number, x: number, y: number): Promise<boolean> {
    const tilePath = path.join(DEM_DATA_DIR, z.toString(), x.toString(), `${y}.png`);
    try {
        await fs.access(tilePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * 读取本地DEM瓦片
 */
async function readLocalTile(z: number, x: number, y: number): Promise<Buffer | null> {
    const tilePath = path.join(DEM_DATA_DIR, z.toString(), x.toString(), `${y}.png`);
    try {
        return await fs.readFile(tilePath);
    } catch {
        return null;
    }
}

/**
 * 生成基础地形数据（海平面基准，避免阴影错位）
 */
async function generateBasicTerrain(z: number, x: number, y: number): Promise<Buffer> {
    console.log(`🗻 生成基础地形: ${z}/${x}/${y} (海平面基准)`);
    
    const tileSize = 256;
    
    // 创建均匀的海平面高度 (32768 = 0米高程)
    const seaLevelR = 128; // (32768 / 256) = 128
    const seaLevelG = 0;
    const seaLevelB = 0;
    
    // 生成256x256的平坦地形
    const pixelData = Buffer.alloc(tileSize * tileSize * 3);
    
    for (let i = 0; i < pixelData.length; i += 3) {
        pixelData[i] = seaLevelR;     // R
        pixelData[i + 1] = seaLevelG; // G  
        pixelData[i + 2] = seaLevelB; // B
    }
    
    // 转换为PNG格式
    return sharp(pixelData, {
        raw: {
            width: tileSize,
            height: tileSize,
            channels: 3
        }
    }).png().toBuffer();
}

/**
 * 生成模拟DEM瓦片（当本地数据不存在时的后备方案）
 */
async function generateMockTile(z: number, x: number, y: number): Promise<Buffer> {
    const size = 256;
    
    // 创建高度数据 (使用简单的数学函数模拟地形)
    const heightData = new Uint8Array(size * size * 3);
    
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const index = (row * size + col) * 3;
            
            // 使用瓦片坐标和像素位置生成高度
            const lat = (y + row / size) / Math.pow(2, z) * 360 - 180;
            const lon = (x + col / size) / Math.pow(2, z) * 360 - 180;
            
            // 简单的高度函数 (模拟山地地形)
            const height = Math.max(0, 
                100 + 
                50 * Math.sin(lat * 0.1) * Math.cos(lon * 0.1) +
                30 * Math.sin(lat * 0.3) * Math.cos(lon * 0.2) +
                (Math.random() - 0.5) * 20
            );
            
            // Terrarium格式编码: height = (R * 256 + G + B / 256) - 32768
            // 为了简化，我们使用 height = R * 256 + G
            const r = Math.floor(height / 256);
            const g = Math.floor(height % 256);
            const b = 0;
            
            heightData[index] = r;
            heightData[index + 1] = g;
            heightData[index + 2] = b;
        }
    }
    
    // 使用Sharp生成PNG
    return await sharp(heightData, {
        raw: {
            width: size,
            height: size,
            channels: 3
        }
    }).png().toBuffer();
}

/**
 * 多源DEM数据配置 - 更新可用数据源
 */
const DEM_SOURCES = [
    {
        name: 'Mapbox Terrain RGB',
        baseUrl: 'https://api.mapbox.com/v4/mapbox.terrain-rgb',
        timeout: 12000,
        priority: 1,
        requiresToken: true,
        format: 'terrain-rgb', // Mapbox格式
        note: '需要Mapbox access token，但最可靠'
    },
    {
        name: 'Open Elevation',
        baseUrl: 'https://cloud.maptiler.com/tiles/terrain-rgb-v2',
        timeout: 15000,
        priority: 2,
        requiresToken: true,
        format: 'terrain-rgb',
        note: 'MapTiler免费tier可用'
    },
    {
        name: 'NASA SRTM (替代)',
        baseUrl: 'https://elevation-tiles-prod.s3.amazonaws.com/v2/terrarium',
        timeout: 15000,
        priority: 3,
        format: 'terrarium',
        note: 'AWS新版本URL格式'
    },
    {
        name: 'OpenTopo (开源)',
        baseUrl: 'https://a.tile.opentopomap.org',
        timeout: 10000,
        priority: 4,
        format: 'image',
        fallback: true,
        note: '开源地形图服务'
    }
];

/**
 * 增强的DEM下载 - 支持多源、重试、智能超时
 */
async function downloadDEMTile(z: number, x: number, y: number, maxRetries: number = 3): Promise<Buffer | null> {
    console.log(`🌐 开始多源DEM下载: ${z}/${x}/${y} (最大${maxRetries}次重试)`);
    
    // 🔧 紧急修复：尝试所有可用数据源，包括需要token的
    const sources = [...DEM_SOURCES].sort((a, b) => a.priority - b.priority);
    console.log(`🌐 可用DEM数据源: ${sources.map(s => s.name).join(', ')}`);
    
    for (const source of sources) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔄 尝试 ${source.name}: ${z}/${x}/${y} (第${attempt}次)`);
                
                const result = await downloadFromSingleSource(source, z, x, y, attempt);
                
                if (result) {
                    console.log(`✅ ${source.name} 下载成功: ${result.length} bytes (第${attempt}次尝试)`);
                    return result;
                }
                
                // 如果不是最后一次尝试，等待后重试
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 指数退避，最大5秒
                    console.log(`⏳ ${source.name} 第${attempt}次失败，${delay}ms后重试`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.warn(`⚠️ ${source.name} 第${attempt}次尝试失败: ${errorMsg}`);
                
                if (attempt < maxRetries) {
                    const delay = Math.min(2000 * attempt, 8000); // 递增延迟
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        console.warn(`❌ ${source.name} 所有尝试都失败，切换下一个数据源`);
    }
    
    console.error(`💔 所有DEM数据源都失败: ${z}/${x}/${y}`);
    return null;
}

/**
 * 从单一数据源下载DEM瓦片
 */
async function downloadFromSingleSource(
    source: typeof DEM_SOURCES[0], 
    z: number, 
    x: number, 
    y: number,
    attempt: number
): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        let url: string;
        
        // 🔧 支持不同DEM数据源的URL格式
        if (source.name === 'Mapbox Terrain RGB') {
            // 使用我们的Mapbox token
            const mapboxToken = 'pk.eyJ1Ijoid3VqbGluIiwiYSI6ImNtM2lpemVjZzAxYnIyaW9pMGs1aDB0cnkifQ.sxVHnoUGRV51ayrECnENoQ';
            url = `${source.baseUrl}/${z}/${x}/${y}@2x.pngraw?access_token=${mapboxToken}`;
        } else if (source.name === 'Open Elevation') {
            // MapTiler格式
            const maptilerKey = 'get_from_maptiler'; // 需要注册获取
            url = `${source.baseUrl}/${z}/${x}/${y}.png?key=${maptilerKey}`;
        } else if (source.name === 'NASA SRTM (替代)') {
            // AWS新版本URL格式
            url = `${source.baseUrl}/${z}/${x}/${y}.png`;
        } else if (source.name === 'OpenTopo (开源)') {
            // OpenTopoMap只是地形图，不是高程数据，跳过
            console.log(`⏭️ 跳过 ${source.name} (非高程数据)`);
            reject(new Error('非高程数据源'));
            return;
        } else {
            // 默认格式
            url = `${source.baseUrl}/${z}/${x}/${y}.png`;
        }
        
        console.log(`📡 请求URL: ${url.replace(/access_token=[^&]+/, 'access_token=***')}`); // 隐藏token
        
        // 动态调整超时时间（重试时增加超时）
        const timeoutMs = source.timeout + (attempt - 1) * 3000; // 每次重试增加3秒
        
        const request = https.get(url, { timeout: timeoutMs }, (response) => {
            // 处理重定向
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    console.log(`🔄 ${source.name} 重定向到: ${redirectUrl}`);
                    https.get(redirectUrl, { timeout: timeoutMs }, handleResponse).on('error', reject);
                    return;
                }
            }
            
            handleResponse(response);
        });
        
        function handleResponse(response: any) {
            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            
            const chunks: Buffer[] = [];
            let totalSize = 0;
            
            response.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                totalSize += chunk.length;
                
                // 检查数据大小合理性（DEM瓦片通常1KB-100KB）
                if (totalSize > 500 * 1024) { // 超过500KB可能有问题
                    reject(new Error('响应数据过大'));
                    return;
                }
            });
            
            response.on('end', () => {
                if (totalSize < 100) { // 太小可能是错误响应
                    reject(new Error('响应数据过小'));
                    return;
                }
                
                const buffer = Buffer.concat(chunks);
                
                // 验证PNG文件头
                if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
                    reject(new Error('无效的PNG文件'));
                    return;
                }
                
                resolve(buffer);
            });
        }
        
        request.on('error', reject);
        request.on('timeout', () => {
            request.destroy();
            reject(new Error(`请求超时 (${timeoutMs}ms)`));
        });
        
        // 设置请求超时
        request.setTimeout(timeoutMs, () => {
            request.destroy();
            reject(new Error(`连接超时 (${timeoutMs}ms)`));
        });
    });
}

/**
 * 保存DEM瓦片到本地
 */
async function saveDEMTile(z: number, x: number, y: number, buffer: Buffer): Promise<void> {
    try {
        const tileDir = path.join(DEM_DATA_DIR, z.toString(), x.toString());
        await fs.mkdir(tileDir, { recursive: true });
        
        const filePath = path.join(tileDir, `${y}.png`);
        await fs.writeFile(filePath, buffer);
        
        console.log(`💾 DEM瓦片已保存: ${filePath}`);
    } catch (error) {
        console.error(`❌ 保存DEM瓦片失败:`, error);
    }
}

/**
 * 获取DEM瓦片
 * 当前配置：仅使用GeoServer数据源（测试模式）
 */
export async function getDEMTile(z: number, x: number, y: number): Promise<Buffer> {
    // 验证瓦片坐标有效性
    const n = Math.pow(2, z);
    if (x < 0 || x >= n || y < 0 || y >= n) {
        const errorMsg = `无效DEM瓦片坐标: ${z}/${x}/${y} (最大: ${n-1})`;
        console.error(`❌ ${errorMsg}`);
        throw new Error(errorMsg);
    }
    
    // 🎯 仅从GeoServer获取（慕尼黑区域的真实DEM数据）
    console.log(`🔍 尝试从GeoServer获取DEM: ${z}/${x}/${y}`);
    const geoserverTile = await downloadFromGeoServer(z, x, y);
    if (geoserverTile) {
        console.log(`🗺️ 返回GeoServer DEM数据: ${z}/${x}/${y} (${geoserverTile.length} bytes)`);
        return geoserverTile;
    }
    
    // GeoServer获取失败，抛出错误
    const errorMsg = `GeoServer无法提供瓦片 ${z}/${x}/${y} - 可能超出数据范围或服务不可用`;
    console.error(`❌ ${errorMsg}`);
    throw new Error(errorMsg);
    
    /* 
    // ========== 以下Fallback机制已注释（测试期间） ==========
    
    // 2. 尝试读取本地缓存的DEM数据
    const localTile = await readLocalTile(z, x, y);
    if (localTile) {
        console.log(`📍 返回本地缓存DEM数据: ${z}/${x}/${y} (${localTile.length} bytes)`);
        return localTile;
    }
    
    // 3. 多源、多重试下载在线DEM数据（备用）
    console.log(`📭 本地缓存不存在，尝试在线下载: ${z}/${x}/${y}`);
    const downloadedTile = await downloadDEMTile(z, x, y, 3); // 最多重试3次
    
    if (downloadedTile) {
        // 异步保存到本地缓存
        saveDEMTile(z, x, y, downloadedTile).catch(error => {
            console.warn(`⚠️ 在线DEM瓦片缓存失败 ${z}/${x}/${y}:`, error);
        });
        console.log(`🌍 返回在线下载的DEM数据: ${z}/${x}/${y} (${downloadedTile.length} bytes)`);
        return downloadedTile;
    }
    
    // 4. 紧急处理：生成基础地形数据（避免阴影错位）
    console.warn(`⚠️ 所有DEM数据源都失败: ${z}/${x}/${y}`);
    console.log(`🔧 紧急处理: 生成基础地形数据 (海平面基准)`);
    
    const basicTerrain = await generateBasicTerrain(z, x, y);
    console.log(`🗻 返回基础地形数据: ${z}/${x}/${y} (${basicTerrain.length} bytes)`);
    return basicTerrain;
    
    // ========== Fallback机制结束 ==========
    */
}

/**
 * 获取DEM服务信息
 */
export function getDEMInfo() {
    return {
        service: 'DEM Tile Service',
        description: 'Digital Elevation Model tiles for shadow simulation',
        format: 'PNG (RGB)',
        encoding: 'GeoServer WMS PNG format',
        tileSize: 256,
        mode: 'GeoServer Only (Testing Mode)',
        dataSources: [
            {
                name: 'GeoServer',
                coverage: 'Munich area (E11.4-11.6, N48.0-48.2)',
                status: 'Active',
                description: 'Local GeoServer with real TIF data from workstation'
            }
        ],
        fallbackDisabled: true,
        fallbackNote: 'Local cache, online sources, and basic terrain fallbacks are disabled for testing',
        geoserverConfig: {
            baseUrl: GEOSERVER_BASE_URL,
            layer: GEOSERVER_LAYER,
            bbox: GEOSERVER_BBOX,
            format: 'WMS GetMap PNG'
        },
        lastUpdated: new Date().toISOString()
    };
}

// 保持向后兼容的别名
export const generateMockDemTile = getDEMTile;
export const getRealDemTile = readLocalTile;
export async function cacheDemTile(z: number, x: number, y: number, tileBuffer: Buffer): Promise<void> {
    console.log(`Caching DEM tile: ${z}/${x}/${y} (${tileBuffer.length} bytes)`);
}
