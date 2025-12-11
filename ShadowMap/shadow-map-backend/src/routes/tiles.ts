import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';

const router = express.Router();

const mbtilesPath =
  process.env['BUILDING_MBTILES'] ||
  path.join(__dirname, '../../data/hk_buildings.mbtiles');

let db: Database.Database | null = null;
try {
  db = new Database(mbtilesPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`[Tiles] Failed to open mbtiles at ${mbtilesPath}`, err);
}

const stmt =
  db?.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?') ?? null;

router.get('/:z/:x/:y.pbf', (req, res) => {
  if (!db || !stmt) {
    res.status(503).send('Tile service unavailable');
    return;
  }

  const z = Number.parseInt(req.params['z'] ?? '', 10);
  const x = Number.parseInt(req.params['x'] ?? '', 10);
  const y = Number.parseInt(req.params['y'] ?? '', 10);

  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).send('Invalid tile coordinates');
    return;
  }

  // MBTiles 存储为 TMS，需要 Y 轴翻转
  const flippedY = (1 << z) - 1 - y;

  try {
    const row = stmt.get(z, x, flippedY) as { tile_data: Buffer } | undefined;
    if (!row) {
      res.status(404).end();
      return;
    }

    res.set('Content-Type', 'application/x-protobuf');
    res.set('Content-Encoding', 'gzip'); // tippecanoe 默认 gzip
    res.send(row.tile_data);
  } catch (error) {
    console.error('[Tiles] Error serving tile', z, x, y, error);
    res.status(500).send('Tile error');
  }
});

export default router;
