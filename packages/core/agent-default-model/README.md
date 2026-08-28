# @deepseek-ai/dsh-agent-default-model

English | [中文](README.zh.md)

Default Provider, model, and reasoning-effort selection for future Agents. A dedicated Cordis Service owns the configuration and reads it live through the unified Settings Provider; Agent Loop does not hard-code a concrete model.

## Model Experience

Indirectly, through the provider, model, and optional reasoning effort selected for future Agent requests.

#### KV Cache effect

The service adds no tokens; changing the selection routes later requests to a potentially different provider cache namespace.

## Known Limitations and Deferred Work

- **Deferred availability check** — saved provider, model, and reasoning identifiers are validated by the selected adapter when a request is prepared, not by this settings service.
