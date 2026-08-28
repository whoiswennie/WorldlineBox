# Vendored framework packages

This directory contains the pinned framework layer used by the Worldline runtime. The packages are private workspaces and are published only as part of the product build.

All source packages retain their upstream MIT license. Package names and internal imports retain their `@deepseek-ai/*` coordinates; runtime identifiers owned by the upstream framework are intentionally unchanged.

| Directory | npm name | Upstream name | Version | Upstream repo | Commit |
|---|---|---|---|---|---|
| `cosmokit/` | `@deepseek-ai/cosmokit` | `cosmokit` | 1.8.2 | https://github.com/deepseek-harness/cosmokit | `16f6fc058ade66e8ac5da0033d35a8d0f279f544` |
| `schemastery/` | `@deepseek-ai/schemastery` | `schemastery` | 3.18.1 | https://github.com/deepseek-harness/schemastery (`packages/core`) | `e67cee00ad725bd1534aee930a979ea3eec6f698` |
| `cordis/` | `@deepseek-ai/cordis` | `cordis` | 4.0.1 | https://github.com/cordiverse/cordis (`packages/core`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.2 | https://github.com/cordiverse/cordis (`packages/loader`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `include/` | `@deepseek-ai/cordis-plugin-include` | `@cordisjs/plugin-include` | 1.0.6 | https://github.com/deepseek-harness/cordis (`packages/include`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `group/` | `@deepseek-ai/cordis-plugin-group` | `@cordisjs/plugin-group` | 1.0.1 | https://github.com/deepseek-harness/cordis (`packages/group`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | `@cordisjs/plugin-timer` | 1.1.3 | https://github.com/deepseek-harness/cordis (`packages/timer`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | `@cordisjs/plugin-hmr` | 1.0.16 | https://github.com/deepseek-harness/cordis (`packages/hmr`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` | 1.0.1 | https://github.com/deepseek-harness/cordis (`packages/logger-console`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |

Local modifications are limited to namespace rescoping, ESM TypeScript build metadata, product-neutral diagnostics, and the lifecycle/configuration hardening recorded by the framework contract tests. Updating a package requires replacing its source from the pinned upstream, reapplying those changes, updating this table, and rerunning `pnpm test:framework`.
