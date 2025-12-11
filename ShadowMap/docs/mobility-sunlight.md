## Mobility 日照/阴影计算说明（更新版）

### 概览
- 入口：`react-shadow-app/src/services/mobilitySunlightService.ts` → `computeMobilitySunlightForRows`。
- 目标：按分钟聚合轨迹点，调用后端 `/api/analysis/shadow`（建筑 + 可选树冠），并叠加 ERA5 云量与辐照度得到 `sunlit`、云量修正后的时长/能量。
- 室内：未区分，默认室外。

### 输入要点
- 经度纬度优先级：`fnl_lon/fnl_lat` → `gps` → `gpx` → `air`；`timestamp` 秒级 UTC，后续按分钟取整。
- 其他业务字段透传。

### 处理流程（前端）
1) 分桶：`timestamp` 取整到分钟作为 bucket key。
2) 生成 bbox：桶内点包络并微扩展避免零面积。
3) 请求引擎：`bbox`、分钟 `timestamp`、`timeGranularityMinutes=1`、`outputs` (shadow/sunlight=true, heatmap=false)、`metadata`（includeCanopy/canopyRasterPath）。
4) 并行天气：调用 `/api/weather/current`（本地 ERA5 tcc/ssrd），得 `sunlightFactor= max(0.15,1-tcc*0.85)`，`solarIrradianceWm2 = Δssrd/Δt`。
5) 判定与修正：
   - 有阴影多边形：命中 → `sunlit=0`，否则 `sunlit=1`；无多边形回退均值。
   - 云量修正：`sunlitEffective = sunlit * sunlightFactor`，`shadowPercentEffective = 100 - sunlitEffective*100`。
   - 辐照度：阴影=0，否则用 `solarIrradianceWm2`；积分量 `irradianceJ = irradianceEffective * durationSeconds`。
6) 错误降级：夜间 400、无建筑 500 视为缺失，可通过 buckets 增量重跑；其他错误标记 `fallback_error:5xx`。

### 后端要点
- 路由：`shadow-map-backend/src/routes/analysis.ts` 解析 `bbox/timestamp/geometry/outputs/metadata`。
- 天气：`/api/weather/current` 读取本地 ERA5（`ERA5_FILE_TEMPLATE`），返回云量/辐照度并给出 `sunlightFactor`。
- 引擎：优先 FastAPI（`SHADOW_ENGINE_BASE_URL`），否则本地 CLI；metadata 合并 `.env` 树冠路径。
- 支持按桶增量重算（`--buckets-file`，保留旧值只覆盖指定桶）。

### 输出要点
- 关键字段：`sunlit`、`shadowPercent`、`bucketStart/bucketEnd`、`source/errorDetail`、`cloudCover/sunlightFactor`、`sunlitEffective/shadowPercentEffective`、`solarIrradianceWm2/irradianceEffective`、`durationSeconds/sunlightSeconds/shadowSeconds/irradianceJ`。
- 原 CSV 列保持不变，按时间升序输出。
