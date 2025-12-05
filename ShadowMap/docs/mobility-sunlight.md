## Mobility 日照/阴影计算说明

### 概览
- 入口：`react-shadow-app/src/services/mobilitySunlightService.ts` 的 `computeMobilitySunlightForRows(rows, options)`。
- 目标：对轨迹点按分钟聚合，调用后端 `/api/analysis/shadow` 获取建筑+可选树冠的阴影结果，为每个点输出 `sunlit`/`shadowPercent` 等字段。
- 室内/云量：当前未区分室内/室外；未引入云量修正，阴影纯由建筑+树冠决定。

### 输入数据
- `MobilityCsvRecord`（主要字段）：
  - `timestamp: Date`（秒级，后续按分钟取整）
  - `coordinates: [lon, lat]`
  - 可选：`traceId`, `speed`, 其他业务字段（原样透传）
- 经纬度优先：`fnl_lon/fnl_lat`，回退 `gps/gpx/air`（批处理脚本亦如此）。

### 流程（前端）
1) **分桶**：`startOfMinuteIso(timestamp)` 作为 bucket key；每个桶收集同一分钟的点。
2) **构造请求**：
   - `bbox: [west, south, east, north]`（桶内点的包络，`ensureNonZeroBounds` 防零面积）
   - `timestamp: bucketStartDate`（分钟起点）
   - `timeGranularityMinutes: 1`
   - `outputs: { shadowPolygons: true, sunlightGrid: true, heatmap: false }`
   - `metadata`：`includeCanopy`（默认 true），`canopyRasterPath`（默认 `VITE_CANOPY_RASTER_PATH`），可由调用方覆盖
3) **预判/降级**：
   - 夜间（SunCalc 日出日落）：`source=fallback_night`，`sunlit=0`，`shadowPercent=100`
   - 退化 bbox：`source=fallback_error`（0/0）
4) **调用后端**：`shadowAnalysisClient.requestAnalysis` 发送上述 payload 至 `/api/analysis/shadow`。
5) **结果判定**：
   - 有多边形：`pointInPolygon` 命中 → `sunlit=0, shadowPercent=100`；未命中 → `sunlit=1, shadowPercent=0`
   - 无多边形：回退 `metrics.avgShadowPercent`
6) **错误降级**：
   - “No building features” → `source=fallback_no_buildings`，`sunlit=1, shadowPercent=0`
   - 夜间报错 → `source=fallback_night`
   - 其他 → `source=fallback_error`
7) **输出排序**：按时间升序返回 `MobilitySunlightSample[]`。

### 后端链路
- 路由：`shadow-map-backend/src/routes/analysis.ts` 解析 `bbox/timestamp/geometry/outputs/metadata` 并调用服务。
- 服务：`shadowAnalysisService.run`（`src/services/shadowAnalysisService.ts`）
  - 归一化：分钟取整；outputs 默认 `shadowPolygons/sunlightGrid=true`，`heatmap=false`
  - 引擎选择：`engineBaseUrl` → 外部 FastAPI；否则 `localScriptPath` → Python CLI；否则模拟
  - metadata：请求内 + `.env` 的 `SHADOW_ENGINE_CANOPY_RASTER_PATH`
  - 缓存：key 基于 bbox、bucketStart、granularity、geometryHash、outputs（当前未包含 metadata，存在含/不含树冠共用缓存的风险）
- 外部引擎请求体示例：
  ```json
  {
    "bbox": { "west": 114.159, "south": 22.277, "east": 114.175, "north": 22.288 },
    "timestamp": "2025-12-03T08:00:00Z",
    "granularityMinutes": 1,
    "outputs": { "shadowPolygons": true, "sunlightGrid": true, "heatmap": false },
    "geometry": null,
    "metadata": { "includeCanopy": true, "canopyRasterPath": "/home/jinlin/data/HKtree_reprojected4326.tif" }
  }
  ```

### 输出数据结构
- `MobilitySunlightSample`（新增字段）：
  - `sunlit: 0 | 1`
  - `shadowPercent: number`（0–100）
  - `bucketStart: string ISO`
  - `bucketEnd: string ISO`
  - `source: 'engine' | 'fallback_no_buildings' | 'fallback_night' | 'fallback_error'`（或内部错误标记，如 `missing_coords`）
- 原始 CSV/记录的字段保持不变。
- 后端响应 `ShadowServiceResponse`（关键字段）：
  - `data.shadows`（Polygon/MultiPolygon FeatureCollection，可空）
  - `metrics.avgShadowPercent`, `avgSunlightHours`, `sampleCount`, `engineLatencyMs`
  - `bucketStart`, `bucketEnd`, `cache.hit/key`
  - `metadata`（回显 includeCanopy/canopyRasterPath 等）

### 已知未覆盖
- 云量：未引入天气/云量修正，完全由建筑+树冠决定阴影。
- 室内/室外：未区分，所有点默认视为室外。

### 批处理脚本
- 位置：`ShadowMap/scripts/batch-mobility-shadow.mjs`
- 功能：递归处理输入目录的 CSV（默认 `../GLAN`），按上述流程调用后端，输出到 `../GLAN_processed`，文件名加 `-sunlight.csv`，保留原字段并追加 `sunlit/shadowPercent/bucketStart/bucketEnd/source`。
- 默认参数：`--backend http://localhost:3001/api/analysis/shadow`，`--canopy /home/jinlin/data/HKtree_reprojected4326.tif`，`--concurrency 4`。可用 `--concurrency 8` 等提升并发。
