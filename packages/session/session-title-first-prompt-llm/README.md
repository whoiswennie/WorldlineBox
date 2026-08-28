# @deepseek-ai/dsh-session-title-first-prompt-llm

English | [中文](README.zh.md)

Cordis provider plugin that generates a session title from the first human prompt.

## Model Experience

### First-prompt title request

#### What the model sees

The auxiliary title model receives only the first logged human message, selected by the `first-prompt` provider and framed by `session-title-llm`.

#### Token effect

One automatic auxiliary request consumes the shared title system instruction, the JSON-framed first message, and output up to `maxOutputTokens`.

#### KV Cache effect

Title generation uses an independent request; its stable system prefix may be reusable across sessions, while the framed first message changes per Session.

## Known Limitations and Deferred Work

- **First message only** — later human context cannot refine an automatically generated title; another provider is required for multi-message titles.
- **Configured route required** — generation fails when no explicit provider/model pair exists and the source request has no logged route.
