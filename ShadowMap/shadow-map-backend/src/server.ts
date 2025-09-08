import dotenv from 'dotenv';
import app from './app';

// 加载环境变量
dotenv.config();

const PORT = process.env['PORT'] || 3001;

// 尝试启动服务器，如果端口被占用则尝试其他端口
function startServer(port: number): void {
  const server = app.listen(port, () => {
    console.log(`🚀 Shadow Map Backend Server is running on port ${port}`);
    console.log(`📍 Environment: ${process.env['NODE_ENV'] || 'development'}`);
    console.log(`🌐 API Base URL: http://localhost:${port}`);
    console.log(`🗺️  DEM Tiles: http://localhost:${port}/api/dem/{z}/{x}/{y}.png`);
    console.log(`❤️  Health Check: http://localhost:${port}/api/health`);
    console.log(`🔄 Server ready - nodemon is watching for changes...`);
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

// 启动服务器
startServer(Number(PORT));

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
