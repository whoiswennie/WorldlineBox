# @deepseek-ai/dsh-local-auth

English | [中文](README.zh.md)

Local account and session authority for the Worldline Host. It stores scrypt password hashes, remembered accounts, cross-entry auto-login preferences, expiring session-token hashes, profile fields, and the active account tenant in owner-only files below the configured authentication root.

The plugin exposes same-origin JSON routes through `host-webserver`, sets an HttpOnly `SameSite=Strict` cookie, and validates the managed account tenant before protected API or upgrade requests proceed. WebUI and Electron use the same account runtime root but retain separate browser cookie jars. A random single-use URL-fragment proof can mint each container's cookie without copying a password; the proof is consumed before the Host mutation and is never stored. Mutations are serialized and persisted through temporary-file replacement. For the active managed tenant only, an uploaded data-URL avatar is atomically materialized below the tenant profile directory. The read-only `ctx.localAccountProfile` face can expose that Host path to trusted model tools, while browser responses continue to contain only presentation data; credentials, cookie sessions, remembered accounts, and other tenants never cross that seam.

## Model Experience

### Authenticated browser identity

#### What the model sees

Nothing directly: the `worldline_session` cookie remains in the Host/browser boundary, and this package registers no prompt contribution. An opt-in context consumer may read the active managed tenant's display name, biography, and optional Host avatar path through `ctx.localAccountProfile`; image bytes are loaded only by an explicit trusted image tool.

#### Token effect

Authentication adds no prompt, message, tool schema, or tool result tokens.

#### KV Cache effect

Signing in, switching accounts, or updating a profile does not alter an already-assembled model request prefix.

## Known Limitations and Deferred Work

- **Local identity only** — the store has no remote identity provider, account recovery, multi-factor authentication, or cross-device synchronization.
- **Host-process concurrency** — WebUI and Electron may retain independent sessions, but running both writable Host processes at the same time is not supported yet; close one entry point before starting the other.
