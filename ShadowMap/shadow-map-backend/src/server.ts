import dotenv from 'dotenv';
import app from './app';

dotenv.config();

const port = Number(process.env['PORT'] || 3500);

function bootServer(startPort: number): void {
  const server = app.listen(startPort, () => {
    console.log(`🚀 Shadow Map Backend Server is running on port ${startPort}`);
    console.log(`📍 Environment: ${process.env['NODE_ENV'] || 'development'}`);
    console.log(`🌐 API Base URL: http://localhost:${startPort}`);
    console.log(`🗺️  DEM Tiles: http://localhost:${startPort}/api/dem/{z}/{x}/{y}.png`);
    console.log(`🏢  Buildings: http://localhost:${startPort}/api/buildings/{z}/{x}/{y}.json`);
    console.log(`🌤️  Weather: http://localhost:${startPort}/api/weather/current`);
    console.log('🚀 Server ready and accepting requests!');
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`⚠️  Port ${startPort} is in use, trying port ${startPort + 1}...`);
      bootServer(startPort + 1);
      return;
    }

    console.error('❌ Server error:', error);
    process.exit(1);
  });

  (global as any).server = server;
}

bootServer(port);

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
