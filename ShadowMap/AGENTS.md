# Development Guidelines for Coding Agents

This document provides guidelines for AI coding agents contributing to this project. Following these standards is mandatory to maintain code quality, consistency, and a clear architecture.

## Core Principles

1.  **Language**: All code, comments, documentation, and commit messages **must** be in **English**.
2.  **Clarity and Simplicity**: The code architecture must be kept clean and modular. Avoid overly complex solutions or "spaghetti code." Prioritize readability and maintainability.
3.  **Consistency**: Adhere strictly to the naming conventions and code style defined below. Consistency is key to a predictable and understandable codebase.

## Setup

- Install dependencies using the command: `pnpm install`

## Code Style

- **TypeScript**: Strict mode is enforced (`"strict": true` in `tsconfig.json`). All new code must be type-safe.
- **Formatting**:
    - Use **single quotes** (`'`) for all strings.
    - **Do not use semicolons** (`;`) at the end of statements.
    - Always run `pnpm lint` to format the code before committing.
- **Naming Conventions**:
    - **Use consistent terminology.** Avoid using synonyms for the same concept across different files. For example, if a variable is named `buildingData` in one file, do not name it `structureInfo` or `propertyData` in another file if it represents the same data structure.
    - Follow standard `camelCase` for variables and functions, and `PascalCase` for classes, types, and interfaces.

## Architecture

- **Modularity**: Encapsulate logic into reusable modules or functions.
- **Separation of Concerns**: Ensure a clear distinction between different parts of the application (e.g., UI, business logic, data access).
- **Avoid "Magic"**: Code should be explicit and easy to follow. Avoid clever tricks that obscure the intent of the code.

## Testing

- CI (Continuous Integration) plans are defined in the `.github/workflows/` directory.
- To run tests for a specific package, use the command: `pnpm turbo run test --filter <pkg>`
- **All tests must pass** before any code is committed. Run `pnpm test` locally to verify.

## Pull Request (PR) / Commit Rules

- **Title Format**: Commit messages and PR titles must follow this format: `[<pkg>] <Title>`.
    - Example: `[shadow-map-frontend] Refactor shadow calculation logic`
- **Pre-commit Verification**: **Always** run `pnpm lint && pnpm test` before committing to ensure the code is clean and all tests pass. Any commit that fails these checks will be rejected.

## Agent Interaction & Resource Management

- **Be Mindful of Context Window**: The model has a limited context window. Avoid actions that generate excessively large outputs.
- **Efficient Tool Usage**:
    - When analyzing a UI with browser tools, avoid capturing full-page snapshots or screenshots unless absolutely necessary.
    - Prefer to inspect smaller, specific components of the UI to get targeted information.
    - When possible, use tool parameters to limit the scope of the output. For example, instead of a full DOM snapshot, query for specific elements.
- **Iterative Refinement**: Instead of asking for a broad analysis ("improve the UI"), break down the task. For example: "First, analyze the header component, then the map controls." This keeps the context for each step smaller and more focused.
