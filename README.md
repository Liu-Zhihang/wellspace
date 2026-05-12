# ShadowMap / Wellspace 阴影计算仓库

本仓库同时承载两个用途：一个是用于演示的 Web 交互系统，另一个是用于研究生产的全美移动阴影离线计算。两条链路不要混用：前后端服务适合展示和抽查，论文级或全国级计算应走 Python-first 离线流水线。

如果只读一个入口，先读 `DOCS_INDEX.md`；数据细节读 `ShadowMap/docs/data-registry.md`；`place20190206.csv` 的字段和语义读 `ShadowMap/docs/place20190206-data-document.md`。

## 1. 仓库层次

```text
.
├── README.md                         # 本文件：仓库入口
├── DOCS_INDEX.md                     # 中文主线手册
├── DATASETS.md                       # 数据入口说明
├── CODEBASE_STRUCTURE.md             # 代码结构入口存根
└── ShadowMap/
    ├── .shadowmap.env.example        # 统一配置模板，不含真实密钥
    ├── docs/                         # 数据、方法、全国计算框架文档
    ├── scripts/                      # Python-first 批处理、数据准备、运维脚本
    ├── scripts/ops/                  # WSA/全国计算/GeoParquet/DuckDB/ERA5/Canopy 工具
    ├── shadow-map-backend/           # Express + TypeScript 后端
    ├── shadow-map-frontend/          # React + Vite 前端
    └── Chinese documents/            # 中文运维和旧项目文档
```

核心代码逻辑按层看：

- 前端层：`ShadowMap/shadow-map-frontend/react-shadow-app/`，负责地图交互、Mapbox 可视化、结果展示。
- 后端层：`ShadowMap/shadow-map-backend/`，负责 Demo 链路中的 WFS、DEM、天气、分析 API。
- 离线计算层：`ShadowMap/scripts/` 与 `ShadowMap/scripts/ops/`，负责移动轨迹预处理、建筑/树冠/ERA5 数据准备、任务图、分区候选、精确求解和断点续跑。
- 数据文档层：`ShadowMap/docs/`，记录数据来源、字段语义、全国计算框架、Mobility 输出 schema。

## 2. 两条工作流

### A. Demo / 交互展示链路

```text
React frontend -> Express backend -> GeoServer/WFS/PostGIS + DEM + ERA5/weather
```

用途是可视化、抽查、演示和小规模交互分析。它不是全国批处理的主执行链路，因为 HTTP、WFS 和在线服务会成为吞吐瓶颈。

启动方式：

```bash
cd ShadowMap/shadow-map-backend
cp .env.example .env
npm install
npm run dev

cd ../shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev
```

### B. 全美 / 论文生产离线链路

```text
mobility stay CSV
  -> 预处理与过滤
  -> task graph / source spans
  -> building/canopy/weather candidate partitions
  -> exact solver
  -> checkpointed CSV/Parquet outputs
```

这条链路不依赖 `node -> backend -> WFS` 服务链。它直接读取本地建筑、树冠、ERA5 和移动数据，使用分区候选减少无效空间查询，并依靠断点续跑避免机器重启或单个 heavy task 造成重算。

常用入口：

```bash
cp ShadowMap/.shadowmap.env.example ShadowMap/.shadowmap.env
source ShadowMap/.shadowmap.env

# 传统 mobility 批处理入口
CONCURRENCY=16 bash ShadowMap/scripts/run_full_recal_batch.sh

# 全国任务图和 exact executor 入口集中在 scripts/ops
python3 ShadowMap/scripts/ops/build_national_task_graph_raw_stays.py --help
python3 ShadowMap/scripts/ops/run_exact_partition_executor.py --help
```

## 3. 统一配置

所有本机路径和服务地址应从 `ShadowMap/.shadowmap.env` 读取，不要写死到代码里。模板是 `ShadowMap/.shadowmap.env.example`，真实文件被 git 忽略。

推荐把 WSA 上的数据集中放到类似结构：

```text
~/datasets/wellspace_v2/shadowmap/
  raw/        # 原始下载或外部输入
  derived/    # GeoParquet、任务图、分区表、benchmark、executor 输出
  infra/      # GeoServer/PostGIS/服务配置导出
```

HDD 大缓存可以放在：

