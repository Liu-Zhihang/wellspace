# 居住地阳光暴露（IRBM）计算方法（与 RMBM 对齐）

## 1. 概述
目标：在居住地及其缓冲区内，逐小时评估日照/阴影与云量衰减后的暴露时长和辐照能量，用于与移动性暴露（RMBM）对比检验 NEAP。计算链路、气象与阴影引擎与 RMBM 保持一致，区别在于：位置固定、时间采样为逐小时。

## 2. 数据与来源
- 轨迹/居住地：`timestamp`（秒，UTC），经纬度优先 `fnl_*` → `gps/gpx/air`；夜间停留点（22:00–06:00）最长位置作为居住地。
- 城市形态：建筑矢量 + 树冠栅格（可选）。
- 气象：ERA5 single-levels（本地），tcc（云量），ssrd（短波辐照度累积 J/m²，1h，0.25°）。

## 3. 缓冲区与时间采样
- 半径：100/200/500/1000 m，主分析 200 m，其余做敏感性。
- 采样：逐小时 06:00–22:00（16 个时间点），每小时视为该小时平均状态，积分步长 Δt = 3600 s。RMBM 为分钟级逐点积分，最终都聚合到日层面对比。
- 空间：以居住地为中心生成覆盖缓冲区的 bbox（推荐，取区域平均阴影率）；可选网格采样均值（更精细但更耗时）。

## 4. 气象反演（ERA5，本地）
- 云量衰减：$K_{cloud} = \max(0.15,\; 1 - 0.85 \times \text{tcc})$  
- 辐照度：$I_{atm} = \dfrac{\max(0,\; ssrd(t_{k+1}) - ssrd(t_k))}{\Delta t}$，$\Delta t=3600$s；ssrd 已含云/气溶胶衰减。  
- 输出：`cloudCover`、`sunlightFactor=K_cloud`、`solarIrradianceWm2=I_atm`。

## 5. 阴影建模（建筑 + 可选树冠）
- 引擎：基于太阳方位/高度的几何投影（非全路径光线追踪），对建筑与树冠做平面投影，输出阴影多边形或平均阴影率 `avgShadowPercent`。
- 输入：`bbox`、`timestamp`（桶起点）、`includeCanopy/canopyRasterPath`、`timeGranularity=1`。

## 6. 点级判定与修正（单时间点）
对于居住地 $(x_H, y_H)$、缓冲区半径 $r$、时间点 $t$：
1) 区域阴影：$\bar{S}_{shadow}(t) = \text{avgShadowPercent}(\text{bbox}(x_H,y_H,r), t)$  
2) 区域日照：$\bar{S}_{sunlit}(t) = 1 - \bar{S}_{shadow}(t)/100$  
3) 有效日照：$S_{eff}(t) = \bar{S}_{sunlit}(t) \times K_{cloud}(t)$  
4) 有效辐照度：$I_{eff}(t) = \bar{S}_{sunlit}(t) \times I_{atm}(t)$ （ssrd 已含云量，无需再衰减）

## 7. 日累积
对每个采样点 $t_i$，权重 $\Delta t=3600$ s：
- 日照时长：$T_{sun}^{day} = \sum S_{eff}(t_i) \times \Delta t$  
- 辐照能量：$E_{total}^{day} = \sum I_{eff}(t_i) \times \Delta t$  
- 平均辐照度：$\bar{I}_{eff}^{day} = E_{total}^{day} / T_{sun}^{day}$

## 8. 指标体系（命名与 RMBM 对齐）
- 时长：`IRBM_sunlight_min = T_{sun}^{day}/60`；`IRBM_raw_sunlight_min = \sum \bar{S}_{sunlit} \times \Delta t / 60`（未云量修正，可选）；`IRBM_cloud_adj_min` 同 `IRBM_sunlight_min`。  
- 强度：`IRBM_irradiance_kJ = E_{total}^{day}/1000`；`IRBM_mean_irradiance = \bar{I}_{eff}^{day}`。  
- 时段：morning/midday/afternoon/evening 后缀按小时聚合。  
- 缓冲区：`IRBM_{buffer}m_{metric}`（如 `IRBM_200m_sunlight_min`，`IRBM_1000m_irradiance_kJ`）。

## 9. 异常处理与标记
- 夜间：HTTP 400（Outside daylight），可忽略重算。  
- 无建筑：HTTP 500（No building features），视为缺失。  
- 其他 5xx/网络：HTTP 5xx，`source/errorDetail` 记录，支持 buckets 增量重跑。  
- 输出字段与 schema 对齐：`sunlit/shadowPercent`、`bucketStart/bucketEnd`、`source/errorDetail`、`cloudCover/sunlightFactor`、`solarIrradianceWm2/irradianceEffective`、`durationSeconds/sunlightSeconds/shadowSeconds/irradianceJ`。

## 10. 输出结构（示例）
- 日层 CSV：`IRBM_daily_all_buffers.csv`，列：ID、date、buffer_m、IRBM_sunlight_min、IRBM_irradiance_kJ、IRBM_mean_irradiance，以及各时段/敏感性指标。  
- 设计与 RMBM 对齐，便于 NEAP 对比分析。

## 11. 输出字段说明（日层，示例）
| 字段 | 含义 | 用途/备注 |
| --- | --- | --- |
| ID | 参与者/居住地标识 | 汇总键 |
| date | 日期 (UTC) | 日层聚合 |
| buffer_m | 缓冲区半径 (100/200/500/1000) | 敏感性分析 |
| IRBM_sunlight_min | 日总有效日照时长 (含云量修正)，分钟 | 核心时长指标 |
| IRBM_raw_sunlight_min | 未云量修正的日照时长，分钟 | 对照/敏感性 |
| IRBM_irradiance_kJ | 日总有效辐照能量，kJ | 暴露强度 |
| IRBM_mean_irradiance | 日平均有效辐照度，W/m² | 强度均值 |
| IRBM_morning_min / _kJ | 06–10 时段时长/能量 | 时段分层 |
| IRBM_midday_min / _kJ | 10–14 时段时长/能量 | 时段分层 |
| IRBM_afternoon_min / _kJ | 14–18 时段时长/能量 | 时段分层 |
| IRBM_evening_min / _kJ | 18–22 时段时长/能量 | 时段分层 |
