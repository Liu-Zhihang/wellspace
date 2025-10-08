#!/usr/bin/env node

/**
 * TUM长期缓存管理工具
 * 基于TUM数据4个月更新频率的缓存优化工具
 */

const axios = require('axios');

// 配置
const API_BASE_URL = 'http://localhost:3001/api/tum-cache';
const POPULAR_LOCATIONS = [
  { name: '北京天安门', lat: 39.9042, lng: 116.4074 },
  { name: '上海外滩', lat: 31.2304, lng: 121.4737 },
  { name: '广州塔', lat: 23.1291, lng: 113.3240 },
  { name: '深圳平安大厦', lat: 22.5431, lng: 114.0579 },
  { name: '杭州西湖', lat: 30.2741, lng: 120.1551 },
  { name: '南京夫子庙', lat: 32.0473, lng: 118.7892 },
  { name: '武汉黄鹤楼', lat: 30.5428, lng: 114.2734 },
  { name: '成都春熙路', lat: 30.6598, lng: 104.0633 }
];

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function colorLog(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// API调用函数
async function apiCall(endpoint, method = 'GET', data = null) {
  try {
    const config = {
      method,
      url: `${API_BASE_URL}${endpoint}`,
      timeout: 30000
    };
    
    if (data && (method === 'POST' || method === 'PUT')) {
      config.data = data;
      config.headers = { 'Content-Type': 'application/json' };
    }
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      colorLog('red', '❌ 无法连接到后端服务器，请确保服务器正在运行 (npm start)');
    } else if (error.response) {
      colorLog('red', `❌ API错误 (${error.response.status}): ${error.response.data?.message || error.message}`);
    } else {
      colorLog('red', `❌ 网络错误: ${error.message}`);
    }
    throw error;
  }
}

// 命令处理函数
async function showStats() {
  colorLog('cyan', '📊 获取TUM缓存统计...');
  
  try {
    const result = await apiCall('/stats');
    const { stats } = result;
    
    console.log('\n' + '='.repeat(50));
    colorLog('bright', '📊 TUM长期缓存统计信息');
    console.log('='.repeat(50));
    
    colorLog('green', `📦 总网格数量: ${stats.totalGrids}`);
    colorLog('blue', `🏗️ TUM数据网格: ${stats.tumDataGrids}`);
    colorLog('yellow', `🌍 OSM数据网格: ${stats.osmDataGrids}`);
    colorLog('magenta', `🔗 混合数据网格: ${stats.hybridDataGrids}`);
    colorLog('cyan', `📈 缓存命中率: ${stats.cacheHitRate.toFixed(1)}%`);
    colorLog('green', `📅 平均缓存年龄: ${stats.averageAge.toFixed(1)}天`);
    colorLog('blue', `💾 存储大小: ${stats.storageSize}MB`);
    
    console.log('='.repeat(50) + '\n');
    
  } catch (error) {
    // 错误已在apiCall中处理
  }
}

async function preloadLocation(lat, lng, zoom = 15) {
  colorLog('cyan', `🔄 预加载位置: (${lat}, ${lng}) zoom=${zoom}`);
  
  try {
    const result = await apiCall('/preload', 'POST', { lat, lng, zoom });
    colorLog('green', `✅ ${result.message}`);
  } catch (error) {
    // 错误已在apiCall中处理
  }
}

async function preloadPopularLocations() {
  colorLog('cyan', `🔄 批量预加载${POPULAR_LOCATIONS.length}个热门位置...`);
  
  try {
    const result = await apiCall('/batch-preload', 'POST', {
      locations: POPULAR_LOCATIONS,
      zoom: 15
    });
    
    colorLog('green', `✅ ${result.message}`);
    colorLog('blue', '📍 预加载位置:');
    POPULAR_LOCATIONS.forEach(loc => {
      console.log(`   • ${loc.name} (${loc.lat}, ${loc.lng})`);
    });
    
  } catch (error) {
    // 错误已在apiCall中处理
  }
}

async function checkLocation(lat, lng, zoom = 15) {
  colorLog('cyan', `🔍 检查位置缓存: (${lat}, ${lng}) zoom=${zoom}`);
  
  try {
    const result = await apiCall(`/check?lat=${lat}&lng=${lng}&zoom=${zoom}`);
    
    if (result.hasCachedData) {
      colorLog('green', `✅ 找到缓存数据`);
      if (result.dataPreview) {
        console.log(`   📊 建筑物数量: ${result.dataPreview.featureCount}`);
        console.log(`   📡 数据源: ${result.dataPreview.dataSource}`);
      }
    } else {
      colorLog('yellow', `⚠️ 无缓存数据`);
    }
    
  } catch (error) {
    // 错误已在apiCall中处理
  }
}

async function cleanupCache() {
  colorLog('cyan', '🧹 清理过期缓存...');
  
  try {
    const result = await apiCall('/cleanup', 'DELETE');
    colorLog('green', `✅ ${result.message}`);
    
  } catch (error) {
    // 错误已在apiCall中处理
  }
}

