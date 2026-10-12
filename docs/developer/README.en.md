# Developer Docs

For people who want to build WorldlineBox locally or become contributors: setup, architecture, testing, packaging, and how to participate. These pages ship on `main`. They are not the slice logs or internal specs in `docs/internal/`.

Developer documentation is split into two parts.

## Part 1: Software development

For developers working on WorldlineBox itself: architecture, building from source, testing.

- [Setup](setup.md) — dependencies, first build, development environment
- [Build & packaging](build-packaging.md) — package / make / release pipeline / signing
- [Architecture](architecture.md) — process model, directory layout, key design
- [Testing](testing.md) — test layers and how to run them
- [Adding media format support](media-format-support.md) — registry, import, preview, filters, protocols, and acceptance
- [Branches and workflow](workflow.md) — branching strategy, open source contribution process, and maintainer workflow discipline
- [Contributing guide](contributing.en.md) — open source collaboration, Pull Requests, and code gate requirements
- [Contributors](https://github.com/whoiswennie/WorldlineBox/blob/dev/CONTRIBUTORS.md) — contributions accepted and merged into the project

Other software docs (internal records live on the repo `dev` branch and are not published to the site):

- [Development process](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/development-process.md) — slice workflow and quality gates
- [Domain model](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/domain-model.md) / [Glossary](../glossary.md)
- [Architecture decision records](https://github.com/whoiswennie/WorldlineBox/tree/dev/docs/internal/adr) — ADR-0000 onward
- [Implementation specs](https://github.com/whoiswennie/WorldlineBox/tree/dev/docs/internal/implementation) — slice specs

## Part 2: Extension development

For developers writing plugins, scripts or MCP adapters. **No software-architecture knowledge required** — go straight to the [extension author manual](../manual/README.md):

- [Plugin development guide](../manual/plugins/development.md) + [best practices](../manual/plugins/best-practices.md) + [API reference](../manual/plugins/api-reference.md)
- [Plugin distribution and updates](../manual/plugins/distribution-and-updates.md)
- Official plugin reference implementations:
  - [WorldlineBox-Plugin-Renamer](https://github.com/dolag233/WorldlineBox-Plugin-Renamer) — Unrestricted mode (`unrestricted`), batch asset renaming and real-time diff preview built on standard host dialogs and list controls
  - [WorldlineBox-Plugin-MediaConverter](https://github.com/dolag233/WorldlineBox-Plugin-MediaConverter) — Media transcoding and compression extension demonstrating multi-profile media plans, background job queue lifecycle, and universal package distribution (`any`)
  - [WorldlineBox-Plugin-ImageUpscaler](https://github.com/dolag233/WorldlineBox-Plugin-ImageUpscaler) — Unrestricted mode (`unrestricted`), external AI inference binary orchestration, platform-specific packaging (`darwin-arm64` / `win32-x64`), and chunked content streaming
- [Script development guide](../manual/scripts/development.md) + [API reference](../manual/scripts/api-reference.md)
- [MCP development guide](../manual/mcp/development.md) + [API reference](../manual/mcp/api-reference.md)

End users: see [Using plugins](../user-guide/plugins.md), [Browser extension](../user-guide/browser-extension.md), and [Automation](../user-guide/automation.md).
