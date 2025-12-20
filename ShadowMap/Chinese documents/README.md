# 中文文档索引（Chinese documents）

本目录用于存放 ShadowMap 的中文运维与数据流程文档，并按主题分层，减少“所有东西堆在一起”的维护成本。

> 原则：当前有效流程尽量短、可执行；历史资料放入 `archive/` 并明确标注“可能过时”。

## 目录结构

- `ops/`：空间服务与数据导入（GeoServer / PostGIS / WFS / DEM）
- `datasets/`：外部数据集说明（例如 GlobalBuildingAtlas / LoD1 / Height）
- `frontend/`：前端相关的开发/排障/集成说明
- `backend/`：后端服务的配置与排障说明
- `devtools/`：开发工具链（WSL / 代理 / Codex / MCP 等）
- `analysis/`：研究方法与指标定义（IRBM/RMBM/NEAP 等）
- `archive/`：历史资料/第三方摘录（可能与当前实现不一致）

## 当前建议阅读顺序（Demo / 数据服务）

1) 空间数据服务运维主线（部署 + 导入 + 验证）：`ops/空间数据服务运维手册.md`  
2) 后端配置与自检：`backend/后端文档.md`  

## 文件清单

- 运维（ops）
  - `ops/空间数据服务运维手册.md`：PostGIS + GeoServer 部署、瓦片入库、GeoServer 刷新与 ShadowMap 后端联调（主线）
  - `ops/空间数据服务部署.md`：入口（已合并；保留路径兼容）
  - `ops/瓦片数据导入与统一流程.md`：入口（已合并；保留路径兼容）

- 数据集（datasets）
  - `datasets/TUM数据介绍.md`：GlobalBuildingAtlas 数据说明（LoD1/Height 等）

- 前端（frontend）
  - `frontend/前端文档.md`：Clean 3D 控制面板与核心组件梳理（参考）
  - `frontend/LOCAL_DEM_GUIDE.md`：前端直读本地 DEM 的方案说明（参考）

- 后端（backend）
  - `backend/后端文档.md`：后端 `.env` 配置、WFS/GeoServer 对接与常用自检命令

- 开发工具（devtools）
  - `devtools/mcp安装的坑以及wsl配置codex的坑.md`：WSL + Codex CLI + MCP 常见坑位（参考）

- 归档（archive）
  - `archive/开发文档.md`：早期愿景/规划（可能过时）
  - `archive/MongoDB数据访问完整指南.md`：MongoDB 方案说明（当前主线可能未使用）
  - `archive/mapbox-gl-shadow-simulator使用手册.md`：第三方 README 摘录（以官方为准）

- 研究方法（analysis）
  - `analysis/residence-sunlight-IRBM-method.md`：入口（当前有效版本见 `ShadowMap/docs/residence-sunlight-IRBM-method.md`）
