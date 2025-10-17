# Repository Guidelines

## Project Structure & Module Organization
- `shadow-map-backend/`: TypeScript Express API. Source code lives in `src/`, compiled output in `dist/`, smoke scripts in `test-*.sh`.
- `shadow-map-frontend/react-shadow-app/`: Vite + React + TypeScript client. UI logic in `src/`, static examples under `public/Example`.
- `Chinese documents/`: operational guides (e.g., tile import, deployment). Update when workflows change.
- External simulators (`mapbox-gl-shadow-simulator/`, `leaflet-shadow-simulator-main/`) and large data caches remain local-only.

## Build, Test, and Development Commands
- Backend:
  - `cd shadow-map-backend && cp .env.example .env && npm install` — install dependencies and prepare config.
  - `npm run dev` — nodemon hot-reload server (port from `.env`, default 3500).
  - `npm run build && npm start` — compile with `tsc` then run `dist/server.js`.
- Frontend:
  - `cd shadow-map-frontend/react-shadow-app && npm install`
  - `npm run dev` — Vite dev server (`http://localhost:5173`).
  - `npm run lint && npm run build` — ensure lint passes and emit production bundle.
- Smoke tests: execute scripts like `bash test-both-endpoints.sh` after major data loads.

## Coding Style & Naming Conventions
- Language: all code, comments, docs, and commits must be in English.
- TypeScript strict mode is enforced; resolve every `tsc` warning.
- Formatting: follow ESLint/Prettier defaults; prefer single quotes and omit semicolons per legacy agent guide. Run `npm run lint` before commits.
- Naming: camelCase for variables/functions/files, PascalCase for React components and types. Keep terminology consistent (`buildingData`, `tileId`).
- Architecture: maintain modular separation (UI vs services vs data access); avoid “magic” values—document domain constants.

## Testing Guidelines
- No global unit suite yet; rely on targeted scripts and ad-hoc checks.
- Add `*.test.ts` near complex logic when introducing new algorithms; exclude tests from production builds.
- Validate data imports via GeoServer/PostGIS steps outlined in `Chinese documents/瓦片数据导入与统一流程.md`.

## Commit & Pull Request Guidelines
- Commit titles follow `[scope] message` (`scope` ∈ {`backend`,`frontend`,`docs`}): e.g., `[frontend] Center map on Hong Kong`.
- Pre-commit checklist: backend `npm run build`; frontend `npm run lint && npm run build`.
- PRs must include a concise summary, affected paths, run steps, smoke-test evidence, and UI screenshots/GIFs for visual changes. Reference related issues and flag data migrations.

## Security & Configuration Tips
- Never commit `.env` or credentials. Backend requires `MONGODB_URI`, `PORT`, etc.—copy `.env.example` locally.
- Large datasets (`data/`, `cache/`, `storage/`) stay out of Git; document changes in the Chinese guides.
