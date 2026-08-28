# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm TypeScript monorepo built around Cordis dependency injection. `apps/cli`, `apps/web`, and `apps/desktop` provide the command-line, browser, and Electron entry points. Product capabilities live in small plugins under `packages/<domain>/<plugin>`; each plugin normally separates Host and Client faces through its package exports. Shared Cordis sources are vendored in `vendor/`. Cross-package fixtures and end-to-end scenarios live in `fixtures/` and `apps/web/tests/`; package tests sit beside modules in `tests/`. Treat `lib/`, `dist/`, `release/`, and build metadata as generated output.

Read `docs/architecture.md` and the linked WorldlineBox knowledge base before changing packages. WorldlineBox is maintained as an independent product; no upstream synchronization workflow is part of the repository.

## Build, Test, and Development Commands

- `pnpm install` installs the pinned pnpm workspace.
- `pnpm run dev` starts the development runtime.
- `start-electron.bat` rebuilds and launches the Windows Electron desktop test path.
- `pnpm run build` builds types, Host/Client plugins, Web, CLI, and desktop.
- `pnpm run test:runtime` runs runtime Vitest suites.
- `pnpm run test:client` runs jsdom client/plugin tests.
- `pnpm run test:cli` and `pnpm run test:desktop` cover application entry points.
- `pnpm exec vitest run path/to/file.spec.ts --config vitest.client.config.ts` runs a focused test.

## Coding Style & Naming Conventions

Use TypeScript/React with 2-space indentation, semicolons, single quotes, and a 100-column preference (`.prettierrc`). Components and types use `PascalCase`; functions, hooks, and variables use `camelCase`; package and file groups use kebab-case. Declare Cordis dependencies with `inject`, register disposable resources through effects/registries, and keep Electron-specific behavior in Host plugins. Do not patch installed third-party plugins or edit generated `lib` files.

## Testing Guidelines

Vitest is the primary framework; browser flows use Playwright. Name unit tests `*.spec.ts(x)` and Web journeys `*.e2e.ts`. Add focused regression coverage for every bug, including lifecycle disposal and Host/Client boundaries. Run the narrow suite first, then the relevant aggregate command.

## Commit & Pull Request Guidelines

History mixes concise Chinese summaries with Conventional Commit prefixes such as `fix:` and `feat:`. Prefer an imperative, scoped subject, for example `fix: keep auxiliary views full height`. Pull requests should describe behavior and architecture impact, list verification commands, link issues, and include screenshots for UI changes. Never commit credentials from `%USERPROFILE%/.worldline`.
