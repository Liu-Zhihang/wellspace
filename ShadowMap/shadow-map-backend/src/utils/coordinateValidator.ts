/**
 * 坐标系统验证工具
 * 诊断阴影与建筑物错位问题
 */

// 瓦片坐标转换函数 - 标准Web Mercator
export function tileToBounds(x: number, y: number, z: number): {
  north: number; south: number; east: number; west: number;
  center: { lat: number; lng: number };
} {
  const n = Math.pow(2, z);
  
  // 🔧 标准Web Mercator投影公式
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  
  const north = northRad * (180 / Math.PI);
  const south = southRad * (180 / Math.PI);
  
  return {
    north, south, east, west,
    center: {
      lat: (north + south) / 2,
      lng: (east + west) / 2
    }
  };
}

// 地理坐标转瓦片坐标
export function latLngToTile(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  
  const x = (lng + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  
  return {
    x: Math.floor(x),
    y: Math.floor(y)
  };
}

// 验证瓦片坐标一致性
export function validateTileConsistency(lat: number, lng: number, z: number): {
  isConsistent: boolean;
  demTile: { x: number; y: number };
  buildingTile: { x: number; y: number };
  coordinateOffset: { deltaX: number; deltaY: number; distanceMeters: number };
  recommendations: string[];
} {
  // 使用相同算法计算瓦片坐标
  const demTile = latLngToTile(lat, lng, z);
  const buildingTile = latLngToTile(lat, lng, z); // 应该相同
  
  // 计算偏移
  const deltaX = Math.abs(demTile.x - buildingTile.x);
  const deltaY = Math.abs(demTile.y - buildingTile.y);
  
  // 计算实际距离偏移（粗略估算）
  const metersPerTileX = 40075016.686 / Math.pow(2, z); // 地球周长/瓦片数
  const metersPerTileY = metersPerTileX; // 简化处理
  const distanceMeters = Math.sqrt(
    Math.pow(deltaX * metersPerTileX, 2) + 
    Math.pow(deltaY * metersPerTileY, 2)
  );
  
  const isConsistent = deltaX === 0 && deltaY === 0;
  
  const recommendations: string[] = [];
  
  if (!isConsistent) {
    recommendations.push('⚠️ DEM和建筑物瓦片坐标不一致');
    recommendations.push('🔧 检查瓦片坐标转换算法');
  }
  
  if (distanceMeters > 100) {
    recommendations.push(`⚠️ 坐标偏移过大: ${distanceMeters.toFixed(1)}米`);
    recommendations.push('🔧 检查投影系统和坐标精度');
  }
  
  return {
    isConsistent,
    demTile,
    buildingTile,
    coordinateOffset: { deltaX, deltaY, distanceMeters },
    recommendations
  };
}

// DEM高程数据验证
export function validateDEMElevation(r: number, g: number, b: number): {
  elevation: number;
  isValid: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  
  // AWS Terrarium格式解码
  const elevation = (r * 256 + g + b / 256) - 32768;
  
  let isValid = true;
  
  // 验证高程合理性
  if (elevation < -500 || elevation > 9000) {
    isValid = false;
    issues.push(`高程值异常: ${elevation.toFixed(1)}m (合理范围: -500 ~ 9000m)`);
  }
  
  // 验证RGB值合理性
  if (r === 0 && g === 0 && b === 0) {
    isValid = false;
    issues.push('RGB值全为0，可能是无效数据');
  }
  
  if (r === 255 && g === 255 && b === 255) {
    isValid = false;
    issues.push('RGB值全为255，可能是无效数据');
  }
  
  return { elevation, isValid, issues };
}

// 建筑物坐标验证
export function validateBuildingCoordinates(coordinates: number[][][]): {
  isValid: boolean;
  issues: string[];
  bbox: { north: number; south: number; east: number; west: number };
  area: number;
} {
  const issues: string[] = [];
  let isValid = true;
  
  if (!coordinates || !coordinates[0] || coordinates[0].length < 4) {
    return {
      isValid: false,
      issues: ['建筑物坐标数据不完整'],
      bbox: { north: 0, south: 0, east: 0, west: 0 },
      area: 0
    };
  }
  
  const coords = coordinates[0];
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  
  // 验证每个坐标点
  coords.forEach((coord, index) => {
    if (!Array.isArray(coord) || coord.length !== 2) {
      isValid = false;
      issues.push(`坐标点${index}格式错误`);
      return;
    }
    
    const [lng, lat] = coord;
    
    if (typeof lng !== 'number' || typeof lat !== 'number') {
      isValid = false;
      issues.push(`坐标点${index}不是数字`);
      return;
    }
    
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      isValid = false;
      issues.push(`坐标点${index}超出有效范围: [${lng}, ${lat}]`);
      return;
    }
    
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  });
  
  // 检查多边形闭合
  const firstCoord = coords[0];
  const lastCoord = coords[coords.length - 1];
  if (firstCoord[0] !== lastCoord[0] || firstCoord[1] !== lastCoord[1]) {
    issues.push('多边形未闭合');
  }
  
  // 计算面积（鞋带公式）
  let area = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    area += coords[i][0] * coords[i + 1][1] - coords[i + 1][0] * coords[i][1];
  }
  area = Math.abs(area) / 2;
  
  // 转换为平方米（粗略）
  const areaMeters = area * 111000 * 111000;
  
  // 检查面积合理性
  if (areaMeters < 1 || areaMeters > 10000000) { // 1m² ~ 10km²
    issues.push(`建筑面积异常: ${areaMeters.toFixed(1)}m²`);
  }
  
  return {
    isValid,
    issues,
    bbox: { north: maxLat, south: minLat, east: maxLng, west: minLng },
    area: areaMeters
  };
}

