#!/usr/bin/env node
/**
 * 居住地阳光暴露（IRBM）批量计算脚本
 *
 * - 输入：CSV，包含 id, lat, lon（列名不区分大小写；lat/lon 也接受 home_lat/home_lon）
 * - 过程：逐天逐小时采样（默认 06:00-22:00，步长 1 小时），按缓冲区生成 bbox 调用 /api/analysis/shadow；
 *         并行调用 /api/weather/current 取得云量/辐照度，计算时长和能量暴露。
 * - 输出：日层 CSV（可指定路径），字段命名与文档一致。
 *
 * 运行示例：
 * node scripts/residence-irbm.mjs \
 *   --input homes.csv \
 *   --output irbm_daily.csv \
 *   --start 2021-11-18 --end 2021-11-20 \
 *   --buffers 200,100,500 \
 *   --backend http://localhost:3001/api/analysis/shadow \
 *   --weather http://localhost:3001/api/weather/current \
 *   --canopy /home/jinlin/data/HKtree_small_cog.tif
 */

import fs from 'fs/promises';
import path from 'path';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    const nxt = args[i + 1];
    if (k.startsWith('--')) {
      const key = k.replace(/^--/, '');
      if (nxt && !nxt.startsWith('--')) {
        out[key] = nxt;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
};

const args = parseArgs();

const config = {
  input: args.input,
  output: args.output ?? 'irbm_daily.csv',
  start: args.start,
  end: args.end,
  buffers: (args.buffers ? args.buffers.split(',') : ['200', '100', '500', '1000']).map((v) => Number(v.trim())).filter(Number.isFinite),
  backendUrl: (args.backend ?? 'http://localhost:3001/api/analysis/shadow').replace(/\/$/, ''),
  weatherUrl: (args.weather ?? 'http://localhost:3001/api/weather/current').replace(/\/$/, ''),
  canopy: args.canopy ?? '/home/jinlin/data/HKtree_small_cog.tif',
};

if (!config.input || !config.start || !config.end) {
  console.error('缺少参数：--input homes.csv --start YYYY-MM-DD --end YYYY-MM-DD');
  process.exit(1);
}

const HOURS = Array.from({ length: 16 }, (_, i) => 6 + i); // 06-21
const PERIODS = [
  { name: 'morning', hours: [6, 7, 8, 9] },
  { name: 'midday', hours: [10, 11, 12, 13] },
  { name: 'afternoon', hours: [14, 15, 16, 17] },
  { name: 'evening', hours: [18, 19, 20, 21] },
];

const parseCsv = (text) => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cols[idx] ?? '';
    });
    return row;
  });
  return { headers, rows };
};

const readHomes = async (filePath) => {
  const content = await fs.readFile(filePath, 'utf-8');
  const { headers, rows } = parseCsv(content);
  const idxId = headers.findIndex((h) => h.toLowerCase() === 'id');
  const idxLat = headers.findIndex((h) => ['lat', 'latitude', 'home_lat'].includes(h.toLowerCase()));
  const idxLon = headers.findIndex((h) => ['lon', 'lng', 'longitude', 'home_lon'].includes(h.toLowerCase()));
  if (idxLat === -1 || idxLon === -1) {
    throw new Error('输入 CSV 需包含 lat/lon (或 home_lat/home_lon) 列');
  }
  return rows
    .map((r) => {
      const id = idxId >= 0 ? Object.values(r)[idxId] : '';
      const lat = Number(Object.values(r)[idxLat]);
      const lon = Number(Object.values(r)[idxLon]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { id, lat, lon };
    })
    .filter(Boolean);
};

const toIso = (date, hour) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0));
  return d.toISOString();
};

const listDates = (start, end) => {
  const out = [];
  let d = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  while (d <= endDate) {
    out.push(new Date(d));
    d = new Date(d.getTime() + 24 * 3600 * 1000);
  }
  return out;
};

const metersToDeg = (meters, latDeg) => {
  const latRad = (latDeg * Math.PI) / 180;
  const degLat = meters / 111000;
  const degLon = meters / (111000 * Math.cos(latRad));
  return { degLat, degLon };
};

const buildBbox = (lat, lon, radiusMeters) => {
  const { degLat, degLon } = metersToDeg(radiusMeters, lat);
  return {
    west: lon - degLon,
    east: lon + degLon,
    south: lat - degLat,
    north: lat + degLat,
  };
};

const fetchJson = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
};

