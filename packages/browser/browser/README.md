# `@deepseek-ai/dsh-browser`

English | [中文](README.zh.md)

Service Definition for controlling conversation-owned native browser tabs. The contract carries normalized browser operations and JSON-safe results; Electron objects, CDP transport, screenshot writes, tab ownership, and lifecycle remain provider responsibilities.

## Model Experience

Indirectly, through a separately mounted browser tool consumer.

#### KV Cache effect

The Host capability itself adds no model prefix; its consumer owns any schema or result tokens.

## Known Limitations and Deferred Work

- The current contract targets a visible native browser. Headless and remote browser providers are not yet implemented.
