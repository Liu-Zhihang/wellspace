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
| REQ-ANALYSIS-01 | Extend upload workflow for geometry-based analysis | In Progress | Uploads auto-select geometry, UI overlays show backend metrics, JSON/CSV export ready |
| REQ-ENGINE-01 | Shadow engine service abstraction | In Progress | `/api/analysis/shadow` + local pybdshadow worker + script bridge landed; Redis/metrics TBD |
| REQ-ENGINE-02 | Frontend shadow engine integration | In Progress | Zustand stores consume engine metrics, heatmap default-off toggle + overlay redesign shipped |
| REQ-MAP-BASE | MapLibre basemap switching revamp | Done | `mapSettings.baseMapId` now drives in-place `map.setStyle` calls; overlays + uploads are rehydrated without remounting |
| REQ-MOBILITY-01 | Mobility data ingestion + UI | In Progress | CSV uploader, dataset list, validation pipeline and sample data refresh in-flight |
| REQ-MOBILITY-02 | Trajectory rendering + playback | In Progress | MapLibre line/heatmap layers + animation hooks under active development |
| REQ-MOBILITY-03 | Mobility controls & overlays | In Progress | Unified upload panel, zoom/animate buttons landed; heatmap/analysis hooks next |
| REQ-MOBILITY-04 | Mobility sunlight export | New | Derive per-minute sunlight/shadow (0/1) along trajectories and export CSV/JSON |

## Next Steps

1. Finish `REQ-TS-01`
   - Guard geometry types when reading `coordinates`.
   - Replace accesses to private Mapbox internals (`_data`, `_loaded`) with safe helpers.
   - Normalise timeout types to the browser-safe `number`.
   - Re-run `pnpm exec tsc -b` and `pnpm run build`.
2. Kick off `REQ-ANALYSIS-01`
   - Merge trace upload into a generic GeoJSON uploader (Clean control + left toolbar).
   - Extend `shadowMapStore` to manage uploaded geometries, analysis results, exports.
   - Prototype sampling + ShadeMap integration for shadow coverage / sunlight hours.
   - Wire mobility traces to shadow analysis for per-minute sunlight/shadow export (see `REQ-MOBILITY-04`).
3. After TS build and analysis prototype, run bundle report to confirm no missing imports and size regressions.
4. Draft shadow-engine migration plan
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
5. Launch mobility analysis feature
   - Design CSV schema + validation (id, time ISO8601, lon/lat decimal, optional metrics) and update `ShadowMap/data/samples/mobility-demo.csv` accordingly.
   - Build uploader modal + dataset drawer entries; surface row-level errors similar to Mobmap’s “data type mismatch”.
   - Implement GeoJSON/multi-layer rendering for traces, tied to global animation clock; compute per-trace analytics, heatmaps, and export hooks.
   - Unify mobility controls with main upload experience, provide zoom-to-dataset, animation toggle, and timeline-linked heatmap overlays.

## Risks / Blockers

- Multiple map components still assume Mapbox private fields; needs careful refactor.
- `OptimizedMapboxComponent` references cache APIs that have drifted; ensure functionality or suspend the component.
- Ensure backend API parity before removing any additional services.

## Workflow Reminders

- Every new task: update this plan, confirm scope, then code.
- Each change set should update docs if structure or workflow shifts.
- Keep branches small (`fix/...`, `feat/...`), and merge only after build/test passing.
