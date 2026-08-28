# @deepseek-ai/dsh-cmdline

English | [中文](README.zh.md)

Host-provided immutable command-line arguments and bounded process-exit integration for Cordis applications.

## Model Experience

None, as this package only snapshots launcher arguments and process-exit handling before sessions exist.

#### KV Cache effect

The immutable argument handoff adds no model request tokens and cannot invalidate a reusable prompt prefix.

## Known Limitations and Deferred Work

- **Immutable snapshot** — consumers cannot observe changes to `process.argv` after the service is constructed.
