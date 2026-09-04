# Worldline AI

English | [中文](README.zh.md)

This package provides model routing, bounded context assembly, actor decisions, resilient streamed text generation, and durable usage telemetry for Worldline Runs.

## Contract

Requests are scoped to one project and Run, validated against current choices, and bounded by the selected model's real context window. Provider-classified transient failures use that route's retry and Retry-After policy; every attempt is retained as invocation evidence, while failed partial output is discarded. Usage and estimated cost remain diagnostic telemetry and never pause a story. AI output records intent and invocation evidence but cannot mutate authoritative state directly.

## Model Experience

### Bounded Worldline request

#### What the model sees

The selected `ContextPack` sections, the request purpose, allowed choices or narrative instruction, and no project records outside the bound scope.

#### Token effect

Input is capped by the routed model window and package context bounds; output is capped by the request policy. These are protocol validity bounds, not user quotas.

#### KV Cache effect

Stable system instructions and unchanged Canon sections retain their order, while a new snapshot, memory selection, choice set, or narration instruction replaces the request-specific suffix.

## Known Limitations and Deferred Work

- **Diagnostic price estimates** — estimated cost depends on maintained provider/model price rows; an unknown route uses explicit fallback prices rather than silently recording zero cost.
