# 方法：高分辨率城市移动轨迹日照与辐射暴露计算框架

## 1. 概述 (Overview)

本研究开发了一套集成计算框架，旨在量化个体在复杂的城市形态和动态气象条件下的分钟级日照暴露。该框架将个体移动轨迹与高精度城市形态数据（建筑物与树冠）及再分析气象数据相结合，通过时空分桶、几何阴影模拟及辐射传输方程，计算个体的有效日照时长与累积辐射能量。

## 2. 轨迹数据预处理与时空索引 (Trajectory Preprocessing and Spatiotemporal Indexing)

### 2.1 轨迹点定义

原始轨迹数据由一系列离散的时空点组成。为了处理异构数据源，我们采用优先级策略确定每个轨迹点 $p_i$ 的空间坐标：

$$L_i = \text{first\_valid}(\text{fnl}, \text{gps}, \text{gpx}, \text{air})$$

其中 $L_i = (\phi_i, \lambda_i)$ 分别表示纬度和经度，$t_i$ 为UTC时间戳（秒）。

### 2.2 时间分桶 (Temporal Binning)

为优化计算效率并对齐气象数据，我们将连续的时间戳离散化为分钟级的时间桶（Bucket）。对于任意轨迹点 $p_i(t_i)$，其所属的时间桶键 $T_{bucket}$ 定义为：

$$T_{bucket} = \lfloor t_i / 60 \rfloor \times 60 \quad (\text{epoch seconds})$$

并将其格式化为 UTC 的 ISO 字符串（例如 `2025-12-14T08:30:00.000Z`）作为 `bucketStart`（离线链路默认 `bucketEnd = bucketStart`；历史实现也可能使用 `bucketStart+1min`，两者下游应兼容）。

此步骤的**输入**为原始时间戳 `timestamp`，**输出**为 `bucketStart` 和 `bucketEnd`。

### 2.3 空间包络生成 (Spatial Bounding)

对于同一时间桶 $T_{bucket}$ 内的所有轨迹点集合 $P_{bucket}$，我们计算其空间包络（Bounding Box）以限定后续阴影模拟的计算域：

$$\text{bbox} = \{ \min(\lambda), \min(\phi), \max(\lambda), \max(\phi) \mid (\phi, \lambda) \in P_{bucket} \}$$

该 `bbox` 是阴影检索引擎的**核心输入**参数。

------

## 3. 大气参数反演 (Atmospheric Parameter Retrieval)

为量化大气条件对地表辐射的衰减作用，我们利用 ERA5 Single Levels 再分析数据进行气象参数反演。

### 3.1 辐射与云量参数

对于每个时空桶，我们提取以下变量：

- **输入数据**：ERA5 逐小时数据网格（0.25°分辨率）。
- **总云量 (Total Cloud Cover, TCC)**：变量 `tcc`，范围 $[0, 1]$。
- **地表下行短波辐射 (Surface Solar Radiation Downwards, SSRD)**：变量 `ssrd`，单位 $J/m^2$。

### 3.2 瞬时辐照度与衰减系数计算

由于 ERA5 的辐射数据为累积值，我们需要计算瞬时辐照度 $I_{atm}$ (`solarIrradianceWm2`)：

$$I_{atm} = \frac{\max(0, \text{ssrd}(t_{k+1}) - \text{ssrd}(t_k))}{\Delta t_{era}}$$

同时，定义云量衰减系数 $K_{cloud}$ (`sunlightFactor`)，用于修正几何日照的有效性。根据经验模型，云层覆盖会导致日照强度的非线性衰减：

$$K_{cloud} = \max(0.15, 1 - 0.85 \times \text{tcc})$$

此步骤的**输出**为 `cloudCover`、`sunlightFactor` 和 `solarIrradianceWm2`。

------

## 4. 城市形态阴影建模 (Urban Morphological Shadow Modeling)

### 4.1 阴影检索引擎

我们利用基于投影算法的阴影引擎，结合城市地表覆盖数据计算地表阴影。

- **输入**：
  - 空间范围：`bbox`
  - 时间：`timestamp` (即 $T_{bucket}$)
  - 形态数据：建筑物矢量及树冠栅格 (`canopyRasterPath`)
- **处理**：计算该时刻太阳方位角与高度角，投射建筑物与树冠的三维模型至地表。
- **输出**：阴影多边形集合 $\mathcal{S}_{poly}$ 或区域平均阴影率 $\bar{S}_{avg}$ (`avgShadowPercent`)。

### 4.2 点级几何日照判定

对于每个轨迹点 $p_i$，其几何日照状态 $S_{raw}$ (`sunlit`) 判定如下：

$$S_{raw}(p_i) = \begin{cases}  0 & \text{if } p_i \in \mathcal{S}_{poly} \quad (\text{In Shadow}) \\ 1 & \text{if } p_i \notin \mathcal{S}_{poly} \quad (\text{Sunlit}) \end{cases}$$

若无多边形返回，则退化为使用平均阴影率进行估计。

------

## 5. 暴露量化与积分 (Exposure Quantification and Integration)

本环节将几何阴影与气象条件耦合，计算最终的有效生理暴露指标。

### 5.1 有效日照与阴影修正

考虑云层衰减后的有效日照状态 $S_{eff}$ (`sunlitEffective`) 定义为：

$$S_{eff} = S_{raw} \times K_{cloud}$$

对应的有效阴影百分比 $P_{shadow}$ (`shadowPercentEffective`) 为：

$$P_{shadow} = 100 \times (1 - S_{eff})$$

### 5.2 有效辐照度掩码

我们构建有效辐照度 $I_{eff}$ (`irradianceEffective`)，假设阴影区域完全阻挡直射分量（注：此处模型做简化处理，视全阴影区辐射为0或忽略散射背景）：

$$I_{eff} = \begin{cases}  I_{atm} & \text{if } S_{raw} = 1 \\ 0 & \text{if } S_{raw} = 0  \end{cases}$$

### 5.3 时长加权与能量积分

为了计算累积暴露，首先计算每个轨迹点代表的时间跨度 $\Delta \tau_i$ (`durationSeconds`)。为处理数据中断，我们对时间步长进行截断：

$$\Delta \tau_i = \text{clamp}(t_{i+1} - t_i, 1, 300)$$

最终输出的累积指标如下：

- 有效日照时长 (sunlightSeconds)：

  

  $$T_{sun} = S_{eff} \times \Delta \tau_i$$

- 有效阴影时长 (shadowSeconds)：

  

  $$T_{shadow} = \frac{P_{shadow}}{100} \times \Delta \tau_i$$

- 累积辐射能量 (irradianceJ)：

  

  $$E_{total} = \max(0, I_{eff}) \times \Delta \tau_i$$

------

## 6. 异常处理与质量控制 (Exception Handling and Quality Control)

为了保证大规模计算的鲁棒性，系统包含以下状态标记逻辑：

- **夜间快速路径**：当 ERA5 推导的 `solarIrradianceWm2` 低于阈值（`MOBILITY_NIGHT_IRRADIANCE_THRESHOLD`）时，标记 `source="night"` 并跳过几何阴影计算；所有暴露量按 0 或空值写出（下游按 0 处理）。
- **数据缺失/异常**：若指定范围内无建筑物要素或阴影引擎失败，标记 `source="fallback_error"`，并将错误信息写入 `errorDetail`（截断）。
- **状态追踪**：所有计算结果通过 `source` 与 `errorDetail` 字段记录元数据，便于过滤异常并对失败样本做增量重算（例如按分钟 bucket 选择性重算）。
