# `@deepseek-ai/dsh-llm`

English | [中文](README.zh.md)

This package owns the provider-neutral model vocabulary and the `ctx.llm` service. Agent, session, prompt, tool, provider, and UI packages depend on this vocabulary instead of a concrete SDK.

An adapter registers one or more provider routes. Route registration and replacement are atomic effects, so a failed candidate never leaves a gap. A model call is prepared against one exact adapter generation: model metadata, output defaults, reasoning effort, and retry policy are resolved together, then the prepared handle can stream exactly once.

The stream protocol keeps model output structured. Text, reasoning, tool-call arguments, usage, replay state, and terminal finish reasons remain separate chunks. Adapter selection, iterator construction, synchronous provider failures, and iteration failures are normalized into one terminal `finish` chunk; middleware and consumer defects remain thrown.

Messages are immutable identified values. Provider/model provenance and replay state stay attached to assistant messages. Loop-built requests are deep-frozen and marked process-locally, and every model-visible field must later be reconstructable from the session event log.

`LlmRuntime` is a Cordis service. Providers subclass `LlmAdapter`; policies wrap `llm/stream`; consumers call `prepareCall()` and dispatch the returned registration-bound stream. No consumer instantiates a provider SDK directly.

## Model Experience

None, as the registry forwards already-assembled model requests unchanged to the selected adapter.

#### KV Cache effect

The neutral runtime adds no prompt tokens; adapter choice determines the provider cache namespace and wire-level cache behavior.

## Known Limitations and Deferred Work

- **Provider implementation required** — this package defines routing and streaming contracts but cannot execute a model call until an adapter registers the requested provider and model.
