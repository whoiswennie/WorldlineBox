# @deepseek-ai/dsh-host-frontend-static

English | [中文](README.zh.md)

Static SPA fallback plugin with traversal rejection and index transform support.

## Model Experience

None, as this package only serves browser assets and transforms the SPA index response.

#### KV Cache effect

Static HTTP responses never enter model requests and have no KV-cache effect.

## Known Limitations and Deferred Work

- **SPA assets only** — the fallback does not provide general-purpose directory hosting, dynamic rendering, or application API routes.
