import dotenv from 'dotenv';
import path from 'path';

// 加载环境变量
dotenv.config();

// 配置接口定义
interface Config {
  env: string;
  port: number;
  mongodb: {
    uri: string;
    database: string;
    maxPoolSize: number;
    minPoolSize: number;
  };
  redis: {
    host: string;
    port: number;
    password?: string;
    db: number;
  } | null;
  cache: {
    ttl: number; // 缓存过期时间（秒）
    maxSize: number; // 内存缓存最大条目数
  };
  data: {
    demPath: string;
    buildingsPath: string;
    cachePath: string;
  };
  api: {
    overpassUrl: string;
    weatherApiUrl: string | null;
    rateLimit: {
      windowMs: number;
      maxRequests: number;
    };
  };
  cors: {
    origins: string[];
    credentials: boolean;
  };
}

// 默认配置
const defaultConfig: Config = {
  env: process.env['NODE_ENV'] || 'development',
  port: parseInt(process.env['PORT'] || '3001', 10),
  
  mongodb: {
    uri: process.env['MONGODB_URI'] || 'mongodb://localhost:27017',
    database: process.env['MONGODB_DATABASE'] || 'shadowmap',
    maxPoolSize: parseInt(process.env['MONGODB_MAX_POOL_SIZE'] || '10', 10),
    minPoolSize: parseInt(process.env['MONGODB_MIN_POOL_SIZE'] || '2', 10),
  },
  
  redis: process.env['REDIS_HOST'] ? {
    host: process.env['REDIS_HOST'],
    port: parseInt(process.env['REDIS_PORT'] || '6379', 10),
    ...(process.env['REDIS_PASSWORD'] && { password: process.env['REDIS_PASSWORD'] }),
    db: parseInt(process.env['REDIS_DB'] || '0', 10),
  } : null,
  
  cache: {
    ttl: parseInt(process.env['CACHE_TTL'] || '604800', 10), // 7天
    maxSize: parseInt(process.env['CACHE_MAX_SIZE'] || '5000', 10), // 调整为5000
  },
  
  data: {
    demPath: process.env['DEM_DATA_PATH'] || path.join(__dirname, '../../data/dem'),
    buildingsPath: process.env['BUILDINGS_DATA_PATH'] || path.join(__dirname, '../../data/buildings'),
    cachePath: process.env['CACHE_PATH'] || path.join(__dirname, '../../data/cache'),
  },
  
  api: {
    overpassUrl: process.env['OVERPASS_API_URL'] || 'https://overpass-api.de/api/interpreter',
    weatherApiUrl: process.env['WEATHER_API_URL'] || null,
    rateLimit: {
      windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] || '60000', 10), // 1分钟
      maxRequests: parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] || '100', 10),
    },
  },
  
  cors: {
    origins: process.env['CORS_ORIGINS'] ? 
      process.env['CORS_ORIGINS'].split(',').map(origin => origin.trim()) : 
      ['http://localhost:3000', 'http://localhost:5173'],
    credentials: process.env['CORS_CREDENTIALS'] === 'true',
  },
};

// 验证必要的环境变量
function validateConfig(config: Config): void {
  const requiredEnvVars = [
    'MONGODB_URI'
  ];

  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.warn(`⚠️  Missing environment variables: ${missingVars.join(', ')}`);
    console.warn('🔧 Using default values. Please check your .env file.');
  }

  // 验证MongoDB URI格式
  if (!config.mongodb.uri.startsWith('mongodb://') && !config.mongodb.uri.startsWith('mongodb+srv://')) {
    throw new Error('Invalid MongoDB URI format');
  }

  // 验证端口范围
  if (config.port < 1 || config.port > 65535) {
    throw new Error('Invalid port number');
  }
}

// 验证配置
validateConfig(defaultConfig);

// 导出配置
export const config = defaultConfig;

// 导出配置工具函数
export const isDevelopment = () => config.env === 'development';
export const isProduction = () => config.env === 'production';
export const isTest = () => config.env === 'test';

// 打印配置信息（开发环境）
if (isDevelopment()) {
  console.log('🔧 Configuration loaded:');
  console.log(`   Environment: ${config.env}`);
  console.log(`   Port: ${config.port}`);
  console.log(`   MongoDB: ${config.mongodb.uri.replace(/\/\/.*@/, '//***:***@')}`);
  console.log(`   Database: ${config.mongodb.database}`);
  console.log(`   Cache TTL: ${config.cache.ttl}s`);
  console.log(`   DEM Path: ${config.data.demPath}`);
  console.log(`   Buildings Path: ${config.data.buildingsPath}`);
}
