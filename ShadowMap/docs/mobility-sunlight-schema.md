## Mobility 日照/阴影字段速览

### 输入（CSV 关键字段）
| 变量 | 描述 | 用途 | 来源 |
| --- | --- | --- | --- |
| timestamp | 秒级时间戳（UTC） | 分桶至分钟 | CSV |
| fnl_lon / fnl_lat | 经纬度（优先） | 定位 | CSV |
| gps_lon / gps_lat | 经纬度（次优） | 定位 | CSV |
| gpx_lon / gpx_lat | 经纬度（再次） | 定位 | CSV |
| air_lon / air_lat | 经纬度（兜底） | 定位 | CSV |
| 其他业务列 | traceId/速度等 | 透传 | CSV |

### 请求（按分钟桶，POST /api/analysis/shadow）
| 变量 | 描述 | 用途 | 来源 |
| --- | --- | --- | --- |
| bbox | {west,south,east,north} | 限定建筑/树冠查询范围 | 桶内点包络 |
| timestamp | 分钟起点 ISO | 对应分钟桶 | 分桶时间 |
| timeGranularityMinutes | 固定 1 | 控制时间步长 | 固定 |
| outputs | shadowPolygons/sunlightGrid/heatmap=false | 控制返回内容 | 固定 |
| metadata.includeCanopy | 是否含树冠 | 控制遮挡 | 默认 true/调用方 |
| metadata.canopyRasterPath | 树冠栅格路径 | 控制遮挡 | 环境/调用方 |
| geometry | 可选 GeoJSON | 限定分析区域 | 调用方 |

### 天气（并行 `/api/weather/current`，ERA5 本地）
| 变量 | 描述 | 用途 | 来源 |
| --- | --- | --- | --- |
| cloudCover | 0–1 云量（tcc） | 计算 sunlightFactor | ERA5 |
| sunlightFactor | 0.15–1（1 - tcc*0.85） | 衰减日照 | 计算 |
| solarIrradianceWm2 | 短波辐照度 W/m²（ssrd 差分/Δt） | 叠加阴影掩码 | ERA5 |

### 输出（追加字段）
| 变量 | 描述 | 用途 | 来源 |
| --- | --- | --- | --- |
| sunlit | 0/1 是否日照 | 基础判定 | 引擎结果/回退 |
| shadowPercent | 0–100 阴影占比 | 基础判定 | 引擎结果/回退 |
| bucketStart / bucketEnd | 分钟桶起止 | 对齐分钟 | 请求/响应 |
| source | engine / fallback_error/400/500 等 | 标记数据来源或降级原因 | 计算 |
| errorDetail | 错误文本（含状态码） | 调试/过滤 | 计算 |
| cloudCover | 0–1 | 记录云量 | 天气 |
| sunlightFactor | 0.15–1 | 记录衰减系数 | 天气 |
| sunlitEffective | sunlit * sunlightFactor | 云量修正 | 计算 |
| shadowPercentEffective | 100 - sunlitEffective*100 | 云量修正 | 计算 |
| solarIrradianceWm2 | 辐照度 W/m² | 记录原值 | 天气 |
| irradianceEffective | 阴影掩码后的辐照度 | 物理量计算 | 计算 |
| durationSeconds | 当前点代表的时长（邻点差，限 1–300s） | 积分时长 | 计算 |
| sunlightSeconds | durationSeconds * sunlitEffective | 日照时长 | 计算 |
| shadowSeconds | durationSeconds * shadowPercentEffective/100 | 阴影时长 | 计算 |
| irradianceJ | irradianceEffective * durationSeconds | 辐照能量（J） | 计算 |
