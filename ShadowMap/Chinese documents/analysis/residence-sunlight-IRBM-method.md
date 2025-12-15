# 居住地阳光暴露（IRBM）计算方法

## 0. 代码实现入口（纯 Python，推荐）

- 脚本：`ShadowMap/scripts/residence_irbm.py`
- 包装器（自动加载 `ShadowMap/.shadowmap.env`）：`ShadowMap/scripts/run_residence_irbm.sh`
- Home 提取：香港本地时间 22:00–06:00，若存在 `stay_status` 列则默认只使用 `stay_status==1` 的夜间点（优先 `stay_point_x/y`，否则回退 `fnl/gps/gpx/air` 坐标）。
- 时间口径：按香港本地日采样（默认 06:00–21:00），并转换为 UTC `*.000Z` 时间戳用于 ERA5 与阴影引擎，保证太阳方位/气象对齐。
- “太阳日”：脚本支持 `--solar-day true`，会采样 0–23 点并依据 `solarIrradianceWm2` 自动跳过夜间小时。

### 0.1 快速运行（产出 `IRBM_daily_all_buffers.csv`）

1) 确认已配置（推荐用 `.shadowmap.env`）：

```bash
cp ShadowMap/.shadowmap.env.example ShadowMap/.shadowmap.env
# 编辑 ShadowMap/.shadowmap.env：至少填好 INPUT_ROOT / OUTPUT_ROOT / BUILDING_LOCAL_GEOJSON / ERA5_FILE_TEMPLATE
```

2) 生成 targets（建议用相对路径，便于跨机器复用）：

```bash
source ShadowMap/.shadowmap.env
mkdir -p "$OUTPUT_ROOT/_shadowmap_tasks"
find "$INPUT_ROOT" -name "*.csv" -type f | sed "s|^$INPUT_ROOT/||" | sort > "$OUTPUT_ROOT/_shadowmap_tasks/irbm_targets.txt"
```

3) 执行（默认断点续跑；关树冠可显著提速）：

```bash
MOBILITY_INCLUDE_CANOPY=false CONCURRENCY=32 bash ShadowMap/scripts/run_residence_irbm.sh \
  --solar-day true \
  --targets-file "$OUTPUT_ROOT/_shadowmap_tasks/irbm_targets.txt" \
  --output "$OUTPUT_ROOT/IRBM_daily_all_buffers.csv" \
  --buffers 100,200,500,1000
```

## 1. 概述 (Overview)

本文档描述如何使用阳光暴露计算应用计算**居住地阳光暴露（Indoor Residence-Based Measurements, IRBM）**，用于与**移动性阳光暴露（Real-time Mobility-Based Measurements, RMBM）**进行比较，以检验**邻里效应平均问题（Neighborhood Effect Averaging Problem, NEAP）**。

### 1.1 理论背景

根据Kwan (2018)提出的NEAP理论：

> 当忽略人们的日常移动性时，基于居住地的环境暴露评估可能存在系统性偏差。移动性暴露（MBE/RMBM）倾向于向平均水平收敛，而居住地暴露（RBE/IRBM）则呈现更大的方差。

**核心假设**：
- 居住在高暴露区域的人，移动性可能导致**下向平均（Downward Averaging）**
- 居住在低暴露区域的人，移动性可能导致**上向平均（Upward Averaging）**
- 部分人群可能是**双重劣势（Doubly Disadvantaged）**：居住地暴露低且移动性无法改善

### 1.2 研究意义

| 比较维度 | IRBM | RMBM |
|----------|------|------|
| **位置** | 固定居住地 | 沿移动轨迹变化 |
| **时间** | 假设全天在家 | 实际活动时间 |
| **代表性** | 居住环境潜在暴露 | 实际接收暴露 |
| **方法论问题** | 忽略移动性（UGCoP） | 更准确但数据需求高 |

---

## 2. 居住地坐标获取

### 2.1 数据来源

居住地坐标从移动轨迹数据中提取，采用以下策略：

```
方法1：夜间停留点识别
- 提取 22:00-06:00 期间的主要停留位置
- 选择停留时长最长的位置作为居住地
```


## 3. 多缓冲区设计

### 3.1 为什么使用缓冲区而非单点？

1. **居住地是建筑物**：室内无法直接接收阳光
2. **可接触环境**：居民会在居住地周边活动（小区、街道）
3. **与参考文献一致**：绿地研究使用100m网格，空气污染研究使用1km网格
4. **敏感性分析**：不同缓冲区可检验结果稳健性

### 3.2 缓冲区半径选择

