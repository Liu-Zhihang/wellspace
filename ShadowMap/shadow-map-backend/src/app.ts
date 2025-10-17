import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import path from 'path';
import fs from 'fs';

import demRoutes from './routes/dem';
import healthRoutes from './routes/health';
import buildingRoutes from './routes/buildings';
import dataPreloadRoutes from './routes/dataPreload';
import tileDebugRoutes from './routes/tileDebug';
import buildingOptRoutes from './routes/buildingOptimization';
import coordValidateRoutes from './routes/coordinateValidation';
import buildingWfsRoutes from './routes/buildingWfs';
import localBuildingDatasetRoutes from './routes/localBuildingDataset';
import localBuildingDataRoutes from './routes/localBuildingData';

const app = express();

// Security middleware configuration
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

// Simple permissive CORS configuration
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

// API routes
app.use('/api/health', healthRoutes);
app.use('/api/dem', demRoutes);
app.use('/api/buildings', buildingRoutes);
app.use('/api/preload', dataPreloadRoutes);
app.use('/api/debug', tileDebugRoutes);
app.use('/api/building-opt', buildingOptRoutes);
app.use('/api/coord-validate', coordValidateRoutes);
app.use('/api/wfs-buildings', buildingWfsRoutes);
app.use('/api/local-datasets', localBuildingDatasetRoutes);
app.use('/api/local-buildings', localBuildingDataRoutes);

// Static file service - prefer the built React app, fall back to prototypes
const reactDistPath = path.join(__dirname, '../../shadow-map-frontend/react-shadow-app/dist');
const fallbackPublic = path.join(__dirname, '../../shadow-map-frontend');
const publicRoot = fs.existsSync(reactDistPath) ? reactDistPath : fallbackPublic;

app.use(express.static(publicRoot));
console.log(`[Static] Serving frontend assets from ${publicRoot}`);

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Shadow Map Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      dem: '/api/dem/:z/:x/:y.png',
      buildings: '/api/buildings/:z/:x/:y.json',
      wfsBuildings: {
        test: 'GET /api/wfs-buildings/test - verify GeoServer connectivity',
        bounds: 'POST /api/wfs-buildings/bounds - fetch buildings for a bounding box',
        tile: 'POST /api/wfs-buildings/tile - fetch buildings for a tile',
        sample: 'GET /api/wfs-buildings/sample/beijing - sample dataset check'
      },
      preload: {
        cities: 'POST /api/preload/cities - warm frequently used city tiles',
        location: 'POST /api/preload/location - warm cache for a coordinate radius',
        status: 'GET /api/preload/status - inspect ongoing preload jobs',
        cleanup: 'POST /api/preload/cleanup - clear stale preload entries',
        cityList: 'GET /api/preload/cities - list supported preset cities'
      },
      localDatasets: {
        status: 'GET /api/local-datasets/status - inspect local dataset availability',
        load: 'POST /api/local-datasets/load - load local dataset into memory',
        query: 'POST /api/local-datasets/query - query buildings from local dataset',
        stats: 'GET /api/local-datasets/stats - data statistics',
        info: 'GET /api/local-datasets/info - metadata about the local dataset service'
      },
      docs: '/api/docs'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Application] Unhandled error', err);

  // Prevent duplicate responses once headers are sent
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: process.env['NODE_ENV'] === 'development' ? err.message : 'Something went wrong'
  });
});

export default app;