```text
/mnt/data_hdd/wellspace_v2/shadowmap/
/mnt/data_hdd/shadowmap_cache/
```

原则：

- 仓库只提交代码、配置模板、文档和小型元数据。
- 不提交 `.env`、`.shadowmap.env`、CDS 凭据、Mapbox token、数据库密码、原始移动数据、树冠瓦片、ERA5 NetCDF、建筑物大文件。
- 输出目录必须有 run id、summary、manifest 或 checkpoint，避免重跑后无法追踪。

## 4. 数据下载与准备

详细登记表见 `ShadowMap/docs/data-registry.md`。这里保留下载逻辑的主线。

### 4.1 移动数据

当前全美测试主输入是 WSA 上的：

```text
/home/jinlin/data/Mobility_Data/place20190206.csv
```

该文件是停留记录，不是逐秒 GPS 轨迹。每行语义是：

```text
ad_id + latitude/longitude + [start_time, end_time] + time_spent
```

字段说明、覆盖范围和质量检查见 `ShadowMap/docs/place20190206-data-document.md`。

### 4.2 建筑物数据

Demo 链路可继续通过 GeoServer/WFS 访问 PostGIS；全国离线计算应优先使用已经导出的 GeoParquet 分区层或直接读 PostGIS 分区表。

相关入口：

```text
ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet.py
ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet_batch.py
ShadowMap/scripts/ops/generate_building_partition_catalog.py
ShadowMap/scripts/ops/materialize_task_partition_edges_duckdb.py
```

建筑数据需要保证空间列在 PostGIS/GeoServer 使用的 `geom` 上正确落地；不要把属性已入库但几何失效的数据混进生产计算。

### 4.3 树冠 / Canopy

树冠数据使用 Meta/WRI Data for Good CHM 公开数据集：

```text
Registry: https://registry.opendata.aws/dataforgood-fb-forests/
Global CHM: s3://dataforgood-fb-data/forests/v1/alsgedi_global_v6_float/chm/
California CHM: s3://dataforgood-fb-data/forests/v1/California/alsgedi_ca_v5_float/chm/
```

推荐策略不是一次性下载全美所有瓦片，而是：

```text
任务 bbox / shard -> canopy manifest -> 缺失 tile 下载 -> shard-local VRT -> exact solver
```

相关脚本：

```text
ShadowMap/scripts/ops/canopy/sync_tiles_index.sh
ShadowMap/scripts/ops/canopy/generate_meta_wri_manifest.py
ShadowMap/scripts/ops/canopy/download_meta_wri_canopy.sh
ShadowMap/scripts/ops/canopy/build_canopy_vrt.sh
```

已经下载但当前任务不再需要的 raw tile 可以按 manifest 清理；保留 tile index、manifest、VRT 生成逻辑和结果说明即可复建。

### 4.4 天气与云量 / ERA5

天气和云量可下载到本地，生产计算不应让每个 worker 反复在线请求。当前主线是 ERA5 single levels：

- `tcc`：total cloud cover
- `ssrd`：surface solar radiation downwards

下载入口：

```bash
python3 ShadowMap/scripts/ops/weather/download_era5_single_levels_month.py --help
```

前提是本机或 WSA 已配置 CDS API 凭据。凭据只放用户 home 或本机环境，不写入仓库。

## 5. WSA 运维入口

WSA 是当前全国计算和大数据落盘的主要机器。Bitvise 在 Windows 上如果不能直接访问 WSL 内的 `127.0.0.1:1080`，可使用仓库内的桥接脚本：

```powershell
ShadowMap/scripts/ops/wsa_socks_bridge_2081.ps1
```

它把 Windows 侧 `127.0.0.1:2081` 转发到 WSL Ubuntu 内的 `127.0.0.1:1080`，用于 Bitvise 的 SOCKS5 Proxy 设置。脚本不包含密码或密钥。

## 6. 提交前检查

```bash
git status --short
rg -n "sk-[A-Za-z0-9]|pk\\.[A-Za-z0-9_-]{20,}|MAPBOX|CDSAPI|password|PASSWORD" .
```

如果搜索结果是占位符或文档中的变量名，需要人工确认；真实 token、密码、CDS key、`.env` 和大数据文件不得进入 commit。
