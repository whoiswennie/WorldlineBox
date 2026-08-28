# @deepseek-ai/dsh-app-boot

English | [中文](README.zh.md)

Shared Cordis Loader bootstrap, profile bundle composition, layered environment loading, and fail-loud configuration guards.

## Model Experience

Indirectly, through the plugin tree loaded for the selected profile.

#### KV Cache effect

Bootstrapping itself adds no request tokens; cache reuse depends on the prompts and tools contributed by the resolved plugin tree.

## Known Limitations and Deferred Work

- **Process-local boot** — one invocation resolves and starts one Loader tree; distributed configuration and cross-process coordination remain application responsibilities.
