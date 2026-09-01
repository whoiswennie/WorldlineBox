# Worldline runtime service

English | [中文](README.zh.md)

This package defines the Host-facing Run lifecycle, control, observation, checkpoint, branching, replay, and intervention service.

## Contract

Every Run is created from a frozen Blueprint and advances through validated actions and deterministic event ordering. The service separates authoritative state from AI intents, invocation telemetry, observations, and narrative beats while preserving all records for explanation and replay.

## Model Experience

Indirectly, through Worldline tools and narrative consumers that render bounded Run views and records.

#### KV Cache effect

The service sends no model request; consumers own context selection and stable-prefix reuse.

## Known Limitations and Deferred Work

- **Logical-time simulation** — wall-clock and multiplayer networking are not authoritative inputs; external real-time systems require an adapter that submits validated actions.
