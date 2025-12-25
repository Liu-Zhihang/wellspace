import { UserTrack, IUserTrack } from '../models/UserTrack';
import { Types } from 'mongoose';

// GPS轨迹分析结果接口
export interface TrackAnalysisResult {
  trackId: string;
  summary: {
    totalDistance: number;
    totalDuration: number;
    averageSpeed: number;
    comfortScore: number;
  };
  shadowAnalysis: {
    totalSunlightMinutes: number;
    totalShadowMinutes: number;
    shadowRatio: number;
    uvExposure: number;
  };
  recommendations: string[];
}

// 轨迹查询选项
export interface TrackQueryOptions {
  userId?: string;
  activityType?: 'walking' | 'running' | 'cycling' | 'driving' | 'other';
  minComfortScore?: number;
  maxComfortScore?: number;
  dateRange?: {
    start: Date;
    end: Date;
  };
  bounds?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  isPublic?: boolean;
  limit?: number;
  cursor?: string;
}

/**
 * 用户轨迹服务类
 */
export class UserTrackService {
  private static instance: UserTrackService;

  private constructor() {}

  public static getInstance(): UserTrackService {
    if (!UserTrackService.instance) {
      UserTrackService.instance = new UserTrackService();
    }
    return UserTrackService.instance;
  }

  /**
   * 创建新的用户轨迹
   */
  public async createTrack(trackData: Partial<IUserTrack>): Promise<IUserTrack> {
    try {
      // 验证必要字段
      if (!trackData.user_id || !trackData.gps_points || trackData.gps_points.length < 2) {
        throw new Error('Invalid track data: user_id and at least 2 GPS points required');
      }

      // 生成route geometry
      const coordinates = trackData.gps_points.map(point => [
        point.lng, 
        point.lat, 
        point.timestamp.getTime()
      ]);

      // 计算基础统计信息
      const stats = this.calculateBasicStats(trackData.gps_points);

      const track = new UserTrack({
        ...trackData,
        route: {
          type: 'LineString',
          coordinates
        },
        metadata: {
          ...trackData.metadata,
          total_distance: stats.totalDistance,
          total_duration: stats.totalDuration
        },
        created_at: new Date()
      });

      const savedTrack = await track.save();
      console.log(`✅ 创建用户轨迹: ${savedTrack._id} (${stats.totalDistance}m, ${stats.totalDuration}min)`);
      
      return savedTrack;

    } catch (error) {
      console.error('❌ 创建用户轨迹失败:', error);
      throw error;
    }
  }

  /**
   * 获取用户的轨迹列表
   */
  public async getUserTracks(
    userId: string, 
    options: Partial<TrackQueryOptions> = {}
  ): Promise<{
    tracks: IUserTrack[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      const limit = Math.min(options.limit || 20, 100);
      const query: any = { user_id: userId };

      // 添加筛选条件
      if (options.activityType) {
        query['metadata.activity_type'] = options.activityType;
      }

      if (options.minComfortScore !== undefined) {
        query['analysis.comfort_score'] = { $gte: options.minComfortScore };
      }

      if (options.dateRange) {
        query.created_at = {
          $gte: options.dateRange.start,
          $lte: options.dateRange.end
        };
      }

      // cursor分页
      if (options.cursor) {
        query._id = { $lt: new Types.ObjectId(options.cursor) };
      }

      const tracks = await UserTrack.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = tracks.length > limit;
      const results = hasMore ? tracks.slice(0, -1) : tracks;
      const nextCursor = hasMore ? results[results.length - 1]._id.toString() : undefined;

      return {
        tracks: results as IUserTrack[],
        hasMore,
        nextCursor
      };

    } catch (error) {
      console.error('❌ 获取用户轨迹失败:', error);
      throw error;
    }
  }

