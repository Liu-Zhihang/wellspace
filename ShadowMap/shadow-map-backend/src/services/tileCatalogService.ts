import fs from 'fs';
import path from 'path';

export interface TileMetadata {
  tileId: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  region?: string;
  description?: string;
  tags?: string[];
}

export interface BoundingBoxLike {
  north: number;
  south: number;
  east: number;
  west: number;
}

type TileMatchStrategy = 'optional' | 'required';

const DEFAULT_TILE_CATALOG_RELATIVE_PATH = './config/buildingTiles.json';

const tileCatalogPathEnv = process.env['BUILDING_WFS_TILE_CATALOG_PATH'];
const resolvedCatalogPath = tileCatalogPathEnv
  ? path.resolve(process.cwd(), tileCatalogPathEnv)
  : path.resolve(process.cwd(), DEFAULT_TILE_CATALOG_RELATIVE_PATH);

const tileStrategy: TileMatchStrategy =
  (process.env['BUILDING_WFS_TILE_STRATEGY'] ?? 'optional').toLowerCase() === 'required'
    ? 'required'
    : 'optional';

let cachedTiles: TileMetadata[] | null = null;
let lastLoadError: Error | null = null;

function deserializeTile(raw: any): TileMetadata | null {
  if (!raw) {
    return null;
  }

  const tileId = String(raw.tileId ?? raw.id ?? '').trim();
  const minLon = Number(raw.minLon ?? raw.west ?? raw.minLng);
  const minLat = Number(raw.minLat ?? raw.south ?? raw.minLat);
  const maxLon = Number(raw.maxLon ?? raw.east ?? raw.maxLng);
  const maxLat = Number(raw.maxLat ?? raw.north ?? raw.maxLat);

  if (
    !tileId ||
    Number.isNaN(minLon) ||
    Number.isNaN(minLat) ||
    Number.isNaN(maxLon) ||
    Number.isNaN(maxLat)
  ) {
    return null;
  }

  return {
    tileId,
    minLon,
    minLat,
    maxLon,
    maxLat,
    region: raw.region ? String(raw.region) : undefined,
    description: raw.description ? String(raw.description) : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag: any) => String(tag)) : undefined
  };
}

function loadTileCatalog(): TileMetadata[] {
  if (cachedTiles) {
    return cachedTiles;
  }

  try {
    if (!fs.existsSync(resolvedCatalogPath)) {
      console.warn(
        `[TileCatalog] Catalog file not found at ${resolvedCatalogPath}. Tile matching is ${
          tileStrategy === 'required' ? 'required' : 'optional'
        }.`
      );
      cachedTiles = [];
      return cachedTiles;
    }

    const raw = fs.readFileSync(resolvedCatalogPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error('Tile catalog must be an array of tile definitions');
    }

    const tiles = parsed
      .map(deserializeTile)
      .filter((tile): tile is TileMetadata => tile !== null);

    cachedTiles = tiles;
    lastLoadError = null;
    console.log(`[TileCatalog] Loaded ${tiles.length} tile definitions from ${resolvedCatalogPath}`);
    return tiles;
  } catch (error) {
    lastLoadError = error instanceof Error ? error : new Error(String(error));
    console.error('[TileCatalog] Failed to load catalog', lastLoadError);
    cachedTiles = [];
    return cachedTiles;
  }
}

export function getTileCatalog(): TileMetadata[] {
  return loadTileCatalog();
}

export function getTileStrategy(): TileMatchStrategy {
  return tileStrategy;
}

export function getTileCatalogPath(): string {
  return resolvedCatalogPath;
}

function intersects(bounds: BoundingBoxLike, tile: TileMetadata): boolean {
  return (
    tile.minLon <= bounds.east &&
    tile.maxLon >= bounds.west &&
    tile.minLat <= bounds.north &&
    tile.maxLat >= bounds.south
  );
}

export interface TileResolutionResult {
  tileIds: string[];
  matchedTiles: TileMetadata[];
}

export function resolveTilesForBounds(bounds: BoundingBoxLike): TileResolutionResult {
  const catalog = loadTileCatalog();
  const matches = catalog.filter(tile => intersects(bounds, tile));

  if (matches.length === 0 && catalog.length > 0) {
    console.warn(
      '[TileCatalog] No tiles matched bounds',
      { bounds }
    );
  }

  const envDefaultTile = process.env['BUILDING_WFS_TILE_ID']?.trim();
  if (matches.length === 0 && envDefaultTile) {
    console.warn(
      `[TileCatalog] Using default tile id ${envDefaultTile} from BUILDING_WFS_TILE_ID`
    );
    return {
      tileIds: [envDefaultTile],
      matchedTiles: catalog.filter(tile => tile.tileId === envDefaultTile)
    };
  }

  return {
    tileIds: matches.map(tile => tile.tileId),
    matchedTiles: matches
  };
}

export function shouldRequireTileMatch(): boolean {
  return tileStrategy === 'required';
}

export function getTileCatalogLoadError(): Error | null {
  return lastLoadError;
}
