# @deepseek-ai/dsh-host-workspace-tree-local

English | [中文](README.zh.md)

Local-filesystem provider for `host-workspace-tree`. It canonicalizes roots through realpath, rejects traversal and escaping symlinks, bounds listings, searches, and text previews, and owns debounced Chokidar watchers through the Cordis lifecycle. Images, audio, and video return metadata only through preview; full or inclusive-range reads use a backpressure-aware file stream, so playback size is bounded by storage rather than RPC memory. External imports stream through a hidden staging file and are atomically linked into place without overwriting an existing entry; `maxImportBytes` defaults to 128 GiB.

Mutations validate existing sources and new destinations below the registered root. Search ignores dependency and generated-output directories, never follows symlinks, and reports truncation when configured scan or result limits are reached.

## Model Experience

### Local workspace projection

#### What the model sees

Nothing: filesystem entries and preview content are returned to the product client through `workspaceTree`, not inserted into Agent context.

#### Token effect

Listings, searches, previews, and mutations add no model-request tokens.

#### KV Cache effect

Filesystem changes and watcher notifications do not alter model prefixes unless another package explicitly reads and submits the changed content.

## Known Limitations and Deferred Work

- **Bounded filename search** — search matches names and relative paths only; it does not index file contents and can truncate after the configured scan or result limit.
- **Local provider** — remote workspaces and virtual filesystems require another implementation of the workspace-tree service.
