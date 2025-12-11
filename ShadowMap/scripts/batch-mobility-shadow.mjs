#!/usr/bin/env node

/**
 * 批量调用 /api/analysis/shadow 计算 GLAN 轨迹的日照/阴影，并输出带字段的 CSV。
 *
 * 默认假设目录结构：
 *   输入：../GLAN/PHASE1/spatial_temporal_merge （与 ShadowMap 同级，可用 --input 覆盖）
 *   输出：../GLAN_processed
 * 可通过 CLI 参数覆盖。
 *
 * 参数：
 *   --input       输入根目录（递归处理 .csv）           默认 ../GLAN/spatial_temporal_merge
 *   --output      输出根目录（镜像子路径，文件加 -sunlight.csv） 默认 ../GLAN_processed
 *   --backend     后端 shadow API 地址                   默认 http://localhost:3001/api/analysis/shadow
 *   --canopy      canopy 栅格路径                       默认 /media/liuzhihang/repo/projects/wellspace/Tree/HKtree_small.tif
 *   --concurrency 并发桶数                             默认 4
 *   --force       是否覆盖已存在的输出文件             默认 false（存在则跳过）
 */

import fs from 'fs/promises';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = true;
    }
  }
  return result;
};

const args = parseArgs();
// 默认路径使用英文 repo，避免中文目录被 URL 编码
const DEFAULT_INPUT_ROOT = '/media/liuzhihang/repo/projects/wellspace/GLAN/PHASE1/spatial_temporal_merge';
const DEFAULT_OUTPUT_ROOT = '/media/liuzhihang/repo/projects/wellspace/GLAN_processed';
const DEFAULT_CANOPY = '/media/liuzhihang/repo/projects/wellspace/Tree/HKtree_small.tif';

const config = {
  inputRoot: path.resolve(args['input'] ?? process.env.INPUT_ROOT ?? DEFAULT_INPUT_ROOT),
  outputRoot: path.resolve(args['output'] ?? process.env.OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT),
  backendUrl: (args['backend'] ?? process.env.BACKEND_URL ?? 'http://localhost:3001/api/analysis/shadow').replace(/\/$/, ''),
  weatherUrl: (args['weather'] ?? process.env.WEATHER_URL ?? 'http://localhost:3001/api/weather/current').replace(/\/$/, ''),
  canopyRasterPath: args['canopy'] ?? process.env.CANOPY_RASTER_PATH ?? DEFAULT_CANOPY,
  concurrency: Number.parseInt(args['concurrency'] ?? process.env.CONC ?? '4', 10),
  force: args['force'] === 'true' || args['force'] === true,
  bucketsFile: args['buckets-file'] ?? args['bucketsFile'],
  targetFile: args['target-file'] ?? args['targetFile'],
};

const headersToAppend = [
  'sunlit',
  'shadowPercent',
  'bucketStart',
  'bucketEnd',
  'source',
  'errorDetail',
  'cloudCover',
  'sunlightFactor',
  'sunlitEffective',
  'shadowPercentEffective',
  'solarIrradianceWm2',
  'irradianceEffective',
  'durationSeconds',
  'sunlightSeconds',
  'shadowSeconds',
  'irradianceJ',
];

const ensureDir = async (dir) => fs.mkdir(dir, { recursive: true });

const listCsvFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listCsvFiles(full);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
      files.push(full);
    }
  }
  return files;
};

const parseCsv = (content) => {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    rows.push(row);
  }
  return { headers, rows };
};

const floorToMinuteIso = (epochSeconds) => {
  const date = new Date(Math.floor(Number(epochSeconds) * 1000));
  if (Number.isNaN(date.getTime())) return null;
  date.setSeconds(0, 0);
  return date.toISOString();
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const readBucketsFromFile = async (filePath) => {
  if (!filePath) return null;
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    const set = new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
    return set;
  } catch (err) {
    console.warn(`[Buckets] failed to read ${filePath}: ${err.message}`);
    return null;
  }
};

const loadExistingOutput = async (outFile) => {
  try {
    const content = await fs.readFile(outFile, 'utf-8');
    const { headers, rows } = parseCsv(content);
    return { headers, rows };
  } catch (err) {
    return null;
  }
};

const pointInRing = (point, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const pointInPolygon = (point, geometry) => {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    const [outerRing, ...holes] = geometry.coordinates || [];
    if (!outerRing) return false;
    if (!pointInRing(point, outerRing)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  }
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates || []).some((polygon) => {
      const [outerRing, ...holes] = polygon;
      if (!outerRing) return false;
      if (!pointInRing(point, outerRing)) return false;
      return !holes.some((hole) => pointInRing(point, hole));
    });
  }
  return false;
};

