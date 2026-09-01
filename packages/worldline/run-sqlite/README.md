# Worldline Run SQLite store

English | [中文](README.zh.md)

This package stores one Run's authoritative snapshot, ordered streams, checkpoints, and metadata in a single-writer SQLite database using write-ahead logging.

## Contract

One runtime worker owns the writable connection for its lifetime. Commits update the snapshot and append ordered records in one transaction; replay, checkpoint lookup, integrity checks, and read-only archive access preserve that sequence.

## Model Experience

Indirectly, through runtime and narrative consumers that select bounded Run records.

#### KV Cache effect

The database sends no model request; consumers decide which monotonic record prefix enters context.

## Known Limitations and Deferred Work

- **Single writer by design** — concurrent writable connections are outside the contract; scaling uses one database per logical Run rather than shared writers.
