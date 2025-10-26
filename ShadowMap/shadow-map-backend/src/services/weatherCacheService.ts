import mongoose from 'mongoose';
import { Schema, Document } from 'mongoose';
import { gfsCloudService } from './gfsCloudService';

// 天气数据接口
export interface IWeatherData extends Document {
  _id: string;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lng, lat]
  };
  grid_cell: string; // 网格标识，如 "39.9_116.4"
  timestamp: Date;
  data: {
    temperature: number;
    humidity: number;
    cloud_cover: number; // 0-1
    uv_index: number; // 0-15
    wind_speed: number; // m/s
    wind_direction: number; // 度
    visibility: number; // 米
    precipitation: number; // mm/h
    pressure: number; // hPa
  };
  source: string; // 数据源标识
  expires_at: Date;
  created_at: Date;
}

// 天气缓存Schema
const WeatherCacheSchema = new Schema<IWeatherData>({
  location: {
    type: {
      type: String,
      enum: ['Point'],
      required: true
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: function(coords: number[]) {
          return coords.length === 2 && 
                 coords[0] >= -180 && coords[0] <= 180 &&
                 coords[1] >= -90 && coords[1] <= 90;
        },
        message: 'Invalid coordinates'
      }
    }
  },
  grid_cell: { 
    type: String, 
    required: true, 
    index: true 
  },
  timestamp: { 
    type: Date, 
    required: true, 
    index: true 
  },
  data: {
    temperature: { type: Number, required: true },
    humidity: { type: Number, required: true, min: 0, max: 100 },
    cloud_cover: { type: Number, required: true, min: 0, max: 1 },
    uv_index: { type: Number, required: true, min: 0, max: 15 },
    wind_speed: { type: Number, required: true, min: 0 },
    wind_direction: { type: Number, required: true, min: 0, max: 360 },
    visibility: { type: Number, required: true, min: 0 },
    precipitation: { type: Number, required: true, min: 0 },
    pressure: { type: Number, required: true, min: 800, max: 1100 }
  },
  source: { 
    type: String, 
    required: true,
    enum: ['nullschool.net', 'openweather', 'manual', 'gfs_nomads']
  },
  expires_at: { 
    type: Date, 
    required: true, 
    index: true 
  },
  created_at: { 
    type: Date, 
    default: Date.now 
  }
}, {
  collection: 'weather_cache'
});

// 创建索引
WeatherCacheSchema.index({ location: '2dsphere' });
WeatherCacheSchema.index({ grid_cell: 1, timestamp: -1 });
WeatherCacheSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 }); // TTL索引

const WeatherCache = mongoose.model<IWeatherData>('WeatherCache', WeatherCacheSchema);

// 天气查询选项
export interface WeatherQueryOptions {
  location: {
    lng: number;
    lat: number;
  };
  timestamp?: Date;
  radius?: number; // 查询半径（米）
  maxAge?: number; // 最大缓存年龄（毫秒）
  skipCache?: boolean; // 跳过缓存
}

/**
 * 天气缓存服务类
 */
export class WeatherCacheService {
  private static instance: WeatherCacheService;
  private readonly gridSize: number = 0.1; // 网格大小（度）
  private readonly defaultTTL: number = 6 * 60 * 60 * 1000; // 6小时

  private constructor() {}

  public static getInstance(): WeatherCacheService {
    if (!WeatherCacheService.instance) {
      WeatherCacheService.instance = new WeatherCacheService();
    }
    return WeatherCacheService.instance;
  }