| 缓冲区 | 含义 | 对应场景 |
|--------|------|----------|
| **100m** | 住宅楼+小区内部 | 高密度城市核心 |
| **200m** | 小区+周边街道 | 日常步行范围 |
| **500m** | 步行5分钟可达 | 社区邻里范围 |
| **1000m** | 步行10分钟可达 | 扩展社区范围 |

**建议**：香港作为高密度城市，主要使用 **200m** 作为主分析，100m/500m/1000m 作为敏感性分析。

### 3.3 缓冲区实现方式

```
方案A：边界框采样（Bounding Box）
- 以居住地为中心，生成指定半径的正方形边界框
- 调用阴影API返回区域平均阴影率
- 优点：计算效率高，一次API调用

方案B：多点采样（Multi-point Sampling）
- 在缓冲区内均匀生成采样点（如3×3或5×5网格）
- 分别计算每个点的阴影状态
- 取平均值作为缓冲区阳光暴露
- 优点：精度更高，适合不规则地形

推荐：方案A（边界框采样），利用API的avgShadowPercent输出
```

---

## 4. IRBM计算流程

### 4.1 输入参数

| 参数 | 描述 | 来源 |
|------|------|------|
| `home_coord` | 居住地坐标 (lat, lon) | 轨迹分析/问卷地址 |
| `buffer_radii` | 缓冲区半径列表 [100, 200, 500, 1000] | 研究设计 |
| `measurement_dates` | 测量日期（与RMBM同期） | RMBM数据 |
| `time_range` | 计算时段 (06:00-22:00) | 与RMBM一致 |

### 4.2 时间采样策略

为平衡计算效率与精度，采用**逐小时采样**：

```
采样时间点：06:00, 07:00, 08:00, ..., 21:00 （共16个时间点/天）

每个时间点代表该小时的平均状态
假设：该小时内阳光条件相对稳定
```

**与RMBM的差异**：
- RMBM：分钟级采样，逐点积分
- IRBM：小时级采样，假设小时内稳定

**对齐方式**：两者最终都聚合到日层面进行比较

### 4.3 核心计算公式

#### 4.3.1 单时间点计算

对于居住地坐标 $(x_H, y_H)$、缓冲区半径 $r$、时间点 $t$：

**步骤1：获取区域平均阴影率**
$$\bar{S}_{shadow}(t) = \text{API.avgShadowPercent}(\text{bbox}(x_H, y_H, r), t)$$

**步骤2：计算区域平均日照状态**
$$\bar{S}_{sunlit}(t) = 1 - \frac{\bar{S}_{shadow}(t)}{100}$$

**步骤3：获取ERA5气象数据**
$$K_{cloud}(t) = \text{sunlightFactor}(x_H, y_H, t)$$
$$I_{atm}(t) = \text{solarIrradianceWm2}(x_H, y_H, t)$$

**步骤4：计算有效暴露（与RMBM公式完全一致）**
$$S_{eff}(t) = \bar{S}_{sunlit}(t) \times K_{cloud}(t)$$
$$I_{eff}(t) = \bar{S}_{sunlit}(t) \times I_{atm}(t)$$

#### 4.3.2 日累积计算

对于每个采样时间点 $t_i$，时间权重 $\Delta t = 3600$ 秒（1小时）：

**日总有效日照时长（秒）**：
$$T_{sun}^{day} = \sum_{i=1}^{16} S_{eff}(t_i) \times \Delta t$$

**日总有效辐照能量（J）**：
$$E_{total}^{day} = \sum_{i=1}^{16} I_{eff}(t_i) \times \Delta t$$

**日平均有效辐照度（W/m²）**：
$$\bar{I}_{eff}^{day} = \frac{E_{total}^{day}}{T_{sun}^{day}}$$

---

## 5. 指标体系（与RMBM对齐）

### 5.1 时长指标

| 指标名称 | 公式 | 单位 | 说明 |
|----------|------|------|------|
| `IRBM_sunlight_min` | $T_{sun}^{day} / 60$ | 分钟 | 日总有效日照时长 |
| `IRBM_cloud_adj_min` | 同上（已包含云量调整） | 分钟 | 云量调整后日照时长 |
| `IRBM_raw_sunlight_min` | $\sum \bar{S}_{sunlit} \times \Delta t / 60$ | 分钟 | 未调整云量的日照时长 |

### 5.2 强度指标

