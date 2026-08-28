# @deepseek-ai/dsh-client-ui-worldline-chrome

English | [中文](README.zh.md)

Worldline-owned desktop chrome for workspaces, terminal sessions, runtime logs, toolchain status, and the product status bar. It fills stable UI Slots and delegates every privileged operation to authenticated Host remotes.

The workspace explorer and editor share the workspace-tree capability, while terminal and runtime-log workbenches use the Host API carrier. The package contains presentation and client coordination only; it does not read the filesystem or spawn processes directly.

## Model Experience

### Product workbenches

#### What the model sees

Nothing: workspace previews, `TerminalRawReadResult` values, and runtime-log records stay in client workbenches unless a user separately submits their contents.

#### Token effect

Opening or operating product workbenches adds no model-request tokens.

#### KV Cache effect

Chrome state and Host polling are independent of the model prefix and do not invalidate cache reuse.

## Known Limitations and Deferred Work

- **Host-backed seats** — workspace, terminal, browser, and runtime-log controls require their corresponding authenticated Host services; this package provides no browser-only fallback implementations.
