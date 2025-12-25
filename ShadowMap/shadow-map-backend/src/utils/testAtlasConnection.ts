import mongoose from 'mongoose';
import { config } from '../config';

/**
 * 测试MongoDB Atlas连接
 */
export async function testAtlasConnection(): Promise<void> {
  try {
    console.log('🔄 Testing MongoDB Atlas connection...');
    
    const uri = config.mongodb.uri;
    console.log(`📍 Connecting to: ${uri.replace(/\/\/.*@/, '//***:***@')}`);
    
    // 连接配置
    const options = {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 5,
      retryWrites: true,
      w: 'majority' as const,
      ssl: true,
      tls: true,
    };
    
    // 连接到Atlas
    await mongoose.connect(uri, options);
    
    // 测试基本操作
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');
    
    // Ping测试
    const pingResult = await db.admin().ping();
    console.log('🏓 Ping result:', pingResult);
    
    // 列出集合
    const collections = await db.listCollections().toArray();
    console.log('📊 Available collections:', collections.map(c => c.name));
    
    // 获取数据库统计
    const stats = await db.stats();
    console.log('📈 Database stats:', {
      name: stats['db'],
      collections: stats['collections'],
      dataSize: `${Math.round(stats['dataSize'] / 1024)} KB`,
      indexSize: `${Math.round(stats['indexSize'] / 1024)} KB`
    });
    
    console.log('✅ MongoDB Atlas connection successful!');
    
  } catch (error) {
    console.error('❌ MongoDB Atlas connection failed:');
    
    if (error instanceof Error) {
      if (error.message.includes('authentication')) {
        console.error('🔐 Authentication error - check username/password');
      } else if (error.message.includes('network')) {
        console.error('🌐 Network error - check internet connection');
      } else if (error.message.includes('timeout')) {
        console.error('⏰ Timeout error - Atlas cluster may be paused');
      } else {
        console.error('📝 Error details:', error.message);
      }
    }
    
    throw error;
    
  } finally {
    // 关闭连接
    await mongoose.disconnect();
    console.log('🔌 Connection closed');
  }
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
  testAtlasConnection()
    .then(() => {
      console.log('🎉 Test completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Test failed:', error);
      process.exit(1);
    });
}
