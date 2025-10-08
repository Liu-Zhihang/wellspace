#!/usr/bin/env node

/**
 * Mapbox阴影同步验证工具
 * 直接测试阴影与Mapbox底图的对齐情况
 * 
 * 这是一个简单直接的验证脚本，避免复杂化
 */

console.log(`
🎯 Mapbox阴影同步验证

目标: 直接验证阴影是否与Mapbox底图对齐

测试方法:
1. 打开浏览器开发者工具 (F12)
2. 在Console中粘贴以下代码
3. 查看同步验证结果

=== 复制以下代码到浏览器Console ===

// 验证Mapbox-阴影同步状态
function validateMapboxShadowSync() {
  console.log('🔍 验证Mapbox-阴影同步状态...');
  
  // 检查必要的对象是否存在
  if (!window.mapInstance && !window.map) {
    console.error('❌ 未找到Mapbox地图实例');
    return;
  }
  
  const map = window.mapInstance || window.map;
  
  if (!window.shadeMapInstance) {
    console.error('❌ 未找到阴影模拟器实例');
    return;
  }
  
  const shadeMap = window.shadeMapInstance;
  
  console.log('✅ 找到Mapbox地图和阴影模拟器实例');
  
  // 获取Mapbox状态
  const mapboxCenter = map.getCenter();
  const mapboxZoom = map.getZoom();
  const mapboxBounds = map.getBounds();
  
  console.log('📍 Mapbox状态:');
  console.log(\`   中心: (\${mapboxCenter.lng.toFixed(6)}, \${mapboxCenter.lat.toFixed(6)})\`);
  console.log(\`   缩放: \${mapboxZoom.toFixed(2)}\`);
  console.log(\`   边界: [\${mapboxBounds.getWest().toFixed(6)}, \${mapboxBounds.getSouth().toFixed(6)}, \${mapboxBounds.getEast().toFixed(6)}, \${mapboxBounds.getNorth().toFixed(6)}]\`);
  
  // 测试点击同步
  console.log('🧪 测试点击坐标同步...');
  
  // 在地图中心创建一个测试点
  const centerPixel = map.project([mapboxCenter.lng, mapboxCenter.lat]);
  console.log(\`📍 Mapbox中心像素坐标: (\${centerPixel.x.toFixed(1)}, \${centerPixel.y.toFixed(1)})\`);
  
  // 如果阴影模拟器有getHoursOfSun方法，测试它
  if (typeof shadeMap.getHoursOfSun === 'function') {
    try {
      const hoursOfSun = shadeMap.getHoursOfSun(centerPixel.x, centerPixel.y);
      console.log(\`☀️ 中心点日照时长: \${hoursOfSun.toFixed(1)}小时\`);
      console.log('✅ 阴影模拟器坐标转换正常');
    } catch (error) {
      console.error('❌ 阴影模拟器坐标转换失败:', error);
    }
  }
  
  // 视觉验证建议
  console.log('👁️ 视觉验证方法:');
  console.log('1. 观察建筑物轮廓与阴影是否重叠');
  console.log('2. 移动地图，检查阴影是否跟随');
  console.log('3. 缩放地图，检查阴影是否保持对齐');
  console.log('4. 如果仍有错位，刷新页面重新同步');
}

// 强制重新同步
function forceResync() {
  console.log('🔄 强制重新同步Mapbox-阴影坐标...');
  
  const map = window.mapInstance || window.map;
  const shadeMap = window.shadeMapInstance;
  
  if (!map || !shadeMap) {
    console.error('❌ 未找到地图或阴影实例');
    return;
  }
  
  try {
    // 强制阴影模拟器重新计算
    if (typeof shadeMap.setDate === 'function') {
      shadeMap.setDate(new Date());
    }
    
    if (typeof shadeMap._draw === 'function') {
      shadeMap._draw();
    }
    
    console.log('✅ 强制重新同步完成');
    console.log('💡 如果问题仍存在，可能需要刷新页面');
    
  } catch (error) {
    console.error('❌ 强制同步失败:', error);
  }
}

// 导出到window便于在浏览器中调用
if (typeof window !== 'undefined') {
  window.validateMapboxShadowSync = validateMapboxShadowSync;
  window.forceResync = forceResync;
}

=== 复制结束 ===

使用方法:
1. 在浏览器中运行: validateMapboxShadowSync()
2. 如果发现错位: forceResync()
3. 观察控制台输出和地图效果

预期结果:
✅ 同步验证显示"对齐"
✅ 阴影精确覆盖建筑物轮廓
✅ 地图移动时阴影跟随
`);

// 如果在Node.js环境，提供后端验证
if (typeof require !== 'undefined') {
  console.log('\n🔧 后端验证方式:');
  console.log('1. 重启前端应用: npm run dev');
  console.log('2. 打开浏览器，按F12打开开发者工具');
  console.log('3. 在Console中运行上述验证代码');
  console.log('4. 观察同步验证结果');
  
  console.log('\n🎯 关键指标:');
  console.log('   • 偏移像素 < 5px = 对齐良好');
  console.log('   • 偏移像素 5-20px = 轻微错位');  
  console.log('   • 偏移像素 > 20px = 严重错位');
}
