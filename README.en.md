<div align="center">
<img src="assets/icons/startup-logo.png" alt="WorldlineBox" width="160" />

# WorldlineBox

**A home and coordinating brain for virtual characters, worlds, assets, and execution tools.**

[简体中文](README.md) · [Repository](https://github.com/whoiswennie/WorldlineBox)
</div>

WorldlineBox is intended to keep persistent characters, companions, interactive stories, and virtual worlds together. It will own character identity, memory, relationships and behavior, maintain world state and branching worldlines, and organize the images, voices, music, models and documents those worlds use. Adapters will connect it to DSH (DeepSeek Harness), games, world runners and other ecosystem tools.

The character-facing brain can maintain its identity during a conversation while delegating concrete work to an execution backend, then receive progress and results and respond in character. Backend updates should not require rebuilding the character or world.

## Current status: 0.1.0 foundation

The current code provides an Electron / React / TypeScript desktop app with local asset libraries, import and organization, tagging, collections, search, workspaces, media and 3D previews, asset AI analysis, WebDAV asset synchronization, browser extension, plugins, scripts and MCP integration. Windows development and installer scripts are included.

Windows x64 now includes a [DSH launcher](docs/user-guide/dsh-launcher.md) with exact runtime artifacts, private plugin instances, process controls, packs, snapshots and complete offline backups. Versions and packs share sessions, the default workspace, account authorization and model/API settings. Plugins, skills and execution configuration remain private. The launcher is the first application module and opens by default.

**Character cognition, persistent world state and game/world adapters remain planned features.** Actual cross-version data migrations and third-party plugin compatibility require version-specific validation.

## Target architecture

| Domain | Intended responsibility |
| --- | --- |
| Characters | Personality, memory, emotions, relationships, habits, appearance and voice. |
| Worlds | Characters, places, events, rules, time, snapshots and worldline branches. |
| Assets | Shared, traceable content and generated outputs. |
| Execution environments | Exact engine/runtime versions, plugin combinations and independent instances. |
| Packs | Reproducible, shareable combinations of engine, plugins, configuration and content. |
| Adapters | DSH execution, games, world runners, voice and other tools. |

DSH is an early integration target. Version management separates immutable programs, private plugin environments and shared saves. Each instance retains its own `DSH_HOME`, profile, plugins and skills while native adapters route sessions, the default workspace, accounts and model choices to shared storage. Multiple packs can use one engine version. Upgrades are tested in copies; reverting the executable does not guarantee data-format downgrade compatibility. The manager remains available when an execution instance fails.

We study PCL's instance/isolation mechanisms and DSH's native profile and bundle contracts. No PCL source code is included. PackForge is a reference for pack exchange and workflows, rather than a claim that our future system already exists.

## One-click Windows workflow

Double-click these files in the project root:

- `01-Setup-Environment.bat`: prepare pinned Node.js, npm dependencies, Electron, native database modules, verified media tools and Inno Setup.
- `02-Start-Development.bat`: run development using an isolated `.tools/dev-user-data` profile.
- `03-Build-Installer.bat`: type-check, package the app and create `out/make/inno/WorldlineBoxSetup.exe`.

Initial setup needs internet access. Missing Python/C++ Build Tools are installed through winget when available and may require system permission or a restart. Portable tools live under `.tools/`; global Node.js is not replaced. The development and installer scripts prepare missing prerequisites automatically. Build tools, dependencies, caches and outputs are excluded from Git.

## Roadmap and documentation

The next stages are environment/instance management, locked pack installation and recovery, persistent character/world systems, and ecosystem adapters. See [product direction](docs/product-brief.md), [existing asset guide](docs/user-guide/README.en.md), [developer guide](docs/developer/README.en.md), and [extension author guide](docs/manual/README.md).

See the [0.1.0 validation record](docs/developer/validation-0.1.0.md) for checks and known limitations. The full inherited test suite is not fully passing on this Windows environment.

References: [PCL](https://github.com/Meloong-Git/PCL), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [DSH PackForge](https://github.com/DSH-PackForge/dsh-pack-plugin).

## License and attribution

MIT; see [LICENSE](LICENSE). The asset-management foundation comes from dolag233 and the original contributors, whose copyright notice is retained. Third-party components and media follow their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The maintainer supplied the new icon artwork.
