# @deepseek-ai/dsh-agent-vault-local

English | [中文](README.zh.md)

The local `ctx.agentVaults` provider stores semantic truth below `WORLDLINE_HOME/agents/v1`, keeps SQLite FTS only under each Vault's `.system`, and enforces domain, freeze, lock, revision, URI, symlink, and package-integrity checks at the operation that commits a change.

## Model Experience

Indirectly, through the mounted Vault skill and tool consumers.

#### KV Cache effect

The storage provider adds no prefix; consumers own any bounded recall results they render.

## Known Limitations and Deferred Work

- Package encryption remains deployment-owned.
