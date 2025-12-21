## Mobility 日照/阴影算法（1页版，给合作者/论文复现用）

### 0) 目标

对每个移动轨迹点输出分钟级“是否在阴影中”、天气修正后的有效日照、以及辐射能量积分字段：

- 几何：`sunlit`（0/1）、`shadowPercent`（0/100）
- 天气：`cloudCover`、`sunlightFactor`、`solarIrradianceWm2`
- 有效：`sunlitEffective`、`shadowPercentEffective`、`irradianceEffective`
- 积分：`durationSeconds`、`sunlightSeconds`、`shadowSeconds`、`irradianceJ`

入口（推荐离线）：`ShadowMap/scripts/batch_mobility_shadow.py`（通过 `ShadowMap/scripts/batch-mobility-shadow.sh --engine python` 调用）。

---

### 1) 输入

- 轨迹 CSV：至少包含 `timestamp`（Unix epoch seconds）和经纬度列（默认按 `fnl`→`gps`→`gpx`→`air` 优先级取第一组可用坐标；可用 `MOBILITY_COORD_PRIORITY` 覆盖）
  - 室内判定/后处理可单独配置 `MOBILITY_INDOOR_COORD_PRIORITY`，默认优先使用 `stay_point_x/y`（仅 `stay_status>=1` 时有效）提高稳定性
  - 如需规避部分数据中 `fnl_*` 抖动，可临时改成 `MOBILITY_COORD_PRIORITY="gps,fnl,gpx,air"` 做敏感性对照
- 建筑：本地 GPKG/GeoJSON（香港默认 `hong_kong_cleaned.gpkg`，高度字段 `height` 字符串可自动转 float）
- 树冠（可选）：GeoTIFF（如 `HKtree_small.tif`）
- ERA5（本地）：逐小时 NetCDF（`tcc` 与 `ssrd`）

---

### 2) 分桶（minute bucket）

对每条轨迹点：

1) `timestamp` 向下取整到分钟，生成 `bucketStart`（UTC ISO，如 `2025-12-14T08:30:00.000Z`）
2) 同一分钟内的点聚合为一个 bucket，并计算 bucket 的 `bbox`（west/south/east/north）；零面积 bbox 会微扩展。

离线链路默认 `bucketEnd == bucketStart`（历史链路可能写 `bucketStart+1min`，下游应兼容）。

---

### 3) 天气（ERA5 → 辐照度与云量衰减）

对每个 bucket，用 ERA5 最近网格点提取：

- `cloudCover = clamp(tcc, 0..1)`
- `sunlightFactor = max(min, 1 - coef*cloudCover)`（默认 `min=0.15`、`coef=0.85`，可用环境变量 `MOBILITY_SUNLIGHT_FACTOR_MIN / MOBILITY_SUNLIGHT_FACTOR_COEF` 调参；把 `min=0` 可用于“移除下限”的敏感性测试）

敏感性测试（推荐，速度快）：无需重算阴影/树冠/ERA5，可用 `ShadowMap/scripts/recompute_sunlight_factor.py` 对已生成的 `*-sunlight.csv` 重新计算 `sunlightFactor/sunlitEffective/sunlightSeconds` 等字段，快速生成新版本数据集用于对照。

**关键：`ssrd` → `solarIrradianceWm2`（W/m²）**

1) 用 bucket 所在的整点区间 `[hour, hour+1h]` 计算（避免分钟级 nearest 造成午后异常）。
2) 自动识别 `ssrd` 形态：
   - cumulative（累积量）：`energy = ssrd(t1) - ssrd(t0)`（若为负，视为 reset，改用 `ssrd(t1)`）
   - incremental（逐小时能量）：`energy = ssrd(t1)`
3) `solarIrradianceWm2 = max(energy / Δt, 0)`，其中 `Δt` 为 `t1-t0` 秒数。

---

### 4) 夜间快速路径（提速关键）

若 `solarIrradianceWm2 <= MOBILITY_NIGHT_IRRADIANCE_THRESHOLD`（默认 `1e-6`）：

- 直接写 `source=night`，跳过几何阴影计算；
- 输出字段统一写 0/空（下游按 0 处理）。

---

### 5) 几何阴影（建筑 + 树冠）

当不走夜间快速路径时：

1) 读取 Buildings（推荐 `--buildings-mode preload`，Linux/fork 可共享内存）
2) 若 `--include-canopy true`，把 canopy GeoTIFF 转为矢量面并合并到 Buildings 参与遮挡
3) 调用 `engine_core.generate_shadows(buildings, bucketStart, timezone)` 生成阴影多边形
   - 若太阳已落山/低于地平线（引擎会报 “outside daylight”），该 bucket 视为 night：写 `source=night` 且 `solarIrradianceWm2=0`
4) 将阴影面构建 STRtree 空间索引，点落入阴影面 ⇒ `sunlit=0`，否则 `sunlit=1`

---

### 6) 有效量与积分（按行）

- `sunlitEffective = sunlit * sunlightFactor`
- `shadowPercentEffective = 100 - sunlitEffective*100`
- `irradianceEffective = (sunlit==0) ? 0 : solarIrradianceWm2`
- `durationSeconds`：相邻点时间差，clamp 到 `[1,300]`，末行默认 60
- `sunlightSeconds = sunlitEffective * durationSeconds`
- `shadowSeconds = (shadowPercentEffective/100) * durationSeconds`
- `irradianceJ = max(0, irradianceEffective) * durationSeconds`

---

### 7) 质量控制（强烈建议在统计前做）

- 结构完整性：`ShadowMap/scripts/validate_sunlight_csv.py`
- 语义异常（抓“下午系统性清零/全 night”）：`ShadowMap/scripts/qc_sunlight_daylight.py`

---

### 8) （可选但推荐）室内剔除/掩码

如果轨迹点大量位于建筑 footprint 内（室内），日照会被系统性高估。建议在统计前做一次室内处理：

- 脚本：`ShadowMap/scripts/indoor_filter_sunlight_csv.py`
- 推荐模式：`--mode mask`（室内点保留行，但把 `sunlightSeconds/irradianceJ` 等暴露量置 0，并标记 `indoor=1`）
- 推荐并行与断点续跑：加 `--workers N`（文件级并行），中断后再次运行会自动跳过已处理文件（需要时用 `--no-resume` 强制重跑）。
