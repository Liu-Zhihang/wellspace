import mongoose from 'mongoose';
import { Schema, Document } from 'mongoose';

// 建筑物接口定义
export interface IBuilding extends Document {
  _id: string;
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
  properties: {
    id: string;
    buildingType: string;
    height: number;
    levels?: number;
    area?: number;
    osm_id?: string;
  };
  tile: {
    z: number;
    x: number;
    y: number;
  };
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  last_updated: Date;
  created_at: Date;
}

// 建筑物Schema定义
const BuildingSchema = new Schema<IBuilding>({
  geometry: {
    type: {
      type: String,
      enum: ['Polygon'],
      required: true
    },
    coordinates: {
      type: [[[Number]]],
      required: true
    }
  },
  properties: {
    id: { type: String, required: true, unique: true },
    buildingType: { type: String, required: true, default: 'building' },
    height: { type: Number, required: true, min: 0, max: 1000 },
    levels: { type: Number, min: 1, max: 200 },
    area: { type: Number, min: 0 },
    osm_id: { type: String }
  },
  tile: {
    z: { type: Number, required: true, min: 0, max: 20 },
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 }
  },
  bbox: {
    type: [Number],
    required: true,
    validate: {
      validator: function(bbox: number[]) {
        return bbox.length === 4 && 
               bbox[0] <= bbox[2] && // minLng <= maxLng
               bbox[1] <= bbox[3];   // minLat <= maxLat
      },
      message: 'Invalid bbox format'
    }
  },
  last_updated: { type: Date, default: Date.now },
  created_at: { type: Date, default: Date.now }
}, {
  timestamps: true,
  collection: 'buildings'
});

// 创建地理空间索引
BuildingSchema.index({ geometry: '2dsphere' });
BuildingSchema.index({ 'tile.z': 1, 'tile.x': 1, 'tile.y': 1 });
BuildingSchema.index({ bbox: 1 });
BuildingSchema.index({ 'properties.buildingType': 1 });
BuildingSchema.index({ 'properties.height': 1 });
BuildingSchema.index({ last_updated: 1 });

// 复合索引用于瓦片查询优化
BuildingSchema.index({ 
  'tile.z': 1, 
  'tile.x': 1, 
  'tile.y': 1, 
  'properties.height': -1 
});

export const Building = mongoose.model<IBuilding>('Building', BuildingSchema);

