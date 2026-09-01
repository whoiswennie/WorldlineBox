# Worldline AI

English | [中文](README.zh.md)

This package provides budgeted model routing, bounded context assembly, actor decisions, and streamed text generation for Worldline Runs.

## Contract

Requests are scoped to one project and Run, validated against current choices, priced before dispatch, charged from durable usage, and rejected when budget or context limits would be exceeded. AI output records intent and invocation evidence but cannot mutate authoritative state directly.

## Model Experience

### Bounded Worldline request

#### What the model sees

The selected `ContextPack` sections, the request purpose, allowed choices or narrative instruction, and no project records outside the bound scope.

#### Token effect

Input is capped by the routed model window and package context bounds; output is capped by the request policy and charged to the Run budget.

#### KV Cache effect

Stable system instructions and unchanged Canon sections retain their order, while a new snapshot, memory selection, choice set, or narration instruction replaces the request-specific suffix.

## Known Limitations and Deferred Work

- **Configured price authority** — cost enforcement depends on maintained provider/model price rows; an unknown route uses explicit fallback prices rather than silently assuming zero cost.
