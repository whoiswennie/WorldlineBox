# Defensive Lifecycle Patterns

English | [中文](defensive-patterns.zh.md)

## Initialization transactions

When a plugin initializes multiple resources, use one effect or an explicit transaction: roll back in reverse creation order and publish ready state only after every step succeeds. Initialization failure must not leave routes, listeners, processes, or registry entries behind.

## Cancellation and timeouts

- Caller cancellation, policy timeout, and Fiber unload are distinct sources that must converge on one idempotent termination.
- A timeout covers the complete operation, not only the first I/O segment.
- Cleanup has its own bound and must not wait forever for an uncooperative subprocess.
- After timeout, publish the timeout result and never publish a later success.

## Publication commit point

Complete persistence or state mutation before emitting events and updating caches. A failed operation must not produce UI, logs, or Telemetry that look successful.

## Resource ownership

- The Fiber that creates a resource owns its disposal.
- A Registry contribution must be reversible, with coverage for unloading the contributing plugin alone.
- Background tasks, Watchers, PTYs, Workers, and Child Processes participate in quiescence.
- Process exit is not a substitute for a disposer.

## Filesystem

Resolve and validate the final absolute path before writing, moving, or deleting. Symlink and case rules belong to the Provider. An atomic write uses a temporary file in the same directory and a commit point, then cleans the temporary file on failure.

## Cross-boundary input

Validate at configuration, filesystem, JSON, model-tool, Remote, Worker, and process boundaries. Do not repeat hostile validation for values already guaranteed by TypeScript within one process.
