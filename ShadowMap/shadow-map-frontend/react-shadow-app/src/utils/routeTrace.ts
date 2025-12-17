import type { BoundingBox, MobilityCsvRecord } from '../types/index.ts'

type LngLat = [number, number]

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const approximateDistanceMeters = (a: LngLat, b: LngLat) => {
  const metersPerDegreeLat = 111_320
  const meanLatRad = ((a[1] + b[1]) / 2) * (Math.PI / 180)
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(meanLatRad)
  const dx = (b[0] - a[0]) * metersPerDegreeLon
  const dy = (b[1] - a[1]) * metersPerDegreeLat
  return Math.sqrt(dx * dx + dy * dy)
}

const buildCumulativeDistances = (coordinates: LngLat[]) => {
  const distances: number[] = [0]
  for (let i = 1; i < coordinates.length; i++) {
    const prev = coordinates[i - 1]
    const current = coordinates[i]
    const segment = approximateDistanceMeters(prev, current)
    distances.push(distances[i - 1] + (Number.isFinite(segment) ? segment : 0))
  }
  return distances
}

const interpolateLngLat = (a: LngLat, b: LngLat, t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

const interpolateAtDistance = (coordinates: LngLat[], distances: number[], target: number): LngLat => {
  if (coordinates.length < 2) {
    return coordinates[0] ?? [0, 0]
  }
  const total = distances[distances.length - 1] ?? 0
  if (total <= 0) {
    return coordinates[0]
  }
  const clampedTarget = clamp(target, 0, total)
  let low = 0
  let high = distances.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if ((distances[mid] ?? 0) < clampedTarget) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  const index = clamp(low, 1, distances.length - 1)
  const d0 = distances[index - 1] ?? 0
  const d1 = distances[index] ?? d0
  const span = d1 - d0
  const t = span > 0 ? (clampedTarget - d0) / span : 0
  return interpolateLngLat(coordinates[index - 1] ?? coordinates[0], coordinates[index] ?? coordinates[coordinates.length - 1], t)
}

export type RouteTraceResult = {
  rows: MobilityCsvRecord[]
  bounds: BoundingBox
  timeRange: { start: Date; end: Date }
  traceIds: string[]
}

export const buildMobilityTraceFromRoute = (options: {
  traceId: string
  startTime: Date
  stepSeconds: number
  coordinates: LngLat[]
  durationSeconds?: number
}): RouteTraceResult => {
  const step = Math.max(1, Math.floor(options.stepSeconds))
  const coords = options.coordinates
  const distances = buildCumulativeDistances(coords)
  const totalDistance = distances[distances.length - 1] ?? 0
  const duration = Math.max(1, Math.floor(options.durationSeconds ?? (totalDistance > 0 ? totalDistance / 1.4 : step)))
  const samples = Math.max(2, Math.floor(duration / step) + 1)

  const startTime = new Date(options.startTime)
  const rows: MobilityCsvRecord[] = []
  let north = -Infinity
  let south = Infinity
  let east = -Infinity
  let west = Infinity

  for (let i = 0; i < samples; i++) {
    const offsetSeconds = Math.min(duration, i * step)
    const fraction = duration > 0 ? offsetSeconds / duration : 0
    const targetDist = totalDistance * fraction
    const [lng, lat] = interpolateAtDistance(coords, distances, targetDist)
    const timestamp = new Date(startTime.getTime() + offsetSeconds * 1000)
    rows.push({
      sourceRow: i + 1,
      traceId: options.traceId,
      timestamp,
      coordinates: [lng, lat],
    })
    north = Math.max(north, lat)
    south = Math.min(south, lat)
    east = Math.max(east, lng)
    west = Math.min(west, lng)
  }

  const endTime = rows[rows.length - 1]?.timestamp ?? startTime
  return {
    rows,
    bounds: { north, south, east, west },
    timeRange: { start: startTime, end: endTime },
    traceIds: [options.traceId],
  }
}

