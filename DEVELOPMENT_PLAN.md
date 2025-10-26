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
| REQ-CLOUD-04 | Integrate GFS cloud attenuation & weather cache | Done | Weather service live; Clean/WFS modes consume sunlight factor |
| REQ-CLEAN-05 | Consolidate map modes around Clean 3D | Done | Legacy modes retired; Clean viewport is sole entry point |

## Next Steps

1. Finish `REQ-TS-01`
   - Guard geometry types when reading `coordinates`.
   - Replace accesses to private Mapbox internals (`_data`, `_loaded`) with safe helpers.
   - Normalise timeout types to the browser-safe `number`.
   - Re-run `pnpm exec tsc -b` and `pnpm run build`.
2. Harden Clean-only viewport
   - Audit Zustand store for unused fields after legacy removal.
   - Split ShadeMap logic into testable utilities (follow-up ticket).
3. After TS build work, run bundle report to confirm no missing imports and size regressions.

## Risks / Blockers

- Multiple map components still assume Mapbox private fields; needs careful refactor.
- `OptimizedMapboxComponent` references cache APIs that have drifted; ensure functionality or suspend the component.
- Ensure backend API parity before removing any additional services.

## Workflow Reminders

- Every new task: update this plan, confirm scope, then code.
- Each change set should update docs if structure or workflow shifts.
- Keep branches small (`fix/...`, `feat/...`), and merge only after build/test passing.
