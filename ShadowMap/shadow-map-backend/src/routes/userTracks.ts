import express from 'express';
import { userTrackService } from '../services/userTrackService';
import { Types } from 'mongoose';

const router = express.Router();

/**
 * POST /api/tracks
 * 创建新的用户轨迹
 */
router.post('/', async (req, res) => {
  try {
    const trackData = req.body;
    
    // 基本验证
    if (!trackData.user_id) {
      return res.status(400).json({
        error: 'Missing required field',
        message: 'user_id is required'
      });
    }

    if (!trackData.gps_points || !Array.isArray(trackData.gps_points) || trackData.gps_points.length < 2) {
      return res.status(400).json({
        error: 'Invalid GPS data',
        message: 'At least 2 GPS points are required'
      });
    }

    // 转换时间戳
    trackData.gps_points = trackData.gps_points.map((point: any) => ({
      ...point,
      timestamp: new Date(point.timestamp)
    }));

    const track = await userTrackService.createTrack(trackData);
    
    res.status(201).json({
      message: 'Track created successfully',
      track: {
        id: track._id,
        user_id: track.user_id,
        distance: track.metadata.total_distance,
        duration: track.metadata.total_duration,
        created_at: track.created_at
      }
    });

  } catch (error) {
    console.error('❌ 创建轨迹失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create track'
    });
  }
});

/**
 * GET /api/tracks/user/:userId
 * 获取用户的轨迹列表
 */
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      activity,
      min_comfort,
      max_comfort,
      start_date,
      end_date,
      limit,
      cursor
    } = req.query;

    const options: any = {
      limit: limit ? Math.min(parseInt(limit as string), 100) : 20
    };

    if (activity) options.activityType = activity as string;
    if (min_comfort) options.minComfortScore = parseFloat(min_comfort as string);
    if (max_comfort) options.maxComfortScore = parseFloat(max_comfort as string);
    if (cursor) options.cursor = cursor as string;

    if (start_date && end_date) {
      options.dateRange = {
        start: new Date(start_date as string),
        end: new Date(end_date as string)
      };
    }

    const result = await userTrackService.getUserTracks(userId, options);
    
    res.json({
      tracks: result.tracks.map(track => ({
        id: track._id,
        name: track.name,
        activity_type: track.metadata.activity_type,
        distance: track.metadata.total_distance,
        duration: track.metadata.total_duration,
        comfort_score: track.analysis?.comfort_score || null,
        created_at: track.created_at
      })),
      pagination: {
        has_more: result.hasMore,
        next_cursor: result.nextCursor
      }
    });

  } catch (error) {
    console.error('❌ 获取用户轨迹失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get user tracks'
    });
  }
});

/**
 * GET /api/tracks/public
 * 获取公开的轨迹
 */
router.get('/public', async (req, res) => {
  try {
    const {
      activity,
      min_comfort,
      bounds,
      limit,
      cursor
    } = req.query;

    const options: any = {
      limit: limit ? Math.min(parseInt(limit as string), 50) : 20
    };

    if (activity) options.activityType = activity as string;
    if (min_comfort) options.minComfortScore = parseFloat(min_comfort as string);
    if (cursor) options.cursor = cursor as string;

    // 解析边界框
    if (bounds) {
      const boundsArray = (bounds as string).split(',').map(Number);
      if (boundsArray.length === 4) {
        options.bounds = {
          west: boundsArray[0],
          south: boundsArray[1],
          east: boundsArray[2],
          north: boundsArray[3]
        };
      }
    }

    const result = await userTrackService.getPublicTracks(options);
    
    res.json({
      tracks: result.tracks.map(track => ({
        id: track._id,
        name: track.name || '未命名路线',
        activity_type: track.metadata.activity_type,
        distance: track.metadata.total_distance,
        duration: track.metadata.total_duration,
        comfort_score: track.analysis?.comfort_score || null,
        route_preview: {
          start: track.route.coordinates[0],
          end: track.route.coordinates[track.route.coordinates.length - 1]
        },
        created_at: track.created_at
      })),
      pagination: {
        has_more: result.hasMore,
        next_cursor: result.nextCursor
      }
    });

  } catch (error) {
    console.error('❌ 获取公开轨迹失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get public tracks'
    });
  }
});

/**
 * GET /api/tracks/:trackId
 * 获取轨迹详情
 */
router.get('/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    
    if (!Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({
        error: 'Invalid track ID',
        message: 'Track ID must be a valid ObjectId'
      });
    }

    // 这里应该添加权限检查
    // const track = await UserTrack.findById(trackId);
    
    res.status(501).json({
      message: 'Track details endpoint not implemented yet'
    });

  } catch (error) {
    console.error('❌ 获取轨迹详情失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get track details'
    });
  }
});

/**
 * POST /api/tracks/:trackId/analyze
 * 分析轨迹的阴影情况
 */
router.post('/:trackId/analyze', async (req, res) => {
  try {
    const { trackId } = req.params;
    
    if (!Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({
        error: 'Invalid track ID',
        message: 'Track ID must be a valid ObjectId'
      });
    }

    console.log(`🔍 开始分析轨迹阴影: ${trackId}`);
    const analysis = await userTrackService.analyzeTrackShadow(trackId);
    
    res.json({
      message: 'Track analysis completed',
      analysis
    });

  } catch (error) {
    console.error('❌ 轨迹阴影分析失败:', error);
    
    if (error instanceof Error && error.message === 'Track not found') {
      return res.status(404).json({
        error: 'Track not found',
        message: 'The specified track does not exist'
      });
    }
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to analyze track'
    });
  }
});

/**
 * GET /api/tracks/user/:userId/stats
 * 获取用户统计信息
 */
router.get('/user/:userId/stats', async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`📊 获取用户统计: ${userId}`);
    const stats = await userTrackService.getUserStatistics(userId);
    
    res.json({
      user_id: userId,
      statistics: stats,
      generated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ 获取用户统计失败:', error);
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to get user statistics'
    });
  }
});

/**
 * DELETE /api/tracks/:trackId
 * 删除轨迹
 */
router.delete('/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const { user_id } = req.body; // 实际应用中应该从认证token获取
    
    if (!Types.ObjectId.isValid(trackId)) {
      return res.status(400).json({
        error: 'Invalid track ID',
        message: 'Track ID must be a valid ObjectId'
      });
    }

    if (!user_id) {
      return res.status(400).json({
        error: 'Missing user ID',
        message: 'user_id is required for authorization'
      });
    }

    await userTrackService.deleteTrack(trackId, user_id);
    
    res.json({
      message: 'Track deleted successfully',
      track_id: trackId
    });

  } catch (error) {
    console.error('❌ 删除轨迹失败:', error);
    
    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        error: 'Track not found',
        message: 'Track not found or permission denied'
      });
    }
    
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete track'
    });
  }
});

export default router;

