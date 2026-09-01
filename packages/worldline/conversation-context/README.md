# Worldline conversation context

English | [中文](README.zh.md)

This package binds an author Session to one project, worldline, source revision, and optional Run, then publishes that durable authority boundary into the scoped system prompt.

## Contract

Bindings are session-owned, reject cross-project ambiguity, and carry the exact source revision used by author tools. Disposal removes the scoped prompt contribution without changing project data.

## Model Experience

### Author binding

#### What the model sees

A compact `Worldline author binding` block naming the authorized project, worldline, source revision, and optional Run identifier.

#### Token effect

The fixed-size block contributes one short system-context entry per bound author Session.

#### KV Cache effect

The block is stable until the binding changes; rebinding replaces that system-context entry and invalidates reuse after its position.

## Known Limitations and Deferred Work

- **One active binding per Session** — cross-project comparison requires separate Sessions or an explicitly designed read-only comparison consumer.
