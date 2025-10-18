import fs from 'fs/promises';
import path from 'path';

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LocalBuildingFeature {
  type: 'Feature';
  geometry: PolygonGeometry | null;
  properties?: Record<string, unknown>;
}

export interface LocalBuildingResponse {
  type: 'FeatureCollection';
  features: LocalBuildingFeature[];
  totalFeatures: number;
  numberMatched: number;
  numberReturned: number;
}

type PolygonGeometry = Polygon | MultiPolygon;

interface Polygon {
  type: 'Polygon';
  coordinates: number[][][];
  bbox?: [number, number, number, number];
}

interface MultiPolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
  bbox?: [number, number, number, number];
}

interface DatasetSource {
  id: string;
  label: string;
  lod1File: string;
  heightDirectory?: string;
  bounds: BoundingBox;
  priority: number;
}

interface DatasetStatus {
  name: string;
  label: string;
  available: boolean;
  lod1Exists: boolean;
  heightExists: boolean;
  fileSize: number;
  priority: number;
}

interface LoadedDataset {
  source: DatasetSource;
  collection: {
    type: 'FeatureCollection';
    features: LocalBuildingFeature[];
  };
  loadedAt: number;
}

const DEFAULT_DATA_DIR = path.join(__dirname, '../../data/local-buildings');
const LEGACY_DATA_DIR = path.join(__dirname, '../../data/tum-buildings');

const LOCAL_DATA_CONFIG = {
  dataDir: resolveDataDir(),
  lod1MetaFile: 'metadata/lod1.geojson',
  heightMetaFile: 'metadata/height_zip.geojson',
  sources: <DatasetSource[]>[
    {
      id: 'munich-demo',
      label: 'Europe / Munich sample',
      lod1File: 'sample/examples/LoD1/europe/e010_n50_e015_n45.geojson',
      heightDirectory: 'sample/examples/Height/europe/e010_n50_e015_n45',
      bounds: { west: 10, south: 45, east: 15, north: 50 },
      priority: 1
    },
    {
      id: 'hong-kong',
      label: 'Asia / Hong Kong',
      lod1File: 'hongkong/LoD1/e110_n25_e115_n20.geojson',
      heightDirectory: 'hongkong/Height/e110_n25_e115_n20',
      bounds: { west: 113.8, south: 21.8, east: 114.6, north: 22.7 },
      priority: 2
    }
  ],
  maxFeaturesPerQuery: 10_000,
  cacheEnabled: true
};

const loadedDatasets: Map<string, LoadedDataset> = new Map();
let lastLoadTimestamp = 0;

export async function checkLocalDatasetStatus(): Promise<{
  available: boolean;
  datasets: DatasetStatus[];
  metadata: { lod1Meta: boolean; heightMeta: boolean };
}> {
  const dataDir = LOCAL_DATA_CONFIG.dataDir;

  const [lod1MetaExists, heightMetaExists] = await Promise.all([
    fileExists(path.join(dataDir, LOCAL_DATA_CONFIG.lod1MetaFile)),
    fileExists(path.join(dataDir, LOCAL_DATA_CONFIG.heightMetaFile))
  ]);

  const datasetStatuses = await Promise.all(
    LOCAL_DATA_CONFIG.sources.map(async (source) => {
      const lod1Path = path.join(dataDir, source.lod1File);
      const heightPath = source.heightDirectory ? path.join(dataDir, source.heightDirectory) : null;

      const [lod1Exists, heightExists] = await Promise.all([
        fileExists(lod1Path),
        heightPath ? directoryExists(heightPath) : Promise.resolve(false)
      ]);

      const fileSize = lod1Exists ? await getFileSize(lod1Path) : 0;

      return {
        name: source.id,
        label: source.label,
        available: lod1Exists || heightExists,
        lod1Exists,
        heightExists,
        fileSize,
        priority: source.priority
      } satisfies DatasetStatus;
    })
  );

  const available = datasetStatuses.some((status) => status.available) || lod1MetaExists;

  datasetStatuses.sort((a, b) => a.priority - b.priority);

  return {
    available,
    datasets: datasetStatuses,
    metadata: {
      lod1Meta: lod1MetaExists,
      heightMeta: heightMetaExists
    }
  };
}

