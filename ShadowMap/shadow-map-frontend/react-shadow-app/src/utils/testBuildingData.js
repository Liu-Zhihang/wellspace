/**
 * 测试建筑物数据获取
 * 用于调试建筑物图层显示问题
 */

// 测试北京区域的建筑物数据获取
async function testBeijingBuildingData() {
  console.log('🏗️ 测试北京区域建筑物数据获取...');
  
  const beijingBounds = {
    north: 40.2,
    south: 39.4,
    east: 117.4,
    west: 115.7
  };
  
  const zoom = 15;
  
  // 计算瓦片坐标
  const n = Math.pow(2, zoom);
  const minTileX = Math.floor((beijingBounds.west + 180) / 360 * n);
  const maxTileX = Math.floor((beijingBounds.east + 180) / 360 * n);
  const minTileY = Math.floor((1 - Math.log(Math.tan(beijingBounds.north * Math.PI / 180) + 1 / Math.cos(beijingBounds.north * Math.PI / 180)) / Math.PI) / 2 * n);
  const maxTileY = Math.floor((1 - Math.log(Math.tan(beijingBounds.south * Math.PI / 180) + 1 / Math.cos(beijingBounds.south * Math.PI / 180)) / Math.PI) / 2 * n);
  
  console.log(`📍 北京区域瓦片范围: x[${minTileX}-${maxTileX}], y[${minTileY}-${maxTileY}]`);
  
  // 测试几个瓦片
  const testTiles = [
    { z: zoom, x: minTileX, y: minTileY },
    { z: zoom, x: minTileX + 1, y: minTileY },
    { z: zoom, x: minTileX, y: minTileY + 1 }
  ];
  
  for (const tile of testTiles) {
    try {
      console.log(`🔍 测试瓦片: ${tile.z}/${tile.x}/${tile.y}`);
      const response = await fetch(`http://localhost:3001/api/buildings/${tile.z}/${tile.x}/${tile.y}.json`);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`  ✅ 成功: ${data.features?.length || 0} 个建筑物`);
        
        if (data.features && data.features.length > 0) {
          console.log(`  🏠 示例建筑:`, {
            type: data.features[0].type,
            properties: data.features[0].properties,
            geometry: data.features[0].geometry?.type
          });
        }
      } else {
        console.log(`  ❌ 失败: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.log(`  ❌ 错误: ${error.message}`);
    }
  }
}

// 在浏览器控制台中运行
if (typeof window !== 'undefined') {
  window.testBeijingBuildingData = testBeijingBuildingData;
  console.log('💡 在控制台运行: testBeijingBuildingData()');
}

export { testBeijingBuildingData };
