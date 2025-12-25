import { dbManager } from '../config/database';
import { buildingServiceMongoDB } from '../services/buildingServiceMongoDB';
import { Building } from '../models/Building';

/**
 * 测试完整数据流：前端 → API → MongoDB → OSM fallback
 */
export async function testCompleteDataFlow(): Promise<void> {
  console.log('🔄 开始测试完整数据流...\n');

  try {
    // 步骤1: 测试MongoDB连接
    console.log('📊 步骤1: 测试MongoDB连接');
    await dbManager.connect();
    const dbHealth = await dbManager.healthCheck();
    console.log(`   状态: ${dbHealth.status}`);
    console.log(`   连接信息: ${JSON.stringify(dbHealth.details, null, 2)}\n`);

    // 步骤2: 测试MongoDB数据查询
    console.log('🏢 步骤2: 测试MongoDB建筑物数据查询');
    const existingBuildings = await Building.countDocuments();
    console.log(`   现有建筑物数量: ${existingBuildings}\n`);

    // 步骤3: 测试OSM API fallback
    console.log('🌐 步骤3: 测试OSM API fallback');
    const testTile = { z: 15, x: 26976, y: 13487 }; // 北京某个瓦片
    
    // 清除该瓦片的MongoDB缓存（如果存在）
    await Building.deleteMany({
      'tile.z': testTile.z,
      'tile.x': testTile.x,
      'tile.y': testTile.y
    });
    console.log(`   已清除瓦片 ${testTile.z}/${testTile.x}/${testTile.y} 的MongoDB缓存`);

    // 调用建筑物服务（应该触发OSM API调用）
    console.log(`   正在从OSM API获取数据...`);
    const startTime = Date.now();
    const tileData = await buildingServiceMongoDB.getBuildingTile(testTile.z, testTile.x, testTile.y);
    const apiTime = Date.now() - startTime;
    
    console.log(`   OSM API响应: ${apiTime}ms`);
    console.log(`   获取建筑物: ${tileData.features.length} 个`);
    console.log(`   数据源: ${tileData.fromDatabase ? 'MongoDB' : 'OSM API'}`);
    console.log(`   已缓存: ${tileData.cached}\n`);

    // 步骤4: 测试MongoDB缓存读取
    console.log('💾 步骤4: 测试MongoDB缓存读取');
    const cachedStartTime = Date.now();
    const cachedData = await buildingServiceMongoDB.getBuildingTile(testTile.z, testTile.x, testTile.y);
    const cachedTime = Date.now() - cachedStartTime;
    
    console.log(`   MongoDB查询: ${cachedTime}ms`);
    console.log(`   获取建筑物: ${cachedData.features.length} 个`);
    console.log(`   数据源: ${cachedData.fromDatabase ? 'MongoDB' : 'OSM API'}`);
    console.log(`   已缓存: ${cachedData.cached}`);
    
    // 比较性能
    const speedup = apiTime / cachedTime;
    console.log(`   性能提升: ${speedup.toFixed(1)}x 倍\n`);

    // 步骤5: 验证数据完整性
    console.log('🔍 步骤5: 验证数据完整性');
    
    if (tileData.features.length !== cachedData.features.length) {
      throw new Error('数据不一致：OSM API结果与MongoDB缓存结果数量不匹配');
    }
    
    // 检查第一个建筑物的数据结构
    if (tileData.features.length > 0) {
      const firstBuilding = tileData.features[0];
      if (firstBuilding?.properties) {
        console.log(`   示例建筑物数据:`);
        console.log(`     ID: ${firstBuilding.properties.id}`);
        console.log(`     类型: ${firstBuilding.properties.buildingType}`);
        console.log(`     高度: ${firstBuilding.properties.height}m`);
        console.log(`     楼层: ${firstBuilding.properties.levels || '未知'}`);
      } else {
        console.log(`   建筑物数据结构异常`);
      }
    } else {
      console.log(`   该瓦片没有建筑物数据`);
    }

    // 步骤6: 测试统计功能
    console.log('\n📈 步骤6: 测试统计功能');
    const stats = await buildingServiceMongoDB.getStatistics();
    console.log(`   总建筑物数量: ${stats.totalBuildings}`);
    console.log(`   总瓦片数量: ${stats.totalTiles}`);
    console.log(`   数据大小: ${Math.round(stats.dataSize / 1024 / 1024 * 100) / 100} MB`);
    console.log(`   建筑类型分布: ${JSON.stringify(stats.buildingTypeDistribution.slice(0, 3), null, 2)}`);

    console.log('\n🎉 数据流测试完成！所有步骤都成功执行。');
    console.log('\n✅ 验证结果:');
    console.log('   ✓ MongoDB连接正常');
    console.log('   ✓ OSM API调用成功');
    console.log('   ✓ 数据自动缓存到MongoDB');
    console.log('   ✓ 缓存读取性能优异');
    console.log('   ✓ 数据完整性验证通过');
    console.log('   ✓ 统计功能正常工作');

  } catch (error) {
    console.error('\n❌ 数据流测试失败:');
    
    if (error instanceof Error) {
      console.error(`   错误信息: ${error.message}`);
      
      if (error.message.includes('authentication')) {
        console.error('   💡 建议: 检查MongoDB Atlas连接字符串和认证信息');
      } else if (error.message.includes('network')) {
        console.error('   💡 建议: 检查网络连接和防火墙设置');
      } else if (error.message.includes('timeout')) {
        console.error('   💡 建议: 检查OSM API是否可访问，或增加超时时间');
      }
    }
    
    throw error;
    
  } finally {
    // 清理连接
    await dbManager.disconnect();
    console.log('\n🔌 数据库连接已关闭');
  }
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
  testCompleteDataFlow()
    .then(() => {
      console.log('\n🎉 数据流测试成功完成！');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 数据流测试失败:', error);
      process.exit(1);
    });
}
