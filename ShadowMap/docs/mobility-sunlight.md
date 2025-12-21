## Mobility 日照/阴影计算说明（统一版）

本仓库同时支持两条计算链路：

1) **实时/交互（HTTP）**：前端 → 后端 `/api/analysis/shadow` + `/api/weather/current`  
2) **论文/离线批处理（Python-first，推荐）**：`batch_mobility_shadow.py` 直接读取本地 Buildings/Canopy/ERA5（无 HTTP）

> 论文/统计分析优先使用离线批处理链路，避免网络与服务状态引入的噪声。

### 入口与职责

- **离线批处理（推荐）**
  - 入口：`ShadowMap/scripts/batch-mobility-shadow.sh --engine python`
  - 核心：`ShadowMap/scripts/batch_mobility_shadow.py`
  - 批量 runner：`ShadowMap/scripts/run_full_recal_batch.sh`（单次 Python 调用 + 单进程池）
- **实时/交互（Demo）**
  - 前端：`shadow-map-frontend/react-shadow-app/src/services/mobilitySunlightService.ts`
  - 后端：`shadow-map-backend/src/routes/analysis.ts`、`shadow-map-backend/src/routes/weather.ts`

### 输入要点（CSV）

- `timestamp`：Unix epoch seconds（整数或浮点），用于按分钟分桶。
- 坐标优先级：`fnl_lon/fnl_lat` → `gps` → `gpx` → `air`（取第一组可用坐标，可用 `MOBILITY_COORD_PRIORITY` 覆盖）。
  - 室内判定/后处理可单独配置 `MOBILITY_INDOOR_COORD_PRIORITY`，默认优先 `stay_point_x/y`（仅 `stay_status>=1` 时有效）。
- 其他业务字段透传；当前 mobility 输出不区分室内/室外（如需室内逻辑请在下游处理或在前端渲染层做标注）。

### 核心流程（分钟桶）

1) **时间分桶**：按 `timestamp` 向下取整到分钟，生成 `bucketStart`（UTC ISO, `...Z`）。
2) **范围生成**：桶内点生成 `bbox`；零面积 bbox 会做微扩展。
3) **天气（ERA5，本地）**：
   - 变量：`tcc`（cloudCover, 0–1）、`ssrd`（累积 J/m²）。
   - `sunlightFactor = max(0.15, 1 - tcc*0.85)`
   - `solarIrradianceWm2 = energy/Δt`（W/m²）
     - 若 `ssrd` 为“累积量”（cumulative），则 `energy = max(0, ssrd(t1)-ssrd(t0))`
     - 若 `ssrd` 已是“逐小时累积”（incremental），则 `energy = max(0, ssrd(t1))`
     - 实现会自动探测两种形态并选择合适公式（见 `ShadowMap/scripts/batch_mobility_shadow.py`、`ShadowMap/scripts/era5_extract.py`）
4) **夜间快速路径（离线批处理）**：
   - 若 `solarIrradianceWm2 <= MOBILITY_NIGHT_IRRADIANCE_THRESHOLD`，直接标记 `source=night`，跳过几何阴影计算。
5) **阴影建模（建筑 + 可选树冠）**：
   - Buildings：本地 GPKG/GeoJSON（建议 `--buildings-mode preload`）。
   - Canopy：栅格 GeoTIFF → 通过 `engine_core.canopy_to_gdf()` 提取为矢量面并合并到 Buildings（`--include-canopy true`）。
   - 阴影引擎：`engine_core.generate_shadows()`（pybdshadow）。
6) **点级判定**：
   - 将阴影多边形构建空间索引（STRtree），点落入阴影 → `sunlit=0`，否则 `sunlit=1`；`shadowPercent` 为 0 或 100。
7) **云量与辐射修正（可用于统计）**：
   - `sunlitEffective = sunlit * sunlightFactor`
   - `shadowPercentEffective = 100 - sunlitEffective*100`
   - `irradianceEffective = (sunlit==0) ? 0 : solarIrradianceWm2`
8) **积分字段（按行）**：
   - `durationSeconds`：相邻点时间差（clamp 1–300s，末行默认 60s）
   - `sunlightSeconds / shadowSeconds / irradianceJ`：按 `durationSeconds` 积分

### 输出要点（追加字段）

- 基础：`sunlit`、`shadowPercent`、`bucketStart/bucketEnd`、`source/errorDetail`
- 天气：`cloudCover`、`sunlightFactor`、`solarIrradianceWm2`
- 修正：`sunlitEffective`、`shadowPercentEffective`、`irradianceEffective`
- 积分：`durationSeconds`、`sunlightSeconds`、`shadowSeconds`、`irradianceJ`

> 兼容性说明：Python 离线链路默认 `bucketEnd == bucketStart`；历史 HTTP 链路可能返回 `bucketEnd=bucketStart+1min`，两者均可下游兼容。

### 质量控制（重要）

- 结构校验：`ShadowMap/scripts/validate_sunlight_csv.py`
- 修复历史坏输出：`ShadowMap/scripts/repair_sunlight_csv.py`

建议在进入统计分析之前，对最终输出根目录做一次 `validate`（抽样或全量）。
