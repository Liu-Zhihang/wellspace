# 数据与环境配置（Data + Env）

本文件用于解决「两台机器路径不同」「脚本/服务里硬编码路径」导致的迁移问题。核心原则：所有路径与服务地址都通过环境变量配置，不写死在脚本/代码里。

最后更新：2025-12-15

## 1) 推荐的数据目录结构（Workstation A 示例）

建议把常用数据集中到 `~/DATASET`：

```
~/DATASET/
  GLAN/PHASE1/spatial_temporal_merge/      # INPUT_ROOT
  GLAN_processed/                          # 旧输出（最终归档）
  GLAN_processed_recalc_*/                 # 新一轮重算输出（临时/中间）
  Height/hong_kong_cleaned.gpkg            # BUILDING_LOCAL_GEOJSON
  Tree/HKtree_small.tif                    # SHADOW_ENGINE_CANOPY_RASTER_PATH
  era5/era5_%Y%m_hk.nc                     # ERA5_FILE_TEMPLATE
```

> 服务器 B 可以使用任意路径，但建议也做一个“数据根目录”（例如 `/data/DATASET` 或 `/media/.../DATASET`），并通过同一套 env 变量映射。

## 2) 统一配置方式：`.shadowmap.env`（推荐）

1. 拷贝模板（本地文件，git 已忽略）：
   ```bash
   cp ShadowMap/.shadowmap.env.example ShadowMap/.shadowmap.env
   ```
2. 编辑 `ShadowMap/.shadowmap.env`，至少填好这些变量：
   - `INPUT_ROOT`
   - `OUTPUT_ROOT`
   - `BUILDING_LOCAL_GEOJSON`（以及 `BUILDING_GPKG_LAYER`）
   - `ERA5_FILE_TEMPLATE`（可选但推荐）
   - `SHADOW_ENGINE_CANOPY_RASTER_PATH`（可选；关树冠也可以保留）
3. 运行脚本时会自动加载：
   - 优先使用 `SHADOWMAP_ENV_FILE=/path/to/profile.env`
   - 否则使用 `ShadowMap/.shadowmap.env`

## 3) 批量计算输出/任务目录（避免 /tmp）

默认：

- 输出根：`OUTPUT_ROOT`
- 任务根：`SHADOWMAP_TASK_ROOT="${OUTPUT_ROOT}/_shadowmap_tasks"`
- 任务桶目录：`BUCKET_DIR="${SHADOWMAP_TASK_ROOT}/buckets_part1_migrated"`（脚本可覆盖）

这些目录都在 `OUTPUT_ROOT` 下，机器重启不会丢。

## 4) 关树冠（提速开关）

两种等价方式（二选一）：

1) 在 `ShadowMap/.shadowmap.env` 里设置：

```bash
export MOBILITY_INCLUDE_CANOPY="false"
```

2) 或者临时覆盖（单次命令生效）：

```bash
MOBILITY_INCLUDE_CANOPY=false CONCURRENCY=32 bash ShadowMap/scripts/run_full_recal_batch.sh
```

## 5) 查看还剩多少任务 / 重建任务

### 5.1 以 retry 文件为准（文件级任务）

```bash
ls -1 "$BUCKET_DIR"/*_retry.txt 2>/dev/null | wc -l
```

### 5.2 扫描缺失的 `*-sunlight.csv`（从输入/输出对比）

```bash
python3 ShadowMap/scripts/rebuild_mobility_tasks.py missing-outputs \
  --input-root "$INPUT_ROOT" \
  --output-root "$OUTPUT_ROOT"
```

需要写回 `*_retry.txt` 时加 `--write`（谨慎使用 `--overwrite`）。

## 6) 合并重算结果回 `GLAN_processed`（推荐用 rsync + 备份目录）

示例（把 `NEW_OUT` 的 `*-sunlight.csv` 合并到 `FINAL_OUT`，并把被覆盖的旧文件备份到独立目录）：

```bash
NEW_OUT="$HOME/DATASET/GLAN_processed_recalc_migrated_part1"
FINAL_OUT="$HOME/DATASET/GLAN_processed"
BACKUP_DIR="$HOME/DATASET/_backup_sunlight_$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"
rsync -av --prune-empty-dirs \
  --include='*/' --include='*-sunlight.csv' --exclude='*' \
  --backup --backup-dir="$BACKUP_DIR" \
  "$NEW_OUT"/ "$FINAL_OUT"/
```

## 6.1) 输出质量检查与修复（CSV 结构对齐）

> 历史输出中曾出现“CSV 未正确 quoting 导致逗号/换行把列打散”的情况，进而影响统计图（例如夜间出现非零日照）。

### 快速检查（推荐先跑）

```bash
FINAL_OUT="$HOME/DATASET/GLAN_processed"
python3 ShadowMap/scripts/validate_sunlight_csv.py --root "$FINAL_OUT" --max-rows-per-file 5000 \
  --write-bad-list "$FINAL_OUT/_shadowmap_tasks/bad_sunlight_files.txt"
```

> `--max-rows-per-file 0` 会全量扫描（更慢但更严格）。

### 修复（只修坏文件；带备份）

```bash
FINAL_OUT="$HOME/DATASET/GLAN_processed"
python3 ShadowMap/scripts/repair_sunlight_csv.py --root "$FINAL_OUT" \
  --bad-list "$FINAL_OUT/_shadowmap_tasks/bad_sunlight_files.txt" \
  --write
```

修复后原文件会被移动到：`$FINAL_OUT/_repair_backup_YYYY-mm-dd_HHMMSS/`。

## 7) 后端/前端与 GeoServer 的关系（快速对齐）

- GeoServer/WFS：由后端 `.env` 里的 `BUILDING_WFS_BASE_URL` / `BUILDING_WFS_TYPE_NAME` 指向。
- 前端请求后端：`VITE_BACKEND_BASE_URL` 指向后端（默认 `http://localhost:3001`）。
- 空间服务部署与瓦片入库流程见：`ShadowMap/Chinese documents/ops/空间数据服务部署.md`、`ShadowMap/Chinese documents/ops/瓦片数据导入与统一流程.md`。

## 8) IRBM（居住地暴露）运行入口

- 方法说明：`ShadowMap/Chinese documents/analysis/residence-sunlight-IRBM-method.md`
- 纯 Python 脚本：`ShadowMap/scripts/residence_irbm.py`
