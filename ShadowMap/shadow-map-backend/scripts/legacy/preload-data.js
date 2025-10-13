#!/usr/bin/env node

/**
 * 数据预处理快速启动脚本
 * 使用方法：
 *   node preload-data.js cities    # 预处理所有热门城市
 *   node preload-data.js location 39.9042 116.4074  # 预处理指定位置
 */

const https = require('https');

const API_BASE = 'http://localhost:3001/api/preload';

// 发送HTTP请求
function sendRequest(path, method = 'POST', data = null) {
    return new Promise((resolve, reject) => {
        const url = `${API_BASE}${path}`;
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        console.log(`📡 发送请求: ${method} ${url}`);

        const req = require('http').request(url, options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (error) {
                    resolve({ status: res.statusCode, data: responseData });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

// 预处理热门城市
async function preloadCities() {
    console.log('🌍 开始预处理热门城市建筑物数据...');
    
    try {
        const response = await sendRequest('/cities', 'POST');
        
        if (response.status === 200) {
            console.log('✅ 预处理请求已发送:');
            console.log(`   状态: ${response.data.status}`);
            console.log(`   城市数量: ${response.data.cities}`);
            console.log(`   预计耗时: ${response.data.estimatedTime}`);
            console.log(`   缩放级别: [${response.data.zoomLevels.join(', ')}]`);
            console.log('\n💡 预处理将在后台进行，请查看服务器日志了解进度');
        } else {
            console.error('❌ 预处理请求失败:', response.data);
        }
        
    } catch (error) {
        console.error('❌ 请求失败:', error.message);
        console.log('\n💡 请确保后端服务器正在运行 (npm run dev)');
    }
}

// 预处理指定位置
async function preloadLocation(lat, lng) {
    console.log(`📍 预处理位置: ${lat}, ${lng}`);
    
    try {
        const response = await sendRequest('/location', 'POST', {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            zoom: 16
        });
        
        if (response.status === 200) {
            console.log('✅ 位置预处理请求已发送:');
            console.log(`   位置: ${response.data.location.lat}, ${response.data.location.lng}`);
            console.log(`   缩放级别: ${response.data.location.zoom}`);
            console.log(`   预计耗时: ${response.data.estimatedTime}`);
            console.log('\n💡 预处理将在后台进行，请查看服务器日志了解进度');
        } else {
            console.error('❌ 位置预处理请求失败:', response.data);
        }
        
    } catch (error) {
        console.error('❌ 请求失败:', error.message);
        console.log('\n💡 请确保后端服务器正在运行 (npm run dev)');
    }
}

// 获取预处理状态
async function getStatus() {
    console.log('📊 获取预处理状态...');
    
    try {
        const response = await sendRequest('/status', 'GET');
        
        if (response.status === 200) {
            const data = response.data;
            console.log('📊 当前数据库状态:');
            console.log(`   总建筑物数: ${data.database.totalBuildings.toLocaleString()}`);
            console.log(`   总瓦片数: ${data.database.totalTiles.toLocaleString()}`);
            console.log(`   数据大小: ${data.database.dataSize}`);
            console.log(`   最新记录: ${data.database.newestRecord}`);
            
            if (data.buildingTypes && data.buildingTypes.length > 0) {
                console.log('\n🏗️ 建筑物类型分布:');
                data.buildingTypes.slice(0, 5).forEach(type => {
                    console.log(`   ${type.type}: ${type.count.toLocaleString()} 个`);
                });
            }
            
            if (data.recommendations) {
                console.log('\n💡 建议:');
                Object.values(data.recommendations).forEach(rec => {
                    if (rec) console.log(`   ${rec}`);
                });
            }
        } else {
            console.error('❌ 状态获取失败:', response.data);
        }
        
    } catch (error) {
        console.error('❌ 请求失败:', error.message);
        console.log('\n💡 请确保后端服务器正在运行 (npm run dev)');
    }
}

// 主函数
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(`
🚀 ShadowMap 数据预处理工具

使用方法:
  node preload-data.js cities              # 预处理所有热门城市
  node preload-data.js location <lat> <lng>  # 预处理指定位置  
  node preload-data.js status             # 查看预处理状态

示例:
  node preload-data.js cities
  node preload-data.js location 39.9042 116.4074
  node preload-data.js status
        `);
        return;
    }
    
    const command = args[0];
    
    switch (command) {
        case 'cities':
            await preloadCities();
            break;
            
        case 'location':
            if (args.length < 3) {
                console.error('❌ 缺少参数: 需要提供纬度和经度');
                console.log('使用方法: node preload-data.js location <lat> <lng>');
                return;
            }
            
            const lat = args[1];
            const lng = args[2];
            
            if (isNaN(lat) || isNaN(lng)) {
                console.error('❌ 无效参数: 纬度和经度必须是数字');
                return;
            }
            
            await preloadLocation(lat, lng);
            break;
            
        case 'status':
            await getStatus();
            break;
            
        default:
            console.error(`❌ 未知命令: ${command}`);
            console.log('支持的命令: cities, location, status');
    }
}

// 运行主函数
main().catch(console.error);
