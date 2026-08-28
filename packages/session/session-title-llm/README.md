# @deepseek-ai/dsh-session-title-llm

English | [中文](README.zh.md)

Shared model-generation policy for session-title provider plugins.

## Model Experience

### Auxiliary title request

#### What the model sees

The title model receives a fixed instruction to return one concise plain-text title in the messages' language plus `Generate the session title from this JSON array of human messages:` and the selected human messages encoded as JSON.

#### Token effect

The independent request is bounded by `maxInputBytes` and `maxOutputTokens`; it does not add tokens to the primary Agent request.

#### KV Cache effect

The system instruction is stable for one resolved target-word configuration, while the JSON-framed user message suffix changes with the selected Session messages.

## Known Limitations and Deferred Work

- **Text-only title contract** — tool calls, empty output, invalid finish reasons, and output that reaches the token cap are rejected rather than repaired with another model call.
- **Hard input bound** — selected messages exceeding `maxInputBytes` fail title generation; this package does not summarize or truncate them.
