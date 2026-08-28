# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web shell kernel: `new AppWebEntry(el, seams?).run()` mounts the whole client through the two-stage boot (web2). Stage one (module face): build the client module system (`@deepseek-ai/dsh-client-modules`) over the host-pushed entry graph (`window.__WORLDLINE_BOOT__`) and prefetch the `immediately` tier in parallel — bundle execution registers factories only. Stage two (plugin face): mount the vendored cordis Loader with the module system injected through its `internal` contract, create one loader entry per graph row plus the shell-own app-shell assembly entry (tree.import materializes each module), and gate AppRoot on the settle (loader quiesced + every entry fiber ACTIVE → full UI in one switch). Composition is entirely the host graph's: the roster and the immediately tier live in the composing app; the shell makes zero composition decisions.

The boot page uses plain DOM and local CSS, so client-bundle and plugin-activation failures remain visible. Its fallback fonts and colors match the theme tokens that arrive during loading. Fiber updates retain one spinner node and grow its CSS arc as entries first become active; hydration preserves that node and its animation phase until the application commit. React mounting, slot rendering, application assembly, and browser-title projection live in [`ui-renderer`](../ui-renderer/README.md). The modules bundle caches its own materialized exports and provides the closed-over system when its ordinary graph entry activates; Cordis service waiting makes graph-row creation order independent from that activation.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shell-seeded shared modules. Together with `PRELOADED_CLIENT_EXTERNALS`, it defines the implicit external baseline for every dynamic bundle; `dsh.client.external` adds only exact non-baseline requests.

The optional override parameter `seams` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context; ordinary browser callers omit it.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The application waits for the full roster** — one failed entry keeps the framework-free boot page visible with a per-entry report; partial UI availability is not supported.
