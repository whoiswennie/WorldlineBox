# Worldline Standard

English | [中文](README.zh.md)

This package owns the portable WWS contracts shared by project storage, the compiler, the runtime worker, Host services, and the Client. It defines stable identity, provenance, maps, Blueprints, actions, processes, event streams, memory, AI usage telemetry, context packs, narrative projections, certificates, checkpoints, and replay records without fixing a genre.

## Contract

Runtime state changes only through validated actions and world events; diagnostic and narrative records cannot masquerade as world facts. Importers accept only the current application-owned format and reject incompatible data instead of branching into compatibility logic.

## OC project framework

`WORLDLINE_PROJECT_LAYOUT` is the single current directory contract. Native creation chooses an
object type first and derives its Markdown directory from this contract; the archive uses the same
types and grouping, so authoring and reading cannot drift apart.

| Authored concern | Canon kinds | Directory |
| --- | --- | --- |
| World charter | `charter` | `canon/` |
| People and species | `character`, `species` | `characters/`, `species/` |
| Space | `place` | `maps/places/` |
| Society | `organization`, `relation` | `organizations/`, `relations/` |
| World knowledge | `rule`, `concept`, `fact` | `mechanisms/`, `concepts/`, `facts/` |
| Objects and media catalogs | `item`, `asset` | `items/`, `assets/catalog/` |
| Story and history | `scenario`, `timeline-event` | `scenarios/plot-points/`, `timelines/` |
| Binary media | — | `assets/files/` |

The `.worldline/` control tree is application-owned. It stores metadata, revision history, builds,
Run snapshots, trash, and transfer state. These derived or managed records never become authored
Canon and restoring a save never rewrites the Markdown source.

## Model Experience

Indirectly, through consumers that select WWS values for prompts, tool results, or model requests.

#### KV Cache effect

The type and validation package sends no model request; consuming packages own ordering and cache stability.

## Known Limitations and Deferred Work

- **Application-owned interchange** — WWS is not an external standard, so archives produced by unrelated tools require explicit validation against the current repository contract.