// 坐标系对齐验证
export function validateSpatialAlignment(
  demTile: { z: number; x: number; y: number },
  building: { coordinates: number[][][]; properties: any }
): {
  aligned: boolean;
  demBounds: ReturnType<typeof tileToBounds>;
  buildingBounds: ReturnType<typeof validateBuildingCoordinates>['bbox'];
  overlap: number; // 重叠百分比
  offsetMeters: number;
  issues: string[];
  recommendations: string[];
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  
  // 获取DEM瓦片边界
  const demBounds = tileToBounds(demTile.x, demTile.y, demTile.z);
  
  // 验证建筑物坐标
  const buildingValidation = validateBuildingCoordinates(building.coordinates);
  const buildingBounds = buildingValidation.bbox;
  
  // 计算重叠区域
  const overlapWest = Math.max(demBounds.west, buildingBounds.west);
  const overlapEast = Math.min(demBounds.east, buildingBounds.east);
  const overlapNorth = Math.min(demBounds.north, buildingBounds.north);
  const overlapSouth = Math.max(demBounds.south, buildingBounds.south);
  
  const hasOverlap = overlapWest < overlapEast && overlapSouth < overlapNorth;
  
  let overlap = 0;
  let offsetMeters = 0;
  
  if (hasOverlap) {
    const overlapArea = (overlapEast - overlapWest) * (overlapNorth - overlapSouth);
    const demArea = (demBounds.east - demBounds.west) * (demBounds.north - demBounds.south);
    overlap = (overlapArea / demArea) * 100;
  } else {
    // 计算最近距离
    const demCenterLat = demBounds.center.lat;
    const demCenterLng = demBounds.center.lng;
    const buildingCenterLat = (buildingBounds.north + buildingBounds.south) / 2;
    const buildingCenterLng = (buildingBounds.east + buildingBounds.west) / 2;
    
    // 使用Haversine公式计算距离
    offsetMeters = calculateDistance(demCenterLat, demCenterLng, buildingCenterLat, buildingCenterLng);
  }
  
  // 分析问题
  if (overlap < 50) {
    issues.push(`DEM瓦片和建筑物重叠度过低: ${overlap.toFixed(1)}%`);
    recommendations.push('检查瓦片坐标转换算法的一致性');
  }
  
  if (offsetMeters > 500) { // 超过500米偏移
    issues.push(`建筑物和DEM中心偏移过大: ${offsetMeters.toFixed(1)}米`);
    recommendations.push('检查坐标系统和投影配置');
  }
  
  if (!buildingValidation.isValid) {
    issues.push('建筑物坐标数据无效');
    issues.push(...buildingValidation.issues);
    recommendations.push('检查OSM数据质量和坐标转换');
  }
  
  return {
    aligned: hasOverlap && overlap > 80 && offsetMeters < 100,
    demBounds,
    buildingBounds,
    overlap,
    offsetMeters,
    issues,
    recommendations
  };
}

