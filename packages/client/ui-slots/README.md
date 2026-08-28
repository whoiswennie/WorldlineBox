# @deepseek-ai/dsh-client-ui-slots

English | [中文](README.zh.md)

Pure UI Slot kernel shared by browser Cordis plugins. Pages, layouts, settings sections, tool renderers, and blueprint editors contribute components through declarative Slot contracts. Each registration belongs to the current Fiber and is revoked precisely when its plugin unloads.

This package owns no product page and depends on neither Electron nor Host implementations. React appears only at the type boundary and the replaceable renderer seam.

## Model Experience

None, as the slot registry only composes browser-side React renderers.

#### KV Cache effect

Slot registration changes UI composition only and has no model-request or KV-cache effect.

## Known Limitations and Deferred Work

- **In-process rendering** — contributions must run in the same browser Cordis runtime; the registry provides no iframe or worker isolation for third-party components.
