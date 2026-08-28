# @deepseek-ai/dsh-client-modules

English | [中文](README.zh.md)

Dual-face client module graph: host discovery/bundling and browser lazy module table.

## Model Experience

None, as the module loader only discovers and evaluates browser plugins.

#### KV Cache effect

Client module loading does not assemble model requests and has no KV-cache effect.

## Known Limitations and Deferred Work

- **Web client format** — browser entries must conform to the generated lazy CommonJS module table; this package does not load arbitrary native or server modules in the browser.
