# 数据与环境配置入口

最后更新：2026-05-12

本文件只保留数据入口，避免与主文档重复。完整线性说明见 `DOCS_INDEX.md`，数据登记和具体路径见 `ShadowMap/docs/data-registry.md`。

## 1. 统一配置

```bash
cp ShadowMap/.shadowmap.env.example ShadowMap/.shadowmap.env
source ShadowMap/.shadowmap.env
```

`.shadowmap.env` 是本机文件，不能提交。真实密码、CDS 凭据、Mapbox token、数据库连接串和本地大数据路径都应放在本机环境或本机配置里。

## 2. 数据类型

| 数据 | 用途 | 推荐位置 | 说明 |
| --- | --- | --- | --- |
| Mobility stay CSV | 全美移动阴影主输入 | `~/datasets/wellspace_v2/shadowmap/raw/` 或 WSA `/home/jinlin/data/Mobility_Data/` | `place20190206.csv` 语义见 `ShadowMap/docs/place20190206-data-document.md` |
| Buildings | 建筑阴影障碍物 | PostGIS + `derived/buildings_geoparquet/` | 全国计算优先走 GeoParquet 分区层 |
| Canopy CHM | 树冠阴影 | HDD cache，例如 `/mnt/data_hdd/shadowmap_cache/` | 来源是 AWS Data for Good Meta/WRI forests 数据集 |
| ERA5 weather/cloud | 云量和辐射 | `raw/era5/` | 使用 CDS API 下载到本地，避免 worker 在线请求 |
| Output/checkpoint | 计算结果和断点续跑 | `derived/executor_runs/` | 每个 run 需要 summary、日志、manifest/checkpoint |

## 3. 下载入口

Canopy：

```text
https://registry.opendata.aws/dataforgood-fb-forests/
ShadowMap/scripts/ops/canopy/sync_tiles_index.sh
ShadowMap/scripts/ops/canopy/generate_meta_wri_manifest.py
ShadowMap/scripts/ops/canopy/download_meta_wri_canopy.sh
ShadowMap/scripts/ops/canopy/build_canopy_vrt.sh
```

ERA5：

```bash
python3 ShadowMap/scripts/ops/weather/download_era5_single_levels_month.py --help
```

Buildings GeoParquet：

```text
ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet.py
ShadowMap/scripts/ops/postgis/export_building_partitions_geoparquet_batch.py
ShadowMap/scripts/ops/generate_building_partition_catalog.py
```

## 4. 禁止提交

- 原始移动数据、建筑大文件、树冠 tile、ERA5 NetCDF、executor 输出。
- `.env`、`.shadowmap.env`、CDS 凭据、Mapbox token、数据库密码。
- 临时 cache、下载中间文件、机器私有配置。

提交前用 `git status --short` 和敏感信息搜索确认。
