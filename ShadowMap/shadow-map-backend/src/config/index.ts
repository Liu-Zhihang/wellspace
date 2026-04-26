import path from 'path';
import { loadShadowMapEnv } from './loadEnv';

loadShadowMapEnv();

interface Config {
  env: string;
  port: number;
  database: {
    enabled: boolean;
    provider: 'mongodb';
  };
  mongodb: {
    uri: string;
    database: string;
    maxPoolSize: number;
    minPoolSize: number;
  };
  service: {
    backendOrigin: string;
    engineOrigin: string | null;
    geoserverOrigin: string | null;
  };
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

const readEnv = (...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
};

const normalizeOrigin = (value?: string | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
};

const parseOrigins = (value: string | undefined, defaults: string[]): string[] => {
  const entries = (value ? value.split(',') : defaults)
    .map((origin) => origin.trim())
    .filter(Boolean);
  return Array.from(new Set(entries));
};

const port = Number.parseInt(readEnv('PORT', 'SHADOWMAP_BACKEND_PORT') ?? '3001', 10);
const backendOrigin =
  normalizeOrigin(readEnv('SHADOWMAP_BACKEND_ORIGIN', 'SHADOW_ENGINE_BACKEND_URL')) ??
  `http://localhost:${port}`;
const engineOrigin = normalizeOrigin(readEnv('SHADOW_ENGINE_BASE_URL', 'SHADOWMAP_ENGINE_ORIGIN'));
const geoserverOrigin = normalizeOrigin(readEnv('SHADOWMAP_GEOSERVER_ORIGIN', 'GEOSERVER_BASE_URL'));
const dbEnabled = readEnv('SHADOWMAP_ENABLE_DB', 'ENABLE_MONGODB', 'SKIP_DB') === 'true' &&
  readEnv('SKIP_DB') !== 'true';

const config: Config = {
  env: process.env['NODE_ENV'] || 'development',
  port,
  database: {
    enabled: dbEnabled,
    provider: 'mongodb',
  },
  mongodb: {
    uri: readEnv('MONGODB_URI') ?? '',
    database: readEnv('MONGODB_DATABASE', 'MONGODB_DB_NAME') ?? 'shadowmap',
    maxPoolSize: Number.parseInt(readEnv('MONGODB_MAX_POOL_SIZE') ?? '20', 10),
    minPoolSize: Number.parseInt(readEnv('MONGODB_MIN_POOL_SIZE') ?? '2', 10),
  },
  service: {
    backendOrigin,
    engineOrigin,
    geoserverOrigin,
  },
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
    engineBaseUrl: engineOrigin,
    requestTimeoutMs: Number.parseInt(process.env['SHADOW_ENGINE_TIMEOUT_MS'] || '45000', 10),
    cacheTtlMs: Number.parseInt(process.env['SHADOW_ENGINE_CACHE_TTL_MS'] || '120000', 10),
    maxCacheEntries: Number.parseInt(process.env['SHADOW_ENGINE_CACHE_MAX_KEYS'] || '200', 10),
    deploymentMode: (process.env['SHADOW_ENGINE_DEPLOYMENT_MODE'] as 'microservice' | 'worker') || 'microservice',
    localScriptPath: process.env['SHADOW_ENGINE_SCRIPT_PATH'] || null,
    pythonPath: process.env['SHADOW_ENGINE_PYTHON_PATH'] || 'python3',
    timezone: process.env['SHADOW_ENGINE_TIMEZONE'] || 'Asia/Hong_Kong',
    backendBaseUrl:
      normalizeOrigin(readEnv('SHADOW_ENGINE_BACKEND_URL', 'SHADOWMAP_BACKEND_ORIGIN')) ?? backendOrigin,
    maxFeatures: Number.parseInt(process.env['SHADOW_ENGINE_MAX_FEATURES'] || '8000', 10),
    canopyRasterPath: readEnv('SHADOW_ENGINE_CANOPY_RASTER_PATH', 'CANOPY_RASTER_PATH') ?? null,
  },
  cors: {
    origins: parseOrigins(readEnv('CORS_ORIGINS', 'CORS_ORIGIN'), [
      'http://localhost:3000',
      'http://localhost:5173',
      backendOrigin,
    ]),
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
  console.log(`   Backend Origin: ${config.service.backendOrigin}`);
  console.log(`   DEM Path: ${config.data.demPath}`);
  console.log(`   Buildings Path: ${config.data.buildingsPath}`);
  console.log(`   Database: ${config.database.enabled ? `${config.database.provider} enabled` : 'disabled'}`);
  console.log(
    `   Shadow Engine: mode=${config.analysis.deploymentMode}, base=${config.analysis.engineBaseUrl ?? 'local-script'}`,
  );
}
