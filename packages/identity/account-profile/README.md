# Account Profile

English | [中文](README.zh.md)

Host service definition for the active account tenant's profile. Providers expose a read-only `current()` snapshot; consumers cannot enumerate accounts, inspect sessions, or reach credentials through this capability. The snapshot keeps the browser presentation data and may also expose `avatarPath`, an active-tenant-only Host path materialized for trusted image tools. Browser APIs must never serialize that path.

## Model Experience

Indirectly, through an explicitly mounted consumer such as account-profile context; this definition registers no prompt or message content.

#### KV Cache effect

The type and service seam add no tokens and do not alter request prefixes.

## Known Limitations and Deferred Work

- **Current tenant only** — the capability deliberately has no account enumeration or request-cookie identity operation.
- **Host path only** — `avatarPath` is local runtime data, not a portable profile field or browser contract.
