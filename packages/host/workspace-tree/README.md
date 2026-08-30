# @deepseek-ai/dsh-host-workspace-tree

English | [中文](README.zh.md)

Replaceable Host service definition for the product workspace explorer. It defines bounded directory listings, filename search results, typed previews, validated mutations, streamed external-file imports, range-readable file streams, and the `workspace-tree/changed` notification.

Providers must treat the registered workspace root as the authority boundary and preserve cancellation for reads, imports, streams, and searches. Import bytes remain outside the JSON RPC envelope, and media metadata stays separate from byte delivery, so movie-sized files do not require whole-file browser or Host memory. This package contains no filesystem implementation.

## Model Experience

### Workspace explorer service

#### What the model sees

Nothing: `WorkspaceTreeListing`, previews, and mutations are Host-to-client values and are not Agent tools.

#### Token effect

Calling the workspace explorer service adds no model-request tokens.

#### KV Cache effect

Workspace tree state does not participate in model prompt assembly and has no KV-cache effect.

## Known Limitations and Deferred Work

- **Provider required** — the service definition cannot list, preview, watch, or mutate a workspace until exactly one compatible Host provider is mounted.
