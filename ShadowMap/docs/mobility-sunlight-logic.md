## Mobility 日照/阴影计算逻辑（工程视角，离线 Python 为主）

### 0) 链路选择（先分清再动手）

本仓库支持两条链路，建议把它们当作两个产品面：

1) **离线/批处理（推荐用于论文与统计）**：`ShadowMap/scripts/batch_mobility_shadow.py` 直接读本地 Buildings / Canopy / ERA5（无 HTTP）。  
2) **实时/交互（Demo）**：前端 → 后端 → `POST /api/analysis/shadow` + `/api/weather/current`（依赖服务状态与网络）。

> 本文档优先描述离线批处理逻辑；HTTP 链路仅用于 Demo，不建议作为论文数据主来源。

---

### 1) 离线批处理（`batch_mobility_shadow.py`）

#### 1.1 输入选择（哪些 CSV 要算）

- 全量：遍历 `--input` 目录下所有 `*.csv`
- 指定集合：`--targets-file`（文件内每行是相对 `INPUT_ROOT` 的路径，如 `ST/batch10/1069.csv`）
- 指定单文件：`--target-file 1069.csv`

> 约束：`--targets-file` 与 `--target-file` 二选一。

#### 1.2 断点续跑 / 增量重算（强烈建议了解）

- **默认跳过已存在输出**：若 `output_root/<rel>-sunlight.csv` 已存在且未设置 `--force`，会直接 `[Skip existing]`。
- **增量重算指定分钟桶**：使用 `--buckets-file`（每行一个分钟 ISO，如 `2025-12-14T08:30:00.000Z`）。
  - 若输出已存在，会先 “seed existing output”，仅覆盖命中的 bucket，其余行保留。

#### 1.3 每个文件的处理流程（按分钟 bucket 并行）

对单个输入 CSV（如 `ST/batch10/1069.csv`）：

1) **读入并补齐列**：原列透传；若缺少输出列（如 `sunlit`）会先填空。
2) **时间分桶**：`timestamp`（epoch seconds）向下取整到分钟，生成 `bucketStart`（UTC ISO，`...:00.000Z`），并聚合该分钟内的点。
3) **计算 bbox**：对每个 bucket 内点求包络 `{west,south,east,north}`，并做零面积微扩展。
4) **天气（ERA5，本地）**：
   - 读取 `tcc` 与 `ssrd`，得到 `cloudCover`/`solarIrradianceWm2`，并计算 `sunlightFactor=max(0.15, 1-tcc*0.85)`。
5) **夜间快速路径（提速关键）**：
   - 若 `solarIrradianceWm2 <= MOBILITY_NIGHT_IRRADIANCE_THRESHOLD`，直接标记 `source=night`，跳过几何阴影计算（输出统一写 0/空字段，下游按 0 处理）。
6) **建筑数据（Buildings）**：
   - `--buildings-mode preload`：父进程先把 GPKG 读入内存，子进程 fork 共享（Linux）。
   - `--buildings-mode bbox`：每个 bucket 读取 bbox 窗口（IO 重，性能差，除非内存不够不推荐）。
   - 可选“点缓冲取建筑”（减少大 bbox IO）：`--buildings-point-buffer-m` + `--buildings-point-buffer-threshold-m`。
7) **树冠（Canopy，可选）**：
   - `--include-canopy true` 且 `--canopy` 有效时：将树冠 GeoTIFF 转为矢量面后与 Buildings 合并参与遮挡。
8) **阴影生成与点判定**：
   - 通过 `engine_core.generate_shadows()`（pybdshadow）生成阴影多边形；
   - 以 STRtree 建立空间索引，点命中阴影 → `sunlit=0`、否则 `sunlit=1`（离线链路为 0/1 判定，`shadowPercent` 为 0 或 100）。
9) **云量与辐照度修正（用于统计）**：
   - `sunlitEffective = sunlit * sunlightFactor`
   - `shadowPercentEffective = 100 - sunlitEffective*100`
   - `irradianceEffective = (sunlit==0) ? 0 : solarIrradianceWm2`
10) **积分字段（按行）**：
   - `durationSeconds`：相邻点差值（clamp 1–300s），末行默认 60s；
   - `sunlightSeconds / shadowSeconds / irradianceJ`：按 `durationSeconds` 积分。
11) **写出输出**：生成 `output_root/<rel>-sunlight.csv`。

#### 1.4 并行策略（避免嵌套进程是关键）

- 并行粒度：**bucket-level 并行**（一个 `ProcessPoolExecutor`）。
- Runner 推荐：`run_full_recal_batch.sh` 采用“单次 Python 调用 + 单进程池 + 多文件顺序处理”，避免 **文件级并行 × bucket 并行** 的嵌套。
- 若要多窗口并行（tmux 拆分任务）：请把 `--concurrency` 按窗口平均分配，避免 CPU 过载。
- 建议显式关闭数值库线程（避免每个进程再开多线程导致 50+ runnable）：
  - `OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1`

#### 1.5 进程池崩溃恢复（长跑必备）

当出现 `BrokenProcessPool`（子进程异常退出）时：

- 自动重启池：由 `MOBILITY_POOL_RESTARTS_PER_FILE` 控制单文件最多重启次数（默认 1）。
- 可选降并发重试：`MOBILITY_POOL_RESTART_BACKOFF=true` 时每次崩溃会把 workers 减半。

#### 1.6 进度与日志

- `--progress-style single`：单行刷新，适合终端观看。
- `--progress-style log`：按间隔输出日志行，适合重定向到文件。
- `--progress-interval <seconds>`：进度刷新间隔（0 表示不输出）。

---

### 2) 实时/交互（HTTP，Demo 简述）

- 前端（`mobilitySunlightService.ts`）按分钟分桶，构造 payload；
- 后端 `/api/analysis/shadow` 负责：
  - bbox/time bucket 规范化、缓存与超时策略；
  - 调用外部引擎或本地 Python worker（取决于部署模式）。

> 该链路更适合“可视化/交互”；论文数据请优先用离线批处理，减少服务抖动带来的不可控噪声。
