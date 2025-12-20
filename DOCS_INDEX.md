# 项目主线手册（Project Guide）

最后更新：2025-12-19

本仓库的文档以 **一条主线** 组织：本文件 `DOCS_INDEX.md` 是唯一入口；其余 `CODEBASE_STRUCTURE.md` / `DATASETS.md` / `DEVELOPMENT_PLAN.md` / `WSL-Docker-EasyConnect-v2rayN-guide.md` 仅保留为“附录或入口存根”，避免内容重复与漂移。

---

## 1) TL;DR：两条工作流（务必先分清）

### A) Demo / 实时可视化（HTTP 链路）

- 目标：前端 3D 可视化、交互式查询与演示
- 典型链路：Frontend → Backend → GeoServer/WFS/PostGIS + ERA5
- 运维主线：`ShadowMap/Chinese documents/ops/空间数据服务运维手册.md`
- 后端自检：`ShadowMap/Chinese documents/backend/后端文档.md`

### B) 论文 / 离线批处理（Python-first，推荐用于研究产出）

- 目标：稳定、可复现的大规模 `*-sunlight.csv` 产出（避免 `node → HTTP → backend` 引入的网络/服务噪声）
- 入口：`ShadowMap/scripts/batch-mobility-shadow.sh --engine python`
- 批量 runner：`ShadowMap/scripts/run_full_recal_batch.sh`（单次 Python 调用 + 单进程池，避免嵌套进程）
- 质量控制：`ShadowMap/scripts/validate_sunlight_csv.py` + `ShadowMap/scripts/repair_sunlight_csv.py`

---

## 2) 快速开始（按你要做的事选）

### 2.1 Demo（前端 + 后端 + 空间服务）

1) 确认空间服务可用（GeoServer/PostGIS）  
   - 见：`ShadowMap/Chinese documents/ops/空间数据服务运维手册.md`

2) 启动后端

```bash
cd ShadowMap/shadow-map-backend
cp .env.example .env
npm install
npm run dev
curl -s http://localhost:3001/api/health | head -c 200 && echo
curl -s http://localhost:3001/api/wfs-buildings/test | head -c 300 && echo
```

3) 启动前端

```bash
cd ShadowMap/shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev
```

> 前端通过 `VITE_BACKEND_BASE_URL` 指向后端；详见 `ShadowMap/Chinese documents/backend/后端文档.md`。

### 2.2 离线批处理（Mobility）

1) 配置本机数据路径（本地文件，git 忽略）

```bash
cp ShadowMap/.shadowmap.env.example ShadowMap/.shadowmap.env
# 编辑 ShadowMap/.shadowmap.env：至少填 INPUT_ROOT / OUTPUT_ROOT / BUILDING_LOCAL_GEOJSON / ERA5_FILE_TEMPLATE
source ShadowMap/.shadowmap.env
```

2) 运行（建议先小样本）

```bash
CONCURRENCY=16 bash ShadowMap/scripts/run_full_recal_batch.sh
```

3) 质量校验（强烈建议）

```bash
python3 ShadowMap/scripts/validate_sunlight_csv.py --root "$OUTPUT_ROOT" --max-rows-per-file 5000 \
  --write-bad-list "$OUTPUT_ROOT/_shadowmap_tasks/bad_sunlight_files.txt"
python3 ShadowMap/scripts/repair_sunlight_csv.py --root "$OUTPUT_ROOT" \
  --bad-list "$OUTPUT_ROOT/_shadowmap_tasks/bad_sunlight_files.txt" \
  --write
```

---

## 3) 数据与环境（跨机器统一）

### 3.1 推荐目录结构（Workstation A 示例）