  /**
   * 获取天气数据（优先缓存，fallback到API）
   */
  public async getWeatherData(options: WeatherQueryOptions): Promise<IWeatherData['data']> {
    try {
      const { location, timestamp = new Date(), maxAge = this.defaultTTL, skipCache = false } = options;
      
      // 1. 尝试从缓存获取
      if (!skipCache) {
        const cached = await this.getCachedWeatherData(location, timestamp, maxAge);
        if (cached) {
          console.log(`📊 从缓存获取天气数据: ${location.lat.toFixed(2)}, ${location.lng.toFixed(2)}`);
          return cached.data;
        }
      }

      // 2. 从外部API获取
      console.log(`🌐 从API获取天气数据: ${location.lat.toFixed(2)}, ${location.lng.toFixed(2)}`);
      const weatherData = await this.fetchWeatherFromAPI(location, timestamp);
      
      // 3. 缓存数据
      await this.cacheWeatherData(location, timestamp, weatherData);
      
      return weatherData;

    } catch (error) {
      console.error('❌ 获取天气数据失败:', error);
      
      // 返回默认天气数据
      return this.getDefaultWeatherData();
    }
  }

  /**
   * 批量获取天气数据
   */
  public async getBatchWeatherData(
    locations: Array<{ lng: number; lat: number }>,
    timestamp: Date = new Date()
  ): Promise<Array<{ location: { lng: number; lat: number }; data: IWeatherData['data'] }>> {
    try {
      const results = await Promise.all(
        locations.map(async location => {
          const data = await this.getWeatherData({ location, timestamp });
          return { location, data };
        })
      );

      return results;

    } catch (error) {
      console.error('❌ 批量获取天气数据失败:', error);
      throw error;
    }
  }

