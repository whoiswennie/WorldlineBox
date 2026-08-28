# @deepseek-ai/dsh-host-webserver

English | [中文](README.zh.md)

Cordis-owned HTTP/upgrade route registry, index transforms, and fallback seat.

## Model Experience

None, as the server transports browser and API traffic without composing model requests.

#### KV Cache effect

Route registration and HTTP delivery add no model tokens and do not affect KV-cache reuse.

## Known Limitations and Deferred Work

- **Transport primitive** — TLS termination, authentication policy, and externally reachable deployment topology must be supplied by the owning Host application.
