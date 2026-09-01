# Local Worldline projects

English | [中文](README.zh.md)

This package is the durable local-filesystem provider for the Worldline project service. It owns root binding, indexing, optimistic writes, history, trash, frozen build storage, logical Run references, and streamed archives.

## Contract

Every resolved path stays inside the user-selected library or an explicit archive path, symlinks are rejected at trust boundaries, and durable writes use temporary files plus atomic publication. Recoverable project trash remains under that library and permanent emptying is a separate explicit operation. Archive preflight enforces entry, size, traversal, manifest, and content-digest bounds before extraction.

## Model Experience

Indirectly, through Worldline tools and context consumers that read the provider's project-scoped records.

#### KV Cache effect

The provider sends no model request; a changed source revision affects only later consumer-selected context.

## Known Limitations and Deferred Work

- **Single-machine library** — file locking and durable rename semantics target one local machine; shared network filesystems need a separate provider with an explicit concurrency model.
