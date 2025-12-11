## Mobility 日照/阴影计算逻辑（最新版）

### 核心目标
- 按分钟聚合轨迹点，结合建筑+可选树冠，判定日照/阴影并附带云量/辐照度修正。
- 关键输出：`sunlit`/`shadowPercent`、云量衰减后的 `sunlitEffective`、辐照度及积分量（秒、焦耳）。

### 前端流程（`computeMobilitySunlightForRows`）
1) **分桶**：`timestamp` 取整到分钟作为 bucket key。
2) **bbox**：桶内点取包络，`ensureNonZeroBounds` 防零面积。
3) **请求体**（POST `/api/analysis/shadow`）：
   - `bbox`, `timestamp`（分钟起点）, `timeGranularityMinutes=1`
   - `outputs`: shadow/sunlight 开启、heatmap 关闭
   - `metadata`: `includeCanopy`（默认 true）、`canopyRasterPath`
4) **天气并行**：同一分钟调用 `/api/weather/current`，本地 ERA5（tcc/ssrd）：
   - `sunlightFactor = max(0.15, 1 - tcc*0.85)`
   - `solarIrradianceWm2` = 相邻 ssrd 差分 / Δt（W/m²），ERA5 已含云量衰减
5) **判定**：
   - 有多边形：点落阴影 → `sunlit=0`；否则 `sunlit=1`
   - 无多边形：回退 `metrics.avgShadowPercent`
   - 云量修正：`sunlitEffective = sunlit * sunlightFactor`；`shadowPercentEffective = 100 - sunlitEffective*100`
   - 辐照度：阴影=0，否则用 `solarIrradianceWm2`；积分 `irradianceJ = irradianceEffective * durationSeconds`
6) **错误/降级**：
   - 夜间（400 Outside daylight）：保留 400 但可不重算
   - 无建筑（500 文案包含 No building features）：视为缺失
   - 其他错误：`fallback_error`，可用 buckets 文件增量重跑
7) **输出整理**：按时间升序，附 `bucketStart/bucketEnd`、时长与积分字段。

### 后端流程（`shadowAnalysisService.run`）
1) 路由解析 `bbox/timestamp/geometry/outputs/metadata`，分钟取整，outputs 默认 shadow/sunlight=true, heatmap=false。
2) 天气：`/api/weather/current` 调用 ERA5 本地文件（`ERA5_FILE_TEMPLATE`），返回 tcc/ssrd→`sunlightFactor`/`solarIrradianceWm2`。
3) 引擎：优先 FastAPI（`SHADOW_ENGINE_BASE_URL`），否则本地 Python CLI，或模拟；metadata 合并 `.env` 树冠路径。
4) 缓存：key 含 bbox、bucketStart、granularity、geometryHash、outputs（当前未含 metadata）。
5) 进阶：支持按桶增量重跑（`--buckets-file`），已算好的行会保留，只有指定桶被覆盖。

### 数据源与假设
- 太阳位置/阴影：NREL SPA（Reda & Andreas 2003）。
- ERA5 single-levels：tcc（云量比值）、ssrd（累积 J/m²，1h 分辨率，0.25°），ssrd 已含云/气溶胶衰减，阴影仅做掩码。
- 积分假设：相邻时间状态恒定，矩形法积算；持续时长按相邻点差值并限制上/下限。
