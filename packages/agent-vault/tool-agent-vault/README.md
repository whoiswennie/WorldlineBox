# @deepseek-ai/dsh-tool-agent-vault

English | [中文](README.zh.md)

Model-facing tools for quick memory and procedure direction, bounded Wiki exploration, immediate short-memory capture, structured self inspection/change, checkpointed consolidation, and resource discovery. A runtime Agent must first be Host-bound to exactly one private Vault; the model cannot select another Agent id.

`resource_find.roles` is an any-of list: asking for expression, appearance, source, and attachment returns resources carrying any requested role. Private and public results are merged without granting access to another Agent's private Vault.

## Model Experience

### Vault orientation and operations

#### What the model sees

One concise orientation section explains domain boundaries and progressive disclosure. Ten fixed schemas return bounded JSON carrying `vault://` URIs, revisions, scores, and match reasons instead of host paths.

#### Token effect

The orientation and ten schemas are fixed request-prefix costs. Data-dependent, size-bounded tool results append during the conversation.

#### KV Cache effect

Schemas and guidance remain prefix-stable; data-dependent tool results append after the reusable prefix.

## Known Limitations and Deferred Work

- Binary resource creation remains a UI/Host upload workflow rather than a base64 model tool.
