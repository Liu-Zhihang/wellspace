import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import path from 'path';
import fs from 'fs';

import demRoutes from './routes/dem';
import healthRoutes from './routes/health';
import buildingRoutes from './routes/buildings'; // 重新启用
import dataPreloadRoutes from './routes/dataPreload';
import tileDebugRoutes from './routes/tileDebug';
import buildingOptRoutes from './routes/buildingOptimization';
import coordValidateRoutes from './routes/coordinateValidation';
import tumBuildingRoutes from './routes/tumBuildings'; // TUM建筑数据路由
import localTUMDataRoutes from './routes/localTUMData'; // 本地TUM数据路由
import localBuildingDataRoutes from './routes/localBuildingData'; // 本地建筑数据处理路由

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
app.use('/api/preload', dataPreloadRoutes);
app.use('/api/debug', tileDebugRoutes);
app.use('/api/building-opt', buildingOptRoutes);
app.use('/api/coord-validate', coordValidateRoutes);
app.use('/api/tum-buildings', tumBuildingRoutes); // TUM建筑数据API
app.use('/api/local-tum', localTUMDataRoutes); // 本地TUM数据API
app.use('/api/local-buildings', localBuildingDataRoutes); // 本地建筑数据处理API

// 静态文件服务 - 优先提供React构建产物，其次提供原型目录
const reactDistPath = path.join(__dirname, '../../shadow-map-frontend/react-shadow-app/dist');
const fallbackPublic = path.join(__dirname, '../../shadow-map-frontend');
const publicRoot = fs.existsSync(reactDistPath) ? reactDistPath : fallbackPublic;

app.use(express.static(publicRoot));
console.log(`📁 静态文件服务: ${publicRoot}`);

// 根路由
app.get('/', (req, res) => {
  res.json({
    message: 'Shadow Map Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      dem: '/api/dem/:z/:x/:y.png',
      buildings: '/api/buildings/:z/:x/:y.json',
      preload: {
        cities: 'POST /api/preload/cities - 预处理热门城市',
        location: 'POST /api/preload/location - 预处理指定位置',
        status: 'GET /api/preload/status - 获取预处理状态',
        cleanup: 'POST /api/preload/cleanup - 清理过期数据',
        cityList: 'GET /api/preload/cities - 支持的城市列表'
      },
      tumCache: {
        stats: 'GET /api/tum-cache/stats - TUM缓存统计',
        preload: 'POST /api/tum-cache/preload - 预加载区域',
        check: 'GET /api/tum-cache/check - 检查缓存状态',
        cleanup: 'DELETE /api/tum-cache/cleanup - 清理过期缓存',
        config: 'GET /api/tum-cache/config - 缓存配置信息'
      },
      localTUM: {
        status: 'GET /api/local-tum/status - 本地数据状态',
        load: 'POST /api/local-tum/load - 加载数据到内存',
        query: 'POST /api/local-tum/query - 查询建筑数据',
        stats: 'GET /api/local-tum/stats - 统计信息',
        info: 'GET /api/local-tum/info - 服务信息'
      },
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
