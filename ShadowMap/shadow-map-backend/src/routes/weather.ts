import express from 'express';
import { weatherCacheService } from '../services/weatherCacheService';

const router = express.Router();

/**
 * GET /api/weather/current
 * 获取指定位置的当前天气
 */
router.get('/current', async (req, res) => {
  try {
    const { lat, lng, timestamp, refresh } = req.query;
    
    // 验证参数
    if (!lat || !lng) {
      return res.status(400).json({
        error: 'Missing coordinates',
        message: 'lat and lng parameters are required'
      });
    }

    const latitude = parseFloat(lat as string);
    const longitude = parseFloat(lng as string);
    
    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({
        error: 'Invalid coordinates',
        message: 'lat and lng must be valid numbers'
      });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({
        error: 'Coordinates out of range',
        message: 'lat must be between -90 and 90, lng must be between -180 and 180'
      });
    }

    const queryTimestamp = timestamp ? new Date(timestamp as string) : new Date();
    
    console.log(`🌤️ 获取天气数据: ${latitude}, ${longitude} @ ${queryTimestamp.toISOString()}`);
    
    const weatherData = await weatherCacheService.getWeatherData({
      location: { lng: longitude, lat: latitude },
      timestamp: queryTimestamp,
      skipCache: refresh === '1' || refresh === 'true'
    });

    res.json({
      location: {
        latitude,
        longitude
      },
      timestamp: queryTimestamp.toISOString(),
      weather: weatherData,
      units: {
        temperature: "°C",
        humidity: "%",
        cloud_cover: "ratio (0-1)",
        uv_index: "index (0-15)",
        wind_speed: "m/s",
        wind_direction: "degrees",
        visibility: "meters",
        precipitation: "mm/h",
        pressure: "hPa"
      }
    });

  } catch (error) {
    console.error('❌ 获取天气数据失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch weather data'
    });
  }
});

/**
 * POST /api/weather/batch
 * 批量获取多个位置的天气数据
 */
router.post('/batch', async (req, res) => {
  try {
    const { locations, timestamp } = req.body;
    
    if (!Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({
        error: 'Invalid locations',
        message: 'locations must be a non-empty array'
      });
    }

    if (locations.length > 50) {
      return res.status(400).json({
        error: 'Too many locations',
        message: 'Maximum 50 locations allowed per request'
      });
    }

    // 验证所有位置
    for (const location of locations) {
      if (!location.lat || !location.lng) {
        return res.status(400).json({
          error: 'Invalid location format',
          message: 'Each location must have lat and lng properties'
        });
      }
      
      if (typeof location.lat !== 'number' || typeof location.lng !== 'number') {
        return res.status(400).json({
          error: 'Invalid coordinates',
          message: 'lat and lng must be numbers'
        });
      }
    }

    const queryTimestamp = timestamp ? new Date(timestamp) : new Date();
    
    console.log(`🌤️ 批量获取天气数据: ${locations.length} 个位置`);
    
    const weatherResults = await weatherCacheService.getBatchWeatherData(
      locations.map(loc => ({ lng: loc.lng, lat: loc.lat })),
      queryTimestamp
    );

    res.json({
      timestamp: queryTimestamp.toISOString(),
      count: weatherResults.length,
      results: weatherResults.map(result => ({
        location: {
          latitude: result.location.lat,
          longitude: result.location.lng
        },
        weather: result.data
      }))
    });

  } catch (error) {
    console.error('❌ 批量获取天气数据失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to fetch batch weather data'
    });
  }
});

/**
 * POST /api/weather/preload
 * 预加载指定区域的天气数据
 */
