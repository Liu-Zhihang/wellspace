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
    buildingsPath: process.env['BUILDINGS_DATA_PATH'] || path.join(__dirname, '../../data/local-buildings'),
  },
  api: {
    weatherBaseUrl: process.env['WEATHER_API_URL'] || null,
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
}