```
~/DATASET/
  GLAN/PHASE1/spatial_temporal_merge/      # INPUT_ROOT
  GLAN_processed/                          # 旧输出（最终归档）
  GLAN_processed_paper_canopy_v1/          # 论文产出（建议新建，不覆盖旧目录）
  Height/hong_kong_cleaned.gpkg            # BUILDING_LOCAL_GEOJSON
  HKtree_small.tif                         # SHADOW_ENGINE_CANOPY_RASTER_PATH
  era5/era5_%Y%m_hk.nc                     # ERA5_FILE_TEMPLATE
```

### 3.2 统一配置方式：`.shadowmap.env`

- 模板：`ShadowMap/.shadowmap.env.example`
- 本机文件：`ShadowMap/.shadowmap.env`（git 忽略）
- 目标：所有脚本都只读环境变量，不在代码里写死路径

关键变量（最小集合）：

- `INPUT_ROOT`：GLAN 源 CSV 根目录
- `OUTPUT_ROOT`：输出根目录（建议分版本）
- `BUILDING_LOCAL_GEOJSON`：本地 buildings 数据（GPKG/GeoJSON）
- `BUILDING_GPKG_LAYER`：GPKG 图层名（如 `hk_buildings`）
- `ERA5_FILE_TEMPLATE`：ERA5 文件模板（如 `era5_%Y%m_hk.nc`）
- `SHADOW_ENGINE_CANOPY_RASTER_PATH`：树冠 GeoTIFF（论文建议开启）

### 3.3 任务目录约定（避免 /tmp 丢失）

默认约定（脚本可覆盖）：

- `OUTPUT_ROOT`：输出根目录
- `SHADOWMAP_TASK_ROOT="${OUTPUT_ROOT}/_shadowmap_tasks"`：任务根目录

建议把所有 `targets/*.txt`、`*_retry.txt`、`bad list`、`logs` 都放在 `_shadowmap_tasks/` 下，机器重启不丢。

---

## 4) Mobility（日照/阴影）产出主线（论文数据）

### 4.1 计算入口

- Wrapper：`ShadowMap/scripts/batch-mobility-shadow.sh`
- Python 引擎：`ShadowMap/scripts/batch_mobility_shadow.py`
- Runner：`ShadowMap/scripts/run_full_recal_batch.sh`

### 4.2 核心机制（必须知道）

- 并行粒度：**分钟 bucket 并行**（单 `ProcessPoolExecutor`），避免文件级并行×桶级并行的嵌套
- 夜间快速路径：当 `solarIrradianceWm2 <= MOBILITY_NIGHT_IRRADIANCE_THRESHOLD` → `source=night`，跳过几何计算
- 断点续跑：若输出存在且未 `--force` → 跳过；配合 `--buckets-file` 可对指定分钟增量重算
- 稳定性：`MOBILITY_POOL_RESTARTS_PER_FILE` / `MOBILITY_POOL_RESTART_BACKOFF` 支持 pool 崩溃恢复与降并发重试

### 4.3 论文数据产出流水线（建议固定成 SOP）

1) validate 输出并生成 bad list  
2) repair 历史坏 CSV（自动备份）  
3) 对 bad targets（带树冠）重算到新目录  
4) `rsync --backup --backup-dir` 合并到最终分析目录  
5) 最终 validate + 生成 manifest（样本清单与数量）

合并示例（只同步 `*-sunlight.csv`，并备份被覆盖文件）：

```bash
NEW_OUT="$HOME/DATASET/GLAN_processed_paper_canopy_v1"
FINAL_OUT="$HOME/DATASET/GLAN_processed"
BACKUP_DIR="$HOME/DATASET/_backup_merge_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

rsync -av --prune-empty-dirs \
  --include='*/' --include='*-sunlight.csv' --exclude='*' \
  --backup --backup-dir="$BACKUP_DIR" \
  "$NEW_OUT"/ "$FINAL_OUT"/
```

manifest 示例（避免把 `_bench_*`、临时目录计入样本）：

