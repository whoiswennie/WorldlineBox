# Cordis Plugin Model

English | [中文](cordis-primer.zh.md)

## Five basic concepts

### Context is a service and lifecycle view

Plugins use declared services through `ctx.<key>`. Context also carries the current Fiber, scope, and effect ownership, so an arbitrary Context must not be retained in a global variable beyond its lifecycle.

### Service defines stable capability

A Service subclass declares its Context key during construction. An abstract Service defines capability only; a concrete Provider extends or implements it. Consumers import the definition package, not a local, remote, or desktop Provider.

### inject expresses dependency topology

<a id="loader-configuration"></a>

`inject` is a plugin activation condition, not a documentation annotation. A plugin waits while required services are missing; optional services are read with `ctx.get(key)` at the point of use. Never replace dependency declarations with load order or timers.

### Events are composable extension points

<a id="dispatch-modes"></a>

<a id="cordis-waterfall-semantics"></a>

- `emit`: synchronous observation with no result.
- `waterfall`: middleware chain; cooperative listeners must call `next()`.
- `parallel`: await all listeners concurrently.
- `serial`: await listeners in order for deterministic shutdown or commit procedures.

Event names and payloads are declared through TypeScript declaration merging. Durable facts use Session Events; real-time coordination uses Agent or capability events.

### Effects make contributions reversible

File watchers, routes, tools, Prompt sections, Providers, Slots, and event listeners must be bound to a Fiber. For example:

```ts
declare const ctx: {
  effect(setup: () => () => void, label: string): void
  on(name: string, listener: () => void): void
}
declare const registry: { register(value: unknown): () => void }
declare const value: unknown
declare const listener: () => void

ctx.effect(() => registry.register(value), 'package: contribution')
ctx.on('domain/event', listener)
```

When a registry creates an effect from the caller Context internally, its `register()` may be called directly. The registry contract and unload tests must prove that lifecycle behavior.

## Two plugin forms

A function plugin exports `name`, `inject`, `Config`, and `apply` without a default export. A Service plugin default-exports the Service class. Mixing the forms prevents Loader from reliably distinguishing plugin metadata from implementation.

## Fiber state

A Fiber progresses through dependency waiting, loading, activation, unloading, and disposal. Initialization failure must roll back created effects; unload must await asynchronous disposers; canceled work must not publish state after Fiber disposal.

Worldline keeps `FiberState` as a runtime enum so independently built Loader, desktop, and plugin packages can inspect state across package boundaries. The current vendor contract is recorded in [`vendor/README.md`](../vendor/README.md).

## Scope and Agent Preset

Process-level services live in the Host Context. Session- or Agent-specific Tool, Prompt, and Provider contributions are installed into an Agent scope. A private orchestration chain restores the Agent from its initiator scope and then captures its Session explicitly; it must not depend on an implicit global “current session.”