// 计算两点间距离（Haversine公式）
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // 地球半径（米）
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}

// 验证阴影模拟器坐标系配置
export function validateShadowSimulatorConfig(mapConfig: any): {
  valid: boolean;
  issues: string[];
  recommendations: string[];
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  
  // 检查terrain source配置
  if (!mapConfig.terrainSource) {
    issues.push('缺少terrainSource配置');
    recommendations.push('确保配置了正确的DEM数据源');
  } else {
    const terrainSource = mapConfig.terrainSource;
    
    // 检查瓦片大小
    if (terrainSource.tileSize !== 256) {
      issues.push(`terrainSource.tileSize应为256，当前: ${terrainSource.tileSize}`);
      recommendations.push('DEM瓦片大小应与标准Web瓦片一致');
    }
    
    // 检查最大zoom
    if (terrainSource.maxZoom && terrainSource.maxZoom < 15) {
      issues.push(`terrainSource.maxZoom过低: ${terrainSource.maxZoom}`);
      recommendations.push('建议设置maxZoom至少为15以获得足够精度');
    }
    
    // 检查高程解码函数
    if (!terrainSource.getElevation) {
      issues.push('缺少getElevation高程解码函数');
      recommendations.push('必须提供正确的Terrarium格式解码函数');
    }
  }
  
  // 检查建筑物数据格式
  if (!mapConfig.getFeatures) {
    issues.push('缺少getFeatures建筑物数据函数');
    recommendations.push('必须提供建筑物GeoJSON数据');
  }
  
  const valid = issues.length === 0;
  
  if (!valid) {
    recommendations.push('🔧 修复以上配置问题可能解决阴影错位');
  }
  
  return { valid, issues, recommendations };
}

// DEM像素坐标转地理坐标
export function demPixelToLatLng(
  pixelX: number, 
  pixelY: number, 
  tileX: number, 
  tileY: number, 
  zoom: number,
  tileSize: number = 256
): { lat: number; lng: number } {
  // 计算在瓦片内的相对位置
  const relativeX = pixelX / tileSize; // 0-1
  const relativeY = pixelY / tileSize; // 0-1
  
  // 计算实际瓦片坐标（包含小数部分）
  const actualTileX = tileX + relativeX;
  const actualTileY = tileY + relativeY;
  
  // 转换为地理坐标
  const n = Math.pow(2, zoom);
  const lng = (actualTileX / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * actualTileY) / n)));
  const lat = latRad * (180 / Math.PI);
  
  return { lat, lng };
}

// 建筑物中心点计算
export function calculateBuildingCenter(coordinates: number[][][]): { lat: number; lng: number } | null {
  if (!coordinates || !coordinates[0] || coordinates[0].length === 0) {
    return null;
  }
  
  const coords = coordinates[0];
  let sumLng = 0, sumLat = 0;
  let validPoints = 0;
  
  coords.forEach(coord => {
    if (Array.isArray(coord) && coord.length === 2) {
      sumLng += coord[0];
      sumLat += coord[1];
      validPoints++;
    }
  });
  
  if (validPoints === 0) return null;
  
  return {
    lng: sumLng / validPoints,
    lat: sumLat / validPoints
  };
}
