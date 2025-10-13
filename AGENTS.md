# Repository Guidelines

## Project Structure & Module Organization
- `ShadowMap/` is the main workspace.
  - `shadow-map-backend/`: TypeScript Express API (`src/`, `dist/`, `.env*`, shell test scripts `test-*.sh`).
  - `shadow-map-frontend/react-shadow-app/`: Vite + React + TypeScript client (`src/`, `public/`).
  - `shadow-map-frontend/*.html`: Standalone prototypes/manual tests.
  - External libs (`mapbox-gl-shadow-simulator/`, `leaflet-shadow-simulator-main/`) are local and ignored by Git.
  - Data/cache directories (e.g., `ShadowMap/**/data`, `cache`, `storage`) are gitignored.

## Build, Test, and Development Commands
- Backend
  - `cd ShadowMap/shadow-map-backend && cp .env.example .env && npm install`
  - `npm run dev` — start with Nodemon (port from `.env`, fallback 3001/3500).
  - `npm run build && npm start` — compile (`tsc`) then run `dist/server.js`.
- Frontend (React)
  - `cd ShadowMap/shadow-map-frontend/react-shadow-app && npm install`
  - `npm run dev` — Vite dev server (e.g., `http://localhost:5173`).
  - `npm run build` — production build.
- Prototypes: open `ShadowMap/shadow-map-frontend/*.html` directly or serve via a static server.

## Coding Style & Naming Conventions
- English only for code, comments, and commits.
- TypeScript strict mode is enabled across backend and frontend.
- Frontend lint: `npm run lint` (ESLint). Keep 0 errors before commit.
- Naming: camelCase for variables/functions/files; PascalCase for React components and types.
- Consistent terminology: do not rename the same concept across modules (e.g., keep `buildingData` consistent).
- Modular design and separation of concerns (UI, business logic, data access). Avoid “magic”.

## Testing Guidelines
- No formal test suite yet. Use backend shell scripts for smoke tests:
  - Examples: `bash test-hongkong-data.sh`, `bash test-tum-wfs.sh`, `bash test-both-endpoints.sh`.
- Add unit tests for new complex logic; co-locate as `*.test.ts` and exclude from build.

## Commit & Pull Request Guidelines
- Format: `[scope] title` where `scope` is `backend`/`frontend`/`docs`.
- PRs include: summary, affected paths, run steps, and screenshots/GIFs for UI.
- Pre-commit verification: frontend `npm run lint && npm run build`; backend `npm run build`. Do not commit `.env` or large data.

## Security & Configuration
- Backend requires `.env` (e.g., `MONGODB_URI`, `PORT`). Never commit secrets.
- Large data/cache and external libraries are ignored per `.gitignore`; keep them local.