router.post('/preload', async (req, res) => {
  try {
    const { bounds, timestamp } = req.body;
    
    if (!bounds || typeof bounds !== 'object') {
      return res.status(400).json({
        error: 'Missing bounds',
        message: 'bounds object is required'
      });
    }

    const { west, south, east, north } = bounds;
    
    if (typeof west !== 'number' || typeof south !== 'number' || 
        typeof east !== 'number' || typeof north !== 'number') {
      return res.status(400).json({
        error: 'Invalid bounds',
        message: 'bounds must contain numeric west, south, east, north values'
      });
    }

    if (west >= east || south >= north) {
      return res.status(400).json({
        error: 'Invalid bounds',
        message: 'west must be < east and south must be < north'
      });
    }

    // 限制预加载区域大小
    const area = (east - west) * (north - south);
    if (area > 1) { // 限制为1度×1度
      return res.status(400).json({
        error: 'Area too large',
        message: 'Preload area cannot exceed 1 degree × 1 degree'
      });
    }

    const queryTimestamp = timestamp ? new Date(timestamp) : new Date();
    
    console.log(`🔄 预加载天气数据: ${west},${south} 到 ${east},${north}`);
    
    const result = await weatherCacheService.preloadWeatherData(bounds, queryTimestamp);
    
    res.json({
      message: 'Weather data preload completed',
      timestamp: queryTimestamp.toISOString(),
      bounds,
      results: result
    });

  } catch (error) {
    console.error('❌ 预加载天气数据失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to preload weather data'
    });
  }
});

/**
 * GET /api/weather/cache/stats
 * 获取天气缓存统计信息
 */
router.get('/cache/stats', async (req, res) => {
  try {
    const stats = await weatherCacheService.getCacheStatistics();
    
    res.json({
      timestamp: new Date().toISOString(),
      cache_statistics: {
        total_records: stats.totalRecords,
        estimated_size: `${Math.round(stats.dataSize / 1024 / 1024 * 100) / 100} MB`,
        source_breakdown: stats.sourceBreakdown,
        oldest_record: stats.oldestRecord,
        newest_record: stats.newestRecord,
        expiring_in_24h: stats.expiringIn24h
      }
    });

  } catch (error) {
    console.error('❌ 获取缓存统计失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get cache statistics'
    });
  }
});

/**
 * DELETE /api/weather/cache/cleanup
 * 清理过期的天气缓存
 */
router.delete('/cache/cleanup', async (req, res) => {
  try {
    console.log('🧹 开始清理过期天气缓存...');
    
    const deletedCount = await weatherCacheService.cleanupExpiredCache();
    
    res.json({
      message: 'Cache cleanup completed',
      deleted_records: deletedCount,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ 清理缓存失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to cleanup cache'
    });
  }
});

/**
 * GET /api/weather/forecast
 * 获取天气预报（未来功能）
 */
router.get('/forecast', async (req, res) => {
  res.status(501).json({
    message: 'Weather forecast endpoint not implemented yet',
    planned_features: [
      'Hourly forecast for next 48 hours',
      'Daily forecast for next 7 days',
      'UV index predictions',
      'Optimal travel time suggestions'
    ]
  });
});

/**
 * GET /api/weather/info
 * 获取天气服务信息
 */
router.get('/info', async (req, res) => {
  try {
    const stats = await weatherCacheService.getCacheStatistics();
    
    res.json({
      service: 'Weather Cache Service',
      version: '1.0.0',
      status: 'operational',
      features: [
        'Real-time weather data',
        'Intelligent caching',
        'Batch requests',
        'Area preloading',
        'Multiple data sources'
      ],
      cache_info: {
        total_records: stats.totalRecords,
        estimated_size: `${Math.round(stats.dataSize / 1024 / 1024 * 100) / 100} MB`,
        sources: stats.sourceBreakdown.map(s => s.source)
      },
      endpoints: {
        current: '/api/weather/current?lat={lat}&lng={lng}',
        batch: '/api/weather/batch',
        preload: '/api/weather/preload',
        cache_stats: '/api/weather/cache/stats',
        cleanup: '/api/weather/cache/cleanup'
      },
      data_sources: [
        'NOAA GFS (NOMADS OPeNDAP)',
        'nullschool.net (legacy fallback)',
        'openweather (planned)',
        'local weather stations (planned)'
      ]
    });

  } catch (error) {
    console.error('❌ 获取服务信息失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get service information'
    });
  }
});

export default router;

