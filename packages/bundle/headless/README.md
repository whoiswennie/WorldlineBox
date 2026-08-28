# @deepseek-ai/dsh-headless

English | [中文](README.zh.md)

One-shot CLI runner bundle over the shared Cordis baseline.

## Model Experience

None, as the runner submits its task as an ordinary user message and leaves request composition to the mounted bundles.

#### KV Cache effect

The runner adds no independent prefix; cache behavior follows the selected session, prompt, and tool plugins.

## Known Limitations and Deferred Work

- **One-shot runtime** — the bundle intentionally omits the Host, HTTP, desktop, and browser layers required for interactive product sessions.
