# @deepseek-ai/dsh-agent-vault-local

English | [中文](README.zh.md)

The local `ctx.agentVaults` provider stores semantic truth below `WORLDLINE_HOME/agents/v1`, keeps SQLite FTS only under each Vault's `.system`, and enforces domain, freeze, lock, revision, URI, symlink, and package-integrity checks at the operation that commits a change.

## Model Experience

Recall combines exact title, aliases, canonical tags, FTS ranking, and character n-gram scoring. It does not call an embedding model or remote semantic service.

#### KV Cache effect

Bounded recall results stabilize prompt size independently of Vault size.

## Known Limitations and Deferred Work

- Package encryption remains deployment-owned.
