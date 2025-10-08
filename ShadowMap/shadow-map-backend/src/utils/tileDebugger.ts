/**
 * 瓦片调试工具
 * 帮助诊断0建筑物问题，验证瓦片位置和优化查询策略
 */

// 瓦片坐标转地理坐标
export function tileToLatLng(x: number, y: number, z: number): {
  north: number; south: number; east: number; west: number;
  center: { lat: number; lng: number };
} {
  const n = Math.pow(2, z);
  
  // 计算边界
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  
  const north = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
  const south = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
  
  const center = {
    lat: (north + south) / 2,
    lng: (east + west) / 2
  };
  
  return { north, south, east, west, center };
}

// 生成地图链接用于验证
export function generateMapLinks(z: number, x: number, y: number): {
  googleMaps: string;
  openStreetMap: string;
  bingMaps: string;
  tileCoords: string;
  area: string;
} {
  const bounds = tileToLatLng(x, y, z);
  const { lat, lng } = bounds.center;
  
  return {
    googleMaps: `https://www.google.com/maps/@${lat},${lng},${Math.min(z + 2, 20)}z`,
    openStreetMap: `https://www.openstreetmap.org/#map=${Math.min(z + 2, 18)}/${lat}/${lng}`,
    bingMaps: `https://www.bing.com/maps?cp=${lat}~${lng}&lvl=${Math.min(z + 2, 20)}`,
    tileCoords: `Tile: ${z}/${x}/${y}`,
    area: `Area: ${((bounds.east - bounds.west) * 111 * Math.cos(lat * Math.PI/180)).toFixed(2)}km × ${((bounds.north - bounds.south) * 111).toFixed(2)}km`
  };
}

// 改进的OSM查询生成器
export function generateOptimizedOverpassQuery(bbox: {
  west: number; south: number; east: number; north: number;
}, mode: 'strict' | 'normal' | 'loose' = 'normal'): string {
  
  const bboxStr = `${bbox.south.toFixed(7)},${bbox.west.toFixed(7)},${bbox.north.toFixed(7)},${bbox.east.toFixed(7)}`;
  
  switch (mode) {
    case 'strict':
      // 原来的严格模式 - 只包含主要建筑类型
      return `[out:json][timeout:25];
(
  way["building"~"^(yes|house|residential|apartments|commercial|retail|office|industrial|warehouse)$"](${bboxStr});
  relation["building"](${bboxStr});
);
out geom;`;

    case 'normal':
      // 正常模式 - 包含更多建筑类型
      return `[out:json][timeout:25];
(
  way["building"~"^(yes|house|residential|apartments|commercial|retail|office|industrial|warehouse|school|hospital|church|hotel|public|civic|dormitory|kindergarten|university)$"](${bboxStr});
  relation["building"](${bboxStr});
);
out geom;`;

    case 'loose':
      // 宽松模式 - 包含所有有building标签的元素
      return `[out:json][timeout:25];
(
  way["building"](${bboxStr});
  relation["building"](${bboxStr});
);
out geom;`;
  }
}

// 地理区域类型推断
export function inferAreaType(lat: number, lng: number): {
  type: string;
  likelihood: string;
  expectedBuildings: string;
} {
  // 简单的启发式判断
  const absLat = Math.abs(lat);
  const absLng = Math.abs(lng);
  
  // 水域检测（非常粗略）
  if (absLat < 1 && absLng < 1) {
    return {
      type: '赤道海域',
      likelihood: '低建筑密度',
      expectedBuildings: '0-10个/km²'
    };
  }
  
  if (absLat > 70) {
    return {
      type: '极地区域', 
      likelihood: '极低建筑密度',
      expectedBuildings: '0-1个/km²'
    };
  }
  
  // 中国区域判断
  if (lat > 20 && lat < 50 && lng > 75 && lng < 135) {
    if (lat > 35 && lat < 45 && lng > 110 && lng < 125) {
      return {
        type: '中国北方城市区域',
        likelihood: '中等-高建筑密度', 
        expectedBuildings: '10-100个/km²'
      };
    }
    return {
      type: '中国区域',
      likelihood: '中等建筑密度',
      expectedBuildings: '5-50个/km²'
    };
  }
  
  // 欧洲
  if (lat > 35 && lat < 70 && lng > -10 && lng < 40) {
    return {
      type: '欧洲区域',
      likelihood: '中等-高建筑密度',
      expectedBuildings: '20-200个/km²'  
    };
  }
  
  // 北美
  if (lat > 25 && lat < 60 && lng > -130 && lng < -60) {
    return {
      type: '北美区域',
      likelihood: '中等建筑密度',
      expectedBuildings: '10-100个/km²'
    };
  }
  
  return {
    type: '其他区域',
    likelihood: '未知建筑密度', 
    expectedBuildings: '0-?个/km²'
  };
}

// 调试单个瓦片
export function debugTile(z: number, x: number, y: number): {
  coordinates: ReturnType<typeof tileToLatLng>;
  mapLinks: ReturnType<typeof generateMapLinks>;
  areaInfo: ReturnType<typeof inferAreaType>;
  queries: {
    strict: string;
    normal: string;
    loose: string;
  };
  recommendations: string[];
} {
  const coordinates = tileToLatLng(x, y, z);
  const mapLinks = generateMapLinks(z, x, y);
  const areaInfo = inferAreaType(coordinates.center.lat, coordinates.center.lng);
  
  const queries = {
    strict: generateOptimizedOverpassQuery(coordinates, 'strict'),
    normal: generateOptimizedOverpassQuery(coordinates, 'normal'), 
    loose: generateOptimizedOverpassQuery(coordinates, 'loose')
  };
  
  const recommendations = [];
  
  if (areaInfo.expectedBuildings.startsWith('0')) {
    recommendations.push('该区域预期建筑密度很低，0个结果可能是正常的');
  } else {
    recommendations.push('该区域预期有建筑物，建议使用宽松模式查询');
    recommendations.push('考虑检查OSM数据完整性');
  }
  
  if (z < 15) {
    recommendations.push(`缩放级别${z}较低，单个瓦片覆盖面积较大，可能包含无建筑区域`);
  }
  
  return {
    coordinates,
    mapLinks, 
    areaInfo,
    queries,
    recommendations
  };
}