| 指标名称 | 公式 | 单位 | 说明 |
|----------|------|------|------|
| `IRBM_irradiance_kJ` | $E_{total}^{day} / 1000$ | kJ | 日总有效辐照能量 |
| `IRBM_mean_irradiance` | $\bar{I}_{eff}^{day}$ | W/m² | 日平均有效辐照度 |

### 5.3 时段分层指标

| 时段 | 时间范围 | 指标后缀 |
|------|----------|----------|
| 早上 | 06:00-10:00 | `_morning` |
| 中午 | 10:00-14:00 | `_midday` |
| 下午 | 14:00-18:00 | `_afternoon` |
| 傍晚 | 18:00-22:00 | `_evening` |

**时段指标**：`IRBM_morning_min`, `IRBM_midday_min`, `IRBM_afternoon_min`, `IRBM_evening_min`
**时段辐照**：`IRBM_morning_kJ`, `IRBM_midday_kJ`, `IRBM_afternoon_kJ`, `IRBM_evening_kJ`

### 5.4 多缓冲区指标命名

```
格式：IRBM_{buffer}m_{metric}

示例：
- IRBM_100m_sunlight_min    # 100m缓冲区日照时长
- IRBM_200m_irradiance_kJ   # 200m缓冲区辐照能量
- IRBM_500m_afternoon_min   # 500m缓冲区下午日照
- IRBM_1000m_mean_irradiance # 1000m缓冲区平均辐照度
```

---

## 6. 输出数据结构

### 6.1 日层面输出

```
文件：IRBM_daily_all_buffers.csv

列名：
- ID：参与者ID
- date：日期
- buffer_m：缓冲区半径（100/200/500/1000）
- IRBM_sunlight_min：日总日照时长（分钟）
- IRBM_irradiance_kJ：日总辐照能量（kJ）
- IRBM_mean_irradiance：日平均辐照度（W/m²）
- IRBM_morning_min：早上日照（分钟）
- IRBM_midday_min：中午日照（分钟）
- IRBM_afternoon_min：下午日照（分钟）
- IRBM_evening_min：傍晚日照（分钟）
- IRBM_morning_kJ, IRBM_midday_kJ, IRBM_afternoon_kJ, IRBM_evening_kJ
- n_samples：有效采样次数
```

### 6.2 个人层面输出（聚合）

```
文件：IRBM_individual_all_buffers.csv

聚合方式：对每个参与者的所有测量日取平均

列名：
- ID：参与者ID
- n_days：有效天数
- IRBM_100m_sunlight_min, IRBM_200m_sunlight_min, ...
- IRBM_100m_irradiance_kJ, IRBM_200m_irradiance_kJ, ...
- （各缓冲区、各时段的所有指标）
```

### 6.3 宽格式合并输出（用于NEAP分析）

```
文件：IRBM_RMBM_comparison.csv

合并RMBM和IRBM数据，便于直接比较

列名：
- ID, date
- RMBM_sunlight_min, RMBM_irradiance_kJ, RMBM_morning_min, ...
- IRBM_100m_sunlight_min, IRBM_100m_irradiance_kJ, ...
- IRBM_200m_sunlight_min, IRBM_200m_irradiance_kJ, ...
- IRBM_500m_sunlight_min, ...
- IRBM_1000m_sunlight_min, ...
- diff_100m：RMBM - IRBM_100m（差异）
- diff_200m, diff_500m, diff_1000m
```

---

## 7. NEAP检验分析框架

### 7.1 描述性比较

```
1. 配对t检验：H0: μ_RMBM = μ_IRBM
2. 相关性分析：r(RMBM, IRBM)
3. Bland-Altman图：评估一致性
4. 方差比较：Var(RMBM) vs Var(IRBM)
```

**预期结果**（根据NEAP理论）：
- RMBM方差 < IRBM方差（移动性导致收敛）
- 高IRBM区域：RMBM < IRBM（下向平均）
- 低IRBM区域：RMBM > IRBM（上向平均）

### 7.2 NEAP模式识别

```
上向平均（Upward Averaging）：
- 条件：RMBM > IRBM
- 含义：移动性增加了阳光暴露

下向平均（Downward Averaging）：
- 条件：RMBM < IRBM
- 含义：移动性减少了阳光暴露

双重劣势（Doubly Disadvantaged）：
- 条件：IRBM < 平均值 × 0.8 且 RMBM ≤ IRBM
- 含义：居住地暴露低，移动性也无法改善
```

### 7.3 敏感性分析

```
1. 缓冲区敏感性：
   - 比较100m, 200m, 500m, 1000m的结果
   - 检验结论是否随缓冲区大小变化

2. 时段敏感性：
   - 分别分析早上、中午、下午、傍晚
   - 检验NEAP是否在特定时段更明显

3. 指标敏感性：
   - 时长 vs 强度
   - 检验不同指标的NEAP模式是否一致
```

