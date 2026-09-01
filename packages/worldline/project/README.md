# Worldline project service

English | [中文](README.zh.md)

This package defines the replaceable Host capability and generated Remote surface for Worldline project libraries. Filesystem policy, indexing, history, and archive streaming belong to the local provider.

## Contract

The service owns project-library operations, recoverable project trash plus explicit permanent trash emptying, project-scoped document mutations, frozen build references, logical Run storage references, and cancellable transfer jobs. Callers use stable project identifiers and optimistic revisions rather than direct filesystem access.

## Model Experience

Indirectly, through Worldline tools and conversation-context consumers that select project records for a model request.

#### KV Cache effect

The service itself sends no model request; consumers determine prefix stability from the selected project revision.

## Known Limitations and Deferred Work

- **Local-first provider set** — the shipped implementation binds one user-selected local library root; remote or collaborative providers must implement this same service contract without weakening project isolation.
