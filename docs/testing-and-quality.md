# Testing and Quality Gates

English | [中文](testing-and-quality.zh.md)

## Evidence levels

| Level | What it proves |
| --- | --- |
| Unit tests | Local algorithms, error semantics, and boundary values |
| Lifecycle tests | Contributions disappear and running operations stop when the exact Fiber is disposed |
| Real Cordis composition tests | Loader, inject, Profile, Provider selection, and startup failures |
| Client tests | Browser behavior across Slot, Locale, Remote, and Session scopes |
| Web E2E | User journeys and Host/Client integration |
| Snapshots | Model-visible Prompt, tools, logs, and final transcript |
| Built smoke | Built artifacts, exports, and bare Node/Electron startup |

A test that only calls `ctx.plugin()` manually does not prove the product Bundle loads a feature. User-visible or model-visible changes include at least one real-composition or snapshot-backed check.

## Required gates

- runtime architecture and compatibility boundaries;
- runtime branding and compatibility-exception audits;
- source/artifact layering;
- Host and Client TypeScript aggregates;
- Runtime, Client, CLI, and Desktop tests;
- Snapshot and E2E product-composition tests;
- Cordis configuration and package-invariant completeness;
- Client bundle purity;
- built-artifact and runtime-closure smoke tests.

## Regression requirements

Every defect receives coverage through the entry point that originally failed. Lifecycle tests dispose the exact plugin Fiber instead of only the root Context. Security policy proves rejection at the final executor rather than only hiding a UI control or omitting a schema field.

## Aggregate commands

```powershell
pnpm run check:architecture
pnpm run build
pnpm run verify:built-package-invariants
pnpm run publint
pnpm run test:runtime
pnpm run test:client
pnpm run test:scripts
pnpm run test:cli
pnpm run test:desktop
pnpm run test:python
pnpm run test:snapshot
pnpm run test:e2e
pnpm run docs:build
```

Runtime tests use at most four workers, and the engineering-script suite runs serially. These limits are test-isolation contracts: the former owns real file watchers, subprocesses, and external product fixtures; the latter creates Git repositories, worktrees, hooks, and merge drivers. Raise concurrency only after proving it cannot lose events, cause timeouts, or cross temporary-repository cleanup boundaries.

Release verification has two layers. The workspace may retain `./src/*` exports used by in-repository tests; the npm publishing view removes those exports and includes only compiled artifacts declared by `files`. `publint` checks the publishing view, while `verify:built-package-invariants` uses bare Node.js and the real Loader to load companion entries for all 227 packages.

Snapshot `record` and `refresh` commands inject their environment through `scripts/run-snapshot-mode.mjs`, so PowerShell, cmd, and POSIX shells share one command. Windows product compositions prove the real pwsh path; examples that promise Bash-only semantics skip explicitly on Windows and rely on package-level Bash contracts plus non-Windows CI instead of manufacturing success through unavailable WSL.
