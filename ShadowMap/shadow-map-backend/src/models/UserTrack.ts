import mongoose from 'mongoose';
import { Schema, Document } from 'mongoose';

// GPS点接口
export interface IGPSPoint {
  lng: number;
  lat: number;
  timestamp: Date;
  altitude?: number;
  accuracy?: number;
}

// 阴影分析结果接口
export interface IShadowAnalysis {
  total_sunlight_minutes: number;
  total_uv_exposure: number;
  comfort_score: number; // 1-10评分
  peak_exposure_time?: Date;
  shadow_segments: Array<{
    start_time: Date;
    end_time: Date;
    shadow_ratio: number; // 0-1
    uv_index: number;
  }>;
  weather_conditions?: {
    avg_temperature: number;
    avg_humidity: number;
    cloud_cover: number;
  };
}

// 用户轨迹接口定义
export interface IUserTrack extends Document {
  _id: string;
  user_id: string;
  name?: string;
  description?: string;
  route: {
    type: 'LineString';
    coordinates: number[][]; // [lng, lat, timestamp_ms]
  };
  gps_points: IGPSPoint[];
  analysis: IShadowAnalysis;
  metadata: {
    total_distance: number; // 总距离（米）
    total_duration: number; // 总时长（分钟）
    start_location: string; // 起点地址
    end_location: string;   // 终点地址
    activity_type: 'walking' | 'running' | 'cycling' | 'driving' | 'other';
  };
  created_at: Date;
  analyzed_at?: Date;
  is_public: boolean;
  tags: string[];
}

// 用户轨迹Schema定义
const UserTrackSchema = new Schema<IUserTrack>({
  user_id: { 
    type: String, 
    required: true, 
    index: true 
  },
  name: { 
    type: String, 
    maxlength: 100 
  },
  description: { 
    type: String, 
    maxlength: 500 
  },
  route: {
    type: {
      type: String,
      enum: ['LineString'],
      required: true
    },
    coordinates: {
      type: [[Number]],
      required: true,
      validate: {
        validator: function(coords: number[][]) {
          return coords.length >= 2 && coords.every(coord => 
            coord.length >= 2 && 
            coord[0] >= -180 && coord[0] <= 180 && // lng
            coord[1] >= -90 && coord[1] <= 90      // lat
          );
        },
        message: 'Invalid route coordinates'
      }
    }
  },
  gps_points: [{
    lng: { type: Number, required: true, min: -180, max: 180 },
    lat: { type: Number, required: true, min: -90, max: 90 },
    timestamp: { type: Date, required: true },
    altitude: { type: Number },
    accuracy: { type: Number, min: 0 }
  }],
  analysis: {
    total_sunlight_minutes: { type: Number, required: true, min: 0 },
    total_uv_exposure: { type: Number, required: true, min: 0 },
    comfort_score: { type: Number, required: true, min: 1, max: 10 },
    peak_exposure_time: { type: Date },
    shadow_segments: [{
      start_time: { type: Date, required: true },
      end_time: { type: Date, required: true },
      shadow_ratio: { type: Number, required: true, min: 0, max: 1 },
      uv_index: { type: Number, required: true, min: 0, max: 15 }
    }],
    weather_conditions: {
      avg_temperature: { type: Number },
      avg_humidity: { type: Number, min: 0, max: 100 },
      cloud_cover: { type: Number, min: 0, max: 1 }
    }
  },
  metadata: {
    total_distance: { type: Number, required: true, min: 0 },
    total_duration: { type: Number, required: true, min: 0 },
    start_location: { type: String, maxlength: 200 },
    end_location: { type: String, maxlength: 200 },
    activity_type: {
      type: String,
      enum: ['walking', 'running', 'cycling', 'driving', 'other'],
      default: 'walking'
    }
  },
  created_at: { type: Date, default: Date.now, index: true },
  analyzed_at: { type: Date },
  is_public: { type: Boolean, default: false, index: true },
  tags: [{ type: String, maxlength: 50 }]
}, {
  timestamps: true,
  collection: 'user_tracks'
});

// 创建地理空间索引
UserTrackSchema.index({ route: '2dsphere' });

// 创建复合索引
UserTrackSchema.index({ user_id: 1, created_at: -1 });
UserTrackSchema.index({ is_public: 1, created_at: -1 });
UserTrackSchema.index({ tags: 1 });
UserTrackSchema.index({ 'metadata.activity_type': 1, created_at: -1 });
UserTrackSchema.index({ 'analysis.comfort_score': -1 });

// 静态方法：查找用户的轨迹
UserTrackSchema.statics.findByUser = function(userId: string, limit: number = 20) {
  return this.find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(limit);
};

// 静态方法：查找公开的轨迹
UserTrackSchema.statics.findPublicTracks = function(limit: number = 50) {
  return this.find({ is_public: true })
    .sort({ created_at: -1 })
    .limit(limit)
    .select('-gps_points'); // 不返回详细GPS点数据
};

// 静态方法：按区域查找轨迹
UserTrackSchema.statics.findByBounds = function(
  west: number,
  south: number,
  east: number,
  north: number
) {
  return this.find({
    route: {
      $geoIntersects: {
        $geometry: {
          type: 'Polygon',
          coordinates: [[
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south]
          ]]
        }
      }
    }
  });
};

// 实例方法：计算轨迹统计
UserTrackSchema.methods.calculateStats = function() {
  const points = this.gps_points;
  if (points.length < 2) return null;
  
  let totalDistance = 0;
  const startTime = points[0].timestamp;
  const endTime = points[points.length - 1].timestamp;
  
  // 计算总距离（使用Haversine公式）
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    totalDistance += this.calculateDistance(prev.lat, prev.lng, curr.lat, curr.lng);
  }
  
  return {
    totalDistance: Math.round(totalDistance),
    totalDuration: Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60)),
    averageSpeed: totalDistance / ((endTime.getTime() - startTime.getTime()) / (1000 * 3600))
  };
};

// 实例方法：计算两点距离（Haversine公式）
UserTrackSchema.methods.calculateDistance = function(
  lat1: number, lng1: number, 
  lat2: number, lng2: number
): number {
  const R = 6371000; // 地球半径（米）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

export const UserTrack = mongoose.model<IUserTrack>('UserTrack', UserTrackSchema);