```bash
find "$FINAL_OUT" -type f -name '*-sunlight.csv' ! -path '*/_bench_*/*' \
  | sed "s|^$FINAL_OUT/||" | sort > "$FINAL_OUT/_shadowmap_tasks/manifest_sunlight.txt"
wc -l "$FINAL_OUT/_shadowmap_tasks/manifest_sunlight.txt"
```

### 4.4 任务查看与重建（缺失输出 / retry 文件）

以 retry 文件粗略统计（文件级任务）：

```bash
ls -1 "$OUTPUT_ROOT/_shadowmap_tasks"/**/*_retry.txt 2>/dev/null | wc -l
```

从输入/输出对比扫描缺失（并可写回 retry 文件）：

```bash
python3 ShadowMap/scripts/rebuild_mobility_tasks.py missing-outputs \
  --input-root "$INPUT_ROOT" \
  --output-root "$OUTPUT_ROOT"
```

需要写回 `*_retry.txt` 时再加 `--write`（谨慎使用 `--overwrite`）。

方法与字段对齐：

- 统一说明：`ShadowMap/docs/mobility-sunlight.md`
- 字段速览：`ShadowMap/docs/mobility-sunlight-schema.md`
- 工程逻辑：`ShadowMap/docs/mobility-sunlight-logic.md`
- 论文公式：`ShadowMap/docs/mobility-sunlight-method-new.md`

---

## 5) 空间数据服务（GeoServer / PostGIS / WFS）

- 运维主线：`ShadowMap/Chinese documents/ops/空间数据服务运维手册.md`
- 中文索引：`ShadowMap/Chinese documents/README.md`
- 后端对接与自检：`ShadowMap/Chinese documents/backend/后端文档.md`

---

## 6) 开发/维护（面向开发者）

### 6.1 目录结构（简版）

```
ShadowMap/
  shadow-map-frontend/react-shadow-app/   # React + Vite
  shadow-map-backend/                    # Express + TS
  scripts/                               # Python-first batch + utilities
  docs/                                  # Mobility/IRBM 方法与字段
  Chinese documents/                     # 运维手册（CN）
```

更详细的入口点与文件职责：见 `CODEBASE_STRUCTURE.md`（入口存根）。

常用入口点（快速定位）：

- 前端（`ShadowMap/shadow-map-frontend/react-shadow-app/`）
  - 地图视口：`src/components/Map/ShadowMapViewport.tsx`
  - 控制面板：`src/components/UI/CleanControlPanel.tsx`
  - 后端服务封装：`src/services/*`（WFS/DEM/analysis/mobility 等）
- 后端（`ShadowMap/shadow-map-backend/`）
  - health：`GET /api/health`
  - WFS buildings：`GET /api/wfs-buildings/*`
  - weather（ERA5）：`GET /api/weather/current`
  - analysis：`POST /api/analysis/shadow`（Demo/交互）
- 批处理（`ShadowMap/scripts/`）
  - Mobility：`batch-mobility-shadow.sh` / `batch_mobility_shadow.py` / `run_full_recal_batch.sh`
  - QC：`validate_sunlight_csv.py` / `repair_sunlight_csv.py`
  - IRBM：`residence_irbm.py` / `run_residence_irbm.sh`

### 6.2 当前优先级（摘要）

- Demo 链路稳定：GeoServer/WFS + backend + frontend
- 论文离线批处理扩展：带树冠 + 夜间快速路径 + 质量控制流水线

详细计划与历史记录：见 `DEVELOPMENT_PLAN.md`（入口存根）。

---

## 7) WSL / Docker / 代理（常见坑位）

完整长文：`WSL-Docker-EasyConnect-v2rayN-guide.md`

最重要的两条经验：

1) 批处理/后端跑本机服务时，建议显式清理代理，避免 `localhost/局域网` 走代理导致超时：  
   - `unset ALL_PROXY HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`  
   - `export NO_PROXY=localhost,127.0.0.1,<LAN_IP>`
2) 多进程计算时，注意数值库线程（OpenBLAS/MKL）会放大 runnable 数：  
   - `OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1`
