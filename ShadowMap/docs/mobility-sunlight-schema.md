## Mobility 日照/阴影字段速览（简版）

### 输入（CSV）
| 名称 | 描述 | 来源 |
| --- | --- | --- |
| timestamp | 秒级时间戳（UTC） | CSV |
| fnl_lon / fnl_lat | 经纬度（优先） | CSV |
| gps_lon / gps_lat | 经纬度（次优） | CSV |
| gpx_lon / gpx_lat | 经纬度（再次） | CSV |
| air_lon / air_lat | 经纬度（兜底） | CSV |
| 其他列 | traceId、速度等，原样透传 | CSV |

### 请求（按分钟桶，POST /api/analysis/shadow）
| 名称 | 描述 | 来源 |
| --- | --- | --- |
| bbox | {west,south,east,north} | 桶内点包络 |
| timestamp | 分钟起点 ISO | 分桶时间 |
| timeGranularityMinutes | 1 | 固定 |
| outputs | shadowPolygons/sunlightGrid/heatmap=false | 固定 |
| metadata.includeCanopy | 是否含树冠 | 默认 true / 调用方 |
| metadata.canopyRasterPath | 树冠栅格路径 | 环境/调用方 |
| geometry | 可选 GeoJSON | 调用方 |

### 云量（并行 `/api/weather/current`）
| 名称 | 描述 | 来源 |
| --- | --- | --- |
| cloudCover | 0–1 云量 | 天气接口 |
| sunlightFactor | 0.15–1 衰减系数 | 由 cloudCover 计算 |

### 输出（追加到每行）
| 名称 | 描述 | 来源 |
| --- | --- | --- |
| sunlit | 0/1 是否在日照 | 阴影多边形 / 均值回退 |
| shadowPercent | 0–100 阴影占比 | 阴影多边形 / 均值回退 |
| bucketStart / bucketEnd | 分钟桶时间 | 请求/响应 |
| source | engine / fallback_* | 引擎或降级 |
| cloudCover | 0–1 云量 | 天气接口（失败为空） |
| sunlightFactor | 0.15–1 | 天气接口（失败视为 1） |
| sunlitEffective | sunlit * sunlightFactor | 计算 |
| shadowPercentEffective | 100 - sunlitEffective*100 | 计算 |
| solarIrradianceWm2 | 短波辐照度 W/m² | 天气接口（GFS dswrf，失败为空） |
| irradianceEffective | 阴影掩码后的辐照度（阴影=0，日照=dswrf） | 计算 |
| durationSeconds | 当前点代表的时长（到下一点，兜底/上限） | 计算 |
| sunlightSeconds | durationSeconds * sunlitEffective | 计算 |
| shadowSeconds | durationSeconds * shadowPercentEffective/100 | 计算 |
| irradianceJ | irradianceEffective * durationSeconds | 计算 |
