# Worldline

<p align="center">
  <img src="build/icon.png" width="180" alt="Huan, the observer of Worldline">
</p>

<p align="center"><strong>A Cordis-native agent harness and a gateway to original worldlines.</strong></p>

English | [简体中文](README.zh.md)

Worldline is a modular agent runtime built around [Cordis](https://github.com/cordiverse/cordis). Its agent loop, model providers, prompts, tools, sessions, CLI, internal Web runtime, and Electron desktop application are composed as lifecycle-aware plugins instead of being coupled to one model vendor.

Worldline is the foundation application. **Worldline Fantasy** is the separate game and creative project built on that foundation, with original worlds grounded in the **Su (素)** system. **Huan (幻)**, represented by the application icon, observes and connects those worlds without reducing them to a single story.

> Every world has its story, and every story deserves to be observed. — Huan

## What it provides

- A complete headless and desktop agent loop with replayable session event logs.
- Cordis dependency injection, scoped lifecycles, effects, and disposable registries.
- Small Host/Client plugins with explicit package boundaries.
- Pluggable LLM providers, tools, prompts, storage, profiles, themes, and locales.
- A CLI and Electron desktop application sharing one internal Web runtime.
- A hardened Cordis foundation maintained as an independent Worldline codebase.
- A bilingual architecture and operator knowledge base maintained with executable gates.

Worldline is currently a developer preview. Interfaces may still change before a stable release.

## 0.2.2 kernel update

Worldline 0.2.2 selectively incorporates the stable, non-conflicting behavior from DeepSeek Harness 0.1.1-rc.2 and 0.1.2-alpha.1 while keeping Worldline's product boundaries authoritative. Highlights include:

- DeepSeek Files API uploads with deterministic image normalization, reuse, expiry recovery, bounded fallbacks, and image-aware token estimates.
- Faster startup and history transport, gzip responses, compact SQLite persistence with explicit schema 18 rejection/rebuild semantics, and lossless event provenance ranges.
- Safer WebFetch networking, WebSocket heartbeat, resilient subprocess/PowerShell handling, torn-JSONL diagnostics, and stricter tool editing behavior.
- Per-turn usage details, turn navigation/process folding, adaptive transcript width and font size, session-scoped question drafts, file mentions, streaming code highlighting, and CJK/Latin auto-spacing.
- ACP v1 controls, profile-launched TypeScript SDK/ACP runtimes, dynamic subagent model routing, Claude Code/Codex model selection, third-party locales, and provider-settings extension slots.
- PTC as the single current programmatic tool presentation mode. The stable `run_code` and persisted `tool/code-dispatch` vocabulary remain part of the current protocol, not a legacy implementation.

Plugin inventory upload, incremental session-log upload, and feedback telemetry remain disabled by default. Worldline account data, settings, attachments, Agent Vault resources, `WORLDLINE_HOME`, and the `ignorable` event capability retain their existing ownership boundaries. Old Harness session SQLite schema 17 is intentionally not carried as a second implementation during this developer-preview upgrade; recreate that derived development database under schema 18.

## Quick start

Node.js 24 is recommended; Node.js 22.19 or newer is supported. The repository uses the pnpm version pinned in `package.json`.

```powershell
git clone https://github.com/whoiswennie/WorldlineBox.git
cd WorldlineBox
pnpm install
start-electron.bat
```

The Electron desktop application is the only product release surface. On Windows, `start-electron.bat` rebuilds and launches the desktop application with the account-scoped settings, credentials, plugins, sessions, and workspaces under `%USERPROFILE%/.worldline`. The internal Web profile remains an implementation detail of the Electron runtime and is not packaged or launched as a standalone browser product.

Windows release and launcher checks use the repository entry points directly:

```powershell
start-electron.bat --no-pause --smoke-test
build-exe.bat --no-pause
```

The compressed Electron installer, unpacked application, and update metadata are written to `release/desktop/`. The builder validates the packaged runtime before reporting success. Worldline does not publish a standalone browser WebUI archive.

Useful commands:

```powershell
pnpm worldline --profile headless --help
pnpm run test:runtime
pnpm run test:client
pnpm run test:cli
pnpm run test:desktop
```

User state is stored under `%USERPROFILE%/.worldline`. Credentials must never be committed.

## Architecture at a glance

```text
CLI / Web / Desktop entry points
              │
        profile composition
              │
   Cordis loader and scoped fibers
              │
 Host plugins ─ services ─ Client plugins
              │
 models · tools · prompts · sessions · UI
```

Profiles combine a base bundle, a modality bundle, profile patches, user patches, and CLI patches. Plugins declare dependencies through `inject`; effects and registries own cleanup. The session event log remains the replayable source of truth for model context and UI projections.

## Knowledge base

| Area | Document |
| --- | --- |
| Documentation map | [Harness knowledge base](docs/README.md) |
| System design | [Architecture](docs/architecture.md) |
| Cordis foundations | [Cordis primer](docs/cordis-primer.md) |
| Plugin inventory | [Capability seams](docs/capability-seams.md) |
| Runtime composition | [Profiles and bundles](docs/profiles-and-bundles.md) |
| Process boundaries | [Host/Client boundary](docs/host-client-boundary.md) |
| Persistence | [Session turn lifecycle](docs/session-turn-lifecycle.md) |
| Quality gates | [Testing and quality](docs/testing-and-quality.md) |
| Creative foundation | [Worldlines, Su, and Huan](docs/worldbuilding.md) |

## Development

Start with [the development guide](docs/development.md), [AGENTS.md](AGENTS.md), and the package-local instructions before changing code. Generated `lib`, `dist`, and `release` outputs are not source files.

## Provenance and license

Worldline began from the MIT-licensed [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) rc.7 foundation and has selectively absorbed compatible architecture, reliability, performance, and product improvements through Harness 0.1.2-alpha.1. It remains an independently maintained product without an upstream merge workflow; Worldline branding, product behavior, and project-specific capabilities stay authoritative. Attribution and third-party notices remain intact.

Source code and technical documentation are available under the [MIT License](LICENSE). The Worldline application identity, the Worldline Fantasy game identity, Huan artwork, icons, and other original character assets are governed by [BRAND_ASSETS.md](BRAND_ASSETS.md) and are not granted under the MIT license.
