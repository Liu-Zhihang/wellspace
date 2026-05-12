# 项目主线手册（Project Guide）

最后更新：2026-05-12

本文件是 ShadowMap 仓库的中文主入口。`README.md` 给出快速总览；本文件把代码层次、数据准备、运行链路和维护边界按一条线性逻辑串起来。其余 `CODEBASE_STRUCTURE.md`、`DATASETS.md`、`DEVELOPMENT_PLAN.md` 只保留为入口或附录，避免多处重复维护。

---

## 1) 先分清两条链路

### A. Demo / 交互展示链路

目标：前端 3D 可视化、交互式查询、结果展示和小样本抽查。

```text
Frontend -> Backend -> GeoServer/WFS/PostGIS + DEM + ERA5/weather
```

关键入口：

- 前端：`ShadowMap/shadow-map-frontend/react-shadow-app/`
- 后端：`ShadowMap/shadow-map-backend/`
- 空间服务运维：`ShadowMap/Chinese documents/ops/空间数据服务运维手册.md`
- 后端自检：`ShadowMap/Chinese documents/backend/后端文档.md`

这条链路不作为全美国移动阴影生产计算的主链路，因为 HTTP、WFS、在线障碍物检索和服务进程会放大吞吐瓶颈。

### B. 全国 / 论文生产离线链路

目标：稳定、可复现、可断点续跑的大规模移动阴影产出。

```text
mobility stay CSV
  -> 预处理与过滤
  -> task graph / source spans
  -> building/canopy/weather candidate partitions
  -> exact solver
  -> checkpointed outputs
```

关键入口：

- 原始停留数据说明：`ShadowMap/docs/place20190206-data-document.md`
- 全国计算框架：`ShadowMap/docs/national-compute-framework.md`
- 数据登记表：`ShadowMap/docs/data-registry.md`
- exact executor：`ShadowMap/scripts/ops/run_exact_partition_executor.py`
- task graph：`ShadowMap/scripts/ops/build_national_task_graph_raw_stays.py`
- DuckDB 分区边：`ShadowMap/scripts/ops/materialize_task_partition_edges_duckdb.py`

这条链路直接读取本地建筑、树冠、ERA5 和移动数据；前后端服务只用于展示、诊断和结果抽查。

---

## 2) 代码层次

```text
ShadowMap/
  .shadowmap.env.example                 # 统一配置模板
  docs/                                  # 数据、方法、schema、全国计算文档
  scripts/                               # 传统 mobility 批处理和 QC 工具
  scripts/ops/                           # 全国计算、WSA、PostGIS、DuckDB、Canopy、ERA5 工具
  shadow-map-backend/                    # Express + TypeScript 后端
  shadow-map-frontend/react-shadow-app/  # React + Vite 前端
  Chinese documents/                     # 中文运维文档和旧项目材料
```

常用定位：

- 前端地图视口：`ShadowMap/shadow-map-frontend/react-shadow-app/src/components/Map/ShadowMapViewport.tsx`
- 前端运行配置：`ShadowMap/shadow-map-frontend/react-shadow-app/src/config/runtime.ts`
- 后端 WFS/DEM/weather 服务：`ShadowMap/shadow-map-backend/src/services/`
- 传统 mobility 引擎：`ShadowMap/scripts/batch_mobility_shadow.py`
- 传统批处理 runner：`ShadowMap/scripts/run_full_recal_batch.sh`
- 全国 executor：`ShadowMap/scripts/ops/run_exact_partition_executor.py`
- 建筑 GeoParquet 导出：`ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet_batch.py`
- 树冠下载与 VRT：`ShadowMap/scripts/ops/canopy/`
- ERA5 下载：`ShadowMap/scripts/ops/weather/`

---

## 3) 统一配置与目录

所有机器上的真实路径、服务地址和凭据都应从本机配置读取：

```bash
cp ShadowMap/.shadowmap.env.example ShadowMap/.shadowmap.env
source ShadowMap/.shadowmap.env
```

`.shadowmap.env` 被 git 忽略，不要提交。推荐数据根目录：

```text
~/datasets/wellspace_v2/shadowmap/
  raw/        # 原始输入或外部下载
  derived/    # GeoParquet、task graph、partition edges、benchmark、executor 输出
  infra/      # 服务配置导出、catalog、轻量索引
```

WSA 上的大缓存和机械盘数据可放在：

```text
/mnt/data_hdd/wellspace_v2/shadowmap/
/mnt/data_hdd/shadowmap_cache/
```

配置边界：

- 代码里不要写死 `/home/jinlin/...`、`/mnt/data_hdd/...`、数据库密码或 token。
- 文档可以写公开数据源和推荐目录，但不要写真实密码、Mapbox token、CDS key。
- 大文件、原始移动数据、ERA5 NetCDF、树冠瓦片、建筑物大文件和输出结果不进 git。

---

## 4) 数据下载与准备

详细版本和路径以 `ShadowMap/docs/data-registry.md` 为准。本节只写主线。

### 4.1 移动数据

当前全美测试主输入：

```text
/home/jinlin/data/Mobility_Data/place20190206.csv
```

它是停留记录，不是逐秒轨迹。每行表示一个设备在一个固定停留点的一段停留区间：

