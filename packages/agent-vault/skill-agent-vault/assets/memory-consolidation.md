# Bounded memory consolidation

Consolidation converts short memory to normalized medium memory. It must remain recoverable at any backlog size.

1. Inventory metadata only: counts, dates, Tags, sources, sizes, and candidate clusters. Never load the whole backlog into model context.
2. Create bounded batches around one subject, time window, or directory. Prefer 20–100 records; reduce the batch when documents are large or conflicts are dense.
3. For each candidate, classify it as distinct, duplicate, revision, conflict, unsupported inference, or private material requiring restriction.
4. Preserve sources and stable meaning. Normalize titles, Tags, aliases, dates, and links; do not turn uncertain claims into facts.
5. Commit a batch through `memory_consolidate`. The task checkpoint is authoritative. On interruption, resume the existing job instead of starting a second merge.
6. Treat completion of a consolidation stage as the checkpoint for refreshing common memory. Recall frequency and recency are technical evidence only; the visible common-memory impression changes in a bounded batch, never after one conversation turn.
6. Test the batch with exact, alias, Tag, negative, and neighboring-directory queries. A bad test result means repair or split the batch before continuing.
7. Record unresolved semantic conflicts for deliberate review. Mechanical cleanup can be automatic; semantic replacement requires evidence.

Never enlarge the batch merely because the backlog is large. Progress is many small idempotent commits, not one whole-library summary.
