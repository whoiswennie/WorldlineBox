# Agent Vault and virtual companion refactor plan

English | [中文](README.zh.md)

## Purpose

This directory defines one complete refactor objective for the next WorldlineBox milestone: unify virtual companions, character profiles, knowledge, memory, capabilities, experience, resources, retrieval, context awareness, autonomous skills, and management UI in a freezeable, verifiable, importable, and exportable Agent Vault. The internal steps describe engineering dependencies and acceptance order; they do not permit a multi-stage partial delivery that omits critical capabilities. The refactor is complete only after all required work passes final acceptance.

The pre-refactor baseline is Git commit `e1da103718301e60410914df9fb46960747a8689`. That baseline was pushed to `origin/main` to preserve existing behavior and resources for recovery.

## Goals

- Every general Agent and virtual companion owns an independent, file-native Agent Vault that can be moved as one unit.
- The companion management page displays and edits structured self impressions from that same Vault instead of maintaining a second character-card source of truth.
- Short-, medium-, and long-term memory use distinct write, consolidation, verification, and promotion methods; short-term memory is recallable immediately after saving.
- Common cognition participates in conversations through stable, stage-updated impressions; technical caches remain strictly separate from personality cognition.
- Declarative knowledge, procedural experience, structured self, and resources belong to one Vault while using separate retrieval domains, tools, and renderers.
- Markdown, structured manifests, and binary objects are the portable source of truth; SQLite FTS5 and similar components are disposable, rebuildable projections only.
- Embedding models, vector APIs, and third-party semantic services are not required by default. Recall uses hierarchical directories, canonical tags, aliases, FTS5 trigram, BM25F, character n-grams, sparse TF-IDF, link neighborhoods, and Agent query probes.
- Agents access data through dedicated Vault tools in normal operation instead of managing physical paths through Bash.
- Users can freeze the complete Vault or individual domains, and the Host enforces read-only policy at tool execution time.
- Existing curated memes, images, audio, video, text resources, tags, enabled states, and built-in resources must migrate intact; refactoring never justifies deleting or overwriting them.

## Rejected approaches

- Do not keep old and new character card, knowledge, or reference runtimes active in parallel.
- Do not inject complete knowledge, tag, resource-candidate, or Skill catalogs into model context.
- Do not search or modify `self/` through ordinary `knowledge.search` behavior.
- Do not make SQLite, index caches, absolute paths, or vectors from one embedding model an irreplaceable source of truth.
- Do not use a one-shot, whole-corpus LLM summary as the large-scale consolidation method.
- Do not let a retrieval hit directly mutate personality, overwrite long-term memory, or certify a capability.
- Do not substitute a few demonstration cases for migration integrity, recall quality, permission isolation, and scale tests.

## Documents

1. [Goals and architectural invariants](01-目标与架构不变量.md)
2. [Agent Vault filesystem and portability](02-Agent-Vault-文件系统与移植.md)
3. [Memory lifecycle and autonomous skills](03-记忆生命周期与自治技能包.md)
4. [Recall indexes and context injection](04-召回索引与上下文注入.md)
5. [Impression cards and companion runtime](05-印象卡与伙伴运行时.md)
6. [Unified resource system and management UI](06-统一资源系统与管理界面.md)
7. [Engineering decomposition and implementation order](07-工程拆分与实施顺序.md)
8. [Migration, preservation, and rollback](08-数据迁移保全与回滚.md)
9. [Validation benchmarks and final acceptance](09-验证基准与最终验收.md)

## Definition of done

All conditions below must hold:

- The new Agent Vault format, VFS, permissions, indexes, tools, Skills, UI, import/export, and migration are all on the production runtime path.
- The old runtime logic is removed; no permanent compatibility branch or dual-write path remains.
- Current local reference resources are backed up, converted, count-checked, hash-checked, and visible and usable in the new resource gallery.
- A new companion can be created from scratch, an existing companion can be migrated, and a complete package can be imported under a different absolute path and operate normally.
- Freeze policy, domain isolation, revision conflict prevention, import safety, and privacy export pass tests.
- Fast recall, deep exploration, bulk consolidation, and context budgets meet the acceptance thresholds in this plan.
- All related Runtime, Client, CLI, Desktop, migration, performance, and end-to-end tests pass.
