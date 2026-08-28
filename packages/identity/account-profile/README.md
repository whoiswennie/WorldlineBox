# Account Profile

English | [中文](README.zh.md)

Service definition for the browser-safe profile of the active account tenant. Providers expose a read-only `current()` snapshot; consumers cannot enumerate accounts, inspect sessions, or reach credentials through this capability.

## Model Experience

Indirectly, through an explicitly mounted consumer such as account-profile context; this definition registers no prompt or message content.

#### KV Cache effect

The type and service seam add no tokens and do not alter request prefixes.

## Known Limitations and Deferred Work

- **Current tenant only** — the capability deliberately has no account enumeration or request-cookie identity operation.
