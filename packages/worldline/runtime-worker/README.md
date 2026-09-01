# Worldline runtime worker

English | [中文](README.zh.md)

This package supervises isolated worker threads that run the deterministic discrete-event Worldline kernel and own one Run database each.

## Contract

The Host supervisor applies memory and request-time bounds, maps worker failures to explicit runtime errors, removes failed handles, and can reopen durable logical Runs. Workers serialize commands, validate every state transition, and commit state with its records before publishing results.

## Model Experience

Indirectly, through runtime, Worldline tool, and narrative consumers that read worker-produced state.

#### KV Cache effect

Workers send no model request; later consumers select bounded snapshots and records independently.

## Known Limitations and Deferred Work

- **One thread per open Run** — very large concurrent libraries are bounded by Host resource policy and should close inactive handles instead of retaining every Run worker.
