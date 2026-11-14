<div align="center">
<img src="assets/icons/startup-logo.png" alt="WorldlineBox" width="160" />

# WorldlineBox

**A home and coordinating brain for virtual characters, worlds, assets, and execution tools.**

[简体中文](README.md) · [Windows 0.1.0](https://github.com/whoiswennie/WorldlineBox/releases/tag/0.1.0) · [Android 0.1.0](https://github.com/whoiswennie/WorldlineBoxMobile/releases/tag/0.1.0)
</div>

WorldlineBox is a local-first desktop app combining companions, persistent world state, asset management and DSH execution environments. The companion module is being rebuilt around a Super Agent: users stay in their chat while the coordinating brain recalls memories, delegates work and receives durable results.

## Windows host and Android companion client

The desktop app runs companions, memory and DSH tasks, manages assets, and authorizes devices. [WorldlineBox Mobile](https://github.com/whoiswennie/WorldlineBoxMobile) is the Android client for chatting with those companions, following streamed responses and task stages, exchanging files, and opening portrait-mode calls over SSH.

1. Install `WorldlineBoxSetup.exe` on Windows x64 and `WorldlineBoxMobile.apk` on Android.
2. Install and select a shared DSH instance in the desktop launcher, configure the model under Settings, and verify a desktop chat.
3. In desktop Settings, open Remote Connection and display the pairing QR code. Scan it in the Android app. Keep the desktop app online for remote access. The temporary tunnel changes its address on restart and then needs a fresh scan.

See the [mobile guide](https://github.com/whoiswennie/WorldlineBoxMobile#扫码连接) for pairing, transfers and optional permanent endpoint configuration.

## Current implementation

| Module | Available surface |
| --- | --- |
| Companions | Custom personas, direct/group/world conversations, streaming replies, cancellation, memory tools, independent tasks and a physical world view. |
| Launcher | Exact DSH artifacts, instances, plugins, skills, terminals, packs, snapshots and backups. |
| Assets | Local libraries, importing, tags, collections, search, workspaces, media/3D previews, AI analysis, WebDAV, plugins, scripts and MCP. |
| Browser | Tabs, bookmarks, downloads and built-in asset capture; external browsers can use the extension. |

The launcher opens by default. Companion data no longer requires selecting an asset library. The asset manager retains its Serpent foundation and incremental integrations; see the [0.3.2](docs/developer/serpent-032-upgrade/README.md) and [0.3.3](docs/developer/serpent-033-upgrade/README.md) records. Asset features, global capture tools and user notifications remain separate from the companion refactor.

### Continuous companion conversations

The initial contact is 小伴. Create a companion and edit its name and persona, then use direct or group chat. History is paginated and replies stream into the existing conversation. Failed sends retain their drafts. The UI does not require users to create or manage native DSH Sessions.

WorldlineBox owns durable Inbox/Outbox records, trusted sources and audiences, ordered per-audience lanes, cancellation and task state. DSH owns the native model/tool loop and compaction. Different lanes can run concurrently; direct, group and world contexts are separated. Independent DSH workers return task receipts to their source conversation. User direct-chat tasks can use full DSH tools; group, peer and world sources remain scoped. Submitted, running and completed are different states.

The current companion model connection requires OpenAI Chat Completions. The brain and companion workers use the application's configured model connection; launcher terminals and the DSH Web workbench retain their own settings. Asset-analysis protocol support is independent.

### Memory and bounded active context

The new `resources/vcp-memory` module provides diaries, semantic recall, history lookup and preprocessing/response recording. It uses the application's bundled EmbeddingGemma 2 and 768-dimensional embeddings, without a separate external embedding-model setting. A resident Node Worker and durable background jobs replace per-operation process startup and the old cognition/publication chain. Automatic memory encoding can make additional model calls.

The Memory panel supports search, explicit notes, recent scoped records and forgetting by ID. Forgetting withdraws related sources from use, fences old captures and isolates prior native context; it does not physically erase DSH cold logs. Recall remains selective and can miss or misinterpret information.

Lane epochs and native summary/tail handoff bound individual active sessions while the visible conversation stays continuous. Handoff can invoke a model and take time; failure keeps the old session authoritative. This is not a claim of perfect recall, constant latency or verified unlimited lifetime. Real-model quality and long-running behavior require their own acceptance evidence; controlled protocol fixtures do not establish those results.

### Physical world

World channels can open a position map or Three.js scene. Companions have private homes and can walk along valid paths, use portals to reach the public garden and interact with furniture. Host state persists coordinates, routes, occupancy and activities. Physical “work at the computer” is separate from executing a DSH task.

The new viewport reuses the real house/garden meshes and art. Known art IDs use their corresponding sheets; newly created companions currently use their own name markers. WebGL failures return to the position map. World events go to actual co-located observers, with private observer transcripts.

The launcher integrates Cabin World. The former independent dream and growth dashboards are retired. QQ/WeChat and broader simulation remain future integrations.

### Data and validation

New companion data lives under the application's `companion-bot-v2` profile directory: `bot.sqlite` holds messages, events, tasks and physical state; `memory` holds scoped VCP data. DSH owns native Sessions and cold logs. Asset libraries remain separate. The new entry point does not migrate or dual-write the old companion database.

Use `npm run test:bot:quick` for targeted tests, `npm run test:bot:e2e` for isolated Electron UI checks, and `npm run test:bot:protocol` for a controlled model fixture through real DSH/VCP boundaries. `npm run test:bot:real` explicitly uses a configured online model; a script existing does not mean its acceptance has passed. The 3D screenshot check used software WebGL and is not a hardware performance result. See the [user guide](docs/user-guide/companions.en.md), [runtime guide](docs/developer/superagent-bot-runtime-guide.md) and [historical research](docs/developer/superagent-bot-research-2026-11-02.md).

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

- `01-Setup-Environment.bat`: prepare pinned Node.js, npm dependencies, Electron, native database modules, the isolated companion memory runtime, companion SDK, speech and embedding model runtimes, verified media tools and Inno Setup.
- `02-Start-Development.bat`: check the existing environment and run development using the current user's `%APPDATA%\WorldlineBox` profile, shared with the installed app.
- `03-Build-Installer.bat`: type-check, package the app and create `out/make/inno/WorldlineBoxSetup.exe`.

Initial setup needs internet access. Only `01` installs dependencies, native modules and missing Python/C++ Build Tools (through winget when available). Build tools and download caches live under `.tools/`, and the bundled application tools under `resources/portable-tools/win32-x64`; global Node.js is not replaced. `02` never installs dependencies or rebuilds native modules; Forge/Vite still compile the current source. `03` builds the installer. If setup is incomplete or the dependency lock changes, run `01` explicitly. Build tools, dependencies, caches and outputs are excluded from Git.

The complete [portable tool inventory](resources/portable-tools/manifests/win32-x64.json), version/hash locks, download recipe and acquisition scripts are tracked in Git. Large executable payloads are reconstructed from checksum-pinned official archives. After a pull changes the tool lock, `02` and `03` stop before launching and direct you to `01`, which verifies a replacement before swapping it in and preserves the old payload in `.tools/portable-tool-backups`. For tool-only repair, use `npm run tools:repair`. For an HTTP proxy, run `01-Setup-Environment.bat -Proxy http://127.0.0.1:7897`; this affects only setup and its child processes.

## Roadmap and documentation

The next stages extend environment/instance management, locked pack installation and recovery, character/world simulation, and ecosystem adapters. See [product direction](docs/product-brief.md), [existing asset guide](docs/user-guide/README.en.md), [developer guide](docs/developer/README.en.md), and [extension author guide](docs/manual/README.md).

See the [0.1.0 validation record](docs/developer/validation-0.1.0.md) for checks and known limitations. The full inherited test suite is not fully passing on this Windows environment.

References: [PCL](https://github.com/Meloong-Git/PCL), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [DSH PackForge](https://github.com/DSH-PackForge/dsh-pack-plugin).

## License and attribution

MIT; see [LICENSE](LICENSE). Thanks to [Serpent](https://github.com/dolag233/Serpent) author dolag233 and its contributors for the asset-management foundation and continued improvements. Their copyright notice is retained; WorldlineBox integrates the 0.3.2 changes by feature and keeps its own name and custom functionality. Third-party components and media follow their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The maintainer supplied the new icon artwork.

The memory-system design draws on [VCPToolBox](https://github.com/lioensky/VCPToolBox) diary, vector-index, RiverMemo and long-term-context ideas. The current standalone module in `resources/vcp-memory` retains upstream provenance and licenses; the former vendor runtime and companion memory host are retired.

Thanks also to [VCPChat](https://github.com/lioensky/VCPChat) for conversation and context components, [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for the native execution environment, and [Cabin World by VADS](https://github.com/BabyBus2022/cabin-world) for the virtual living space. DeepSeek-chan artwork and layer separation are by 神宫凉子 and Live2D rigging is by 霓虹猫_NeonNeko. The public package uses the portrait fallback. For private use, see the [author's original announcement](https://www.bilibili.com/video/BV1ALnw6YEGK) and [local model setup](public/companion-call/NOTICE.md).
