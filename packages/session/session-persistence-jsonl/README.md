# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

Cordis Provider for durable append-only Session logs. Each materialized Session is stored as a checksummed JSONL/Zstandard artifact and is coordinated through `@deepseek-ai/dsh-session-persistence`.

The Provider owns physical recovery, contiguous sequence checks, write batching, flush barriers, preparation reuse, cancellation, and quiescent disposal. Consumers depend only on the persistence Service Definition.

## Model Experience

### Durable Session storage

#### What the model sees

Nothing directly: checksummed `JSONL` records reconstruct the Session facts that request-assembly consumers later select.

#### Token effect

Persistence adds no tokens; reconstructed events have the same token effect as their original model-visible projections.

#### KV Cache effect

Saving, recovering, or compactly storing events does not change their ordering or model prefix and therefore does not independently invalidate cache reuse.

## Known Limitations and Deferred Work

- **Local artifact backend** — one materialized Session is stored in local JSONL/Zstandard artifacts; shared-network persistence and multi-writer coordination require another provider.
- **Native codec dependency** — compressed artifacts depend on the supported Zstandard binding for the current platform.
