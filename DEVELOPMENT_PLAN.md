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
| REQ-ANALYSIS-01 | Extend upload workflow for geometry-based analysis | Planned | Merge upload UX, compute shadow coverage & sunlight stats, export results |

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
3. After TS build and analysis prototype, run bundle report to confirm no missing imports and size regressions.
4. Draft shadow-engine migration plan
   - Stage A – Research & Prototype
     - Evaluate `pybdshadow` capabilities (shadow polygons, sunshine duration grids, performance on HK CBD subset).
     - Build a minimal Python notebook/service to ingest building footprints + height and output GeoJSON shadows + statistics.
     - Document upstream data requirements (footprint source, height attribute, CRS) and preprocessing pipeline.
   - Stage B – Service Abstraction
     - Design backend interface (`POST /analysis/shadow`) returning shadow polygons, sunshine metrics, confidence metadata.
     - Outline caching strategy (tile/time buckets) and fallback behaviour when data is missing or geometry is too large.
     - Decide deployment model (separate microservice vs worker) and dependency management.
   - Stage C – Frontend Integration
     - Replace ShadeMap sampling with service call; update Zustand store types to consume new stats/metadata.
     - Render returned shadow/heatmap layers as Mapbox/MapLibre vector overlays (remove ShadeMap visual dependency).
     - Refresh analysis overlay UI (stats, notes, confidence flags) and expose controls for heatmap/shadow toggles.
   - Stage D – Engine Evaluation
     - Compare staying on MapLibre vs migrating to CesiumJS (prototype 3D tiles loading, assess effort).
     - Decide target engine and list migration subtasks (routing, UI adjustments, data loading).
   - Stage E – Testing & Roll-out
     - Define regression suite (unit tests for analysis response, integration tests for overlay rendering).
     - Collect benchmark numbers (processing time per polygon, accuracy vs ShadeMap sampling).
     - Prepare deployment checklist (service containerization, monitoring, rollback strategy).

## Risks / Blockers

- Multiple map components still assume Mapbox private fields; needs careful refactor.
- `OptimizedMapboxComponent` references cache APIs that have drifted; ensure functionality or suspend the component.
- Ensure backend API parity before removing any additional services.

## Workflow Reminders

- Every new task: update this plan, confirm scope, then code.
- Each change set should update docs if structure or workflow shifts.
- Keep branches small (`fix/...`, `feat/...`), and merge only after build/test passing.
