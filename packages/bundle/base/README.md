# @deepseek-ai/dsh-base

English | [中文](README.zh.md)

The shared Cordis profile bundle for CLI, desktop, and Web hosts.

## Model Experience

Indirectly, through the model-facing plugins inserted by the base profile patch.

#### KV Cache effect

The bundle contributes no tokens itself; changing its composed rows can change prompt and tool prefixes owned by those rows.

## Known Limitations and Deferred Work

- **Composition only** — this package inserts the baseline rows but does not configure deployment-specific providers, credentials, or host capabilities.
