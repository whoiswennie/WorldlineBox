# @deepseek-ai/dsh-tool-workspace

English | [中文](README.zh.md)

Optional Cordis plugin contributing workspace-confined `read`, `write`, `edit`, `glob`, `grep`, and `pwsh` tools. The minimal Agent Loop does not import this package; an application profile opts into it.

## Model Experience

### Workspace tools

#### What the model sees

The model receives the `read`, `write`, `edit`, `glob`, `grep`, and `pwsh` tool definitions and their bounded JSON results when this optional plugin is mounted.

#### Token effect

Tool definitions add a fixed request prefix; each call appends arguments and a result capped by the configured read, output, or search limits.

#### KV Cache effect

The tool-definition prefix stays stable while configuration and package code are unchanged; tool calls append after that prefix and can reuse it when the provider supports prefix caching.

## Known Limitations and Deferred Work

- **Fresh PowerShell process** — every `pwsh` call starts a new process, so shell state and environment mutations do not persist between calls.
- **External command confinement** — path-based tools enforce workspace containment, but operating-system sandboxing and approval policy must constrain commands executed by `pwsh`.
- **Bounded in-process search** — glob and grep use the package's built-in traversal and regular-expression implementation rather than native ignore files or ripgrep semantics.
