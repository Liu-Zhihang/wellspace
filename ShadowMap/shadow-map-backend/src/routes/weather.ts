import express from 'express';
import type { Request, Response } from 'express';
import { Era5Service } from '../services/era5Service';

const router = express.Router();
const era5Service = Era5Service.getInstance();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const buildWeatherPayload = (cloudCoverRatio: number | null) => {
  if (cloudCoverRatio == null) {
    return {
      metrics: {
        temperature: null,
        humidity: null,
        cloud_cover: null,
        uv_index: null,
        wind_speed: null,
        wind_direction: null,
        visibility: null,
        precipitation: null,
        pressure: null,
      },
      sunlightFactor: null,
    };
  }

  const cloud = clamp(cloudCoverRatio, 0, 1);
  const humidity = Math.round(cloud * 100);
  const sunlightFactor = Math.max(0.15, 1 - cloud * 0.85);

  return {
    metrics: {
      temperature: null, // 无真实温度数据
      humidity,
      cloud_cover: cloud,
      uv_index: null,
      wind_speed: null,
      wind_direction: null,
      visibility: null,
      precipitation: null,
      pressure: null,
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
    const { cloudCover, irradianceWm2, source, details } = await era5Service.getWeather(
      latitude,
      longitude,
      targetTime,
    );
    const { metrics, sunlightFactor } = buildWeatherPayload(cloudCover);

    res.json({
      location: {
        latitude,
        longitude,
      },
      timestamp: targetTime.toISOString(),
      weather: metrics,
      metadata: {
        source,
        sunlightFactor,
        solarIrradianceWm2: irradianceWm2,
        era5Details: details,
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
        solarIrradianceWm2: 'W/m^2',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Weather] Failed to fetch weather data', message);
    // 返回明确的空值和来源，避免假象
    res.status(200).json({
      location: {
        latitude,
        longitude,
      },
      timestamp: targetTime.toISOString(),
      weather: {
        temperature: null,
        humidity: null,
        cloud_cover: null,
        uv_index: null,
        wind_speed: null,
        wind_direction: null,
        visibility: null,
        precipitation: null,
        pressure: null,
        solarIrradianceWm2: null,
      },
      metadata: {
        source: 'unavailable',
        error: message,
        sunlightFactor: null,
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
        solarIrradianceWm2: 'W/m^2',
      },
    });
  }
});

export default router;