  /**
   * 预加载指定区域的天气数据
   */
  public async preloadWeatherData(bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  }, timestamp: Date = new Date()): Promise<{
    loaded: number;
    cached: number;
    failed: number;
  }> {
    try {
      const gridPoints = this.generateGridPoints(bounds);
      let loaded = 0, cached = 0, failed = 0;

      console.log(`🔄 预加载天气数据: ${gridPoints.length} 个网格点`);

      for (const point of gridPoints) {
        try {
          const existing = await this.getCachedWeatherData(point, timestamp, this.defaultTTL);
          if (existing) {
            cached++;
          } else {
            await this.getWeatherData({ location: point, timestamp });
            loaded++;
          }
          
          // 添加延迟避免API限制
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          failed++;
          console.warn(`⚠️ 预加载失败: ${point.lat}, ${point.lng}:`, error);
        }
      }

      console.log(`✅ 预加载完成: ${loaded} 新加载, ${cached} 已缓存, ${failed} 失败`);
      return { loaded, cached, failed };

    } catch (error) {
      console.error('❌ 预加载天气数据失败:', error);
      throw error;
    }
  }

  /**
   * 清理过期的天气缓存
   */
  public async cleanupExpiredCache(): Promise<number> {
    try {
      const result = await WeatherCache.deleteMany({
        expires_at: { $lt: new Date() }
      });

      const deletedCount = result.deletedCount || 0;
      console.log(`🧹 清理过期天气缓存: ${deletedCount} 条记录`);
      
      return deletedCount;

    } catch (error) {
      console.error('❌ 清理天气缓存失败:', error);
      throw error;
    }
  }

  /**
   * 获取缓存统计信息
   */
  public async getCacheStatistics(): Promise<{
    totalRecords: number;
    dataSize: number;
    sourceBreakdown: Array<{ source: string; count: number }>;
    oldestRecord: Date | null;
    newestRecord: Date | null;
    expiringIn24h: number;
  }> {
    try {
      const [
        totalRecords,
        sourceStats,
        oldestRecord,
        newestRecord,
        expiringCount
      ] = await Promise.all([
        WeatherCache.countDocuments(),
        WeatherCache.aggregate([
          { $group: { _id: '$source', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]),
        WeatherCache.findOne({}, {}, { sort: { created_at: 1 } }),
        WeatherCache.findOne({}, {}, { sort: { created_at: -1 } }),
        WeatherCache.countDocuments({
          expires_at: { $lt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
        })
      ]);

      // 估算数据大小
      const avgRecordSize = 1024; // 估算每条记录1KB
      const dataSize = totalRecords * avgRecordSize;

      return {
        totalRecords,
        dataSize,
        sourceBreakdown: sourceStats.map((item: any) => ({
          source: item._id,
          count: item.count
        })),
        oldestRecord: oldestRecord?.created_at || null,
        newestRecord: newestRecord?.created_at || null,
        expiringIn24h: expiringCount
      };

    } catch (error) {
      console.error('❌ 获取缓存统计失败:', error);
      throw error;
    }
  }

  // === 私有方法 ===

  /**
   * 从缓存获取天气数据
   */
  private async getCachedWeatherData(
    location: { lng: number; lat: number },
    timestamp: Date,
    maxAge: number
  ): Promise<IWeatherData | null> {
    try {
      const gridCell = this.getGridCell(location.lat, location.lng);
      const minTime = new Date(timestamp.getTime() - maxAge);

      const cached = await WeatherCache.findOne({
        grid_cell: gridCell,
        timestamp: { $gte: minTime, $lte: timestamp },
        expires_at: { $gt: new Date() }
      }).sort({ timestamp: -1 });

      return cached;

    } catch (error) {
      console.error('❌ 获取缓存天气数据失败:', error);
      return null;
    }
  }

  /**
   * 从外部API获取天气数据
   */
  private async fetchWeatherFromAPI(
    location: { lng: number; lat: number },
    timestamp: Date
  ): Promise<IWeatherData['data']> {
    try {
      const defaultWeather = this.getDefaultWeatherData();

      try {
        const cloudResult = await gfsCloudService.getCloudCover(location.lat, location.lng, timestamp);
        defaultWeather.cloud_cover = cloudResult.cloudCoverRatio;
        console.log(`[weather] GFS 云量 ${cloudResult.cloudCoverRatio.toFixed(3)} @ f${cloudResult.forecastHour} (run ${cloudResult.runTimestamp.toISOString()})`);
      } catch (cloudError) {
        console.warn('⚠️ GFS 云量获取失败，使用默认值:', cloudError);
      }

      // TODO: temperature/humidity等应使用真实数据源，目前保留默认值
      return defaultWeather;

    } catch (error) {
      console.error('❌ 从API获取天气数据失败:', error);
      throw error;
    }
  }

  /**
   * 缓存天气数据
   */
  private async cacheWeatherData(
    location: { lng: number; lat: number },
    timestamp: Date,
    data: IWeatherData['data']
  ): Promise<void> {
    try {
      const gridCell = this.getGridCell(location.lat, location.lng);
      const expiresAt = new Date(Date.now() + this.defaultTTL);

      const weatherCache = new WeatherCache({
        location: {
          type: 'Point',
          coordinates: [location.lng, location.lat]
        },
        grid_cell: gridCell,
        timestamp,
        data,
        source: 'gfs_nomads',
        expires_at: expiresAt,
        created_at: new Date()
      });

      await weatherCache.save();

    } catch (error) {
      console.error('❌ 缓存天气数据失败:', error);
      // 不抛出错误，因为缓存失败不应该影响主流程
    }
  }

  /**
   * 获取网格标识
   */
  private getGridCell(lat: number, lng: number): string {
    const gridLat = Math.floor(lat / this.gridSize) * this.gridSize;
    const gridLng = Math.floor(lng / this.gridSize) * this.gridSize;
    return `${gridLat.toFixed(1)}_${gridLng.toFixed(1)}`;
  }

  /**
   * 生成网格点
   */
  private generateGridPoints(bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  }): Array<{ lng: number; lat: number }> {
    const points: Array<{ lng: number; lat: number }> = [];
    
    for (let lat = bounds.south; lat <= bounds.north; lat += this.gridSize) {
      for (let lng = bounds.west; lng <= bounds.east; lng += this.gridSize) {
        points.push({ lng, lat });
      }
    }
    
    return points;
  }

  /**
   * 获取默认天气数据
   */
  private getDefaultWeatherData(): IWeatherData['data'] {
    return {
      temperature: 22,
      humidity: 60,
      cloud_cover: 0.3,
      uv_index: 5,
      wind_speed: 2,
      wind_direction: 180,
      visibility: 10000,
      precipitation: 0,
      pressure: 1013
    };
  }
}

// 导出单例实例
export const weatherCacheService = WeatherCacheService.getInstance();

