## Mobility 日照/阴影方法（公式化，读者导向）

> 说明：本文为简版概述；论文写作与实现细节请以 `mobility-sunlight-method-new.md` 为准。

### 1. 研究问题
分钟尺度下，如何将轨迹点与城市形态和气象数据耦合，得到日照/阴影状态以及云量衰减后的时长与辐照能量。

### 2. 数据与来源
- 轨迹：`timestamp`（秒，UTC），经纬度优先 `fnl_*` → `gps/gpx/air`，其他业务列透传。
- 城市形态：建筑矢量 + 树冠栅格（可选）。
- 气象：ERA5 single-levels（本地），tcc（云量），ssrd（短波辐照度累积，1h，0.25°）。

### 3. 工作流（每步说明问题/输入/处理/输出）
1) **时间分桶（对齐分钟与气象）**  
   - 问题：轨迹时间戳不齐，需要分钟对齐。  
   - 输入：原始时间戳 `ts`。  
   - 处理：$ \text{bucketStart} = \left\lfloor \dfrac{ts}{60} \right\rfloor \times 60 $（ISO）。  
   - 输出：分钟桶键，用于后续气象/阴影查询。

2) **空间范围（限定计算域）**  
   - 问题：避免全域计算，限定阴影求交范围。  
   - 输入：桶内点坐标。  
   - 处理：取包络 `bbox = {west, south, east, north}`，零面积时微扩展。  
   - 输出：请求用 bbox。

3) **气象反演（云量与辐照度）**  
   - 问题：获取大气条件对日照的衰减与辐照度。  
   - 输入：桶中心 `lat/lon`，`bucketStart`；ERA5 tcc、ssrd。  
   - 处理：  
     - 云量衰减：$ \text{sunlightFactor} = \max(0.15,\; 1 - \text{tcc} \times 0.85) $  
     - 辐照度：$ \text{solarIrradianceWm2} = \dfrac{\max(0,\; ssrd(t_1) - ssrd(t_0))}{\Delta t} $  
   - 输出：`cloudCover`、`sunlightFactor`、`solarIrradianceWm2`。

4) **阴影建模（建筑/树冠遮挡）**  
   - 问题：判定地表阴影分布。  
   - 输入：`bbox`、`bucketStart`、`includeCanopy/canopyRasterPath`、`timeGranularity=1`。  
   - 处理：计算太阳位置，投影建筑+树冠，得到阴影多边形或均值 `avgShadowPercent`。  
   - 输出：阴影几何/均值。

5) **点级判定与云量修正**  
   - 问题：将几何阴影与云量耦合为点级日照。  
   - 输入：轨迹点、阴影结果、气象输出。  
   - 处理：  
     - 阴影：命中多边形→$ \text{sunlit\_raw}=0 $，否则 1；无几何→$ 1 - \text{avgShadowPercent}/100 $。  
     - 云量：$ \text{sunlitEffective} = \text{sunlit\_raw} \times \text{sunlightFactor} $；$ \text{shadowPercentEffective} = 100 - \text{sunlitEffective} \times 100 $。  
     - 辐照度：$ \text{irradianceEffective} = (\text{sunlit\_raw}=0)?0:\text{solarIrradianceWm2} $。  
   - 输出：点级日照/阴影，云量、辐照度字段。

6) **积分（时长与能量）**  
   - 问题：将瞬时状态转为可积的时长/能量。  
   - 输入：按时间排序的点。  
   - 处理：  
     - 时长：$ \text{durationSeconds} = \operatorname{clamp}(\Delta t_{next}, 1, 300) $（无下一个点默认 60）。  
     - $ \text{sunlightSeconds} = \text{sunlitEffective} \times \text{durationSeconds} $  
     - $ \text{shadowSeconds} = \dfrac{\text{shadowPercentEffective}}{100} \times \text{durationSeconds} $  
     - $ \text{irradianceJ} = \max(0, \text{irradianceEffective}) \times \text{durationSeconds} $  
   - 输出：时长与能量指标。

7) **降级与标记（异常可追溯）**  
   - 问题：明确异常来源，便于过滤/重算。  
   - 输入：引擎/气象返回状态。  
   - 处理：夜间快速路径 `source="night"`；无建筑/引擎异常 `source="fallback_error"` 并记录 `errorDetail`（截断）。  
   - 输出：可追溯的状态标签，支持 buckets 增量重跑或忽略夜间。

### 4. 公式汇总
- 分桶：$ \text{bucketStart} = \left\lfloor \dfrac{timestamp}{60} \right\rfloor \times 60\,(s) $  
- 云量：$ \text{sunlightFactor} = \max(0.15,\; 1 - \text{tcc} \times 0.85) $  
- 辐照度：$ \text{solarIrradianceWm2} = \dfrac{\max(0,\; ssrd(t_1)-ssrd(t_0))}{\Delta t} $  
- 阴影判定：$ \text{sunlit\_raw} \in \{0,1\} $，无几何回退 $ 1-\text{avgShadowPercent}/100 $  
- 云量修正：$ \text{sunlitEffective} = \text{sunlit\_raw} \times \text{sunlightFactor} $；$ \text{shadowPercentEffective} = 100 - \text{sunlitEffective} \times 100 $  
- 辐照度掩码：$ \text{irradianceEffective} = (\text{sunlit\_raw}==0)?0:\text{solarIrradianceWm2} $  
- 时长：$ \text{durationSeconds} = \operatorname{clamp}(\Delta t_{next}, 1, 300) $  
- 积分：$ \text{sunlightSeconds} = \text{sunlitEffective} \times \text{durationSeconds} $；$ \text{shadowSeconds} = (\text{shadowPercentEffective}/100) \times \text{durationSeconds} $；$ \text{irradianceJ} = \max(0, \text{irradianceEffective}) \times \text{durationSeconds} $

### 5. 输入/输出对照（与 schema 对齐）
- 输入：`timestamp`，经纬度（fnl/gps/gpx/air），业务列透传。  
- 中间：`bbox`、`bucketStart`、ERA5（tcc/ssrd→`sunlightFactor/solarIrradianceWm2`）、阴影多边形/均值。  
- 输出追加：`sunlit/shadowPercent`、`bucketStart/bucketEnd`、`source/errorDetail`、`cloudCover/sunlightFactor`、`sunlitEffective/shadowPercentEffective`、`solarIrradianceWm2/irradianceEffective`、`durationSeconds/sunlightSeconds/shadowSeconds/irradianceJ`。
