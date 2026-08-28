# @deepseek-ai/dsh-client-ui-auth

English | [中文](README.zh.md)

Browser account UI for the local-auth Host routes. It registers the login and registration overlay, remembered-account selection, profile editing, avatar cropping, and the account settings section in scoped UI Slots.

The client keeps only the browser-safe authentication snapshot. Password hashing, session-token storage, tenant selection, and authorization remain Host responsibilities. Its launch handoff removes the one-time proof from the URL before exchanging it, then waits for an account-triggered Host restart before reloading the surface.

## Model Experience

### Account controls

#### What the model sees

Nothing: authentication forms and the `AuthSnapshot` client state are not copied into Agent messages or tools.

#### Token effect

Rendering or submitting account controls adds no model-request tokens.

#### KV Cache effect

Account UI state is independent of model prompt prefixes and cannot invalidate cache reuse.

## Known Limitations and Deferred Work

- **Local-auth dependency** — the UI cannot authenticate against OAuth, enterprise identity, or a remote account API; it requires the sibling local-auth routes and same-origin cookies.
