// Redis is optional - graceful fallback if not installed
let Redis: any = null;
try {
  Redis = require('ioredis');
} catch (error) {
  console.log('📝 Redis module not found - using MongoDB-only caching');
}

export class RedisCacheService {
  private static instance: RedisCacheService;
  private redis: any | null = null;
  private isEnabled = false;

  private constructor() {
    this.initializeRedis();
  }

  public static getInstance(): RedisCacheService {
    if (!RedisCacheService.instance) {
      RedisCacheService.instance = new RedisCacheService();
    }
    return RedisCacheService.instance;
  }

  private async initializeRedis() {
    // Check if Redis is explicitly enabled via environment variable
    const redisEnabled = process.env.ENABLE_REDIS === 'true';
    
    if (!redisEnabled) {
      console.log('📝 Redis disabled by default, using MongoDB-only caching');
      console.log('💡 To enable Redis: set ENABLE_REDIS=true and ensure Redis server is running');
      this.isEnabled = false;
      return;
    }

    try {
      // Check if Redis module is available
      if (!Redis) {
        console.log('📝 Redis module not installed, using MongoDB-only caching');
        console.log('💡 To install Redis: npm install ioredis');
        this.isEnabled = false;
        return;
      }

      console.log('🔄 Initializing Redis cache service...');

      // Create Redis connection with minimal retry
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        retryDelayOnFailover: 100,
        enableReadyCheck: false,
        maxRetriesPerRequest: 0,
        lazyConnect: true,
        connectTimeout: 2000,
        commandTimeout: 1000,
      });

      // Set up error handlers
      this.redis.on('error', (error) => {
        console.warn('⚠️ Redis error, falling back to MongoDB-only caching:', error.message);
        this.isEnabled = false;
      });

      this.redis.on('connect', () => {
        console.log('✅ Redis cache service connected successfully');
        this.isEnabled = true;
      });

      // Try to connect with timeout
      await Promise.race([
        this.redis.connect(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Redis connection timeout')), 3000)
        )
      ]);

      this.isEnabled = true;
      console.log('✅ Redis cache service initialized');

    } catch (error) {
      console.log('📝 Redis not available, using MongoDB-only caching');
      this.isEnabled = false;
      if (this.redis) {
        try {
          this.redis.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        this.redis = null;
      }
    }
  }

  // Get cached building tile data
  public async getBuildingTile(z: number, x: number, y: number): Promise<any | null> {
    if (!this.isEnabled || !this.redis) return null;

    try {
      const key = `buildings:${z}:${x}:${y}`;
      const cached = await this.redis.get(key);
      
      if (cached) {
        console.log(`🎯 Redis cache hit for tile ${z}/${x}/${y}`);
        return JSON.parse(cached);
      }
      
      return null;
    } catch (error) {
      console.warn('⚠️ Redis get error:', error);
      return null;
    }
  }

  // Cache building tile data
  public async setBuildingTile(z: number, x: number, y: number, data: any, ttl = 3600): Promise<void> {
    if (!this.isEnabled || !this.redis) return;

    try {
      const key = `buildings:${z}:${x}:${y}`;
      await this.redis.setex(key, ttl, JSON.stringify(data));
      console.log(`💾 Cached tile ${z}/${x}/${y} in Redis (TTL: ${ttl}s)`);
    } catch (error) {
      console.warn('⚠️ Redis set error:', error);
    }
  }

  // Get general cache
  public async get(key: string): Promise<string | null> {
    if (!this.isEnabled || !this.redis) return null;

    try {
      return await this.redis.get(key);
    } catch (error) {
      console.warn('⚠️ Redis get error:', error);
      return null;
    }
  }

  // Set general cache
  public async set(key: string, value: string, ttl = 3600): Promise<void> {
    if (!this.isEnabled || !this.redis) return;

    try {
      await this.redis.setex(key, ttl, value);
    } catch (error) {
      console.warn('⚠️ Redis set error:', error);
    }
  }

  // Set general cache with TTL (alias for better readability)
  public async setWithTTL(key: string, value: string, ttl: number): Promise<void> {
    return this.set(key, value, ttl);
  }

  // Clear cache by pattern
  public async clearByPattern(pattern: string): Promise<number> {
    if (!this.isEnabled || !this.redis) return 0;

    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        const deleted = await this.redis.del(...keys);
        console.log(`🗑️ Cleared ${deleted} Redis cache entries matching ${pattern}`);
        return deleted;
      }
      return 0;
    } catch (error) {
      console.warn('⚠️ Redis clear error:', error);
      return 0;
    }
  }

  // Get cache statistics
  public async getStats(): Promise<{
    enabled: boolean;
    keysCount: number;
    memoryUsage: string;
    hitRate?: number;
  }> {
    if (!this.isEnabled || !this.redis) {
      return {
        enabled: false,
        keysCount: 0,
        memoryUsage: '0B'
      };
    }

    try {
      const info = await this.redis.info('memory');
      const keyspace = await this.redis.info('keyspace');
      
      // Parse memory usage
      const memoryMatch = info.match(/used_memory_human:([^\r\n]+)/);
      const memoryUsage = memoryMatch ? memoryMatch[1].trim() : '0B';
      
      // Count keys (approximate)
      const dbsize = await this.redis.dbsize();
      
      return {
        enabled: true,
        keysCount: dbsize,
        memoryUsage
      };
    } catch (error) {
      console.warn('⚠️ Redis stats error:', error);
      return {
        enabled: false,
        keysCount: 0,
        memoryUsage: '0B'
      };
    }
  }

  // Health check
  public async healthCheck(): Promise<boolean> {
    if (!this.redis) return false;

    try {
      const result = await this.redis.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  // Graceful shutdown
  public async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.disconnect();
      console.log('👋 Redis connection closed');
    }
  }
}

// Export singleton instance
export const redisCacheService = RedisCacheService.getInstance();
