# Account Profile Context

English | [中文](README.zh.md)

An opt-in Agent Preset row that introduces the active managed desktop account to the model. It reads only the browser-safe `ctx.localAccountProfile` projection and contributes no context when the runtime is not attached to an account tenant.

The contribution serializes display name, username, and biography as JSON reference data and explicitly marks those fields as non-instructional. Avatar bytes, credentials, cookie sessions, remembered accounts, numeric ids, and other tenants are excluded. Mount this row only in presets whose relationship model requires user identity; ordinary coding presets do not need it.

## Model Experience

### Active account profile

#### What the model sees

When an active managed profile exists, the model receives a dynamic runtime-context section containing `displayName`, `username`, and `bio` as JSON plus a rule to use them only for understanding and natural address. With no active profile, the section is absent.

#### Token effect

Conditional and bounded by the local-auth profile limits: fixed wrapper text plus at most 80 display-name characters, 32 username characters, and 2,000 biography characters on each request snapshot.

#### KV Cache effect

The runtime context is materialized as a sourced user-role snapshot. An unchanged profile is prefix-stable within the retained history; editing the profile changes the next snapshot without rewriting earlier events.

## Known Limitations and Deferred Work

- **Managed desktop tenant only** — an unmanaged browser session has request-local cookie identity that is not propagated into Agent assembly, so this plugin contributes nothing there.
