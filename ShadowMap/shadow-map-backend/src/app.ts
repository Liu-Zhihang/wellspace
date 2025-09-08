import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import path from 'path';

import demRoutes from './routes/dem';
import healthRoutes from './routes/health';
import buildingRoutes from './routes/buildings'; // 重新启用

const app = express();

// 中间件配置
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-hashes'", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
      connectSrc: ["'self'", "http://localhost:3001", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
    },
  },
}));

// 最简单的 CORS 配置
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

app.use(morgan('combined'));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API路由
app.use('/api/health', healthRoutes);
app.use('/api/dem', demRoutes);
app.use('/api/buildings', buildingRoutes); // 重新启用

// 静态文件服务 - 提供前端文件
const frontendPath = path.join(__dirname, '../../shadow-map-frontend');
app.use(express.static(frontendPath));

console.log(`📁 静态文件服务: ${frontendPath}`);

// 根路由
app.get('/', (req, res) => {
  res.json({
    message: 'Shadow Map Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      dem: '/api/dem/:z/:x/:y.png',
      buildings: '/api/buildings/:z/:x/:y.json',
      docs: '/api/docs'
    }
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// 错误处理中间件
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('❌ Application Error:', err);
  
  // 防止头部已发送后再次发送响应
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env['NODE_ENV'] === 'development' ? err.message : 'Something went wrong'
  });
});

export default app;
