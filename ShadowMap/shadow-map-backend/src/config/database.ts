import mongoose from 'mongoose';
import { config } from './index';

// MongoDB连接配置
export class DatabaseManager {
  private static instance: DatabaseManager;
  private isConnected: boolean = false;

  private constructor() {}

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * 连接MongoDB数据库
   */
  public async connect(): Promise<void> {
    if (this.isConnected) {
      console.log('📊 MongoDB already connected');
      return;
    }

    try {
      const mongoUri = config.mongodb.uri;
      const options = {
        // 连接池配置
        maxPoolSize: config.mongodb.maxPoolSize,
        minPoolSize: config.mongodb.minPoolSize,
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 10000, // Atlas需要更长时间
        socketTimeoutMS: 45000,
        
        // 数据库名称
        dbName: config.mongodb.database,
        
        // Atlas优化配置
        retryWrites: true,
        w: 'majority',
        readPreference: 'primary',
        
        // SSL/TLS配置（Atlas必需）
        ssl: true,
        tls: true,
        tlsAllowInvalidCertificates: false,
        
        // 开发环境配置 - 禁用命令缓冲以避免时序问题
        bufferCommands: false
      };

      console.log('🔄 Connecting to MongoDB...');
      console.log(`📍 URI: ${mongoUri.replace(/\/\/.*@/, '//***:***@')}`);
      
      // 配置mongoose全局设置
      mongoose.set('bufferCommands', false);
      
      await mongoose.connect(mongoUri, options);
      
      this.isConnected = true;
      console.log('✅ MongoDB connected successfully');
      console.log(`📊 Database: ${config.mongodb.database}`);
      
      // 设置事件监听器
      this.setupEventListeners();
      
    } catch (error) {
      console.error('❌ MongoDB connection error:', error);
      throw error;
    }
  }

  /**
   * 断开MongoDB连接
   */
  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await mongoose.disconnect();
      this.isConnected = false;
      console.log('🔌 MongoDB disconnected');
    } catch (error) {
      console.error('❌ MongoDB disconnect error:', error);
      throw error;
    }
  }

  /**
   * 获取连接状态
   */
  public getConnectionStatus(): {
    isConnected: boolean;
    readyState: number;
    host?: string;
    port?: number;
    name?: string;
  } {
    const connection = mongoose.connection;
    return {
      isConnected: this.isConnected,
      readyState: connection.readyState,
      host: connection.host,
      port: connection.port,
      name: connection.name
    };
  }

  /**
   * 健康检查
   */
  public async healthCheck(): Promise<{
    status: 'healthy' | 'unhealthy';
    details: any;
  }> {
    try {
      const adminDb = mongoose.connection.db?.admin();
      const result = await adminDb?.ping();
      
      return {
        status: 'healthy',
        details: {
          ping: result,
          readyState: mongoose.connection.readyState,
          host: mongoose.connection.host,
          port: mongoose.connection.port,
          name: mongoose.connection.name
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    const connection = mongoose.connection;

    connection.on('connected', () => {
      console.log('🔗 Mongoose connected to MongoDB');
    });

    connection.on('error', (error) => {
      console.error('❌ Mongoose connection error:', error);
      this.isConnected = false;
    });

    connection.on('disconnected', () => {
      console.log('🔌 Mongoose disconnected from MongoDB');
      this.isConnected = false;
    });

    // 处理应用程序终止
    process.on('SIGINT', async () => {
      console.log('🛑 Received SIGINT, closing MongoDB connection...');
      await this.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('🛑 Received SIGTERM, closing MongoDB connection...');
      await this.disconnect();
      process.exit(0);
    });
  }

  /**
   * 创建数据库索引
   */
  public async createIndexes(): Promise<void> {
    try {
      console.log('🔄 Creating database indexes...');
      
      // 这里可以添加额外的索引创建逻辑
      // Mongoose会自动创建Schema中定义的索引
      
      console.log('✅ Database indexes created successfully');
    } catch (error) {
      console.error('❌ Error creating indexes:', error);
      throw error;
    }
  }

  /**
   * 获取数据库实例
   */
  public getDatabase() {
    if (!this.isConnected) {
      throw new Error('Database not connected');
    }
    
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not available');
    }
    
    return db;
  }

  /**
   * 数据库统计信息
   */
  public async getStats(): Promise<any> {
    try {
      const db = mongoose.connection.db;
      if (!db) throw new Error('Database not connected');
      
      const stats = await db.stats();
      const collections = await db.listCollections().toArray();
      
      return {
        database: stats,
        collections: collections.map(col => ({
          name: col.name,
          type: col.type
        }))
      };
    } catch (error) {
      console.error('❌ Error getting database stats:', error);
      throw error;
    }
  }
}

// 导出单例实例
export const dbManager = DatabaseManager.getInstance();
