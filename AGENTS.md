# Repository Guidelines

**核心理念与原则**> **简洁至上**：恪守KISS（Keep It Simple, Stupid）原则，崇尚简洁与可维护性，避免过度工程化与不必要的防御性设计。> **深度分析**：立足于第一性原理（First Principles Thinking）剖析问题，并善用工具以提升效率。> **事实为本**：以事实为最高准则。若有任何谬误，恳请坦率斧正，助我精进。分析问题实事求是，务实胜于教条。
**开发工作流**> **渐进式开发**：通过多轮对话迭代，明确并实现需求。在着手任何设计或编码工作前，必须完成前期调研并厘清所有疑点。> **结构化流程**：严格遵循“构思方案 → 提请审核 → 分解为具体任务”的作业顺序。
**输出规范**> **语言要求**：所有回复、思考过程及任务清单，均须使用中文。> **固定指令**：`Implementation Plan, Task List and Thought in Chinese`

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
