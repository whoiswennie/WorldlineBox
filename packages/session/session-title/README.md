# @deepseek-ai/dsh-session-title

English | [中文](README.zh.md)

Cordis session-title service, deterministic fallback, event-log projection, and provider registry.

## Model Experience

### Title provider dispatch

#### What the model sees

Nothing directly: `ctx.sessionTitle` selects a provider and records normalized title state, while a model-backed provider owns any auxiliary request.

#### Token effect

The service and deterministic fallback add no model tokens; auxiliary providers account for their own independent input and output.

#### KV Cache effect

Title state never changes the primary Agent prefix, and any auxiliary title request has a separate cache lifecycle.

## Known Limitations and Deferred Work

- **Registered-provider scope** — automatic generation is limited to the active provider's cadence and source-message selection; the service does not merge competing provider results.
- **Normalization bound** — titles are reduced to one safe non-empty line, so rich formatting and multi-line labels cannot be preserved.