export async function loadLocalDatasets(): Promise<{
  loadedDatasets: number;
  loadedFeatures: number;
  loadTime: number;
}> {
  const start = Date.now();
  const dataDir = LOCAL_DATA_CONFIG.dataDir;
  let loadedCount = 0;
  let featureCount = 0;

  for (const source of LOCAL_DATA_CONFIG.sources.sort((a, b) => a.priority - b.priority)) {
    const lod1Path = path.join(dataDir, source.lod1File);
    if (!(await fileExists(lod1Path))) {
      continue;
    }

    const cacheKey = source.id;
    if (loadedDatasets.has(cacheKey) && LOCAL_DATA_CONFIG.cacheEnabled) {
      loadedCount += 1;
      featureCount += loadedDatasets.get(cacheKey)!.collection.features.length;
      continue;
    }

    try {
      const raw = await fs.readFile(lod1Path, 'utf-8');
      const parsed = JSON.parse(raw);

      if (!parsed || parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
        console.warn(`[LocalDataset] Skipping ${cacheKey}: not a valid GeoJSON FeatureCollection`);
        continue;
      }

      const collection: LoadedDataset['collection'] = {
        type: 'FeatureCollection',
        features: parsed.features as LocalBuildingFeature[]
      };

      loadedDatasets.set(cacheKey, {
        source,
        collection,
        loadedAt: Date.now()
      });

      loadedCount += 1;
      featureCount += collection.features.length;

      console.log(`[LocalDataset] Loaded ${collection.features.length} buildings for ${source.label}`);
    } catch (error) {
      console.error(`[LocalDataset] Failed to load dataset ${cacheKey}`, error);
    }
  }

  lastLoadTimestamp = Date.now();

  return {
    loadedDatasets: loadedCount,
    loadedFeatures: featureCount,
    loadTime: lastLoadTimestamp - start
  };
}

export async function queryLocalDatasets(
  bounds: BoundingBox,
  maxFeatures = 1000
): Promise<LocalBuildingResponse> {
  const cappedMax = Math.max(1, Math.min(maxFeatures, LOCAL_DATA_CONFIG.maxFeaturesPerQuery));

  if (loadedDatasets.size === 0) {
    await loadLocalDatasets();
  }

  const features: LocalBuildingFeature[] = [];

  for (const { source, collection } of loadedDatasets.values()) {
    const matches = collection.features.filter((feature) => geometryIntersectsBounds(feature.geometry, bounds));

    for (const feature of matches) {
      const cloned: LocalBuildingFeature = {
        ...feature,
        properties: {
          ...(feature.properties ?? {}),
          source: feature.properties?.source ?? `local-${source.id}`
        }
      };

      features.push(cloned);

      if (features.length >= cappedMax) {
        break;
      }
    }

    if (features.length >= cappedMax) {
      break;
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    totalFeatures: features.length,
    numberMatched: features.length,
    numberReturned: features.length
  };
}

export async function getLocalDatasetStats(): Promise<{
  datasetsLoaded: number;
  featuresLoaded: number;
  memoryUsage: { total: number; perDataset: Record<string, number> };
  lastLoadAt: number;
}> {
  if (loadedDatasets.size === 0) {
    await loadLocalDatasets();
  }

  const perDataset: Record<string, number> = {};
  let totalBytes = 0;
  let featureCount = 0;

  for (const [key, dataset] of loadedDatasets.entries()) {
    const json = JSON.stringify(dataset.collection);
    const bytes = Buffer.from(json).byteLength;
    perDataset[key] = bytes;
    totalBytes += bytes;
    featureCount += dataset.collection.features.length;
  }

  return {
    datasetsLoaded: loadedDatasets.size,
    featuresLoaded: featureCount,
    memoryUsage: {
      total: totalBytes,
      perDataset
    },
    lastLoadAt: lastLoadTimestamp
  };
}

export function clearLocalDatasetCache(): void {
  loadedDatasets.clear();
  lastLoadTimestamp = 0;
  console.log('[LocalDataset] Cleared in-memory cache');
}

export default {
  checkLocalDatasetStatus,
  loadLocalDatasets,
  queryLocalDatasets,
  getLocalDatasetStats,
  clearLocalDatasetCache
};

function resolveDataDir(): string {
  if (process.env['LOCAL_BUILDING_DATA_DIR']) {
    return process.env['LOCAL_BUILDING_DATA_DIR'];
  }

  return preferExistingDirectory(DEFAULT_DATA_DIR, LEGACY_DATA_DIR);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

function preferExistingDirectory(primary: string, fallback: string): string {
  return directoryExistsSync(primary) ? primary : directoryExistsSync(fallback) ? fallback : primary;
}

function directoryExistsSync(dirPath: string): boolean {
  try {
    const stat = require('fs').statSync(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function geometryIntersectsBounds(geometry: PolygonGeometry | null, bounds: BoundingBox): boolean {
  if (!geometry) {
    return false;
  }

  if (geometry.bbox) {
    return !(
      geometry.bbox[2] < bounds.west ||
      geometry.bbox[0] > bounds.east ||
      geometry.bbox[3] < bounds.south ||
      geometry.bbox[1] > bounds.north
    );
  }

  if (geometry.type === 'Polygon') {
    return polygonIntersects(bounds, geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => polygonIntersects(bounds, poly));
  }

  return false;
}

function polygonIntersects(bounds: BoundingBox, rings: number[][][]): boolean {
  return rings.some((ring) =>
    ring.some(([lng, lat]) => lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north)
  );
}
