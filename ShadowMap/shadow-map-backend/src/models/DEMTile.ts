import mongoose from 'mongoose';
import { Schema, Document } from 'mongoose';

// DEM瓦片元数据接口定义
export interface IDEMTile extends Document {
  _id: string; // 格式: "z/x/y"
  z: number;
  x: number;
  y: number;
  bounds: [number, number, number, number]; // [west, south, east, north]
  file_path: string;
  file_size: number; // 文件大小（字节）
  cached: boolean;
  source: 'aws_terrarium' | 'local' | 'generated';
  max_elevation: number; // 该瓦片的最大高程值
  min_elevation: number; // 该瓦片的最小高程值
  checksum?: string; // 文件校验和
  download_url?: string; // 原始下载URL
  created_at: Date;
  last_accessed: Date;
  access_count: number; // 访问次数统计
}

// DEM瓦片Schema定义
const DEMTileSchema = new Schema<IDEMTile>({
  _id: {
    type: String,
    required: true,
    validate: {
      validator: function(id: string) {
        return /^\d+\/\d+\/\d+$/.test(id);
      },
      message: 'Invalid tile ID format, should be "z/x/y"'
    }
  },
  z: { 
    type: Number, 
    required: true, 
    min: 0, 
    max: 20,
    index: true 
  },
  x: { 
    type: Number, 
    required: true, 
    min: 0,
    index: true 
  },
  y: { 
    type: Number, 
    required: true, 
    min: 0,
    index: true 
  },
  bounds: {
    type: [Number],
    required: true,
    validate: {
      validator: function(bounds: number[]) {
        return bounds.length === 4 && 
               bounds[0] < bounds[2] && // west < east
               bounds[1] < bounds[3];   // south < north
      },
      message: 'Invalid bounds format'
    }
  },
  file_path: { type: String, required: true },
  file_size: { type: Number, required: true, min: 0 },
  cached: { type: Boolean, default: false, index: true },
  source: {
    type: String,
    enum: ['aws_terrarium', 'local', 'generated'],
    required: true,
    default: 'aws_terrarium'
  },
  max_elevation: { type: Number, required: true },
  min_elevation: { type: Number, required: true },
  checksum: { type: String },
  download_url: { type: String },
  created_at: { type: Date, default: Date.now },
  last_accessed: { type: Date, default: Date.now, index: true },
  access_count: { type: Number, default: 0, min: 0 }
}, {
  timestamps: false, // 我们手动管理时间戳
  collection: 'dem_tiles'
});

// 创建复合索引
DEMTileSchema.index({ z: 1, x: 1, y: 1 }, { unique: true });
DEMTileSchema.index({ bounds: 1 });
DEMTileSchema.index({ cached: 1, last_accessed: 1 });
DEMTileSchema.index({ source: 1, created_at: 1 });

// 静态方法：生成瓦片ID
DEMTileSchema.statics.generateTileId = function(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
};

// 实例方法：更新访问统计
DEMTileSchema.methods.updateAccess = function() {
  this.last_accessed = new Date();
  this.access_count += 1;
  return this.save();
};

// 静态方法：查找瓦片通过边界框
DEMTileSchema.statics.findByBounds = function(
  west: number, 
  south: number, 
  east: number, 
  north: number,
  zoom?: number
) {
  const query: any = {
    bounds: {
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
  };
  
  if (zoom !== undefined) {
    query.z = zoom;
  }
  
  return this.find(query);
};

export const DEMTile = mongoose.model<IDEMTile>('DEMTile', DEMTileSchema);

