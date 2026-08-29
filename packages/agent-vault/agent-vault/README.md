# @deepseek-ai/dsh-agent-vault

English | [中文](README.zh.md)

The role-neutral `ctx.agentVaults` seam for a portable Agent's self model, staged memory, procedural experience, resources, governance, recall, and package transfer. Semantic truth is file-native; implementations may keep rebuildable indexes but may not make them authoritative.

The service deliberately separates `self`, `memory`, `procedure`, and `resource` operations. General recall cannot target `self`, and every semantic write carries actor, reason, and optional revision information for provider-side enforcement.

## Model Experience

Consumers expose bounded recall cards and progressive reads instead of the complete Vault.

#### KV Cache effect

Only the compiled self snapshot and bounded activated cards affect a turn's prompt suffix.

## Known Limitations and Deferred Work

- Encryption-at-rest policy remains deployment-owned; portable packages support integrity first.
