# Worldline Package and Plugin Map

English | [中文](README.zh.md)

All product capabilities live under `packages/<domain>/<package>`. Service Definitions, Providers, and Consumers are split when they can evolve independently; application Bundles select implementations.

| Domain | Responsibility |
| --- | --- |
| `core` | Session, Prompt, Tools, Agent, Agent Loop, and Scope spine |
| `llm` | Model capability definitions, DeepSeek/pi-ai Providers, retry, and token meter |
| `fs`, `shell`, `subprocess`, `terminal`, `lsp` | Local and sandboxed execution world |
| `sandbox`, `e2b` | Process isolation and remote-execution Providers |
| `skill`, `video`, `web`, `browser`, `mcp` | Reusable skills, native video inspection, external knowledge, web, browser automation, and MCP capabilities |
| `subagent`, `workflow`, `jobs` | Parallel Agents, workflows, and background jobs |
| `session`, `session-query`, `storage` | Persistence, projections, retrieval, and non-Session data |
| `goal`, `plan`, `todo`, `compaction` | Agent collaboration state and context management |
| `interaction`, `feedback`, `schedule` | Human collaboration, feedback, and follow-up tasks |
| `api`, `typert`, `sdk`, `acp` | Host/Client Remote and out-of-process protocols |
| `host` | WebServer, API Proxy, Directory Picker, Workspace Tree, bounded media gateways, and Desktop Browser |
| `client` | Browser Runtime, Slot/Locale, UI plugins, persistent media surfaces, and product Chrome |
| `auth` | Worldline local accounts and access control |
| `bundle`, `preset`, `boot` | Profile composition, Agent Presets, and application startup |
| `extensions` | Cordis introspection and runtime plugin extensions |
| `runtime-diagnostics` | Package-level runtime invariant registry |
| `credentials`, `settings`, `identity` | User configuration, secret references, durable authorization records and flows, and anonymous identity |
| `attachment`, `spill`, `workspace` | Binary content, large outputs, and Workspace entities |
| `tools` | Optional Worldline-specific Workspace toolkit |
| `util`, `test-support`, `examples` | Foundations, test facilities, and runnable example packages |

A new package must update this map, expose `./invariant`, and register it in the Host or Client TypeScript aggregate. See the [knowledge base](../docs/README.md) for detailed rules.
