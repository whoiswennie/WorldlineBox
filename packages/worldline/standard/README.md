# Worldline Standard

English | [中文](README.zh.md)

This package owns the portable WWS contracts shared by project storage, the compiler, the runtime worker, Host services, and the Client. It defines stable identity, provenance, maps, Blueprints, actions, processes, event streams, memory, AI budgets, context packs, narrative projections, certificates, checkpoints, and replay records without fixing a genre.

## Contract

Runtime state changes only through validated actions and world events; diagnostic and narrative records cannot masquerade as world facts. Importers accept only the current application-owned format and reject incompatible data instead of branching into compatibility logic.

## Model Experience

Indirectly, through consumers that select WWS values for prompts, tool results, or model requests.

#### KV Cache effect

The type and validation package sends no model request; consuming packages own ordering and cache stability.

## Known Limitations and Deferred Work

- **Application-owned interchange** — WWS is not an external standard, so archives produced by unrelated tools require explicit validation against the current repository contract.
