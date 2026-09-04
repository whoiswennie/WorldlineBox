# Worldline tools

English | [中文](README.zh.md)

This package registers the project-scoped model tools used for Worldline authoring, queries, edits, links, maps, builds, Runs, explanations, and transfers.

## Contract

Every execution resolves the calling author Session's active project. Agent mutations are rejected at the tool boundary until that Session has successfully loaded `worldline-authoring`; this is a runtime prerequisite, not a prompt convention. Stage writes also require their matching `worldline-character-design`, `worldline-map-design`, `worldline-mechanism-design`, or `worldline-scenario-design` skill, and freeze/prove requires `worldline-build-audit`. Creating a project or explicitly using another stable project ID switches that context automatically, without manual binding. `worldline_map` validates and writes the one current structured map block through optimistic project revisions; the model never fabricates compiler source anchors. `worldline_build prove` is the authoritative playable-closure gate: it compiles, freezes, creates a Run, executes legal autonomous actions, advances logical time, verifies map and causal records, and creates a checkpoint. `worldline_run simulate` performs a bounded deterministic autonomous cycle. Generic filesystem or shell tools are never an alternate authority for project data.

## Model Experience

### Project-scoped tool surface

#### What the model sees

Nine `worldline_*` schemas documented in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-ai-dsh-tool-worldline), plus a stable system rule that names these tools as the only Worldline mutation authority.

#### Token effect

The schemas and short system rule are fixed while the preset is mounted; individual JSON results, autonomous cycles, map projections, and Run record evidence are bounded by explicit limits.

#### KV Cache effect

The fixed schemas and system rule form a stable prefix; only tool calls and their project-scoped results append request-specific content.

## Known Limitations and Deferred Work

- **Worldline OC author Session required** — only the dedicated mode mounts mutation tools; standard Agents and virtual companions cannot mutate Worldline state.
