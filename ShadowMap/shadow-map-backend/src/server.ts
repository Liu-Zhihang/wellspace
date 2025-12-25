import dotenv from 'dotenv';
import app from './app';
import { dbManager } from './config/database';

// 加载环境变量
dotenv.config();

const PORT = process.env['PORT'] || 3500;

// 初始化数据库连接
async function initializeDatabase(): Promise<void> {
  try {
    await dbManager.connect();
    await dbManager.createIndexes();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }
}

// 尝试启动服务器，如果端口被占用则尝试其他端口
async function startServer(port: number): Promise<void> {
  try {
    // 先初始化数据库，确保连接就绪
    console.log('🔄 Initializing database connection...');
    await initializeDatabase();
    console.log('✅ Database connection ready');
    
    // 数据库就绪后再启动服务器
    const server = app.listen(port, () => {
      console.log(`🚀 Shadow Map Backend Server is running on port ${port}`);
      console.log(`📍 Environment: ${process.env['NODE_ENV'] || 'development'}`);
      console.log(`🌐 API Base URL: http://localhost:${port}`);
      console.log(`🗺️  DEM Tiles: http://localhost:${port}/api/dem/{z}/{x}/{y}.png`);
      console.log(`❤️  Health Check: http://localhost:${port}/api/health`);
      console.log(`🚀 Server ready and accepting requests!`);
    });
    
    // 端口被占用时自动尝试下一个端口
    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`⚠️  Port ${port} is already in use, trying port ${port + 1}...`);
        startServer(port + 1);
      } else {
        console.error('❌ Server error:', error);
        process.exit(1);
      }
    });
    
    // 设置全局服务器引用以便优雅关闭
    (global as any).server = server;
    
  } catch (error) {
    console.error('⚠️  Database connection failed, starting server anyway:', error);
    console.log('💡 Building API will fallback to OSM API only');
    
    // 即使数据库连接失败，也启动服务器（仅使用OSM API）
    const server = app.listen(port, () => {
      console.log(`🚀 Shadow Map Backend Server is running on port ${port} (OSM-only mode)`);
      console.log(`📍 Environment: ${process.env['NODE_ENV'] || 'development'}`);
      console.log(`🌐 API Base URL: http://localhost:${port}`);
      console.log(`🗺️  DEM Tiles: http://localhost:${port}/api/dem/{z}/{x}/{y}.png`);
      console.log(`❤️  Health Check: http://localhost:${port}/api/health`);
      console.log(`⚠️  Server ready (MongoDB unavailable)`);
    });
    
    // 端口被占用时自动尝试下一个端口
    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`⚠️  Port ${port} is already in use, trying port ${port + 1}...`);
        startServer(port + 1);
      } else {
        console.error('❌ Server error:', error);
        process.exit(1);
      }
    });
    
    // 设置全局服务器引用以便优雅关闭
    (global as any).server = server;
  }
}

// 启动服务器
startServer(Number(PORT)).catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});

// 监听未捕获的异常
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('🔄 Server will restart...');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  console.error('🔄 Server will restart...');
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  const server = (global as any).server;
  if (server) {
    server.close(() => {
      console.log('✅ Process terminated');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  const server = (global as any).server;
  if (server) {
    server.close(() => {
      console.log('✅ Process terminated');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});
