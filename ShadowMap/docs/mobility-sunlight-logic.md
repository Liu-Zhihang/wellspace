## Mobility 日照/阴影计算逻辑

### 计算目标
- 对轨迹点按分钟聚合，基于建筑+可选树冠计算每个点的日照/阴影状态。
- 输出每分钟桶的判定结果（`sunlit`/`shadowPercent` 等），并保留原始字段。
- 云量：按分钟获取目标时间/位置的云量（ERA5 tcc），计算太阳衰减系数 `sunlightFactor` 并用于修正结果。
- 辐照度：同源 ERA5 获取 `ssrd`（差分后得到 W/m²），与日照/云量结合得到有效辐照度。
- 室内：未区分，默认视为室外。

### 前端流程（`computeMobilitySunlightForRows`）
1) **分桶**：按分钟将 `timestamp` 归档，使用 `startOfMinuteIso` 作为 bucket key。
2) **构造 bbox**：聚合桶内点，`buildBounds` 得到包络，再通过 `ensureNonZeroBounds` 避免零面积。
3) **请求参数**：
   - `bbox: [west, south, east, north]`
   - `timestamp: bucketStartDate`（分钟起点）
   - `timeGranularityMinutes: 1`
   - `outputs: { shadowPolygons: true, sunlightGrid: true, heatmap: false }`
   - `metadata`: `includeCanopy`（默认 true）+ `canopyRasterPath`（默认 `VITE_CANOPY_RASTER_PATH`），可被调用方覆盖
   - 天气：同一循环内调用 `/api/weather/current?lat&lng&timestamp` 获取云量与 `solarIrradianceWm2`（ERA5 ssrd 差分）→ 计算 `sunlightFactor`
4) **预判/降级**：
   - 夜间（SunCalc 日出/日落前后）：直接标记 `source=fallback_night`，`sunlit=0`，`shadowPercent=100`
   - 退化 bbox：标记 `source=fallback_error`
5) **调用后端**：`shadowAnalysisClient.requestAnalysis` 将上述 payload 发送到 `/api/analysis/shadow`。
6) **结果判定**：
   - 有阴影多边形：`pointInPolygon` 命中 → `sunlit=0, shadowPercent=100`；未命中 → `sunlit=1, shadowPercent=0`
   - 无多边形：回退使用 `metrics.avgShadowPercent`
   - 云量修正：`sunlitEffective = sunlit * sunlightFactor`；`shadowPercentEffective = 100 - sunlitEffective * 100`
   - 辐照度：`irradianceEffective = sunlit === 0 ? 0 : solarIrradianceWm2`（dswrf 已含云量，无需再乘 sunlightFactor；无辐照度则为空）
7) **错误降级**：
   - “No building features” → `source=fallback_no_buildings`，`sunlit=1, shadowPercent=0`
   - 夜间报错 → `source=fallback_night`
   - 其他错误 → `source=fallback_error`
8) **输出排序**：按时间升序返回 `MobilitySunlightSample[]`。

### 后端流程（`shadowAnalysisService.run`）
1) 路由 `src/routes/analysis.ts` 解析 `bbox/timestamp/geometry/outputs/metadata` 并透传。
2) 归一化：分钟取整；`outputs` 默认 shadow/sunlight 开启、heatmap 关闭。
3) 引擎选择：优先 `engineBaseUrl`（FastAPI）；否则 `localScriptPath`（Python CLI）；再否则模拟。
4) Metadata 合并：请求内 + `.env` 的 `SHADOW_ENGINE_CANOPY_RASTER_PATH`。
5) 缓存：key 基于 bbox、bucketStart、granularity、geometryHash、outputs（当前未含 metadata，含/不含树冠请求可能共用缓存，需注意）。
6) 引擎返回后，封装 `ShadowServiceResponse`（附 metrics、cache 信息、warnings）。

### 云量与室内
- 云量：通过天气接口获取对应时间/位置的云量（GFS），转换为 `sunlightFactor`（0.15–1）。在阳光中的点按此系数衰减日照，阴影点保持 0；并提供衍生字段（见 schema 文档）。
- 室内：未区分，默认视为室外。如需室内过滤需新增输入字段或规则。

### 参考与数据源（支撑核心方程）
- 太阳位置与投影：NREL Solar Position Algorithm (Reda & Andreas, 2003, NREL/TP-560-34302)，用于太阳高度/方位角与阴影几何推导。
- 辐照度/云量来源：ERA5 single-levels（本地文件），变量 `ssrd`（surface solar radiation downwards，累计 J/m²，需相邻时刻差分/Δt 转 W/m²）与 `tcc`（total cloud cover），时间分辨率 1h，空间分辨率 ~0.25°。ssrd 已包含云量/气溶胶衰减，仅做阴影掩码。
- 积分假设：相邻时间戳间状态视为恒定，使用矩形法积算时长/辐照量；可按采样间隔或设定上限（当前 5 分钟）约束持续时间。
