# Worldline Standard

Portable WWS contracts shared by the project compiler, runtime worker, Host services, and Client.
It fixes identity, provenance, map, Blueprint, Action/Process, event-stream, memory, AI-budget,
Context Pack, narrative projection, certificate, checkpoint, and replay vocabulary without
hard-coding a genre. Runtime state remains authoritative only through validated Actions and
WorldEvents; diagnostic records cannot masquerade as world facts.

Limitations: WWS is currently an application-owned `0.1` format. Compatibility is guaranteed only
for explicitly versioned manifests and frozen Blueprints produced by this repository.
