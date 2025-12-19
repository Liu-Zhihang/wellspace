# 文档索引（Documentation Index）

最后更新：2025-12-19

## 1) 先从这里开始

- 项目总览与快速启动：`README.md`
- 代码结构导航：`CODEBASE_STRUCTURE.md`
- 近期开发/运维计划：`DEVELOPMENT_PLAN.md`

## 2) 两条主线（先分清再动手）

### A) Demo / 实时可视化（HTTP 链路）

- GeoServer/PostGIS/WFS 运维入口：`ShadowMap/Chinese documents/README.md`
- 空间数据服务部署：`ShadowMap/Chinese documents/ops/空间数据服务部署.md`
- 瓦片数据导入与统一流程：`ShadowMap/Chinese documents/ops/瓦片数据导入与统一流程.md`
- 后端配置与自检（WFS/GeoServer 对接）：`ShadowMap/Chinese documents/backend/后端文档.md`

### B) 论文 / 离线批处理（Python-first，推荐用于研究产出）

- 数据目录与环境变量约定（两台机器统一）：`DATASETS.md`
- 批处理脚本统一配置模板（本地拷贝为 `.shadowmap.env`）：`ShadowMap/.shadowmap.env.example`
- Mobility 批处理入口（默认 Python，可选 Node/HTTP）：`ShadowMap/scripts/batch-mobility-shadow.sh`
- 批量全量重算（单进程池、断点续跑）：`ShadowMap/scripts/run_full_recal_batch.sh`
- 计算引擎（Python 本地计算）：`ShadowMap/scripts/batch_mobility_shadow.py`

## 3) Mobility（日照/阴影）方法与字段

- 方法与字段说明：`ShadowMap/docs/mobility-sunlight.md`
- 字段速览（schema）：`ShadowMap/docs/mobility-sunlight-schema.md`
- 计算逻辑（工程视角）：`ShadowMap/docs/mobility-sunlight-logic.md`
- 论文写作导向（方法+公式）：`ShadowMap/docs/mobility-sunlight-method-new.md`

### 3.1) 任务管理与数据质量（强烈建议）

- 缺失输出/任务重建工具：`ShadowMap/scripts/rebuild_mobility_tasks.py`
- 输出 CSV 结构校验：`ShadowMap/scripts/validate_sunlight_csv.py`
- 输出 CSV 修复工具（历史坏文件对齐）：`ShadowMap/scripts/repair_sunlight_csv.py`

## 4) 居住地暴露（IRBM）

- 方法说明（详细版）：`ShadowMap/Chinese documents/analysis/residence-sunlight-IRBM-method.md`
- 纯 Python 批量计算脚本：`ShadowMap/scripts/residence_irbm.py`
- 运行包装器（自动加载 `.shadowmap.env`）：`ShadowMap/scripts/run_residence_irbm.sh`

## 5) 空间数据服务（GeoServer / PostGIS / WFS）

- 中文运维文档索引：`ShadowMap/Chinese documents/README.md`
- 空间数据服务部署（PostGIS + GeoServer）：`ShadowMap/Chinese documents/ops/空间数据服务部署.md`
- 瓦片数据导入与统一流程（GeoJSON + DEM）：`ShadowMap/Chinese documents/ops/瓦片数据导入与统一流程.md`

## 6) 其他参考

- WSL / Docker / 代理相关：`WSL-Docker-EasyConnect-v2rayN-guide.md`
