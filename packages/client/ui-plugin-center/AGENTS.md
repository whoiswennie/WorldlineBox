# AGENTS.md — Plugin Center client

- Treat Codex Desktop as the visual and interaction reference for the currently selected Feature, not as authorization to copy its complete Plugin Center.
- Render only behavior backed by the current Feature's implemented contracts and an explicit frontend handoff. `planned` or `proposed` Feature documents do not authorize controls, counts, catalog entries, menus, placeholders, or mutation states.
- At each handoff, read the owning Feature spec/tasks and the live Desktop bridge, then reproduce only the matching Codex journey. Extend the UI additively when the next backend Feature is handed off; do not prebuild later Feature surfaces.
- This directory's UI lane owns frontend presentation and interaction polish only. Consume the backend contract handed off by the full-chain development lane; do not change backend contracts, Desktop bridge behavior, catalog authority, or lifecycle implementation from a UI task.
- After a UI change, verify only the directly affected client interactions and rendered states. End-to-end package mutation, native bridge triggering, and full-chain acceptance remain with the full-chain development lane.
- Preserve the existing Settings configuration and runtime-inventory journeys. A Plugin Center change may link to those owners but must not replace, hide, or duplicate them.
