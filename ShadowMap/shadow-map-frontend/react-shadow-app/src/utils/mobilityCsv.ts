import type { BoundingBox, MobilityCsvParseResult, MobilityCsvRecord, MobilityValidationError } from '../types/index.ts';

const REQUIRED_HEADERS = ['id', 'time', 'lng', 'lat'] as const;
const OPTIONAL_SPEED_HEADERS = ['speed_kmh', 'speed'] as const;

type HeaderMap = Record<(typeof REQUIRED_HEADERS)[number] | 'speed', number>;

const normaliseHeader = (value: string): string => value?.trim().toLowerCase();

const parseHeader = (headerLine: string): HeaderMap => {
  const headers = headerLine.split(',').map(normaliseHeader);
  const map: HeaderMap = { id: -1, time: -1, lng: -1, lat: -1, speed: -1 };

  headers.forEach((value, index) => {
    if (value in map && map[value as keyof HeaderMap] === -1) {
      map[value as keyof HeaderMap] = index;
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
    if (!line) return;

    const cells = line.split(',');

    const traceId = cells[headerMap.id]?.trim();
    if (!traceId) {
      errors.push({ row: sourceRow, field: 'id', message: 'Trace id is required.' });
      return;
    }

    const rawTime = cells[headerMap.time]?.trim();
    const timestamp = rawTime ? new Date(rawTime) : null;
    if (!timestamp || Number.isNaN(timestamp.getTime())) {
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
