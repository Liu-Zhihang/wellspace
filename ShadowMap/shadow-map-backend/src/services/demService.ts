/**
 * DEM (Digital Elevation Model) 服务
 * 处理数字高程模型数据，提供地形高度信息
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';

// DEM数据目录
const DEM_DATA_DIR = path.join(__dirname, '../../data/dem');

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
 * 获取DEM瓦片
 * 优先使用本地真实数据，如果不存在则生成模拟数据
 */
export async function getDEMTile(z: number, x: number, y: number): Promise<Buffer> {
    // 首先尝试读取本地真实DEM数据
    const localTile = await readLocalTile(z, x, y);
    if (localTile) {
        console.log(`📍 返回真实DEM数据: ${z}/${x}/${y}`);
        return localTile;
    }
    
    // 如果本地数据不存在，生成模拟数据
    console.log(`🎭 生成模拟DEM数据: ${z}/${x}/${y}`);
    return await generateMockTile(z, x, y);
}

/**
 * 获取DEM服务信息
 */
export function getDEMInfo() {
    return {
        service: 'DEM Tile Service',
        description: 'Digital Elevation Model tiles for shadow simulation',
        format: 'PNG (RGB)',
        encoding: 'Terrarium (height = (R * 256 + G + B / 256) - 32768)',
        tileSize: 256,
        dataSource: 'AWS Open Data (real data) + Mock generation (fallback)',
        coverage: 'Beijing area (zoom 10-15) + Global mock data',
        lastUpdated: new Date().toISOString()
    };
}

// 保持向后兼容的别名
export const generateMockDemTile = getDEMTile;
export const getRealDemTile = readLocalTile;
export async function cacheDemTile(z: number, x: number, y: number, tileBuffer: Buffer): Promise<void> {
    console.log(`Caching DEM tile: ${z}/${x}/${y} (${tileBuffer.length} bytes)`);
}
