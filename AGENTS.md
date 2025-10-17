# Repository Guidelines

## Project Structure & Module Organization
ShadowMap/ is the workspace root. `shadow-map-backend/` houses the Express + TypeScript API; put source in `src/`, generated JS in `dist/`, and keep local environment files as `.env*`. The React client lives in `shadow-map-frontend/react-shadow-app/` with code under `src/` and static assets in `public/`. Standalone HTML prototypes sit beside the React app in `shadow-map-frontend/`. Data, cache, and third-party simulator directories remain local only; do not commit them. Place any new scripts in `ShadowMap/scripts` with executable permissions.

## Build, Test, and Development Commands
Bootstrap once with `cd ShadowMap/shadow-map-backend && cp .env.example .env && npm install`. Run the backend in watch mode via `npm run dev`; compile and serve production code with `npm run build && npm start`. For the frontend, run `cd ShadowMap/shadow-map-frontend/react-shadow-app && npm install` followed by `npm run dev` for the Vite server or `npm run build` for production assets. Manual prototypes can be opened directly in a browser or served through any static file server.

## Coding Style & Naming Conventions
Follow TypeScript strict mode across backend and frontend. Keep files, variables, and functions camelCase; reserve PascalCase for React components, classes, and types. Prefer descriptive names like `buildingDataService`. Use ESLint via `npm run lint` in the React project and respect all warnings before commit. Write concise comments only when the intent is unclear; default to self-explanatory code.

## Testing Guidelines
Smoke-test API endpoints with the provided shell scripts (for example, `bash test-hongkong-data.sh` and `bash test-both-endpoints.sh`). Co-locate any new unit tests as `*.test.ts` files near their subjects and exclude them from runtime builds. Document manual test steps in pull requests when automation is not available.

## Commit & Pull Request Guidelines
Commit messages follow `[scope] title`, using scopes such as `backend`, `frontend`, or `docs`. Keep titles under ~60 characters and describe the change in the present tense. Pull requests should summarize intent, list touched paths, note verification steps (`npm run lint && npm run build`, `npm run build`), and include UI screenshots or GIFs when relevant. Link issues and call out follow-up work explicitly.

## Security & Configuration Tips
Never commit populated `.env` files; reference variable names only. Treat dataset exports and cache folders as disposable and keep them gitignored. When working on new integrations, review the existing `.env.example`, extend it if required, and document any sensitive setup steps in a secure channel rather than in this repository.
