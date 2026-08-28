# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The worldline browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`worldline-base`](../base/README.md): it sets the coding persona, inserts the Web host rows (webserver, API gateway, workspace, projection cache, storage) and the browser plugin roster, the development-gated client-plugin reload chain ([`worldline-client-hmr`](../../client/hmr/README.md)), and mounts this package's `web-runtime` glue plugin (config `{printUrl, surfaceContext, trustedHosts, dev}`). That plugin resolves the built frontend dist through `@deepseek-ai/dsh-web-frontend`'s exports, samples bind-dependent LAN trust once, provides it as `webRuntime` to the browser-trust fence and client roster, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, registers the runtime-source and web-surface prompt sections plus the bash-visible `WORLDLINE_WEB_URL` and `WORLDLINE_WEB_MODE` runtime variables when `surfaceContext` is true, and prints the `worldline web:` URL line when `printUrl` is true, after its Loader tree settles so a sibling failure cannot announce a dead app. This bundle also owns the app command line: the ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`worldline-cmdline`](../../boot/cmdline/README.md)), parses `--host`, `--port`, repeatable `--trusted-host`, `--dev`, and the app's `--help`, then provides `webStartup`. It rejects `--host 0.0.0.0` before publishing that service because the CLI intentionally does not support all-interfaces binding yet. Flag-configured rows inject the service and read it directly from lazy config, so nothing binds a port before argument resolution and `worldline --profile web --help` starts no server. [`worldline-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## Model Experience

### Runtime-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `runtime:source` section identifies the on-disk Worldline runtime implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the production/development update contract, and the instruction not to start replacement servers. `WORLDLINE_WEB_URL` and `WORLDLINE_WEB_MODE` additionally appear in the managed bash environment with their descriptions, resolved per invocation from the live server. Production mode disables HMR; `--dev` enables its receiver, while no-refresh client-plugin reload also requires the `pnpm run dev:web` watcher. When `surfaceContext` is false, neither section nor either variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus four managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence.
- **Only handoff startup is observable** — observation ends when the platform opener accepts spawn, except that Windows waits for its short-lived PowerShell launcher to exit; a later browser exit is not reported, and the printed URL remains the manual fallback.
- **SSH forwarding owns the browser URL** — the printed canonical URL names the remote host's loopback endpoint; automatic handoff is suppressed, and the SSH client or editor must expose and open its local forwarded address.
- **Browser command overrides are launch-only** — a discovered `.env` may not set `BROWSER`; only an inherited value may reach an opener path that honors the variable, so a checkout cannot choose an executable for automatic handoff.
