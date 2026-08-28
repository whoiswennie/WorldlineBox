# `@deepseek-ai/dsh-browser`

English | [中文](README.zh.md)

Service Definition for controlling conversation-owned native browser tabs. The contract carries normalized browser operations and JSON-safe results; Electron objects, CDP transport, screenshot writes, tab ownership, and lifecycle remain provider responsibilities.

## Model Experience

None. This package declares a Host capability. A separate consumer decides whether and how it becomes model-visible.

## Known Limitations and Deferred Work

- The current contract targets a visible native browser. Headless and remote browser providers are not yet implemented.
