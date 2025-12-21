## Mobility 日照/阴影字段速览（以离线 Python 链路为准）

本仓库支持两条计算链路：

1) **离线/批处理（推荐用于论文与统计）**：`batch_mobility_shadow.py` 直接读取本地 Buildings / Canopy / ERA5 计算  
2) **实时/交互（Demo）**：前端 → 后端 → `POST /api/analysis/shadow` + `/api/weather/current`

两条链路输出字段对齐：最终结果均为 `*-sunlight.csv`，仅生成方式不同。

### 输入（CSV 关键字段）
| 字段 | 描述 | 用途/规则 | 来源 |
| --- | --- | --- | --- |
| timestamp | Unix epoch seconds（秒，int/float） | 向下取整到分钟分桶 | CSV |
| fnl_lon / fnl_lat | 经纬度（默认优先） | 默认作为轨迹点坐标（可用 `MOBILITY_COORD_PRIORITY` 调整） | CSV |
| gps_lon / gps_lat | 经纬度（次优） | `fnl_*` 缺失时使用 | CSV |
| gpx_lon / gpx_lat | 经纬度（再次） | `fnl/gps` 缺失时使用 | CSV |
| air_lon / air_lat | 经纬度（兜底） | 仍缺失时使用 | CSV |
| stay_status | 是否停留（0/1） | 配合 `stay_point_*` 用于更稳定的室内判定/可选坐标策略 | CSV |
| stay_point_x / stay_point_y | 停留点中心（lon/lat） | 仅 `stay_status>=1` 时有效；默认用于室内判定（`MOBILITY_INDOOR_COORD_PRIORITY`） | CSV |
| 其他业务列 | 速度、状态等 | 原样透传到输出 | CSV |

### 分桶与引擎输入（按分钟 bucket）

> 离线链路内部构造与 HTTP 请求体等价的“分钟桶 payload”，但不经过网络；HTTP 链路会把这些字段封装成 `POST /api/analysis/shadow` 请求体。

| 字段 | 描述 | 离线/批处理（Python） | 实时/交互（HTTP） |
| --- | --- | --- | --- |
| bucketStart | 分钟桶起点（UTC ISO，如 `2025-12-14T08:30:00.000Z`） | 内部由 `timestamp` 向下取整生成；写入输出 `bucketStart` | 作为请求体 `timestamp` |
| bucketEnd | 分钟桶终点（兼容字段） | 默认与 `bucketStart` 相同 | 历史实现可能为 `bucketStart + 1min`（两者下游应兼容） |
| bbox | `{west,south,east,north}` | 桶内点包络（零面积会做微扩展） | 请求体 `bbox` |
| timeGranularityMinutes | 时间粒度（分钟） | 固定 `1` | 请求体 `timeGranularityMinutes=1` |
| includeCanopy | 是否将树冠作为遮挡体 | `--include-canopy` / `MOBILITY_INCLUDE_CANOPY` | `metadata.includeCanopy` |
| canopyRasterPath | 树冠 GeoTIFF 路径 | `--canopy` / `SHADOW_ENGINE_CANOPY_RASTER_PATH` | `metadata.canopyRasterPath` |
| buildingsPath / layer | 建筑数据（GPKG/GeoJSON）与图层名 | `--buildings` / `--buildings-layer` | 由后端/GeoServer/WFS 配置决定（Demo） |
| geometry（可选） | 指定分析区域（GeoJSON） | 当前批处理未使用（按 bbox 计算） | 可作为请求体 `geometry` |

### 天气（ERA5，本地；HTTP 仅用于 Demo）

| 字段 | 描述 | 用途 | 来源 |
| --- | --- | --- | --- |
| cloudCover | 0–1 总云量（tcc） | 计算 `sunlightFactor` | ERA5 |
| sunlightFactor | `max(0.15, 1 - tcc*0.85)` | 云量衰减系数 | 计算 |
| solarIrradianceWm2 | 短波辐照度（W/m²）= `energy/Δt` | 夜间快速路径/辐照积分 | ERA5（自动适配 ssrd 形态） |

### 输出（追加字段）
| 字段 | 描述 | 备注 |
| --- | --- | --- |
| sunlit | 0/1 是否日照 | 点级几何判定（离线链路为 0/1） |
| shadowPercent | 0–100 阴影占比 | 离线链路为 0 或 100（命中阴影=100）；`night/fallback_error` 为 0 |
| bucketStart / bucketEnd | 分钟桶起止（UTC ISO） | 用于分钟对齐、聚合 |
| source | `engine` / `night` / `fallback_error` | 成功/夜间快速路径/异常降级 |
| errorDetail | 错误文本（截断） | 仅 `fallback_error` 可能非空 |
| cloudCover | 0–1 | 云量（tcc） |
| sunlightFactor | 0.15–1 | 云量衰减系数 |
| sunlitEffective | `sunlit * sunlightFactor` | `night/fallback_error` 可能为空（下游按 0 处理） |
| shadowPercentEffective | `100 - sunlitEffective*100` | 同上 |
| solarIrradianceWm2 | W/m² | `ssrd` 差分得到的辐照度 |
| irradianceEffective | 阴影掩码后的辐照度（W/m²） | `sunlit=0` → 0，否则 `solarIrradianceWm2` |
| durationSeconds | 当前点代表的时长（秒） | 相邻点差值，clamp 1–300；末行默认 60 |
| sunlightSeconds | `durationSeconds * sunlitEffective` | 有效日照时长（秒） |
| shadowSeconds | `durationSeconds * shadowPercentEffective/100` | 有效阴影时长（秒） |
| irradianceJ | `irradianceEffective * durationSeconds` | 累积辐射能量（J） |
