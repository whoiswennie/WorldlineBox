# Persistent chat history, search and room lifecycle

Implemented on 2026-10-14. The SQLite companion store remains owned exclusively by its UtilityProcess. Message storage has no topic/session lifetime; the renderer never requests an entire room history.

## Sources and what was learned

- [Tencent WCDB full-text search documentation](https://github.com/Tencent/wcdb/wiki/C%2B%2B-%E5%85%A8%E6%96%87%E6%90%9C%E7%B4%A2) describes indexing and language-specific tokenization, including Chinese, stemming and optional pinyin/simplified–traditional support. This change adopts the indexing principles; it does not import WCDB or claim to implement its optional pinyin features.
- [WeChat database upgrade announcement](https://developer.cloud.tencent.com/article/2406614) describes FTS5 use and tokenizer improvements in WeChat's local search. The linked detailed WeChat article was unavailable to the browsing tool. Its contents were not guessed.
- [Tencent Chat SDK local-message search](https://intl.cloud.tencent.com/ind/document/product/1047/48134) documents conversation, sender, keyword, type, time and pagination parameters, plus highlighting and result navigation. This is an official related IM API reference, not evidence of QQ's private internal storage implementation.
- [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html) documents indexed MATCH queries, contentless-delete tables and the stock trigram tokenizer's inability to match fewer than three Unicode characters. There is no basis here for claiming QQ or WeChat searches hundreds of millions of records instantaneously under arbitrary conditions.

## Room lifecycle and initialization

Built-in migration installs contacts only. It no longer opens 15 chats or inserts simulated welcome messages. Adding a built-in contact restores its identity and user edits without opening a chat. The messages-page plus opens a contact picker; the contacts-page plus opens the role editor/catalogue.

Schema version 2 adds `hidden_at` and `dissolved_at`. The upgrade hides private rooms containing only the legacy generated `builtin-welcome-*` messages. Actual messages, memory provenance, edited contacts, attachment references and task checkpoints are preserved.

`conversation.delete(mode=hide)` removes a room from the recent list and clears pinning. Opening that private contact, recreating the same active group membership, reopening a search result or receiving a new message shows the durable room again. Hiding a room does not cancel work. Internal reasoning reads include hidden rooms so their queued work can still finish.

`conversation.delete(mode=dissolve)` is group-only. A transaction tombstones the room and cancels its durable queued/interrupted/running work and reply checkpoints before asynchronous Main/DSH cancellation. Writes, capability creation, loop persistence and task resume reject dissolved membership. A late job completion cannot overwrite cancelled queue/reply state. Main aborts that room's controllers and cancels its owned native tasks. Restart does not resume the room. Member-set de-duplication excludes dissolved rooms, permitting a fresh group with the same people. Original files are unaffected; historical rows remain in the local DB and are excluded from normal message search/list views.

## Bounded timeline

`messages` supports mutually exclusive `before`, `after` and `around` cursors. SQL uses the `(conversation_id,sequence)` B-tree; page size is 50 by default, bounded to 100. `around` independently reads both sides of the selected message. Existence probes return older/newer flags without a total count or OFFSET.

The renderer retains at most 200 message objects and a 1,000,000-character combined text/segment budget. A single unusually large message may exceed the text budget so it can still be displayed, but no further messages are retained alongside it. Loading older history evicts the newer end; loading forward evicts the older end. A visible-message ID and pixel offset preserve the reading anchor even when both ends change. A request generation and paging mutex reject stale results after changing room, jumping or returning to latest.

Quoted-message cache: at most 50 objects, pruned against the currently displayed window. Search: 30 excerpts per page, replaced on navigation, with at most 64 numeric back-navigation cursors. It never accumulates all result bodies. The latest button requests the newest 50 directly. Completed work is no longer loaded wholesale for every UI state refresh: source-specific/unfinished queries and indexed queue claiming avoid that secondary history accumulation.

## Indexed search

The old search used trigram FTS for three-character queries and `instr(lower(content),...)` for shorter terms. Short Chinese searches therefore scanned messages. The replacement encodes normalized Unicode characters as safe FTS tokens with phrase positions. The same NFKC/lowercase transformation is used in writes and queries. This supports one/two-character Han substrings, case/width normalization and literal punctuation without SQL/FTS syntax injection or a LIKE fallback. Whitespace-separated user terms are ANDed literal phrases. It does not add semantic search, stemming, pinyin or automatic simplified/traditional conversion.

`message_search` is FTS5 with contentless-delete enabled. Indexed text includes message body and attachment filenames, not file contents or uploaded bytes. A scope column carries exact conversation, author and UTC day tokens, plus image/file/link facets. Metadata conditions intersect inside MATCH, avoiding a pathological SQLite plan that repeatedly opened FTS for each relational candidate. Exact timestamps still enforce partial-day boundaries; ranges up to 366 days also intersect day postings. Wider/open-ended date ranges use SQL date predicates and can cost more. Timeline/time/sender/attachment indexes support keyword-free browsing and context lookups.

Insert/content/membership/attachment triggers update FTS atomically with message changes. Unchanged loop text does not rebuild the index. Legacy migration uses 500-row transactional batches with durable sequence watermarks; the worker yields between batches, emits progress, and continues after restart. Incomplete search is labelled as indexing and refreshes automatically. New writes are indexed immediately throughout migration.

Search pages use sequence keysets and a stable initial high-water mark. New inserts do not shift existing result pages. There is no global exact-hit count, deep OFFSET or load-all request. Compact results contain only a bounded excerpt, identity/time and attachment metadata; full segments and capability results are fetched only when navigating the chat/task view. Excerpts render as React text, including highlight marks, without interpreting HTML.

## Verification

- Real SQLite: empty initialization, hide/reopen/dissolve, FIFO cancellation after restart, bidirectional cursors, surrounding context, one/two-Han queries, literal punctuation, width normalization, AND queries, attachment filenames/types, author/date filters, stable snapshots, multi-batch crash/restart migration, and index replacement on loop updates.
- Service test: dissolution cancels an actual mocked native-task lifecycle and prevents replay after restart, using the real SQLite store.
- Renderer stress: 5,000 source records, 80 older-page requests; message objects and DOM message nodes stay at or below 200, then returning to latest keeps exactly 50. This demonstrates bounded history retention, not a claim that every Electron subsystem is free of all possible memory leaks.
- Desktop E2E: 1,800 offline fixture records in the real DB/IPC/UI; 18 consecutive automatic upward pages, keyword search pages, sender/date filtering, highlighted context navigation, direct return to bottom, hide/reopen, dissolve/recreate and restart. The complete 9-scenario companion desktop suite also passes.
- Windows caption buttons no longer overlap chat actions. Run `node scripts/run-e2e.mjs tests/e2e/companions.test.ts` to regenerate `verified-history-search.png` and `verified-history-context.png` under the ignored local directory `.tools/test-output/companions/`. Historical screenshots and raw test reports are not distributed with the source.

### Million-record benchmark

Run explicitly with `WORLDLINEBOX_HISTORY_BENCHMARK=1000000` and `scripts/run-vitest-with-electron.mjs run tests/worker/companion-history-performance.test.ts`. The benchmark creates and cleans its own temporary DB; no real user records or model calls are involved. The receipt is written to ignored `.tools/history-benchmark-1000000.json`.

The final million-row run used four rooms, short synthetic Chinese bodies, common and rare terms, seven samples per query, and a 510,885,888-byte file-backed SQLite DB (about 487 MiB). Construction plus indexing took 89.17 seconds with the final attachment/link facet implementation. Query plans use the FTS virtual index and message rowid lookups, without a message-table scan or temporary ordering B-tree for the tested indexed lookup.

| Query, 1,000,000 messages | Median ms | Maximum of seven samples, ms |
| --- | ---: | ---: |
| One Han character | 0.674 | 3.383 |
| Two Han characters | 0.644 | 2.526 |
| Rare phrase | 0.541 | 1.094 |
| Absent phrase | 0.148 | 0.254 |
| AND keywords | 0.560 | 0.798 |
| Conversation plus sender | 0.760 | 1.377 |
| Old one-day date range | 1.750 | 3.611 |
| Deep history keyset read | 1.044 | 1.708 |

These are local store latencies on this machine, with warmed filesystem/SQLite caches after construction; they exclude IPC, network, model generation and visual rendering. They are not cold-start benchmarks, long-message distributions or a tested hundred-million-row promise. Very common terms, wide time ranges, disk capacity, WAL/checkpoint costs, index size and long agent outputs require additional measured workloads before claiming that scale; sharding/partitioned indexing would need its own design and migration.

## Message presentation

Incoming and outgoing messages now both use content-sized bubbles. Normal prose has a 580 px / 74% maximum reading width; rich code/diagram/capability content can use 760 px / 82%. Short messages shrink naturally. Incoming bubbles are a light neutral surface, outgoing bubbles a restrained accent tint, with asymmetric rounded corners and bottom-level shadow. Avatars align to the bubble, metadata stays outside, and hover/focus actions use an absolute toolbar that does not reserve an empty line under every message. Search location uses an outline on the bubble rather than a full-row coloured rectangle. The desktop test checks actual bubble geometry and transparent row highlighting as well as rich rendering.

### Presence and header notices

Contact, recent-chat and header avatars carry a lower-right presence dot: green ready, orange working, purple waiting, grey offline. Missing effective global/independent credentials mark a role offline; observed authentication, network, timeout and rate-limit failures also mark idle roles offline with a bounded safe reason. Running work retains its working state. The service keeps only a private connection fingerprint alongside an observed error, resets it when the connection changes, and clears it after a successful reply. This is configuration plus observed execution state, not a periodic network health check.

Saving the global model configuration emits a companion state change immediately. The renderer derives effective presence in a memoized role list to avoid recreating role identities and retriggering detail requests on every render. The header avatar opens a focus-managed status panel, with individual members and connection settings in group chats. Configuration and history notices no longer add horizontal banners above messages; history is a compact header indicator and the existing return-to-latest button. Unit tests exercise missing/failed/changed connections, while desktop tests verify grey-to-green updates, the status panel and the absence of old banners.
