# @deepseek-ai/dsh-llm-retry

English | [中文](README.zh.md)

Provider-route-aware recovery plugin for model requests. It runs each Provider's declared backoff policy at the Agent request-error extension point and writes retry events to the Session before waiting, making retry decisions auditable, recoverable, and cancelable.

## Model Experience

### Retried primary request

#### What the model sees

The same already-assembled request is dispatched again; `llm/retry` and `llm/retry-started` events are durable control records rather than added prompt text.

#### Token effect

Each attempt resends the request tokens and may generate new output tokens, while the retry policy itself contributes zero context tokens.

#### KV Cache effect

An unchanged retry preserves the original prefix and route, so provider-side prefix caching may be reusable; cache availability and eviction remain provider behavior.

## Known Limitations and Deferred Work

- **Provider policy required** — failures fall through to other recovery handlers when the selected adapter declares no retry policy or the error code is not retryable.
- **Process-local wait** — durable events record the decision, but a process restart does not resume a partially elapsed backoff timer.
