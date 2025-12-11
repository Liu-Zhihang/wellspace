import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

interface Config {
  env: string;
  port: number;
  data: {
    demPath: string;
    buildingsPath: string;
  };
  api: {
    weatherBaseUrl: string | null;
  };
  analysis: {
    engineBaseUrl: string | null;
    requestTimeoutMs: number;
    cacheTtlMs: number;
    maxCacheEntries: number;
    deploymentMode: 'microservice' | 'worker';
    localScriptPath: string | null;
    pythonPath: string;
    timezone: string;
    backendBaseUrl: string;
    maxFeatures: number;
    canopyRasterPath: string | null;
  };
  cors: {
    origins: string[];
    credentials: boolean;
  };
}

const config: Config = {
  env: process.env['NODE_ENV'] || 'development',
  port: Number.parseInt(process.env['PORT'] || '3500', 10),
  data: {
    demPath: process.env['DEM_DATA_PATH'] || path.join(__dirname, '../../data/dem'),
    // 优先使用 BUILDING_LOCAL_GEOJSON，其次 BUILDINGS_DATA_PATH，最后默认路径
    buildingsPath:
      process.env['BUILDING_LOCAL_GEOJSON'] ||
      process.env['BUILDINGS_DATA_PATH'] ||
      path.join(__dirname, '../../data/local-buildings'),
  },
  api: {
    weatherBaseUrl: process.env['WEATHER_API_URL'] || null,
  },
  analysis: {
    // 优先 ENV，缺省为 null（worker 模式时不走 external）
    engineBaseUrl: process.env['SHADOW_ENGINE_BASE_URL'] || null,
    requestTimeoutMs: Number.parseInt(process.env['SHADOW_ENGINE_TIMEOUT_MS'] || '45000', 10),
    cacheTtlMs: Number.parseInt(process.env['SHADOW_ENGINE_CACHE_TTL_MS'] || '120000', 10),
    maxCacheEntries: Number.parseInt(process.env['SHADOW_ENGINE_CACHE_MAX_KEYS'] || '200', 10),
    deploymentMode: (process.env['SHADOW_ENGINE_DEPLOYMENT_MODE'] as 'microservice' | 'worker') || 'microservice',
    localScriptPath: process.env['SHADOW_ENGINE_SCRIPT_PATH'] || null,
    pythonPath: process.env['SHADOW_ENGINE_PYTHON_PATH'] || 'python3',
    timezone: process.env['SHADOW_ENGINE_TIMEZONE'] || 'Asia/Hong_Kong',
    backendBaseUrl: process.env['SHADOW_ENGINE_BACKEND_URL'] || 'http://localhost:3500',
    maxFeatures: Number.parseInt(process.env['SHADOW_ENGINE_MAX_FEATURES'] || '8000', 10),
    canopyRasterPath: process.env['SHADOW_ENGINE_CANOPY_RASTER_PATH'] || null,
  },
  cors: {
    origins: process.env['CORS_ORIGINS']
      ? process.env['CORS_ORIGINS'].split(',').map((origin) => origin.trim())
      : ['http://localhost:3000', 'http://localhost:5173'],
    credentials: process.env['CORS_CREDENTIALS'] === 'true',
  },
};

export { config };

export const isDevelopment = () => config.env === 'development';
export const isProduction = () => config.env === 'production';

if (isDevelopment()) {
  console.log('🔧 Configuration loaded:');
  console.log(`   Environment: ${config.env}`);
  console.log(`   Port: ${config.port}`);
  console.log(`   DEM Path: ${config.data.demPath}`);
  console.log(`   Buildings Path: ${config.data.buildingsPath}`);
  console.log(
    `   Shadow Engine: mode=${config.analysis.deploymentMode}, base=${config.analysis.engineBaseUrl ?? 'local-script'}`,
  );
}
