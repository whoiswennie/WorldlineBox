# sandbox/ — process-sandbox capability family

English | [中文](README.zh.md)

This family applies per-session confinement policy to process execution. It covers same-world subprocesses; isolated environments replace complete capability implementations instead of registering here.

| Package | Role | ctx key |
|---|---|---|
| [`sandbox/`](sandbox/README.md) | Defines the process-sandbox service and shared escalation vocabulary | `ctx.sandbox` |
| [`sandbox-local/`](sandbox-local/README.md) | Provides local platform confinement backends | registers on `ctx.sandbox` |
| [`sandbox-policy/`](sandbox-policy/README.md) | Resolves durable per-session sandbox policy | `ctx.sandboxPolicy` |

See the sandbox decision for the capability boundary and the filesystem integration decision for cross-family policy use.

The subsystem reference — modes and enforcement, per-call policy, wrapped-argv dialects, fail-closed errors — is [docs/subsystems/sandbox.md](../../docs/subsystems/sandbox.md); the boundary and the cross-family phase live in the sandbox and cross-family fs sandbox contracts.
