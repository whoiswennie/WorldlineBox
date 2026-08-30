# Account Profile Context

English | [中文](README.zh.md)

An opt-in Agent Preset row that introduces the active managed desktop account to the model. It reads only the current-tenant `ctx.localAccountProfile` projection and contributes no context when the runtime is not attached to an account tenant.

The contribution serializes display name, username, biography, and—when present—the Host-only materialized avatar path as JSON reference data, and explicitly marks those fields as non-instructional. It tells the Agent to call `read_image` before making any visual claim. Avatar bytes, credentials, cookie sessions, remembered accounts, numeric ids, and other tenants are excluded. Mount this row only in presets whose relationship model requires user identity; ordinary coding presets do not need it.

## Model Experience

### Active account profile

#### What the model sees

When an active managed profile exists, the model receives a dynamic runtime-context section containing `displayName`, `username`, `bio`, and an optional `avatarPath` as JSON. The path is evidence location, not visual evidence: the model must inspect it with `read_image` before describing or comparing the avatar. With no active profile, the section is absent.

#### Token effect

Conditional and bounded by the local-auth profile limits: fixed wrapper text plus at most 80 display-name characters, 32 username characters, 2,000 biography characters, and one short local path on each request snapshot. Image bytes enter only a requested tool result.

#### KV Cache effect

The runtime context is materialized as a sourced user-role snapshot. An unchanged profile is prefix-stable within the retained history; editing the profile changes the next snapshot without rewriting earlier events.

## Known Limitations and Deferred Work

- **Managed desktop tenant only** — an unmanaged browser session has request-local cookie identity that is not propagated into Agent assembly, so this plugin contributes nothing there.
