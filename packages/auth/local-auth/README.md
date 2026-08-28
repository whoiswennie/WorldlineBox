# @deepseek-ai/dsh-local-auth

English | [中文](README.zh.md)

Local account and session authority for the Worldline Host. It stores scrypt password hashes, remembered accounts, cross-entry auto-login preferences, expiring session-token hashes, profile fields, and the active account tenant in owner-only files below the configured authentication root.

The plugin exposes same-origin JSON routes through `host-webserver`, sets an HttpOnly `SameSite=Strict` cookie, and validates the managed account tenant before protected API or upgrade requests proceed. WebUI and Electron use the same account runtime root but retain separate browser cookie jars. A random single-use URL-fragment proof can mint each container's cookie without copying a password; the proof is consumed before the Host mutation and is never stored. Mutations are serialized and persisted through temporary-file replacement. The read-only `ctx.localAccountProfile` face exposes only the browser-safe profile of the active managed desktop tenant so an explicitly mounted context plugin can introduce the user to an Agent; credentials, cookie sessions, remembered accounts, and other tenants never cross that seam.

## Model Experience

### Authenticated browser identity

#### What the model sees

Nothing directly: the `worldline_session` cookie remains in the Host/browser boundary, and this package registers no prompt contribution. An opt-in context consumer may read the active managed tenant's public display name and biography through `ctx.localAccountProfile`.

#### Token effect

Authentication adds no prompt, message, tool schema, or tool result tokens.

#### KV Cache effect

Signing in, switching accounts, or updating a profile does not alter an already-assembled model request prefix.

## Known Limitations and Deferred Work

- **Local identity only** — the store has no remote identity provider, account recovery, multi-factor authentication, or cross-device synchronization.
- **Host-process concurrency** — WebUI and Electron may retain independent sessions, but running both writable Host processes at the same time is not supported yet; close one entry point before starting the other.
