import mongoose from 'mongoose';
import { config } from '../config';

async function detailedMongoTest(): Promise<void> {
  console.log('🔍 详细MongoDB连接诊断\n');
  
  // 显示配置信息
  console.log('📋 连接配置:');
  console.log(`   URI: ${config.mongodb.uri.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`   Database: ${config.mongodb.database}`);
  console.log(`   MaxPoolSize: ${config.mongodb.maxPoolSize}\n`);
  
  try {
    console.log('🔄 开始连接...');
    
    // 简化的连接选项
    const options = {
      serverSelectionTimeoutMS: 30000, // 30秒超时
      socketTimeoutMS: 45000,
      maxPoolSize: 5,
      retryWrites: true,
      w: 'majority' as const,
    };
    
    console.log('📡 连接选项:', JSON.stringify(options, null, 2));
    
    // 尝试连接
    await mongoose.connect(config.mongodb.uri, options);
    
    console.log('✅ 连接成功！');
    
    // 测试ping
    const db = mongoose.connection.db;
    if (db) {
      const pingResult = await db.admin().ping();
      console.log('🏓 Ping结果:', pingResult);
      
      // 获取服务器信息
      const serverStatus = await db.admin().serverStatus();
      console.log('🖥️  服务器信息:');
      console.log(`   版本: ${serverStatus['version']}`);
      console.log(`   主机: ${serverStatus['host']}`);
      console.log(`   正常运行时间: ${Math.round(serverStatus['uptime'] / 3600)}小时`);
    }
    
  } catch (error) {
    console.error('❌ 连接失败详细信息:');
    
    if (error instanceof Error) {
      console.error(`   错误类型: ${error.constructor.name}`);
      console.error(`   错误消息: ${error.message}`);
      
      // 分析具体错误类型
      if (error.message.includes('ENOTFOUND')) {
        console.error('🌐 DNS解析失败 - 可能是网络问题或域名错误');
      } else if (error.message.includes('ETIMEDOUT')) {
        console.error('⏰ 连接超时 - 可能是防火墙阻止或服务器响应慢');
      } else if (error.message.includes('authentication')) {
        console.error('🔐 认证失败 - 检查用户名密码');
      } else if (error.message.includes('MongoParseError')) {
        console.error('📝 连接字符串格式错误');
      }
      
      // 显示完整错误堆栈
      console.error('\n📋 完整错误信息:');
      console.error(error);
    }
  } finally {
    // 关闭连接
    try {
      await mongoose.disconnect();
      console.log('\n🔌 连接已关闭');
    } catch (e) {
      console.error('关闭连接时出错:', e);
    }
  }
}

// 执行测试
if (require.main === module) {
  detailedMongoTest()
    .then(() => {
      console.log('\n🎉 诊断完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 诊断失败:', error);
      process.exit(1);
    });
}

export { detailedMongoTest };
