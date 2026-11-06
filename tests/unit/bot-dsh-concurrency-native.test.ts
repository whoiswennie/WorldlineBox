import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

/** Real DSH Agents and HTTP streams, with a local scripted model gate.
 * This measures concurrent admission and cache behavior, not model quality. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('starts one cold Host for 17 concurrent Workers and retains the 16-lane idle cache target', async () => {
  const held: ServerResponse[] = [], seenPids = new Set<number>(); let released = false, calls = 0;
  const complete = (response: ServerResponse) => {
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'NATIVE_CONCURRENCY_DONE' }, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; }
    if (request.url === '/bot/tool') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { recorded: true } })); return; }
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
    if (released) complete(response); else held.push(response);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No local concurrency model listener');
  const startup: string[] = [], native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!, { onStartup: progress => { startup.push(progress.phase); } });
  const brain = new BotDshBrain({
    getHost: async (_id, signal) => { const client = await native.instances.ensureHost(native.instance.id, signal, { automatic: true }); seenPids.add(client.pid); return { client, instance: native.instance }; },
    acquireLease: () => native.instances.acquireCompanionLease(native.instance.id, 'task'),
  });
  const base = { role: 'worker' as const, workerAccess: 'full' as const, system: 'Return the short final answer. No tools or external actions.', tools: [],
    model: { apiFormat: 'openai_chat' as const, model: 'local-concurrency-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-no-billing', contextWindow: 32768, maxTokens: 128 },
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'a'.repeat(64) } };
  let runs: Array<Promise<Awaited<ReturnType<BotDshBrain['run']>>>> = [];
  try {
    expect(native.instances.get(native.instance.id).status).toBe('stopped');
    runs = Array.from({ length: 17 }, (_, index) => brain.run({ ...base, laneId: `concurrent-worker-${index}`, eventId: `concurrent-event-${index}`,
      cwd: path.join(native.root, 'workers', String(index)), prompt: `CONCURRENCY_INPUT_${index}` }));
    const outcomes = Promise.all(runs); void outcomes.catch(() => undefined);
    const gate = (async () => { const end = Date.now() + 100000; while (held.length !== 17) { if (Date.now() > end) throw Error(`Only ${held.length} of 17 native Workers reached the model gate`); await new Promise(resolve => setTimeout(resolve, 20)); } })();
    await Promise.race([gate, outcomes.then(() => { throw Error('Workers completed before their model gate was released'); })]);
    const client = await native.instances.ensureHost(native.instance.id, undefined, { automatic: true });
    const active = await client.request<{ botLanes: number }>('/health'); expect(active.botLanes).toBe(17); expect(calls).toBe(17); expect(seenPids.size).toBe(1);
    expect(startup.filter(phase => phase === 'starting-host')).toHaveLength(1);
    const duplicate = { ...base, sessionId: BotDshBrain.sessionId('same-concurrent-opening'), laneId: 'same-concurrent-opening', eventId: 'same-opening-event', cwd: path.join(native.root, 'duplicate-opening') };
    const copies = await Promise.all([client.request<{ sessionId: string }>('/bot/lanes', duplicate), client.request<{ sessionId: string }>('/bot/lanes', duplicate)]);
    expect(copies[0]?.sessionId).toBe(copies[1]?.sessionId); expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(18);
    released = true; for (const response of held) complete(response);
    const results = await outcomes; expect(results.every(result => result.status === 'succeeded' && result.text === 'NATIVE_CONCURRENCY_DONE')).toBe(true);
    expect((await brain.run({ ...base, laneId: 'after-concurrent-cache-trim', eventId: 'cache-trim-event', cwd: path.join(native.root, 'trim'), prompt: 'CACHE_TRIM' })).status).toBe('succeeded');
    const after = await client.request<{ botLanes: number }>('/health'); expect(after.botLanes).toBeLessThanOrEqual(16);
    const output = path.resolve('artifacts/superagent-bot-development/native-worker-concurrency.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ at: new Date().toISOString(), version: native.runtimeVersion, actualNativeHost: true, paidModelCalls: 0,
      concurrentWorkersAtGate: held.length, residentLanesAtGate: active.botLanes, workerHostProcesses: seenPids.size,
      coldStartupCount: startup.filter(phase => phase === 'starting-host').length, duplicateOpeningCopies: copies.length,
      duplicateOpeningNativeSessions: 1, completedWorkers: results.length, idleResidentLanesAfterNextAdmission: after.botLanes, providerRequests: calls }, null, 2));
  } finally {
    released = true; for (const response of held) if (!response.writableEnded) complete(response);
    await Promise.allSettled(runs); await brain.close(); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 180000);
