# Local Features UI

English | [中文](README.zh.md)

This client plugin owns the `Features` primary-rail destination. The page reads the current Profile's plugin inventory and the default Agent Preset's workspace-sensitive Skill catalog through the authenticated Host Remote. It supports local enable, disable, and guarded delete operations.

Search is immediate and local: exact, prefix, substring, token, and subsequence matches are ranked on every input change. Loader and Skill events refresh the snapshot automatically, with reconnect, focus, visibility, and interval recovery. Directory-backed Skills expose an **Open folder** action routed through the Workspace Host API.

It has no catalog, network discovery, npm/GitHub search, download, update, recovery, or Electron marketplace bridge. Framework plugins are rendered as system-protected and the Host rejects their mutation even if a caller bypasses the UI. Bundled and runtime Skills cannot be deleted; only filesystem-backed project, user, and custom Skills expose deletion.

The base sidebar therefore has three product destinations: Conversation, Features, and Settings. Features owns runtime discovery and lifecycle controls; the Plugins section in Settings independently owns editable configuration schemas, drafts, validation, and persistence.

## Model Experience

None, as the page reads and mutates local plugin inventory without invoking an Agent.

#### KV Cache effect

Inventory rendering and lifecycle actions add no model tokens and do not alter an existing request prefix.

## Known Limitations and Deferred Work

- **Local inventory only** — catalog discovery, package download, updates, recovery, and online marketplace operations are outside this package.