const fetchShadow = async (bbox, timestampIso) => {
  const body = {
    bbox,
    timestamp: timestampIso,
    timeGranularityMinutes: 1,
    outputs: { shadowPolygons: false, sunlightGrid: true, heatmap: false },
  };
  const res = await fetchJson(config.backendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const avg = res?.metrics?.avgShadowPercent;
  return Number.isFinite(avg) ? avg : null;
};

const fetchWeather = async (lat, lon, timestampIso) => {
  const url = `${config.weatherUrl}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lon)}&timestamp=${encodeURIComponent(timestampIso)}`;
  const data = await fetchJson(url, { headers: { Accept: 'application/json' } });
  const sf = data?.metadata?.sunlightFactor ?? data?.weather?.sunlightFactor;
  const irr = data?.metadata?.solarIrradianceWm2 ?? data?.weather?.solarIrradianceWm2;
  return {
    sunlightFactor: Number.isFinite(sf) ? sf : 1,
    solarIrradianceWm2: Number.isFinite(irr) ? irr : 0,
  };
};

const computeDay = async (home, date) => {
  const rows = [];
  for (const hour of HOURS) {
    const tsIso = toIso(date, hour);
    let weather = { sunlightFactor: 1, solarIrradianceWm2: 0 };
    try {
      weather = await fetchWeather(home.lat, home.lon, tsIso);
    } catch (err) {
      // 跳过天气错误，使用默认 1/0
    }
    rows.push({ hour, tsIso, ...weather });
  }
  return rows;
};

const processHomeBufferDay = async (home, buffer, date) => {
  const samples = await computeDay(home, date);
  let sumSun = 0;
  let sumEnergy = 0;
  let sumSunRaw = 0;

  const periodAgg = PERIODS.map((p) => ({
    name: p.name,
    sun: 0,
    raw: 0,
    energy: 0,
  }));

  for (const s of samples) {
    const bbox = buildBbox(home.lat, home.lon, buffer);
    let avgShadow = null;
    try {
      avgShadow = await fetchShadow(bbox, s.tsIso);
    } catch (err) {
      continue; // 跳过该小时
    }
    if (avgShadow === null) continue;
    const sunlit = Math.max(0, Math.min(1, 1 - avgShadow / 100));
    const sunlitEff = sunlit * s.sunlightFactor;
    const shadowEff = 100 - sunlitEff * 100;
    const irradianceEff = sunlit === 0 ? 0 : s.solarIrradianceWm2;

    const dt = 3600;
    sumSunRaw += sunlit * dt;
    sumSun += sunlitEff * dt;
    sumEnergy += Math.max(0, irradianceEff) * dt;

    periodAgg.forEach((p) => {
      if (p.hours && p.hours.includes) return; // not used; keep future friendly
    });
    for (const p of PERIODS) {
      if (p.hours.includes(s.hour)) {
        const agg = periodAgg.find((x) => x.name === p.name);
        agg.sun += sunlitEff * dt;
        agg.raw += sunlit * dt;
        agg.energy += Math.max(0, irradianceEff) * dt;
      }
    }
  }

  const meanIrr = sumSun > 0 ? sumEnergy / sumSun : '';
  const result = {
    id: home.id ?? '',
    date: date.toISOString().slice(0, 10),
    buffer_m: buffer,
    IRBM_sunlight_min: sumSun / 60,
    IRBM_raw_sunlight_min: sumSunRaw / 60,
    IRBM_irradiance_kJ: sumEnergy / 1000,
    IRBM_mean_irradiance: meanIrr === '' ? '' : meanIrr,
  };

  periodAgg.forEach((p) => {
    result[`IRBM_${p.name}_min`] = p.sun / 60;
    result[`IRBM_${p.name}_irradiance_kJ`] = p.energy / 1000;
  });

  return result;
};

const main = async () => {
  const homes = await readHomes(config.input);
  const dates = listDates(config.start, config.end);
  const rows = [];
  let idx = 0;
  for (const home of homes) {
    for (const date of dates) {
      for (const buffer of config.buffers) {
        idx += 1;
        console.log(`[${idx}] home=${home.id || ''} date=${date.toISOString().slice(0, 10)} buffer=${buffer}m`);
        const r = await processHomeBufferDay(home, buffer, date);
        rows.push(r);
      }
    }
  }

  const headers = [
    'ID',
    'date',
    'buffer_m',
    'IRBM_sunlight_min',
    'IRBM_raw_sunlight_min',
    'IRBM_irradiance_kJ',
    'IRBM_mean_irradiance',
    'IRBM_morning_min',
    'IRBM_morning_irradiance_kJ',
    'IRBM_midday_min',
    'IRBM_midday_irradiance_kJ',
    'IRBM_afternoon_min',
    'IRBM_afternoon_irradiance_kJ',
    'IRBM_evening_min',
    'IRBM_evening_irradiance_kJ',
  ];
  const lines = [headers.join(',')];
  rows.forEach((r) => {
    const line = [
      r.id ?? '',
      r.date ?? '',
      r.buffer_m ?? '',
      r.IRBM_sunlight_min ?? '',
      r.IRBM_raw_sunlight_min ?? '',
      r.IRBM_irradiance_kJ ?? '',
      r.IRBM_mean_irradiance ?? '',
      r.IRBM_morning_min ?? '',
      r.IRBM_morning_irradiance_kJ ?? '',
      r.IRBM_midday_min ?? '',
      r.IRBM_midday_irradiance_kJ ?? '',
      r.IRBM_afternoon_min ?? '',
      r.IRBM_afternoon_irradiance_kJ ?? '',
      r.IRBM_evening_min ?? '',
      r.IRBM_evening_irradiance_kJ ?? '',
    ].join(',');
    lines.push(line);
  });
  await fs.writeFile(config.output, lines.join('\n'), 'utf-8');
  console.log(`完成，输出：${config.output}，行数：${rows.length}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
