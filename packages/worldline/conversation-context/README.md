# Worldline conversation context

English | [中文](README.zh.md)

This package maintains a switchable active project, worldline, source revision, and optional Run for a Worldline OC author Session, then publishes that current context into the scoped system prompt.

## Contract

The active project is Session-owned and switches automatically when the author creates or explicitly uses another project. Each tool call still targets exactly one project and carries its exact source revision. Disposal does not change project data.

## Model Experience

### Author binding

#### What the model sees

A compact active-project block naming the current project, worldline, source revision, and optional Run identifier.

#### Token effect

The fixed-size block contributes one short system-context entry per author Session with an active project.

#### KV Cache effect

The block is stable until the active project changes; switching replaces that system-context entry and invalidates reuse after its position.

## Known Limitations and Deferred Work

- **One active project at a time** — a Session may follow user intent across projects, while a single mutation never writes to multiple projects.
