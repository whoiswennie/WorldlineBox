# VCPToolBox upstream regression verification

Executed on 2026-11-02 with Node.js v22.19.0 on Windows x64. This report concerns preserved upstream tests, separately from the standalone CLI integration tests.

```powershell
cd upstream/toolbox
node --test --test-concurrency=4 --test-timeout=90000 --test-force-exit --test-reporter=spec tests/*.test.js
```

Final result: **448 tests, 359 passed, 0 failed, 89 skipped**, duration 18.45 seconds. Full output: `reports/upstream-toolbox-tests-final.log`.

The 67 selected test files cover native SQLite/index lifecycle, atomic ingestion, watcher reconciliation, TagMemo configuration and observation sharing, native RiverMemo query plans, geometry scheduling and training, persistence/checkpoints, semantic deduplication, RAG copy-on-write and refresh system boundaries, timeline/ContextBridge routing, text chunking, LightMemo, thought clusters, cold TDB storage, and adjacent JEV/context helpers.

87 skips belong to third-party tool ecosystem cases whose unrelated plugins are intentionally outside this memory package. Two skips require a separate experimental `target/tdb-validation` native artifact and an old USearch baseline for A/B acceptance and retrieval-quality comparison. Those two experimental comparisons were **not** executed. The shipped native binding is exercised by the other native regression tests and loads `NativeKnowledgeRuntime`, `VexusIndex`, and `VexusWatcher` successfully.

No upstream source or tests were modified to make them pass. Initial missing-fixture failures were resolved by preserving the corresponding public source/configuration files, archive prototypes, static panel files, and three small upstream tool fixtures. The only copied `TVStxt` file is the unmodified, Git-tracked 413-byte public `JevToolCallDecision.txt` protocol prompt. No user diaries, Agent personas, private environment files, state databases, or personal TVStxt content were copied.

These tests include controlled embedding/model doubles and do not establish live embedding quality, live chat-provider behavior, real dream consolidation quality, or equivalence of every whitepaper claim. Those require the standalone integration and real-provider checks recorded separately. `--test-force-exit` bounds upstream watcher lifetimes; standalone shutdown checks must establish cleanup independently.

Toolbox snapshot: 336 source/artifact files; per-file SHA-256 and source commit are recorded in `upstream/manifest.json`. The snapshot verifier checks bytes independently of the original repository. `selection.pluginCompleteness` verifies manifest and entrypoint preservation for every existing explicitly selected plugin; `MemoryMaster` does not exist in the supplied upstream tree.
