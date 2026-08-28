# @deepseek-ai/dsh-session-projection

English | [中文](README.zh.md)

Rebuildable projection registry for the append-only Session event log. Domain plugins contribute pure reducers and serialization schemas. A projection is not a source of truth, and registrations and caches unload with their Cordis Fibers.

## Model Experience

None, as projections expose derived read models to clients without registering model context.

#### KV Cache effect

Projection rebuilds and cache reads do not change model requests or KV-cache reuse.

## Known Limitations and Deferred Work

- **Log-derived state only** — projection values are unavailable for facts that are not recorded in the Session log, and consumers must tolerate rebuilds after cache loss.
