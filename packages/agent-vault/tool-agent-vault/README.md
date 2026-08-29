# @deepseek-ai/dsh-tool-agent-vault

English | [中文](README.zh.md)

Model-facing tools for quick memory and procedure direction, bounded Wiki exploration, immediate short-memory capture, structured self inspection/change, checkpointed consolidation, and resource discovery. A runtime Agent must first be Host-bound to exactly one private Vault; the model cannot select another Agent id.

## Model Experience

### System prompt

One concise orientation section explains domain boundaries and progressive disclosure.

### Tool schemas

Ten fixed schemas are visible when mounted. Results are bounded JSON text and carry `vault://` URIs, revision values, scores, and match reasons rather than host paths.

#### KV Cache effect

Schemas and guidance are prefix-stable; data-dependent tool results append after the reusable prefix.

## Known Limitations and Deferred Work

- Binary resource creation remains a UI/Host upload workflow rather than a base64 model tool.
