# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

Model-facing `browser_control` for Worldline's existing embedded Electron browser. It reuses the same conversation-owned tabs users see in the Browser pane and exposes 27 bounded actions: tab and navigation control, semantic snapshots, HTML/text inspection, screenshots, JavaScript evaluation, mouse/keyboard/form interaction, waits, console/network diagnostics, DevTools, and guarded raw CDP.

The package registers only when `ctx.browserController` is available. Screenshots are contained to the Session workspace, output is capped, tabs are isolated by Session id, and CDP download-path commands are blocked. Add it to an Agent preset with:

```yaml
- id: tool-browser
  name: '@deepseek-ai/dsh-tool-browser'
```

## Model Experience

The model sees one `browser_control` schema plus guidance to inspect with `snapshot`, prefer high-level actions, wait for loads, and use `evaluate`/`cdp` only as escape hatches. Results are bounded JSON containing the selected action, optional tab id and data, and the current tab list.
