# Profiles, Bundles, and Configuration Composition

English | [中文](profiles-and-bundles.zh.md)

## Composition order

The final plugin tree starts empty and applies layers in this order:

1. the inherited `@deepseek-ai/dsh-base` Bundle;
2. a modality Bundle such as `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`, `@deepseek-ai/dsh-sdk-app`, or `@deepseek-ai/dsh-acp-app`;
3. the Profile's own `cordis.patch.yml`;
4. the Worldline Home patch;
5. command-line `--patch` overlays.

Later layers may replace existing-row configuration, disable a row, or insert a new row. Worldline's Include extension also accepts `removed: true`, which lets the plugin center persistently remove a local extension row.

## Bundle responsibilities

- `bundle/base` selects services, Providers, tools, and policies shared across modalities.
- `bundle/web-app` adds the Web Host, Client graph, authentication, plugin center, and desktop-browser capability.
- `bundle/headless` omits Web/HMR and adds the one-shot task entry point.
- `bundle/sdk-app` and `bundle/sdk-minimal` expose the stdio JSON-RPC SDK surface through the named `sdk` and `sdk-minimal` profiles.
- `bundle/acp-app` exposes the ACP v1 automation surface through the named `acp` profile.

Bundles own deployment selection only. Service implementations remain independent packages, and user patches can replace any Provider.

## Agent Presets

An Agent Preset is a session-scoped Cordis composition. The current presets are `standard`, `ptc`, `cordis`, `minimal`, and `virtual-companion`. A preset selects model-visible Tools, Prompt, Skills, and delegation capabilities; process-scoped Session, Jobs, Goals, and Subagents registries remain on the Host plane. The virtual-companion preset is relationship-first: an invisible coordinator routes one or more room members from the account-scoped companion directory, while an opt-in public account-profile context and Web lookup remain available without workspace or coding tools.

## Technical coordinates

All Harness and Worldline-specific packages use Harness 0.1.2-alpha.1-compatible `@deepseek-ai/dsh-*` technical coordinates and the `dsh.bundle`, `dsh.client`, and `dsh.profile` manifest protocols. The runtime does not maintain a second package alias layer. These internal coordinates do not change the Worldline runtime name, CLI, home directory, or UI brand.