async function showConfig() {
  colorLog('cyan', '⚙️ 获取TUM缓存配置...');
  
  try {
    const result = await apiCall('/config');
    const { config } = result;
    
    console.log('\n' + '='.repeat(50));
    colorLog('bright', '⚙️ TUM长期缓存配置');
    console.log('='.repeat(50));
    
    colorLog('green', `🕐 长期缓存TTL: ${config.longTermTTL}天`);
    colorLog('blue', `🕑 中期缓存TTL: ${config.mediumTermTTL}天`);
    colorLog('yellow', `🕒 短期缓存TTL: ${config.shortTermTTL}天`);
    colorLog('magenta', `📏 网格大小: ${config.gridSize}度`);
    colorLog('cyan', `📦 最大网格缓存: ${config.maxGridCache}`);
    colorLog('green', `🔄 预加载半径: ${config.preloadRadius}网格`);
    colorLog('blue', `📊 预加载批次大小: ${config.preloadBatchSize}`);
    colorLog('yellow', `📅 TUM数据更新频率: ${config.tumDataUpdateFrequency}`);
    
    console.log('\n💡 ' + config.description);
    console.log('='.repeat(50) + '\n');
    
  } catch (error) {
    // 错误已在apiCall中处理
  }
}

// 帮助信息
function showHelp() {
  console.log('\n' + '='.repeat(60));
  colorLog('bright', '🗺️  TUM长期缓存管理工具');
  console.log('='.repeat(60));
  console.log('基于TUM GlobalBuildingAtlas数据4个月更新频率的缓存优化工具\n');
  
  colorLog('cyan', '📋 可用命令:');
  console.log('');
  console.log('  📊 stats                    - 显示缓存统计信息');
  console.log('  🔄 preload <lat> <lng>      - 预加载指定位置');
  console.log('  🏙️  preload-popular          - 预加载热门城市位置');
  console.log('  🔍 check <lat> <lng>        - 检查位置缓存状态');
  console.log('  🧹 cleanup                  - 清理过期缓存');
  console.log('  ⚙️  config                   - 显示缓存配置');
  console.log('  ❓ help                     - 显示帮助信息');
  console.log('');
  
  colorLog('yellow', '💡 使用示例:');
  console.log('  node tum-cache-manager.js stats');
  console.log('  node tum-cache-manager.js preload 39.9042 116.4074');
  console.log('  node tum-cache-manager.js check 31.2304 121.4737');
  console.log('  node tum-cache-manager.js preload-popular');
  console.log('  node tum-cache-manager.js cleanup');
  console.log('');
  
  colorLog('green', '🎯 优势特点:');
  console.log('  • 基于TUM数据4个月更新频率，实现90天长期缓存');
  console.log('  • 网格化管理，智能预加载相邻区域');
  console.log('  • 三级缓存架构: Redis + MongoDB + 文件系统');
  console.log('  • 自动过期清理，节省存储空间');
  console.log('  • 支持批量预加载热门城市');
  console.log('');
  console.log('='.repeat(60) + '\n');
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === 'help') {
    showHelp();
    return;
  }
  
  try {
    switch (command) {
      case 'stats':
        await showStats();
        break;
        
      case 'preload':
        if (args.length < 3) {
          colorLog('red', '❌ 缺少参数: node tum-cache-manager.js preload <lat> <lng> [zoom]');
          return;
        }
        const lat = parseFloat(args[1]);
        const lng = parseFloat(args[2]);
        const zoom = args[3] ? parseInt(args[3]) : 15;
        
        if (isNaN(lat) || isNaN(lng) || isNaN(zoom)) {
          colorLog('red', '❌ 参数格式错误，请提供有效的数字');
          return;
        }
        
        await preloadLocation(lat, lng, zoom);
        break;
        
      case 'preload-popular':
        await preloadPopularLocations();
        break;
        
      case 'check':
        if (args.length < 3) {
          colorLog('red', '❌ 缺少参数: node tum-cache-manager.js check <lat> <lng> [zoom]');
          return;
        }
        const checkLat = parseFloat(args[1]);
        const checkLng = parseFloat(args[2]);
        const checkZoom = args[3] ? parseInt(args[3]) : 15;
        
        if (isNaN(checkLat) || isNaN(checkLng) || isNaN(checkZoom)) {
          colorLog('red', '❌ 参数格式错误，请提供有效的数字');
          return;
        }
        
        await checkLocation(checkLat, checkLng, checkZoom);
        break;
        
      case 'cleanup':
        await cleanupCache();
        break;
        
      case 'config':
        await showConfig();
        break;
        
      default:
        colorLog('red', `❌ 未知命令: ${command}`);
        showHelp();
    }
  } catch (error) {
    colorLog('red', '\n❌ 操作失败，请检查后端服务器状态');
    process.exit(1);
  }
}

// 运行主函数
if (require.main === module) {
  main().catch(error => {
    colorLog('red', `❌ 程序异常: ${error.message}`);
    process.exit(1);
  });
}



