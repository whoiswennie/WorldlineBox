# Worldline tools

English | [中文](README.zh.md)

This package registers the project-scoped model tools used for Worldline authoring, queries, edits, links, maps, builds, Runs, explanations, and transfers.

## Contract

Every execution resolves the calling author Session's active project. Creating a project or explicitly using another stable project ID switches that context automatically, without manual binding. Mutations require the relevant stable identity, provenance, optimistic revision, dry-run, or explicit confirmation, and generic filesystem or shell tools are never an alternate authority for project data.

## Model Experience

### Project-scoped tool surface

#### What the model sees

Nine `worldline_*` schemas documented in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-ai-dsh-tool-worldline), plus a stable system rule that names these tools as the only Worldline mutation authority.

#### Token effect

The schemas and short system rule are fixed while the preset is mounted; individual JSON results are bounded by each operation's project or Run query limits.

#### KV Cache effect

The fixed schemas and system rule form a stable prefix; only tool calls and their project-scoped results append request-specific content.

## Known Limitations and Deferred Work

- **Worldline OC author Session required** — only the dedicated mode mounts mutation tools; standard Agents and virtual companions cannot mutate Worldline state.