```text
ad_id + latitude/longitude + [start_time, end_time] + time_spent
```

进入阴影计算前应先做线性过滤：

1. 读取显式 schema，保留本地时间字段为字符串。
2. 校验坐标、UTC 时间、停留时长。
3. 裁剪研究区和研究时间。
4. 黑夜时段不进入精确几何求解。
5. 室内或无需计算的停留点先过滤或打标。
6. 再生成 task graph / source spans。

字段、覆盖范围和质量检查见 `ShadowMap/docs/place20190206-data-document.md`。

### 4.2 建筑物

Demo 链路：

```text
GeoServer/WFS -> PostGIS -> backend -> frontend
```

全国生产链路：

```text
PostGIS buildings_us_lod1 / buildings_us_service
  -> GeoParquet partitions
  -> partition catalog
  -> task -> candidate partition
  -> exact solver
```

相关脚本：

```text
ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet.py
ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet_batch.py
ShadowMap/scripts/ops/generate_building_partition_catalog.py
ShadowMap/scripts/ops/materialize_task_partition_edges_duckdb.py
```

生产前必须确认建筑表的有效几何列落在服务和离线计算都使用的 `geom` 上。属性已入库但 `geom` 无效的数据不能参与全国计算。

### 4.3 树冠 / Canopy

公开来源：

```text
https://registry.opendata.aws/dataforgood-fb-forests/
s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/
s3://dataforgood-fb-data/forests/v1/California/alsgedi_ca_v5_float/chm/
```

推荐策略：

```text
按任务 bbox 或 shard 生成 manifest
  -> 只下载缺失 tile
  -> 生成 shard-local VRT
  -> exact solver 读取本地 VRT
```

相关脚本：

```text
ShadowMap/scripts/ops/canopy/sync_tiles_index.sh
ShadowMap/scripts/ops/canopy/generate_meta_wri_manifest.py
ShadowMap/scripts/ops/canopy/download_meta_wri_canopy.sh
ShadowMap/scripts/ops/canopy/build_canopy_vrt.sh
```

不要默认把 lower48 全部树冠瓦片永久保留在仓库或系统盘。HDD 空间紧张时，可以保留 tile index、manifest 和已完成 run 的摘要，清理 raw tile；后续按 manifest 重新下载即可。

### 4.4 ERA5 / 云量与天气

生产计算应把 ERA5 下载到本地，避免 worker 在线请求。

当前主变量：

- `tcc`：total cloud cover
- `ssrd`：surface solar radiation downwards

下载入口：

```bash
python3 ShadowMap/scripts/ops/weather/download_era5_single_levels_month.py --help
```

前提：本机或 WSA 已配置 CDS API 凭据。凭据不写入仓库。

---

## 5) 运行与质量控制

### 5.1 Demo 启动

```bash
cd ShadowMap/shadow-map-backend
cp .env.example .env
npm install
npm run dev
curl -s http://localhost:3001/api/health | head -c 200 && echo

cd ../shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev
```

### 5.2 传统 mobility 批处理

```bash
source ShadowMap/.shadowmap.env
CONCURRENCY=16 bash ShadowMap/scripts/run_full_recal_batch.sh
```

### 5.3 输出校验与修复

```bash
python3 ShadowMap/scripts/validate_sunlight_csv.py --root "$OUTPUT_ROOT" --max-rows-per-file 5000 \
  --write-bad-list "$OUTPUT_ROOT/_shadowmap_tasks/bad_sunlight_files.txt"

python3 ShadowMap/scripts/repair_sunlight_csv.py --root "$OUTPUT_ROOT" \
  --bad-list "$OUTPUT_ROOT/_shadowmap_tasks/bad_sunlight_files.txt" \
  --write
```

### 5.4 全国 executor 原则

全国计算必须满足：

- run 目录包含 `summary.json`、日志、checkpoint 或 manifest。
- 已完成 shard/task 不重跑，除非显式 `--force`。
- heavy task 限并发，避免 WSA 内存被单个空间窗口打爆。
- 黑夜、区外、无建筑/树冠候选的任务先跳过或走快速路径。
- cell/H3 只能用于调度和复用，不得用 cell 中心替代真实点位做最终判断。

---

## 6) WSA 与 Bitvise 访问

WSA 是当前大规模计算和数据落盘主机。Windows 侧 Bitvise 如果无法访问 WSL 内的 SOCKS5 `127.0.0.1:1080`，使用：

```powershell
ShadowMap/scripts/ops/wsa_socks_bridge_2081.ps1
```

Bitvise 代理设置：

```text
SOCKS5 host: 127.0.0.1
SOCKS5 port: 2081
```

该脚本只做端口桥接，不保存密码。长期使用时可把脚本注册到 Windows 当前用户启动项；具体机器状态不要写入仓库。

---

## 7) 提交前检查

```bash
git status --short
rg -n "sk-[A-Za-z0-9]|pk\\.[A-Za-z0-9_-]{20,}|CDSAPI|MAPBOX|password|PASSWORD" .
```

如果命中真实密钥、密码或 token，必须先移除并改成环境变量或占位符。公开数据链接、变量名和占位符可以保留，但需要人工确认。
