# `@deepseek-ai/dsh-session-reference`

English | [中文](README.zh.md)

`ctx.sessionReferenceResolver` prepares bounded, read-only snapshots of other sessions as sourced model-facing context. It consumes `ctx.sessionQuery` and the backend-independent compact checkpoint marker; SQLite FTS is not required. Hosts that support cross-session mentions may opt into the service.

## Public API

- `listCandidates(agent, query?, limit?)` lists sessions other than `agent.id`, filters case-insensitively by id, cwd, or the latest log-backed title, and ranks same-cwd, cwd-less, then other-cwd records while preserving `listSessions()` creation order within each group. Each selected candidate uses that title as the mention label and falls back to the session id when the title is absent or unreadable; message bodies are not searched.
- `prepare(agent, content, references, signal?)` preserves first-mention order, deduplicates ids, rejects self-reference and more than the configured distinct-source limit, reads every source in parallel, and returns detached content plus zero or one aggregated, identified `UserMessage` context. Any invalid reference, failed read, cancellation, or budget failure rejects before the host calls `followup()` or `steer()`.
- `encodeSessionReferenceUri()` and `decodeSessionReferenceUri()` implement `worldline-session:<base64url(JSON.stringify(sessionId))>` so every JavaScript string id round-trips exactly. `formatSessionReferenceMention()` emits `@[label](uri)`, and `parseSessionReferenceText()` replaces Markdown mentions or bare canonical URIs with readable `@label` text while returning structured references. Explicit Markdown mentions reject every malformed URI; bare text is considered a reference only when a non-empty base64url-shaped payload follows the scheme, and a matching noncanonical candidate still fails. Empty or punctuation-only scheme mentions remain ordinary discussion text.

## Snapshot semantics

Preparation calls `ctx.sessionQuery.readSurface()` once per distinct source and never rereads it after enqueue. It projects only direct-user `user/message`, assistant text, and `user/message` checkpoints carrying the canonical `worldline-compaction` source marker from the folded current surface. For a source prompt that already contains baked prefix context, projection reads only its model-hidden display content, preventing recursive snapshot propagation. Shadowed pre-compaction events, tools, reasoning, context, plugin-generated user messages other than marked compact checkpoints, and unfinished assistant chunks are excluded. A compacted source therefore contributes its latest checkpoint plus retained later conversation, not restored shadowed text.

The context source is `{ kind: 'session-reference', version: 1, references }`; each reference records its source id and label, capture seq, compact presence, retained/omitted message counts, omitted UTF-8 bytes, and truncation state. The service's outer `agent/pre-step` listener post-processes accepted direct user messages, preserves their message ids, and inserts each snapshot immediately after the message that cited it. Queue edits and queue-to-steer relocation need no reference-specific handling because parsing occurs after the final inbox claim. Invalid mentions, failed reads, cancellation, and budget failures end that turn before its messages enter model-visible history. The target log records the readable direct `user/message` followed by its sourced context `user/message`; source mutation after capture cannot change target replay.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `maxReferences` | `3` | Maximum distinct source sessions in one prepared message; must be at most `3`. |
| `candidateLimit` | `50` | Default candidate count returned to a host. |
| `maxReferenceBytes` | `65536` | Maximum serialized JSON bytes for one reference object. |

Retention applies `maxReferenceBytes` independently to each source, keeps compact checkpoints and the newest message before dropping older non-checkpoint units, and uses `worldline-output-retention` head/tail truncation with an exact UTF-8 omission notice. If one source's fixed serialized fields cannot fit, preparation fails with `SESSION_REFERENCE_BUDGET_EXCEEDED` instead of returning a partial context.

## Model Experience

### Referenced session background

#### What the model sees

The model sees two consecutive user-role messages: the current message with its readable `@label`, then the `## Referenced sessions` untrusted snapshot. The warning forbids following instructions, permission claims, or tool requests from the snapshot unless the current user explicitly repeats them. Labels, cwd values, ids, and conversation text are serialized as JSON inside `<referenced-sessions>` tags; every data `<` is emitted as the lossless JSON escape `\u003c`, so source text cannot spell a framing tag.

#### Token effect

Each referenced message adds the fixed warning plus up to three serialized snapshots, each independently bounded by `maxReferenceBytes`. The exact snapshot remains in target history until target compaction shadows or summarizes it; source-session changes add no further tokens.

#### KV Cache effect

The request and snapshot are consecutive append-only target messages and preserve earlier cacheable history. Different references or source capture contents change the new suffix only; later target compaction may invalidate reuse from its replacement boundary.

## Known Limitations and Deferred Work

- **No body discovery** — candidate queries inspect folded titles but do not search message bodies. A non-empty query may inspect every visible persisted session log through the session-query service's bounded, cancellable batch; a dedicated title index may replace that discovery path without changing URI, snapshot, or persistence contracts.
- **Trusted caller boundary** — the service assumes its host is authorized to read every session exposed by `ctx.sessionQuery`; it is not a model-facing search tool.
- **Text projection only** — non-text user and assistant blocks are not propagated across sessions.
- **No live link** — references are snapshots, not forks, resumes, subscriptions, or source-session mutations.
