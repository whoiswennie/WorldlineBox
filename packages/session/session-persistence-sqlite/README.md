# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

A SQLite durable session-persistence backend — a second `SessionPersistence` provider (session persistence) satisfying the same contract as `worldline-session-persistence-jsonl` (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over `node:sqlite` rows instead of file bytes.

`locate(meta)` returns `undefined` because every session shares one database. The provider exposes no per-session raw artifact.

## Storage model

Each `SessionEvent` maps 1:1 onto a row in an `events` table `(session_id, seq, type, time, data, source_event_seqs, surface_op)` — `data` is the event payload as JSON text, so the row shape is the event verbatim (including `assistant/chunk`, keeping `seq` contiguous). The two `TEXT` columns `source_event_seqs` and `surface_op` are nullable; they store the event's optional surface-metadata fields (see session surface). Out-of-log metadata (`SessionHeader`), a per-materialization incarnation id, and a monotonic per-log revision live in a `sessions` row; `createdAt` is a non-negative safe integer stored in a strict `INTEGER` column. A singleton state row carries the immutable store id. A `sessions` row is written only by the first `append` — its existence is the lazy-materialization signal (`list` reports exactly the sessions that have a row).

Schema 17 owns its codec locally rather than importing another persistence format's mutable implementation. Only exact, consecutive same-block text, reasoning, or tool-call delta forms pack. Unknown fields, surface metadata, sequence gaps, incompatible block/call identity, and unsafe timestamps remain scalar. A packed row represents at most 1,024 events and at most 1 MiB of uncompressed UTF-8 `data`; longer runs are partitioned without changing logical events. Reads reconstruct every original sequence number, timestamp, token boundary, argument fragment, and payload before returning data to the persistence coordinator.

Serialized `data` smaller than 4 KiB stays as SQLite `TEXT`. At or above that threshold, the writer uses Zstandard level 3 and stores a `BLOB` only when the frame is smaller than the original text; the reader decompresses it before UTF-8 validation and JSON parsing. `source_event_seqs` remains the complete ordered provenance array. Its first sequence is an unsigned varint and each subsequent sequence is a signed delta encoded with ZigZag varints, stored as a `BLOB`; no source is omitted or converted to a range.

Each append holds `BEGIN IMMEDIATE`, validates the bounded physical tail, packs only the new durable batch, inserts those records, and increments the session revision once. Normal appends never delete or replace an earlier event row. The default 200 ms write-behind window therefore compresses high-frequency streams while the physical write volume stays proportional to newly durable batches rather than repeatedly rewriting a growing packed value. A storage-level logical-tail check rejects a stale writer before mutation.

- **Append = a transaction.** `append` runs `BEGIN`/`COMMIT` around the batch: it materializes the `sessions` row (if still lazy) and INSERTs every event, asserting the contiguous-seq contract first (the first event's `seq` must equal the stored next-seq). A mid-batch failure (a UNIQUE violation on a duplicated seq) rolls back entirely, so the stored log and the in-memory cursor stay consistent. (`load()` already balanced the stored log, so `append` never has to repair a crash tail.)
- **Lazy materialization.** `create()` records intent in memory only — no row is written until the first `append`. A created-but-never-appended session has no `sessions` row, so it is absent from `list()` (which reports exactly the sessions that have a row).
- **Interrupted-turn close on load.** `load()` implements the shared crash-recovery contract: preserve the valid interrupted turn, append its synthetic closing events in one transaction, and remove only a torn tail row. Committed parse errors or sequence gaps make the session unloadable. Because recovery mutates stored rows, the next append starts from a balanced log and accurate cursor.
- **Non-mutating inspection.** `inspect()` returns an immutable balanced logical view and may synthesize recovery closers in memory, without deleting a torn tail row, appending recovery rows, or changing the lightweight revision.
- **Lightweight revisions.** `listSnapshots(signal?)` combines the immutable store and database-file identity, a per-materialization incarnation id, and a per-session counter incremented in each mutating transaction. A full-prefix read captures that revision and its event rows in one read transaction, while `readStoredRevision()` queries only the session row to validate retained preparations. This keeps unchanged observations stable without parsing event rows and distinguishes independent stores and recreated same-id logs. It checks cancellation before and after shared readiness and the synchronous metadata query; the query itself is non-preemptible.

## Configuration (schemastery)

```ts
interface Config {
  path: string
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'
  busyTimeoutMs?: number
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
}
```

`journalMode` defaults to `wal`, `busyTimeoutMs` defaults to `5,000`, `preparedSessionCacheSize` defaults to `5`, and `writeBatchMaxDelayMs` defaults to `200`. The timeout bounds each synchronous SQLite lock wait. Because SQLite may return `SQLITE_BUSY` immediately while changing journal mode, cold open yields between attempts and starts no further attempt after an open-relative retry cutoff. An in-progress synchronous SQLite call may finish after that cutoff. The provider disables trusted schemas and memory-mapped I/O on every connection, then reads both settings back. The selected journal mode is also read back and must match; in-memory databases explicitly accept SQLite's `memory` result. After selecting the journal, the provider pins `synchronous=FULL` and verifies it so SQLite build defaults cannot weaken committed-append durability. On POSIX, the database parent and file must be owned by the current user, the parent must not be group/world-writable, and the file must have no group/world permissions. Symbolic links and non-regular files reject. Windows also rejects symbolic links and non-regular files, but deployments remain responsible for restricting the directory and file ACLs to the harness user. Path and ownership failures reject plugin initialization. Node SQLite loads lazily on the first persistence operation; the import suppresses only Node 22's exact SQLite `ExperimentalWarning`. Store-identity and schema failures reject that operation before data is exposed or mutated.

## Model Experience

### Resumed conversation history

#### What the model sees

Nothing specific to SQLite. Resume restores the same logical events and derived messages as JSONL; physical packed tags never reach prompts, tools, replay, or live `session/event` delivery.

#### Token effect

Zero live-request tokens. Resume pays only for the retained logical history and current request envelope.

#### KV Cache effect

Physical packing does not mutate request prefixes. Provider cache reuse depends on the reconstructed history, current envelope, and model route exactly as with other persistence backends.

## Known Limitations and Deferred Work

- **Interim SQLite-specific design** — This efficiency-focused implementation is informed by [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb). A unified relational-database design with multiple backends and configurable schemas is deferred; neither schema stability nor migration support is guaranteed during pre-release development.
- **Packing follows durable batch boundaries** — compatible runs split by the write-behind window or an explicit flush remain separate physical records; this avoids rewriting prior rows at the cost of a timing-dependent packing ratio.
- **Synchronous compression** — Node's SQLite and Zstandard calls block the JavaScript thread; the 4 KiB threshold limits per-frame work for small records.
- **`DatabaseSync` blocks the event loop** — physical row reduction does not make SQLite operations asynchronous.
- **Busy waits block the event loop** — SQLite waits inside synchronous `DatabaseSync` calls; only a busy journal-mode transition yields between attempts, and the open-relative cutoff prevents another attempt rather than interrupting an active call.
- **External SQL readers must understand physical tags** — supported consumers read through this provider rather than treating every `events.type` as a logical event type.
- **No deletion or background historical compaction** — normal appends are insert-only.
