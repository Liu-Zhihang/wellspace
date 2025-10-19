# ShadowMap 项目简介

ShadowMap 是一个展示城市建筑阴影、日照情况的实验项目，包含前端地图应用和后端数据服务。

## 功能亮点

- **Mapbox 地图体验**：默认提供 2D/3D 建筑渲染，可切换 WFS、清爽模式等不同引擎。
- **建筑阴影分析**：根据当前时间与太阳位置计算建筑阴影、日照时长。
- **多数据源支持**：集成 WFS 服务、本地缓存、DEM 高程数据，支持回退策略。
- **性能工具**：内置多级缓存、智能阴影计算、防抖节流等通用工具。

## 项目结构

```
ShadowMap/
├── shadow-map-frontend/react-shadow-app  # React + TypeScript 客户端
├── shadow-map-backend                    # Express + TypeScript 后端
├── prototypes                            # 独立原型（仅参考）
├── scripts                               # 数据脚本
└── Chinese documents                     # 中文说明
```

详细目录说明参见 `CODEBASE_STRUCTURE.md`。

## 快速开始

### 前端

```bash
cd shadow-map-frontend/react-shadow-app
pnpm install
pnpm run dev        # 开发模式
pnpm run build      # 生产构建
```

默认将启动 Mapbox 模式。WFS、Clean 等模式可通过界面按钮切换。

### 后端

```bash
cd shadow-map-backend
npm install
npm run dev         # 开发模式
npm run build && npm start   # 生产模式
```

确保 `.env` 已根据 `.env.example` 配置好 WFS、数据库等凭据。

## 当前重点工作

1. 修复前端剩余的 TypeScript 错误，恢复无警告的构建流程。
2. 清理历史遗留的未使用组件与脚本，减小打包体积。
3. 持续补充文档和自动化脚本，提高协作效率。

详情请查看 `DEVELOPMENT_PLAN.md`。

## 协作约定

- 新任务先在计划文档中登记并进入 plan 模式，明确范围与风险后再动手。
- 每次改动结束需要更新相关文档（结构、计划、README）。
- 分支命名保持简洁（`fix/...`、`feat/...`、`docs/...`），合并前确保构建与测试通过。
