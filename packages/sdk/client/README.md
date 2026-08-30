# @deepseek-ai/dsh-sdk-client

English | [中文](README.zh.md)

The TypeScript client SDK for driving a Worldline runtime as a subprocess over stdio JSON-RPC — the design twin of the [Python SDK](../../../python/README.md) (`worldline-fantasy-project`), sharing the same runtime peer, protocol, and layering: `DeepSeekHarness` is the high-level owned-run API, `HarnessClient` the lower-level protocol client. The package root enumerates the consumer interface: the two client layers, caller-facing types, and `JsonRpcResponseError`; source modules, normalization helpers, and subscription-delivery machinery are not consumer imports. A pure library: it registers nothing on a Cordis context; the runtime process it spawns is a complete harness whose composition its own `cordis.yml` decides.

The launch surface is profile-based. Callers may provide a `dshBin`, or omit it to resolve the same-version `@deepseek-ai/dsh` dependency; the client constructs `worldline --profile <name>` arguments and ordered `--patch` overlays. This keeps SDK, ACP, CLI, and packaged launches on the same application composition path without exposing raw `command`/`args` as a second runtime API.

## DeepSeekHarness

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

await using harness = new DeepSeekHarness({
  profile: 'sdk',
  patches: ['./automation.cordis.patch.yml'],
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('max'),
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)
```

The subprocess starts lazily on first use and stays owned by the instance across `run()` calls; `close()` (or `await using`) is required so the child is always reaped. `start()` memoizes a bounded `initialize` handshake (default 10 seconds) carrying the workspace cwd, provider/model route, optional adapter-owned `reasoningEffort`, and optional positive `maxTokens` output cap. The server validates the exact route before accepting prompts. A failed handshake reaps the runtime and swaps in a fresh client; if initialization and cleanup both fail, an ordered `AggregateError` preserves both causes and the failed client remains owned. The cap applies to each root-agent request and is inherited by in-process descendants; compaction plugins own their separate summary limits. `session(id?)` opens a named or fresh session handle.

`run(input, { sessionId?, onNotification? })` accepts text or `SdkPromptContentBlock[]`; inline raster image blocks are admitted into the runtime's durable attachment store. It owns one activity interval: it queues the prompt, waits until its `MessageId` appears in a durable `agent/inbox/spliced` receipt, then collects through the next whole-agent `idle`. It returns `RunResult { sessionId, finalResponse, events, notifications }`. `finalResponse` is the last committed root-session assistant text in that interval, not a response causally assigned to the prompt; steering, injected context, and other queued work may contribute before idle. `events` contains root-session events, while `notifications` also contains descendants discovered from `subagent.started`, all in wire order. The result carries no prompt-level status or turn reason. Transport loss, timeout, and protocol violations reject; model outcomes remain observable in the event stream without being attributed to one input.

## HarnessClient

The protocol client under the owned-run API: explicit `start()`/`initialize()`/`prompt()`/`request()`/`close()`, plus notification subscriptions. `prompt()` returns the queued message id as soon as the runtime accepts it; it never waits for agent activity. `subscribe(filter?)` returns a `NotificationSubscription` (awaitable `next()`, non-blocking `tryNext()`, async iteration); `subscribeSessionTree(id)` scopes to one session and the descendants discovered from `subagent.started` lineage edges — the runtime notifies for every session in its context, and scoping is client-side, exactly like the Python SDK. Error surfaces are typed and exported from this package: `JsonRpcResponseError` (wire error response, code/data preserved), `RequestTimeoutError` (a configured bound elapsed), `SdkProtocolError` (a response outside the documented protocol), `TransportClosedError` (the runtime is gone — message carries the exit code and a bounded stderr tail).

`close()` requests protocol `shutdown` (bounded by `shutdownTimeoutMs`, default 1000 ms), then walks a stdin-EOF → SIGTERM → SIGKILL ladder (`disposeEofGraceMs` default 6000, `disposeGraceMs` default 3000) until the process has actually exited. The ladder is private to this client: it runs outside any harness context, so it cannot ride the [`worldline-subprocess`](../../subprocess/README.md) service — the seam's documented exception for SDK-managed transports. It is idempotent, and a closed client refuses reuse.

`HarnessClientOptions.env` replaces the child environment entirely when given (`undefined` inherits the parent's); callers own credential policy — `scrubbedParentEnv` from `worldline-subprocess` is the shared scrub base for isolation-minded launches.

## Model Experience

None, as this is a client-process library; the model runs in the spawned runtime, whose experience is owned by the plugins its `cordis.yml` composes.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No mid-turn cancel** — the wire has no prompt-cancel method; abandoning a turn means closing the runtime (see the protocol's [Known Limitations](../protocol/README.md)).
- **No per-prompt result or cancel** — low-level `prompt()` returns only an enqueue receipt; high-level `run()` owns receipt-to-idle collection, and abandoning it means closing the runtime.
- **Client→server notifications and server→client requests are unimplemented** on both wire ends; the transport carries them for future approval flows.
