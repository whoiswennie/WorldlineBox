# WorldlineBox Knowledge Base

English | [中文](README.zh.md)

This is the architecture source of truth for WorldlineBox. Code defines behavior; these documents define the responsibilities, dependency directions, lifecycles, and verification practices that packages must preserve.

## Reading order

1. [Architecture](architecture.md): runtime layers, core services, and dependency direction.
2. [Cordis plugin model](cordis-primer.md): Context, Service, inject, events, effects, and Fibers.
3. [Capability seams](capability-seams.md): complete Service Definition, Provider, and Consumer families.
4. [Profiles and bundles](profiles-and-bundles.md): how configuration composes applications instead of hard-coded entry points.
5. [Host/Client boundary](host-client-boundary.md): type and trust boundaries between Node/Electron and the browser.
6. [Session and turn lifecycle](session-turn-lifecycle.md): sources of model input, tool execution, and durable facts.
7. [Defensive lifecycle patterns](defensive-patterns.md): concurrency, cancellation, rollback, and resource-disposal rules.
8. [Testing and quality gates](testing-and-quality.md): evidence required to complete a Harness change.
9. [Worldlines, Su, and Huan](worldbuilding.md): the original creative foundation and its relationship to the technical architecture.

## Architecture invariants

- Every product capability is assembled as a Cordis plugin; application entry points only select compositions and manage process lifecycle.
- Extensions depend on Service Definitions, never concrete Providers; only Bundles may select implementations.
- Registrations belong to a Fiber through `ctx.effect()`, `ctx.on()`, or a registry already bound to the calling Context.
- Model-visible information is written to the Session Event Log and must be reconstructible from it.
- The Host owns filesystem, process, credential, and network authority; the Client reaches it only through generated Remotes and explicit events.
- Every package provides an `./invariant` companion entry or explicitly explains why it has no independent runtime relationship to validate.
- Configuration errors fail at the earliest decidable point and never silently degrade into another permission or Provider.
