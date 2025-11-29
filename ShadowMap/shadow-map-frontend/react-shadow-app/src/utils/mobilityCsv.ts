import type { BoundingBox, MobilityCsvParseResult, MobilityCsvRecord, MobilityValidationError } from '../types/index.ts';

const REQUIRED_HEADERS = ['id', 'time', 'lng', 'lat'] as const;
const OPTIONAL_SPEED_HEADERS = ['speed_kmh', 'speed'] as const;

type HeaderMap = Record<(typeof REQUIRED_HEADERS)[number] | 'speed', number>;

const HEADER_ALIASES: Record<(typeof REQUIRED_HEADERS)[number], string[]> = {
  id: ['trace_id', 'move_id'],
  time: ['timestamp', 'time_sec', 'time_second', 'epoch', 'time_epoch'],
  lng: ['lon', 'longitude', 'fnl_lon', 'gps_lon', 'air_lon'],
  lat: ['latitude', 'fnl_lat', 'gps_lat', 'air_lat'],
};

const normaliseHeader = (value: string): string => value?.trim().toLowerCase();

const matchRequiredKey = (value: string): (typeof REQUIRED_HEADERS)[number] | null => {
  const directMatch = (REQUIRED_HEADERS as readonly string[]).find((key) => key === value);
  if (directMatch) return directMatch as (typeof REQUIRED_HEADERS)[number];
  const aliasMatch = (REQUIRED_HEADERS as readonly string[]).find((key) =>
    HEADER_ALIASES[key as (typeof REQUIRED_HEADERS)[number]]?.includes(value),
  );
  return aliasMatch ? (aliasMatch as (typeof REQUIRED_HEADERS)[number]) : null;
};

const parseHeader = (headerLine: string): HeaderMap => {
  const headers = headerLine.split(',').map(normaliseHeader);
  const map: HeaderMap = { id: -1, time: -1, lng: -1, lat: -1, speed: -1 };

  headers.forEach((value, index) => {
    const requiredKey = matchRequiredKey(value);
    if (requiredKey && map[requiredKey] === -1) {
      map[requiredKey] = index;
      return;
    }
    if (map.speed === -1 && OPTIONAL_SPEED_HEADERS.includes(value as any)) {
      map.speed = index;
    }
  });

  return map;
};

const buildBounds = (records: MobilityCsvRecord[]): BoundingBox | undefined => {
  if (!records.length) return undefined;
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;

  records.forEach(({ coordinates: [lng, lat] }) => {
    north = Math.max(north, lat);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    west = Math.min(west, lng);
  });

  return { north, south, east, west };
};

const parseTimestamp = (rawValue: string | undefined | null): Date | null => {
  const value = rawValue?.trim();
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
};

export const parseMobilityCsv = (csv: string): MobilityCsvParseResult => {
  const errors: MobilityValidationError[] = [];
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);

  if (!lines.length) {
    errors.push({ row: 0, message: 'File is empty.' });
    return { rows: [], errors, traceIds: [] };
  }

  const headerMap = parseHeader(lines[0]);
  REQUIRED_HEADERS.forEach((key) => {
    if (headerMap[key] === -1) {
      errors.push({ row: 1, field: key, message: `Missing required column "${key}".` });
    }
  });

  if (errors.length) {
    return { rows: [], errors, traceIds: [] };
  }

  const rows: MobilityCsvRecord[] = [];
  let minTime: Date | undefined;
  let maxTime: Date | undefined;
  const traceIdSet = new Set<string>();

  lines.slice(1).forEach((line, index) => {
    const sourceRow = index + 2; // account for header row
    if (!line || line.startsWith('#')) return;

    const cells = line.split(',');

    const traceId = cells[headerMap.id]?.trim();
    if (!traceId) {
      errors.push({ row: sourceRow, field: 'id', message: 'Trace id is required.' });
      return;
    }

    const timestamp = parseTimestamp(cells[headerMap.time]);
    if (!timestamp) {
      errors.push({ row: sourceRow, field: 'time', message: 'Invalid ISO time value.' });
      return;
    }

    const rawLng = cells[headerMap.lng]?.trim();
    const lng = Number(rawLng);
    if (!Number.isFinite(lng)) {
      errors.push({ row: sourceRow, field: 'lng', message: 'Longitude must be a number.' });
      return;
    }

    const rawLat = cells[headerMap.lat]?.trim();
    const lat = Number(rawLat);
    if (!Number.isFinite(lat)) {
      errors.push({ row: sourceRow, field: 'lat', message: 'Latitude must be a number.' });
      return;
    }

    let speedKmh: number | undefined;
    if (headerMap.speed >= 0) {
      const speedValue = cells[headerMap.speed]?.trim();
      if (speedValue) {
        const parsedSpeed = Number(speedValue);
        if (Number.isFinite(parsedSpeed)) {
          speedKmh = parsedSpeed;
        } else {
          errors.push({ row: sourceRow, field: 'speed', message: 'Speed must be a number.' });
          return;
        }
      }
    }

    const record: MobilityCsvRecord = {
      sourceRow,
      traceId,
      timestamp,
      coordinates: [lng, lat],
      speedKmh,
    };
    rows.push(record);
    traceIdSet.add(traceId);

    if (!minTime || timestamp < minTime) {
      minTime = timestamp;
    }
    if (!maxTime || timestamp > maxTime) {
      maxTime = timestamp;
    }
  });

  return {
    rows,
    errors,
    bounds: buildBounds(rows),
    timeRange: rows.length && minTime && maxTime ? { start: minTime, end: maxTime } : undefined,
    traceIds: Array.from(traceIdSet).sort(),
  };
};