### 7.4 GLMM比较模型

```
Model 1: PSQI ~ RMBM_sunlight + covariates
Model 2: PSQI ~ IRBM_100m_sunlight + covariates
Model 3: PSQI ~ IRBM_200m_sunlight + covariates
Model 4: PSQI ~ IRBM_500m_sunlight + covariates
Model 5: PSQI ~ IRBM_1000m_sunlight + covariates

比较指标：
- β系数：效应大小和方向
- p值：统计显著性
- AIC/BIC：模型拟合度
- R²：解释方差比例
```

**解释**：
- 若RMBM效应显著而IRBM不显著 → 支持NEAP假说，移动性测量更准确
- 若两者效应一致 → NEAP影响不大，可用IRBM替代
- 若IRBM效应更强 → 需重新审视假设

---

## 8. 质量控制

### 8.1 数据有效性检查

```
1. 居住地坐标检查：
   - 坐标在香港边界内
   - 坐标不在海域/郊野公园
   - 与轨迹数据有重叠（确认同一参与者）

2. 时间匹配检查：
   - IRBM计算日期与RMBM测量日期一致
   - 日期数量相同

3. API返回检查：
   - avgShadowPercent在0-100范围内
   - ERA5数据无缺失
   - 夜间（日落后）自动标记为0暴露
```

### 8.2 异常值处理

```
1. 夜间过滤：
   - 日出前、日落后的时间点阳光暴露设为0
   - 使用suncalc计算当日日出日落时间

2. 极端天气：
   - 云量=1时，有效日照接近0
   - 保留但在分析中作为敏感性检验

3. API错误：
   - 记录source字段标记的错误
   - 统计错误率，>5%需人工检查
```

---

## 9. 参考文献

1. Kwan, M.-P. (2018). The neighborhood effect averaging problem (NEAP): An elusive confounder of the neighborhood effect. *International Journal of Environmental Research and Public Health*, 15(9), 1841.

2. Kim, J., & Kwan, M.-P. (2021). How neighborhood effect averaging might affect assessment of individual exposures to air pollution: A study of ozone exposures in Los Angeles. *Annals of the American Association of Geographers*, 111(1), 121-140.

3. Wang, J., Kwan, M.-P., Xiu, G., Peng, X., & Liu, Y. (2024). Investigating the neighborhood effect averaging problem (NEAP) in greenspace exposure: A study in Beijing. *Landscape and Urban Planning*, 243, 104970.

4. Cui, Y., Kwan, M.-P., & Liu, Y. (2025). Individual-Level Exposure to Light at Night and Sleep Health: A Comparison between Real-Time Mobility-Based Measurements and Indoor Residence-Based Measurements. *Environmental Science & Technology*, 59, 23349-23361.

---

## 附录A：API调用参数

### A.1 阴影计算API

```json
POST /api/analysis/shadow

请求参数：
{
  "bbox": {
    "west": 114.1594,
    "south": 22.3093,
    "east": 114.1794,
    "north": 22.3293
  },
  "timestamp": "2022-03-15T10:00:00",
  "timeGranularityMinutes": 1,
  "outputs": {
    "shadowPolygons": false,
    "sunlightGrid": false,
    "heatmap": false
  },
  "metadata": {
    "includeCanopy": true
  }
}

返回字段：
{
  "avgShadowPercent": 45.3,  // 区域平均阴影率
  "timestamp": "2022-03-15T10:00:00"
}
```

### A.2 天气数据API

```json
GET /api/weather/current

请求参数：
{
  "lat": 22.3193,
  "lon": 114.1694,
  "timestamp": "2022-03-15T10:00:00"
}

返回字段：
{
  "cloudCover": 0.3,           // 云量 0-1
  "sunlightFactor": 0.745,     // 日照衰减系数
  "solarIrradianceWm2": 856.2  // 辐照度 W/m²
}
```

---

## 附录B：缓冲区边界框计算

```
给定：居住地坐标 (lat, lon)，缓冲区半径 r（米）

计算边界框：
- 纬度偏移：Δlat = r / 111320
- 经度偏移：Δlon = r / (111320 × cos(lat × π/180))

边界框：
- west = lon - Δlon
- east = lon + Δlon
- south = lat - Δlat
- north = lat + Δlat
```

**香港纬度约22°，1m ≈ 0.000009°（纬度），≈ 0.0000097°（经度）**