  /**
   * 获取公开的轨迹（社区功能）
   */
  public async getPublicTracks(options: TrackQueryOptions = {}): Promise<{
    tracks: IUserTrack[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      const limit = Math.min(options.limit || 20, 100);
      const query: any = { is_public: true };

      // 添加筛选条件
      if (options.activityType) {
        query['metadata.activity_type'] = options.activityType;
      }

      if (options.minComfortScore !== undefined) {
        query['analysis.comfort_score'] = { $gte: options.minComfortScore };
      }

      // 地理区域筛选
      if (options.bounds) {
        const { west, south, east, north } = options.bounds;
        query.route = {
          $geoIntersects: {
            $geometry: {
              type: 'Polygon',
              coordinates: [[
                [west, south], [east, south], 
                [east, north], [west, north], 
                [west, south]
              ]]
            }
          }
        };
      }

      // cursor分页
      if (options.cursor) {
        query._id = { $lt: new Types.ObjectId(options.cursor) };
      }

      const tracks = await UserTrack.find(query)
        .sort({ created_at: -1 })
        .limit(limit + 1)
        .select('-gps_points') // 不返回详细GPS数据
        .lean();

      const hasMore = tracks.length > limit;
      const results = hasMore ? tracks.slice(0, -1) : tracks;
      const nextCursor = hasMore ? results[results.length - 1]._id.toString() : undefined;

      return {
        tracks: results as IUserTrack[],
        hasMore,
        nextCursor
      };

    } catch (error) {
      console.error('❌ 获取公开轨迹失败:', error);
      throw error;
    }
  }

  /**
   * 分析轨迹的阴影暴露情况
   */
  public async analyzeTrackShadow(trackId: string): Promise<TrackAnalysisResult> {
    try {
      const track = await UserTrack.findById(trackId);
      if (!track) {
        throw new Error('Track not found');
      }

      // 这里集成阴影计算逻辑
      const shadowAnalysis = await this.performShadowAnalysis(track);
      
      // 更新轨迹的分析结果
      track.analysis = shadowAnalysis;
      track.analyzed_at = new Date();
      await track.save();

      return {
        trackId: track._id.toString(),
        summary: {
          totalDistance: track.metadata.total_distance,
          totalDuration: track.metadata.total_duration,
          averageSpeed: track.metadata.total_distance / (track.metadata.total_duration * 60 / 3600),
          comfortScore: shadowAnalysis.comfort_score
        },
        shadowAnalysis: {
          totalSunlightMinutes: shadowAnalysis.total_sunlight_minutes,
          totalShadowMinutes: track.metadata.total_duration - shadowAnalysis.total_sunlight_minutes,
          shadowRatio: 1 - (shadowAnalysis.total_sunlight_minutes / track.metadata.total_duration),
          uvExposure: shadowAnalysis.total_uv_exposure
        },
        recommendations: this.generateRecommendations(shadowAnalysis)
      };

    } catch (error) {
      console.error('❌ 轨迹阴影分析失败:', error);
      throw error;
    }
  }

  /**
   * 获取用户统计信息
   */
  public async getUserStatistics(userId: string): Promise<{
    totalTracks: number;
    totalDistance: number;
    totalTime: number;
    averageComfortScore: number;
    activityBreakdown: Array<{ activity: string; count: number; distance: number }>;
    monthlyStats: Array<{ month: string; tracks: number; distance: number }>;
  }> {
    try {
      const [
        totalStats,
        activityStats,
        monthlyStats
      ] = await Promise.all([
        // 总体统计
        UserTrack.aggregate([
          { $match: { user_id: userId } },
          { $group: {
            _id: null,
            totalTracks: { $sum: 1 },
            totalDistance: { $sum: '$metadata.total_distance' },
            totalTime: { $sum: '$metadata.total_duration' },
            avgComfort: { $avg: '$analysis.comfort_score' }
          }}
        ]),

        // 活动类型统计
        UserTrack.aggregate([
          { $match: { user_id: userId } },
          { $group: {
            _id: '$metadata.activity_type',
            count: { $sum: 1 },
            distance: { $sum: '$metadata.total_distance' }
          }},
          { $sort: { count: -1 } }
        ]),

        // 月度统计
        UserTrack.aggregate([
          { $match: { user_id: userId } },
          { $group: {
            _id: { 
              year: { $year: '$created_at' },
              month: { $month: '$created_at' }
            },
            tracks: { $sum: 1 },
            distance: { $sum: '$metadata.total_distance' }
          }},
          { $sort: { '_id.year': -1, '_id.month': -1 } },
          { $limit: 12 }
        ])
      ]);

      const total = totalStats[0] || {
        totalTracks: 0,
        totalDistance: 0,
        totalTime: 0,
        avgComfort: 0
      };

      return {
        totalTracks: total.totalTracks,
        totalDistance: total.totalDistance,
        totalTime: total.totalTime,
        averageComfortScore: Math.round(total.avgComfort * 10) / 10,
        activityBreakdown: activityStats.map((item: any) => ({
          activity: item._id,
          count: item.count,
          distance: item.distance
        })),
        monthlyStats: monthlyStats.map((item: any) => ({
          month: `${item._id.year}-${String(item._id.month).padStart(2, '0')}`,
          tracks: item.tracks,
          distance: item.distance
        }))
      };

    } catch (error) {
      console.error('❌ 获取用户统计失败:', error);
      throw error;
    }
  }