const flattenPolygons = (layer) => {
  if (!layer || layer.type !== 'FeatureCollection' || !Array.isArray(layer.features)) return [];
  return layer.features
    .map((feature) => feature?.geometry)
    .filter((geom) => geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon'));
};

const buildBuckets = (rows) => {
  const buckets = new Map();
  rows.forEach((row, index) => {
    const ts = row['timestamp'];
    const lon = row['fnl_lon'] || row['gps_lon'] || row['gpx_lon'] || row['air_lon'];
    const lat = row['fnl_lat'] || row['gps_lat'] || row['gpx_lat'] || row['air_lat'];
    if (!lon || !lat) {
      row.__error = 'missing_coords';
      return;
    }
    const lonNum = Number(lon);
    const latNum = Number(lat);
    if (!Number.isFinite(lonNum) || !Number.isFinite(latNum)) {
      row.__error = 'invalid_coords';
      return;
    }
    const bucketStart = floorToMinuteIso(ts);
    if (!bucketStart) {
      row.__error = 'invalid_timestamp';
      return;
    }
    const bucket = buckets.get(bucketStart) ?? [];
    bucket.push({ index, lon: lonNum, lat: latNum });
    buckets.set(bucketStart, bucket);
  });
  return buckets;
};

const ensureNonZeroBounds = (bounds) => {
  const epsilon = 1e-5;
  let { west, east, south, north } = bounds;
  if (east - west <= 0) {
    west -= epsilon;
    east += epsilon;
  }
  if (north - south <= 0) {
    south -= epsilon;
    north += epsilon;
  }
  return { west, east, south, north };
};

const buildRequestPayload = (bucketKey, bucketRows, allRows) => {
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  bucketRows.forEach(({ lon, lat }) => {
    north = Math.max(north, lat);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    west = Math.min(west, lon);
  });
  const bounds = ensureNonZeroBounds({ west, east, south, north });
  return {
    bucketKey,
    bbox: bounds,
    timestamp: bucketKey,
    rows: bucketRows,
  };
};

const fetchShadow = async (payload) => {
  const body = {
    bbox: payload.bbox,
    timestamp: payload.timestamp,
    timeGranularityMinutes: 1,
    outputs: { shadowPolygons: true, sunlightGrid: true, heatmap: false },
    metadata: {
      includeCanopy: true,
      canopyRasterPath: config.canopyRasterPath,
    },
  };

  const res = await fetch(config.backendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json();
  return data;
};

const fetchWeather = async (lat, lon, timestampIso) => {
  const url = `${config.weatherUrl}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lon)}&timestamp=${encodeURIComponent(timestampIso)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Weather HTTP ${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json();
  return data;
};

const weatherCache = new Map();
const getWeatherCached = async (lat, lon, timestampIso) => {
  const t = new Date(timestampIso);
  const hour = new Date(t);
  hour.setMinutes(0, 0, 0);
  const key = `${hour.toISOString()}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  if (weatherCache.has(key)) {
    return weatherCache.get(key);
  }
  const data = await fetchWeather(lat, lon, timestampIso);
  weatherCache.set(key, data);
  return data;
};

const processBucket = async (payload, rows, fileLabel) => {
  let cloudCover = null;
  let sunlightFactor = null;
  let solarIrradianceWm2 = null;
  // 取桶中心点
  const centerLat = (payload.bbox.north + payload.bbox.south) / 2;
  const centerLng = (payload.bbox.east + payload.bbox.west) / 2;
  try {
    const weather = await getWeatherCached(centerLat, centerLng, payload.timestamp);
    cloudCover = weather?.weather?.cloud_cover ?? null;
    const cf = typeof cloudCover === 'number' ? Math.max(0, Math.min(1, cloudCover)) : null;
    sunlightFactor = cf == null ? null : Math.max(0.15, 1 - cf * 0.85);
    solarIrradianceWm2 = weather?.metadata?.solarIrradianceWm2 ?? weather?.weather?.solarIrradianceWm2 ?? null;
  } catch (error) {
    console.warn(
      `[Weather error][${fileLabel}][${payload.bucketKey}] ${error instanceof Error ? error.message : error}`,
    );
    // 保留标记，让后续输出知道天气失败
    cloudCover = cloudCover ?? '';
    sunlightFactor = sunlightFactor ?? '';
    solarIrradianceWm2 = solarIrradianceWm2 ?? '';
  }

  try {
    const response = await fetchShadow(payload);
    const polygons = flattenPolygons(response?.data?.shadows);
    const fallbackShadowPercent = clamp(response?.metrics?.avgShadowPercent ?? 0, 0, 100);
    const bucketEnd = response?.bucketEnd ?? response?.bucketStart ?? payload.bucketKey;

    payload.rows.forEach(({ index, lon, lat }) => {
      const point = [lon, lat];
      const inShadow = polygons.some((polygon) => pointInPolygon(point, polygon));
      const shadowPercent = polygons.length ? (inShadow ? 100 : 0) : fallbackShadowPercent;
      const sunlit = inShadow ? 0 : 1;
      const sunlitEffective = sunlightFactor == null ? sunlit : sunlit * sunlightFactor;
      const shadowPercentEffective = 100 - sunlitEffective * 100;
      const irradianceEffective =
        solarIrradianceWm2 != null ? (sunlit === 0 ? 0 : solarIrradianceWm2) : null;
      rows[index]['sunlit'] = sunlit;
      rows[index]['shadowPercent'] = shadowPercent;
      rows[index]['bucketStart'] = response?.bucketStart ?? payload.bucketKey;
      rows[index]['bucketEnd'] = bucketEnd;
      rows[index]['source'] = 'engine';
      rows[index]['cloudCover'] = cloudCover ?? '';
      rows[index]['sunlightFactor'] = sunlightFactor ?? '';
      rows[index]['sunlitEffective'] = sunlitEffective;
      rows[index]['shadowPercentEffective'] = shadowPercentEffective;
      rows[index]['solarIrradianceWm2'] = solarIrradianceWm2 ?? '';
      rows[index]['irradianceEffective'] = irradianceEffective ?? '';
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // 可忽略的预期错误：夜间 / 无建筑（可能返回 400/500/502）
    const isNight = errMsg.includes('Given time before sunrise or after sunset') || errMsg.toLowerCase().includes('outside daylight');
    const noBldg = errMsg.includes('No building features returned');
    const isExpectedError = errMsg.includes('HTTP 500') || errMsg.includes('HTTP 400') || errMsg.includes('HTTP 502') || isNight || noBldg;
    if (!isExpectedError) {
      console.warn(`[Bucket error][${fileLabel}][${payload.bucketKey}] ${errMsg}`);
    }
    const statusMatch = errMsg.match(/HTTP\\s+(\\d{3})/i);
    const sourceLabel = statusMatch ? `fallback_error:${statusMatch[1]}` : 'fallback_error';
    const detail = errMsg.slice(0, 200);
    payload.rows.forEach(({ index }) => {
      rows[index]['sunlit'] = 0;
      rows[index]['shadowPercent'] = 0;
      rows[index]['bucketStart'] = payload.bucketKey;
      rows[index]['bucketEnd'] = payload.bucketKey;
      rows[index]['source'] = sourceLabel;
      rows[index]['errorDetail'] = detail;
      rows[index]['cloudCover'] = cloudCover ?? '';
      rows[index]['sunlightFactor'] = sunlightFactor ?? '';
      rows[index]['sunlitEffective'] = '';
      rows[index]['shadowPercentEffective'] = '';
      rows[index]['solarIrradianceWm2'] = solarIrradianceWm2 ?? '';
      rows[index]['irradianceEffective'] = '';
    });
  }
};

const runWithConcurrency = async (tasks, limit) => {
  const queue = [];
  for (const task of tasks) {
    const p = task().finally(() => {
      const idx = queue.indexOf(p);
      if (idx >= 0) queue.splice(idx, 1);
    });
    queue.push(p);
    if (queue.length >= limit) {
      await Promise.race(queue);
    }
  }
  await Promise.all(queue);
};

const processFile = async (filePath, idx, total) => {
  const relative = path.relative(config.inputRoot, filePath);
  const outDir = path.join(config.outputRoot, path.dirname(relative));
  const base = path.basename(filePath, path.extname(filePath));
  const outFile = path.join(outDir, `${base}-sunlight.csv`);
  const startedAt = Date.now();

  // 如果指定 bucketsFile，则即便已有输出也会尝试增量覆盖
  const filterBuckets = config.bucketsFile ? await readBucketsFromFile(config.bucketsFile) : null;
  if (!config.force && !filterBuckets) {
    try {
      await fs.access(outFile);
      console.log(`[Skip existing][${idx + 1}/${total}] ${relative}`);
      return;
    } catch {
      // no existing file, continue
    }
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const { headers, rows } = parseCsv(content);
  if (!rows.length) {
    console.warn(`[Skip][${idx + 1}/${total}] ${relative} empty file`);
    return;
  }

  // 如果已有输出且需要增量重跑，预填充旧值
  const existing = filterBuckets ? await loadExistingOutput(outFile) : null;
  if (existing && existing.rows.length === rows.length) {
    const existingHeaders = existing.headers;
    existing.rows.forEach((oldRow, i) => {
      const target = rows[i];
      existingHeaders.forEach((h, idx) => {
        target[h] = oldRow[h] ?? oldRow[existingHeaders[idx]];
      });
    });
    console.log(`[Seed existing][${idx + 1}/${total}] ${relative}`);
  }

  // 初始化输出字段（不覆盖已存在的值）
  rows.forEach((row) => {
    headersToAppend.forEach((key) => {
      if (row[key] === undefined) row[key] = '';
    });
  });

  const buckets = buildBuckets(rows);
  const tasks = [];
  for (const [bucketKey, bucketRows] of buckets.entries()) {
    if (!bucketRows.length) continue;
    if (filterBuckets && !filterBuckets.has(bucketKey)) {
      continue;
    }
    const payload = buildRequestPayload(bucketKey, bucketRows, rows);
    tasks.push(() => processBucket(payload, rows, relative));
  }

  // 对缺失数据的行填充标记
  rows.forEach((row) => {
    if (row['sunlit'] !== '' && row['sunlit'] !== undefined) return;
    if (row.__error) {
      row['sunlit'] = 0;
      row['shadowPercent'] = 0;
      row['bucketStart'] = '';
      row['bucketEnd'] = '';
      row['source'] = row.__error;
      row['cloudCover'] = '';
      row['sunlightFactor'] = '';
      row['sunlitEffective'] = '';
      row['shadowPercentEffective'] = '';
      row['solarIrradianceWm2'] = '';
      row['irradianceEffective'] = '';
    }
  });

  console.log(`[Process][${idx + 1}/${total}] ${relative} buckets=${tasks.length}`);
  await runWithConcurrency(tasks, Math.max(1, config.concurrency));

  await ensureDir(outDir);
  const finalHeaders = [...headers, ...headersToAppend];
  // 计算 durationSeconds 等（按时间升序）
  const tsField = headers.includes('timestamp') ? 'timestamp' : headers.includes('time') ? 'time' : null;
  let sortedIndices = rows.map((_, idx) => idx);
  if (tsField) {
    sortedIndices = rows
      .map((row, idx) => {
        const ts = Number(row[tsField]);
        const date = Number.isFinite(ts) ? ts * 1000 : Date.parse(row[tsField]);
        return { idx, ms: date };
      })
      .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))
      .map((item) => item.idx);
  }

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  for (let i = 0; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    const nextIdx = sortedIndices[i + 1];
    const current = rows[idx];
    let durationSeconds = 60;
    if (tsField && nextIdx !== undefined) {
      const curMs = Number(rows[idx][tsField]) * 1000 || Date.parse(rows[idx][tsField]);
      const nxtMs = Number(rows[nextIdx][tsField]) * 1000 || Date.parse(rows[nextIdx][tsField]);
      const diff = (nxtMs - curMs) / 1000;
      if (Number.isFinite(diff) && diff > 0) {
        durationSeconds = clamp(diff, 1, 300);
      }
    }
    const sunlitEffective = Number(current['sunlitEffective']) || 0;
    const shadowPercentEffective = Number(current['shadowPercentEffective']) || 0;
    const irradianceEffective = Number(current['irradianceEffective']);
    current['durationSeconds'] = durationSeconds;
    current['sunlightSeconds'] = sunlitEffective * durationSeconds;
    current['shadowSeconds'] = (shadowPercentEffective / 100) * durationSeconds;
    current['irradianceJ'] =
      Number.isFinite(irradianceEffective) ? Math.max(0, irradianceEffective) * durationSeconds : '';
  }

  const lines = [finalHeaders.join(',')];
  rows.forEach((row) => {
    const line = finalHeaders.map((h) => row[h] ?? '').join(',');
    lines.push(line);
  });
  await fs.writeFile(outFile, lines.join('\n'), 'utf-8');
  console.log(
    `[Done][${idx + 1}/${total}] ${relative} -> ${path.relative(config.outputRoot, outFile)} (${Math.round(
      (Date.now() - startedAt) / 1000,
    )}s) buckets=${tasks.length}${filterBuckets ? ' (filtered)' : ''}`,
  );
};

const main = async () => {
  console.log('Batch mobility shadow');
  console.log(JSON.stringify(config, null, 2));

  let files = await listCsvFiles(config.inputRoot);
  if (config.targetFile) {
    files = files.filter((f) => path.basename(f) === config.targetFile);
    if (!files.length) {
      console.warn(`[Warning] Target file "${config.targetFile}" not found under ${config.inputRoot}`);
    }
  }
  if (!files.length) {
    console.error(`No CSV files found under ${config.inputRoot}`);
    process.exit(1);
  }

  const total = files.length;
  for (let i = 0; i < total; i++) {
    const file = files[i];
    await processFile(file, i, total);
  }

  console.log('All files completed.');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
