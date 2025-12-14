# Development Plan (Sprint 2025-10-19 ~ 2025-10-26)

## Sprint Goals

1. Restore a clean TypeScript build for `react-shadow-app`.
2. Trim unused components and dead code to reduce bundle size.
3. Document core architecture and workflow (this document + `CODEBASE_STRUCTURE.md`).

## Active Work

| ID | Task | Status | Notes |
| --- | --- | --- | --- |
| REQ-TS-01 | Fix remaining TypeScript errors in map components | In Progress | Focus on `Mapbox3DComponent`, `Wfs3DShadowMap`, `OptimizedMapboxComponent`, and timeout typings |
| REQ-CLEAN-02 | Remove unused UI/Control components | Done | Legacy panels removed; verify no stale imports remain |
| REQ-DOC-03 | Establish structure + plan docs | Done | `CODEBASE_STRUCTURE.md` and this file created |
| REQ-CLEAN-04 | Consolidate frontend map modes | Done | Mapbox viewport shared; Clean UI retained as styling |
| REQ-ANALYSIS-01 | Extend upload workflow for geometry-based analysis | Done | GeoJSON upload paths merged into Clean control + toolbar; overlays/export wired |
| REQ-ENGINE-01 | Shadow engine service abstraction | In Progress | `/api/analysis/shadow` + local pybdshadow worker + script bridge landed; Redis/metrics TBD |
| REQ-ENGINE-02 | Frontend shadow engine integration | In Progress | Zustand stores consume engine metrics, heatmap default-off toggle + overlay redesign shipped |
| REQ-MAP-BASE | MapLibre basemap switching revamp | Done | `mapSettings.baseMapId` now drives in-place `map.setStyle` calls; overlays + uploads are rehydrated without remounting |
| REQ-MOBILITY-01 | Mobility data ingestion + UI | In Progress | CSV uploader, dataset list, validation pipeline and sample data refresh in-flight |
| REQ-MOBILITY-02 | Trajectory rendering + playback | In Progress | MapLibre line/heatmap layers + animation hooks under active development |
| REQ-MOBILITY-03 | Mobility controls & overlays | In Progress | Unified upload panel, zoom/animate buttons landed; heatmap/analysis hooks next |
| REQ-MOBILITY-04 | Mobility sunlight export | New | Derive per-minute sunlight/shadow (0/1) along trajectories and export CSV/JSON |
| REQ-CANOPY-01 | Tree canopy data ingestion + analysis integration | In Progress | Canopy dataset synced to the workstation; FastAPI engine running in tmux; backend now points to workstation IP/port (see `.env`) |

## Next Steps

1. Post-merge verification for `REQ-TS-01` and `REQ-ANALYSIS-01`
   - Re-run `pnpm exec tsc -b` and `pnpm run build` to confirm clean builds.
   - Smoke test Clean mode (upload + analysis overlays) to ensure no regressions.
2. Tree canopy integration (`REQ-CANOPY-01`)
   - Validate canopy dataset on the workstation; define API contract between Express backend and the FastAPI engine.
   - Keep `.env` pointing to the workstation IP/port; document tmux session layout and restart steps.
   - Plan frontend overlays/analytics that consume canopy responses.
   - ✅ 已用 curl 调用 `http://<workstation-ip>:9000/shadow`（backend_url 指向 `http://<workstation-ip>:3500`，metadata 带 `/path/to/HKtree_reprojected4326.tif`）返回有效 JSON，确认树冠栅格被引擎加载。
