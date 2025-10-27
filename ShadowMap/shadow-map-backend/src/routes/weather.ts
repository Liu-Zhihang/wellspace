import express from 'express';
import type { Request, Response } from 'express';
import { GfsCloudService } from '../services/gfsCloudService';

const router = express.Router();
const gfsService = GfsCloudService.getInstance();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const buildWeatherPayload = (cloudCoverRatio: number) => {
  const cloud = clamp(cloudCoverRatio, 0, 1);
  const humidity = Math.round(cloud * 100);
  const sunlightFactor = Math.max(0.15, 1 - cloud * 0.85);

  return {
    metrics: {
      temperature: 24 - cloud * 6,
      humidity,
      cloud_cover: cloud,
      uv_index: Math.max(0, Math.round((1 - cloud) * 10)),
      wind_speed: 2 + cloud * 3,
      wind_direction: 180,
      visibility: 10000 - Math.round(cloud * 4000),
      precipitation: Math.max(0, cloud * 3),
      pressure: 1013 - Math.round(cloud * 6),
    },
    sunlightFactor,
  };
};

router.get('/current', async (req: Request, res: Response) => {
  const { lat, lng, timestamp } = req.query;

  if (!lat || !lng) {
    res.status(400).json({
      error: 'Missing coordinates',
      message: 'lat and lng parameters are required',
    });
    return;
  }

  const latitude = Number.parseFloat(String(lat));
  const longitude = Number.parseFloat(String(lng));

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.status(400).json({
      error: 'Invalid coordinates',
      message: 'lat and lng must be numeric values',
    });
    return;
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    res.status(400).json({
      error: 'Coordinates out of range',
      message: 'lat must be between -90 and 90, lng must be between -180 and 180',
    });
    return;
  }

  const targetTime = timestamp ? new Date(String(timestamp)) : new Date();

  try {
    const result = await gfsService.getCloudCover(latitude, longitude, targetTime);
    const { metrics, sunlightFactor } = buildWeatherPayload(result.cloudCoverRatio);

    res.json({
      location: {
        latitude,
        longitude,
      },
      timestamp: targetTime.toISOString(),
      weather: metrics,
      metadata: {
        source: 'gfs_nomads',
        queryUrl: result.queryUrl,
        forecastHour: result.forecastHour,
        runTimestamp: result.runTimestamp.toISOString(),
        runOffsetHours: result.runOffsetHours,
        sunlightFactor,
      },
      units: {
        temperature: '°C',
        humidity: '%',
        cloud_cover: 'ratio (0-1)',
        uv_index: 'index (0-15)',
        wind_speed: 'm/s',
        wind_direction: 'degrees',
        visibility: 'meters',
        precipitation: 'mm/h',
        pressure: 'hPa',
      },
    });
  } catch (error) {
    console.error('[Weather] Failed to fetch GFS data', error);
    res.status(502).json({
      error: 'UpstreamUnavailable',
      message: 'Failed to fetch weather data from GFS',
    });
  }
});

export default router;
