# @deepseek-ai/dsh-host-plugin-inventory

English | [中文](README.zh.md)

Host authority for the local Features page. `PluginInventoryGateway` projects the live Cordis Loader tree and resolves Skills through the default Agent Preset's standing scope with the active workspace `cwd`. The resulting layered catalog matches default-session discovery rather than the root registry alone. Guarded Remote methods list, enable, disable, and delete local entries.

Loader and Skill lifecycle changes emit an authenticated `plugin-inventory/change` notification. Directory resource bases are returned as Host-resolved paths so the client can route **Open folder** through the existing Workspace authority without importing filesystem APIs.

The `toolchains` Remote captures Python, Node.js, and Git readiness when the Host service starts. It returns only normalized versions and availability flags; executable paths and environment values stay on the Host. The embedded Node runtime is the packaged desktop fallback when a standalone `node` command is absent from `PATH`.

Plugin enablement and removal are persisted in the Profile's `local-extensions.json` overlay and applied through normal Cordis recomposition. The shipped bundle remains immutable. All `@deepseek-ai/dsh-*`, `@deepseek-ai/*`, `cordis:*`, and critical bootstrap rows are system-protected; both enablement and deletion are rejected at the Host boundary.

Skill enablement is a persisted discovery-visibility override. Deletion is restricted to filesystem-backed project, user, and custom Skill sources and rejects filesystem-root targets.

This package contains no online marketplace, package download, or registry discovery path.

## Model Experience

None, as the Host gateway exposes inventory and lifecycle operations only to authenticated product clients.

#### KV Cache effect

Inventory snapshots and mutations add no request tokens; any later model-context change is owned by the enabled or disabled plugin.

## Known Limitations and Deferred Work

- **Local sources only** — the gateway cannot discover, download, update, or recover packages from an online registry.