  /**
   * 删除用户轨迹
   */
  public async deleteTrack(trackId: string, userId: string): Promise<boolean> {
    try {
      const result = await UserTrack.deleteOne({ 
        _id: new Types.ObjectId(trackId), 
        user_id: userId 
      });

      if (result.deletedCount === 0) {
        throw new Error('Track not found or permission denied');
      }

      console.log(`🗑️ 删除用户轨迹: ${trackId}`);
      return true;

    } catch (error) {
      console.error('❌ 删除轨迹失败:', error);
      throw error;
    }
  }

  // === 私有辅助方法 ===

  /**
   * 计算基础统计信息
   */
  private calculateBasicStats(gpsPoints: any[]): {
    totalDistance: number;
    totalDuration: number;
  } {
    let totalDistance = 0;
    const startTime = gpsPoints[0].timestamp;
    const endTime = gpsPoints[gpsPoints.length - 1].timestamp;

    // 计算总距离
    for (let i = 1; i < gpsPoints.length; i++) {
      const prev = gpsPoints[i - 1];
      const curr = gpsPoints[i];
      totalDistance += this.calculateDistance(
        prev.lat, prev.lng, 
        curr.lat, curr.lng
      );
    }

    const totalDuration = Math.round((endTime.getTime() - startTime.getTime()) / (1000 * 60)); // 分钟

    return {
      totalDistance: Math.round(totalDistance),
      totalDuration
    };
  }

  /**
   * 计算两点距离（Haversine公式）
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000; // 地球半径（米）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  /**
   * 执行阴影分析（集成阴影计算引擎）
   */
  private async performShadowAnalysis(track: IUserTrack): Promise<any> {
    // TODO: 集成实际的阴影计算逻辑
    // 这里是模拟实现，实际需要调用阴影计算服务
    
    const totalMinutes = track.metadata.total_duration;
    const shadowRatio = Math.random() * 0.5 + 0.2; // 20%-70%的阴影
    
    return {
      total_sunlight_minutes: Math.round(totalMinutes * (1 - shadowRatio)),
      total_uv_exposure: Math.random() * 5 + 1, // 1-6的UV暴露
      comfort_score: Math.random() * 3 + 7, // 7-10的舒适度
      shadow_segments: [] // TODO: 实现详细的阴影段分析
    };
  }

  /**
   * 生成推荐建议
   */
  private generateRecommendations(analysis: any): string[] {
    const recommendations: string[] = [];
    
    if (analysis.total_uv_exposure > 4) {
      recommendations.push('UV暴露较高，建议选择阴影更多的路线');
    }
    
    if (analysis.comfort_score < 6) {
      recommendations.push('舒适度较低，考虑调整出行时间');
    }
    
    if (analysis.total_sunlight_minutes > 30) {
      recommendations.push('建议携带防晒用品');
    }
    
    return recommendations;
  }
}

// 导出单例实例
export const userTrackService = UserTrackService.getInstance();