3. After TS/analysis completion, run a bundle report to confirm no missing imports and size regressions.
4. Shadow-engine migration plan
   - Stage A – Research & Prototype
     - Evaluate `pybdshadow` capabilities (shadow polygons, sunshine duration grids, performance on HK CBD subset).
     - Build a minimal Python notebook/service to ingest building footprints + height and output GeoJSON shadows + statistics.
     - Document upstream data requirements (footprint source, height attribute, CRS) and preprocessing pipeline.
   - Stage B – Service Abstraction
     - ✅ `/api/analysis/shadow` route + cache/in-flight controller delivered with simulator fallback.
     - ✅ Added local pybdshadow worker integration via `service_cli.py` + `SHADOW_ENGINE_SCRIPT_PATH`; backend now streams requests through the Python CLI when no external base URL is configured.
     - [ ] Persist cache entries in Redis (keyed by bbox+bucket) and expose metrics endpoints for hit rate / latency.
     - [ ] Finalise deployment plan (stand-alone microservice vs worker pool) and health probes.
   - Stage C – Frontend Integration
     - ✅ Zustand store, Map viewport, and Analysis panel now read/write engine status + results.
     - [ ] Add UI toggles for shadow polygon vs heatmap overlays and expose cache/debug metadata.
     - [ ] Remove remaining ShadeMap sampling paths once backend parity is validated; gate behind feature flag for rollout.
     - [ ] Stream results into downloadable GeoJSON/CSV exports (currently geometry analysis reuses summary only).
   - Stage D – Engine Evaluation
     - Stand up a spike comparing MapLibre vs CesiumJS rendering of returned shadow polygons + potential 3D tiles.
     - Catalogue migration subtasks (camera controls, interaction patterns, data loading) with engineering estimates.
     - Prototype CesiumJS overlay of pybdshadow outputs to stress-test performance on HK CBD dataset.
   - Stage E – Testing & Roll-out
     - Capture regression suite: contract tests for `/api/analysis/shadow`, frontend rendering snapshot tests, and store selectors.
     - Define performance SLA (p95 latency per bbox) and benchmark both simulator + real engine.
   - Draft launch checklist covering container build, monitoring dashboards, cache warmup, and rollback plan.
5. Ship mobility overlays
   - Refresh `ShadowMap/data/samples/mobility-demo.csv` with denser traces (loop/crossing/walk) for animation QA.
   - Wire `useMobilityPlayback` heatmap/progress layers into shared timeline, including Animate toggle + heatmap opacity rules.
6. Launch mobility analysis feature
   - Design CSV schema + validation (id, time ISO8601, lon/lat decimal, optional metrics) and update `ShadowMap/data/samples/mobility-demo.csv` accordingly.
   - Build uploader modal + dataset drawer entries; surface row-level errors similar to Mobmap’s “data type mismatch”.
   - Implement GeoJSON/multi-layer rendering for traces, tied to global animation clock; compute per-trace analytics, heatmaps, and export hooks.
   - Unify mobility controls with main upload experience, provide zoom-to-dataset, animation toggle, and timeline-linked heatmap overlays.

## Infra / Environment Updates

- Backend services now run on the workstation (tmux sessions): one for the Express backend, one for the FastAPI engine that supports canopy/shadow workflows.
- `.env` files contain the workstation IP/port for backend + engine connectivity; keep secrets local and do not commit populated env files.
- Tree canopy dataset has been transferred to the workstation; integration is tracked under `REQ-CANOPY-01`.
- 已通过 curl 调用验证 FastAPI 引擎可读取 `/path/to/HKtree_reprojected4326.tif`（<workstation-ip>:9000/shadow，backend_url=<workstation-ip>:3500）。
- FastAPI 引擎添加了 `include_canopy` 开关（缺省不加载树冠），携带 metadata `{"canopyRasterPath": "...", "includeCanopy": true}` 可启用树冠；`DEBUG_CANOPY_LOG=1` 时日志会输出建筑/树冠合并数量。实测同一 bbox（114.159,22.277,114.175,22.288）在含树冠与仅建筑下 `avgShadowPercent` 有差异（48.75% vs 46.38%），确认树冠已参与计算。
- 日照计算改为多时间片网格累积（可配置 `samples.grid/timeSteps/stepMinutes`），不再使用占位采样。当前实测同一 bbox 的日照小时也有差异（7.73h vs 7.83h），如需更精细可提高 grid 或 timeSteps。
- 前端网络：`VITE_BACKEND_BASE_URL` 指向 `http://<workstation-ip>:3001`；WFS/天气等全部走统一 `API_BASE_URL`。访问需确保浏览器代理规则允许该 IP（校园 VPN SOCKS5 127.0.0.1:1080 或直连）；工作站防火墙已放行 3001。
- 移动性日照/阴影：前端 mobility 计算已附带 `includeCanopy/canopyRasterPath` metadata，但后端 `/analysis/shadow` 路由尚未解析/转发 `includeCanopy`，引擎侧默认不含树冠；如需轨迹级实时阴影/日照，需要在后端放行 metadata 并按需传轨迹 geometry，而不只是 bbox 采样。

## Risks / Blockers

- Multiple map components still assume Mapbox private fields; needs careful refactor.
- `OptimizedMapboxComponent` references cache APIs that have drifted; ensure functionality or suspend the component.
- Ensure backend API parity before removing any additional services.

## Workflow Reminders

- Every new task: update this plan, confirm scope, then code.
- Each change set should update docs if structure or workflow shifts.
- Keep branches small (`fix/...`, `feat/...`), and merge only after build/test passing.
