# 文档索引（Documentation Index）

最后更新：2025-12-15

## 1) 先从这里开始

- 项目总览与快速启动：`README.md`
- 代码结构导航：`CODEBASE_STRUCTURE.md`
- 近期开发/运维计划：`DEVELOPMENT_PLAN.md`

## 2) 数据与环境（两台机器统一）

- 数据目录与环境变量约定：`DATASETS.md`
- 批处理脚本统一配置模板（本地拷贝为 `.shadowmap.env`）：`ShadowMap/.shadowmap.env.example`
- 后端环境变量模板（本地拷贝为 `.env`）：`ShadowMap/shadow-map-backend/.env.example`

## 3) 批量计算（Mobility sunlight/shadow）

- 方法与字段说明：`ShadowMap/docs/mobility-sunlight.md`
- 批量全量重算（单进程池、断点续跑）：`ShadowMap/scripts/run_full_recal_batch.sh`
- 计算引擎（Python）：`ShadowMap/scripts/batch_mobility_shadow.py`
- 引擎包装器（默认 Python，可选 Node/HTTP）：`ShadowMap/scripts/batch-mobility-shadow.sh`
- 缺失输出/任务重建工具：`ShadowMap/scripts/rebuild_mobility_tasks.py`
- 输出 CSV 结构校验：`ShadowMap/scripts/validate_sunlight_csv.py`
- 输出 CSV 修复工具（历史坏文件对齐）：`ShadowMap/scripts/repair_sunlight_csv.py`

## 3.1) 居住地暴露（IRBM）

- 方法说明（详细版）：`ShadowMap/Chinese documents/analysis/residence-sunlight-IRBM-method.md`
- 纯 Python 批量计算脚本：`ShadowMap/scripts/residence_irbm.py`
- 运行包装器（自动加载 `.shadowmap.env`）：`ShadowMap/scripts/run_residence_irbm.sh`

## 4) 空间数据服务（GeoServer / PostGIS / WFS）

- 中文运维文档索引：`ShadowMap/Chinese documents/README.md`
- 空间数据服务部署（PostGIS + GeoServer）：`ShadowMap/Chinese documents/ops/空间数据服务部署.md`
- 瓦片数据导入与统一流程（GeoJSON + DEM）：`ShadowMap/Chinese documents/ops/瓦片数据导入与统一流程.md`

## 5) 其他参考

- WSL / Docker / 代理相关：`WSL-Docker-EasyConnect-v2rayN-guide.md`
