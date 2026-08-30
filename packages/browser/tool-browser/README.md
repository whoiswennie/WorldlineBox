# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

Model-facing `browser_control` for Worldline's existing embedded Electron browser. It reuses the same conversation-owned tabs users see in the Browser pane and exposes 27 bounded actions: tab and navigation control, semantic snapshots, HTML/text inspection, screenshots, JavaScript evaluation, mouse/keyboard/form interaction, waits, console/network diagnostics, DevTools, and guarded raw CDP.

The package registers only when `ctx.browserController` is available. Screenshots are contained to the Session workspace, output is capped, tabs are isolated by Session id, and CDP download-path commands are blocked. Add it to an Agent preset with:

```yaml
- id: tool-browser
  name: '@deepseek-ai/dsh-tool-browser'
```

Within an Agent scope, this package masks inherited legacy `browser_*` commands from third-party bundles. This prevents an Agent from driving a second hidden Electron view while the user-facing Worldline Browser pane remains empty; unrelated third-party tools are not changed.

## Model Experience

### Browser control

#### What the model sees

The model receives the [`browser_control` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser) plus guidance to inspect with `snapshot`, prefer high-level actions, wait for loads, and reserve `evaluate` or `cdp` for escape hatches. Results are bounded JSON containing the action, optional tab id and data, and the current tab list.

#### Token effect

The fixed schema and guidance add a stable request-prefix cost. Bounded action results append only after calls.

#### KV Cache effect

The tool contract remains prefix-stable; navigation state and action results do not rewrite that prefix.

## Known Limitations and Deferred Work

- The tool requires Worldline's visible Electron browser provider; headless and remote browser providers are not implemented.
