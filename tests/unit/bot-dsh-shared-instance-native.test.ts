import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshAbortAcknowledgedError, BotDshBrain, BotDshDeliveryUnknownError, BotDshPauseAcknowledgedError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { preserveBotNativeJournals } from '../fixtures/bot-native-journal-evidence';

type Key = 'fish-one' | 'fish-two' | 'claude-one' | 'claude-two';
type Wire = { messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>; tools?: Array<{ function: { name: string } }> };
type Workspace = { id: string; path: string; title: string; sessionIds: string[] };
type JournalRecord = { type: string; id?: string; cwd?: string; data?: { cwd?: string; title?: string } };
const textOf = (content: Wire['messages'][number]['content']) => typeof content === 'string' ? content : (content ?? []).map(item => item.text ?? '').join('\n');
const keys: Key[] = ['fish-one', 'fish-two', 'claude-one', 'claude-two'];

/** Genuine installed DSH, one cold profile/Host, real write tools and Session
 * journals. The model transport alone is a deterministic localhost driver.
 * Working directories establish task defaults, not an OS security boundary. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('runs two companions on one native Host, isolates task controls and restores interrupted Sessions without duplicating work', async () => {
  const requests: Array<{ key: Key; wire: Wire }> = [], held = new Map<Key, ServerResponse[]>(), allowed = new Set<Key>(), callbackNames: string[] = [];
  const errors: unknown[] = [], hostPids = new Set<number>(), startups: string[] = [];
  const callbackToken = '9'.repeat(64), fixtureKey = 'shared-local-no-billing';
  const send = (response: ServerResponse, delta: object, finish: 'stop' | 'tool_calls') => {
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  };
  const write = (key: Key, response: ServerResponse) => send(response, { tool_calls: [{ index: 0, id: 'shared-write-' + randomUUID(), type: 'function',
    function: { name: 'write', arguments: JSON.stringify({ file_path: 'same-name.txt', content: `Independent deliverable ${key}` }) } }] }, 'tool_calls');
  const release = (key: Key) => { allowed.add(key); for (const response of held.get(key) ?? []) if (!response.destroyed && !response.writableEnded) write(key, response); };
  const waitFor = async (condition: () => boolean, label: string) => {
    const deadline = Date.now() + 45000;
    while (!condition()) {
      if (errors.length) throw errors[0];
      if (Date.now() > deadline) throw Error(`Native shared Host fixture timed out: ${label}; requests=${requests.map(value => value.key).join(',')}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      if (request.url === '/bot/tool') {
        expect(request.headers.authorization).toBe('Bearer ' + callbackToken);
        expect(['worker_effect_start', 'worker_effect_commit']).toContain(input.name); callbackNames.push(input.name);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
          result: input.name === 'worker_effect_start' ? { state: 'admitted', callId: input.callId } : { recorded: true } })); return;
      }
      expect(request.headers.authorization).toBe('Bearer ' + fixtureKey);
      const wire = input as Wire, userTexts = wire.messages.filter(message => message.role === 'user').map(message => textOf(message.content));
      const key = keys.find(value => userTexts.includes('SHARED_NATIVE_INPUT=' + value));
      if (!key) throw Error('Native input has no fixture task identity');
      // Sharing account/plugin state must not concatenate another task's history.
      for (const other of keys.filter(value => value !== key)) expect(JSON.stringify(wire.messages)).not.toContain('SHARED_NATIVE_INPUT=' + other);
      expect(userTexts.filter(value => value === 'SHARED_NATIVE_INPUT=' + key)).toHaveLength(1);
      requests.push({ key, wire });
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      if (wire.messages.some(message => message.role === 'tool')) send(response, { content: `DELIVERED_${key}` }, 'stop');
      else if (allowed.has(key)) write(key, response);
      else held.set(key, [...held.get(key) ?? [], response]);
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No shared native fixture port');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!, { onStartup: progress => { startups.push(progress.phase); } });
  const output = path.resolve('artifacts/superagent-bot-development/shared-instance-native', path.basename(native.root));
  await mkdir(output, { recursive: true });
  const brain = new BotDshBrain({ getHost: async (id, signal) => {
    expect(id).toBe(native.instance.id);
    const client = await native.instances.ensureHost(native.instance.id, signal, { automatic: true }); hostPids.add(client.pid);
    return { client, instance: native.instance };
  }, acquireLease: () => native.instances.acquireCompanionLease(native.instance.id, 'task') });
  const input = (key: Key): BotDshRun => {
    const companion = key.startsWith('fish-') ? '大肥鱼' : 'Claude', parent = path.join(native.root, 'companions', companion);
    return { role: 'worker', instanceId: native.instance.id, workerAccess: 'scoped', laneId: 'worker-shared-' + key, eventId: 'event-shared-' + key,
      cwd: path.join(parent, key), workspaceParent: { path: parent, title: companion }, workspaceTitle: companion, sessionTitle: `任务 ${key}`,
      system: 'Write only the authorized task deliverable, then return its result.', prompt: 'SHARED_NATIVE_INPUT=' + key, tools: [],
      callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: callbackToken },
      model: { apiFormat: 'openai_chat', model: 'local-shared-native-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: fixtureKey,
        contextWindow: 32768, maxTokens: 512 } };
  };
  const inputs = new Map(keys.map(key => [key, input(key)])), controllers = new Map(keys.map(key => [key, new AbortController()]));
  const pending: Array<Promise<unknown>> = [], launch = (key: Key, signal?: AbortSignal) => {
    const promise = brain.run({ ...inputs.get(key)!, ...(signal ? { signal } : {}) }).catch(error => error); pending.push(promise); return promise;
  };
  try {
    expect(native.instances.list()).toHaveLength(1);
    const jobs = new Map(keys.map(key => [key, launch(key, controllers.get(key)!.signal)]));
    await waitFor(() => keys.every(key => (held.get(key)?.length ?? 0) === 1), 'four concurrent inferences');
    expect(hostPids.size).toBe(1); expect(startups.filter(phase => phase === 'starting-host')).toHaveLength(1);
    let client = await native.instances.ensureHost(native.instance.id, undefined, { automatic: true });
    const originalPid = client.pid;
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(4);
    controllers.get('fish-one')!.abort(Object.assign(new Error('Pause only fish task one'), { code: 'BOT_SUSPEND' }));
    expect(await jobs.get('fish-one')).toBeInstanceOf(BotDshPauseAcknowledgedError);
    controllers.get('fish-two')!.abort(new Error('Stop only fish task two'));
    const cancelled = await jobs.get('fish-two'); expect(cancelled).toBeInstanceOf(BotDshAbortAcknowledgedError);
    expect(cancelled.result).toMatchObject({ status: 'cancelled', eventId: inputs.get('fish-two')!.eventId });
    // Other companion's two requests remain open and the shared process survives.
    expect(held.get('claude-one')![0]!.destroyed).toBe(false); expect(held.get('claude-two')![0]!.destroyed).toBe(false);
    expect((await native.instances.ensureHost(native.instance.id)).pid).toBe(originalPid);
    release('claude-one');
    const completed = await jobs.get('claude-one'); expect(completed).toMatchObject({ status: 'succeeded', text: 'DELIVERED_claude-one' });
    expect(await readFile(path.join(inputs.get('claude-one')!.cwd, 'same-name.txt'), 'utf8')).toBe('Independent deliverable claude-one');
    const resumed = launch('fish-one');
    await waitFor(() => (held.get('fish-one')?.length ?? 0) === 2, 'paused task resumed beside another companion');
    const beforeCrash = requests.length;
    // Crash only the pid created in this fixture, while both companions are busy.
    process.kill(originalPid, 'SIGKILL');
    expect(await resumed).toBeInstanceOf(BotDshDeliveryUnknownError);
    expect(await jobs.get('claude-two')).toBeInstanceOf(BotDshDeliveryUnknownError);
    await native.instances.stop(native.instance.id).catch(() => undefined);
    client = await native.instances.ensureHost(native.instance.id); expect(client.pid).not.toBe(originalPid);
    release('fish-one'); release('claude-two');
    const recovered = await Promise.all([launch('fish-one'), launch('claude-two')]);
    expect(recovered).toMatchObject([{ status: 'succeeded', text: 'DELIVERED_fish-one' }, { status: 'succeeded', text: 'DELIVERED_claude-two' }]);
    expect(hostPids.size).toBe(2); expect(startups.filter(phase => phase === 'starting-host')).toHaveLength(2);
    for (const key of ['fish-one', 'claude-two'] as const) {
      expect(await readFile(path.join(inputs.get(key)!.cwd, 'same-name.txt'), 'utf8')).toBe(`Independent deliverable ${key}`);
    }
    await expect(readFile(path.join(inputs.get('fish-two')!.cwd, 'same-name.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const workspaces = await Promise.all(keys.map(key => client.request<{ workspace: Workspace }>('/bot/lanes', { ...inputs.get(key), sessionId: BotDshBrain.sessionId(inputs.get(key)!.laneId) })));
    expect(workspaces[0]!.workspace.id).toBe(workspaces[1]!.workspace.id);
    expect(workspaces[2]!.workspace.id).toBe(workspaces[3]!.workspace.id);
    expect(workspaces[0]!.workspace.id).not.toBe(workspaces[2]!.workspace.id);
    expect(workspaces[0]!.workspace.path).toBe(path.dirname(inputs.get('fish-one')!.cwd));
    expect(workspaces[2]!.workspace.path).toBe(path.dirname(inputs.get('claude-one')!.cwd));
    expect(workspaces[0]!.workspace.sessionIds.sort()).toEqual(['fish-one', 'fish-two'].map(key => BotDshBrain.sessionId(inputs.get(key as Key)!.laneId)).sort());
    expect(workspaces[2]!.workspace.sessionIds.sort()).toEqual(['claude-one', 'claude-two'].map(key => BotDshBrain.sessionId(inputs.get(key as Key)!.laneId)).sort());
    const beforeReceipts = requests.length;
    expect(await Promise.all([brain.run(inputs.get('fish-one')!), brain.run(inputs.get('claude-two')!)])).toEqual(recovered);
    expect(await brain.run(inputs.get('claude-one')!)).toEqual(completed);
    expect((await brain.cancelDurable(inputs.get('fish-two')!)).result).toEqual(cancelled.result);
    expect(requests).toHaveLength(beforeReceipts);
    expect(callbackNames.filter(name => name === 'worker_effect_start')).toHaveLength(3);
    expect(callbackNames.filter(name => name === 'worker_effect_commit')).toHaveLength(3);
    expect(errors).toEqual([]);
    await brain.close(); await native.instances.stop(native.instance.id);
    await preserveBotNativeJournals(native.root, path.join(output, 'journals.json'), value => value.replaceAll(callbackToken, '<fixture-token>').replaceAll(fixtureKey, '<fixture-key>'));
    const journals = JSON.parse(await readFile(path.join(output, 'journals.json'), 'utf8')) as Array<{ records: JournalRecord[] }>;
    for (const key of keys) {
      const task = inputs.get(key)!, journal = journals.find(value => value.records[0]?.id === BotDshBrain.sessionId(task.laneId));
      expect(journal).toBeDefined(); expect(journal!.records[0]?.cwd).toBe(path.dirname(task.cwd));
      expect(journal!.records.filter(record => record.type === 'working-directory/change').at(-1)?.data?.cwd).toBe(task.cwd);
    }
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), runtimeVersion: native.runtimeVersion,
      actualNativeHost: true, actualModelInference: false, productionProfileReadOrWritten: false, paidProviderRequests: 0,
      profilesCreated: native.instances.list().length, companions: 2, initialConcurrentWorkers: 4, coldStarts: hostPids.size,
      taskPauseAndCancelLeaveOtherCompanionRunning: true, independentWorkspacesAndRealWrites: true,
      interruptedCompanionsRestored: 2, providerRequests: requests.length, requestsAfterCrash: requests.length - beforeCrash,
      originalInputInsertedOncePerRequest: true, completedReceiptReadsMadeNoModelRequest: true,
      duplicateEffectExecutionsAfterRecovery: 0, effectiveTaskDirectoriesVerifiedInNativeJournals: true }, null, 2) + '\n');
  } finally {
    for (const controller of controllers.values()) controller.abort(new Error('Fixture teardown'));
    server.closeAllConnections(); await brain.close().catch(() => undefined); await Promise.allSettled(pending); await native.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 180000);

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('installs a native plugin once and exposes the same live capability to both companions without per-companion setup', async () => {
  const wires: Array<{ tools: string[]; input: string }> = [], errors: unknown[] = [], native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const output = path.resolve('artifacts/superagent-bot-development/shared-plugin-native', path.basename(native.root));
  await mkdir(output, { recursive: true });
  const token = '8'.repeat(64);
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      if (request.url === '/bot/tool') {
        expect(request.headers.authorization).toBe('Bearer ' + token);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
          result: body.name === 'worker_effect_start' ? { state: 'admitted', callId: body.callId } : { recorded: true } })); return;
      }
      const wire = body as Wire, texts = wire.messages.filter(message => message.role === 'user').map(message => textOf(message.content));
      const input = texts.find(value => value.startsWith('SHARED_PLUGIN_TEXT=')); if (!input) throw Error('No authorized plugin fixture input');
      const tool = wire.messages.findLast(message => message.role === 'tool'), tools = wire.tools?.map(value => value.function.name) ?? [];
      expect(tools).toContain('demo_text_statistics'); wires.push({ input, tools });
      const delta = tool ? { content: 'NATIVE_PLUGIN_RESULT=' + textOf(tool.content) } : { tool_calls: [{ index: 0, id: 'shared-plugin-' + randomUUID(), type: 'function',
        function: { name: 'demo_text_statistics', arguments: JSON.stringify({ text: input.slice('SHARED_PLUGIN_TEXT='.length) }) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No shared plugin fixture listener');
  let client = await native.instances.ensureHost(native.instance.id);
  const originalPid = client.pid, brain = new BotDshBrain({ getHost: async () => ({ client, instance: native.instance }) });
  type Capability = { catalog: { items: Array<{ name: string }> }; effective: { digest: string } };
  const catalog = (cwd: string) => client.request<Capability>('/capabilities', { sessionId: 'shared-native-discovery', cwd, companion: true,
    query: { kind: 'catalog', category: 'tool', query: 'demo_text_statistics', limit: 10 } });
  const inputs = ['大肥鱼', 'Claude'].map((companion, index): BotDshRun => ({ role: 'worker', workerAccess: 'full', instanceId: native.instance.id,
    laneId: 'shared-plugin-worker-' + index, eventId: 'shared-plugin-event-' + index, cwd: path.join(native.root, 'companions', companion, 'plugin-task'),
    workspaceParent: { path: path.join(native.root, 'companions', companion), title: companion }, workspaceTitle: companion, sessionTitle: '共享插件分析',
    system: 'Use the actual native text statistics tool, then return its exact rendered result.', prompt: 'SHARED_PLUGIN_TEXT=' + (index ? 'Claude shared plugin' : '大肥鱼 共享 插件'), tools: [],
    model: { apiFormat: 'openai_chat', model: 'local-shared-plugin-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-no-billing' },
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token } }));
  try {
    expect((await catalog(inputs[0]!.cwd)).catalog.items).toEqual([]);
    // The plugin is installed by DSH's native manager once in this shared profile.
    const installed = await client.request<{ application: string }>('/plugins', { action: 'add',
      spec: 'file:' + path.resolve('resources/dsh-demo-plugins/text-statistics').replaceAll('\\', '/') }, undefined, 120000);
    expect(installed.application).toBe('applied');
    const plugins = await client.request<Array<{ name: string; installed: boolean; enabled: boolean }>>('/plugins', { action: 'list' });
    expect(plugins.filter(value => value.name === '@worldlinebox-demo/text-statistics')).toEqual([expect.objectContaining({ installed: true, enabled: true })]);
    const catalogs = await Promise.all(inputs.map(input => catalog(input.cwd)));
    for (const value of catalogs) expect(value.catalog.items).toEqual([expect.objectContaining({ name: 'demo_text_statistics' })]);
    expect(catalogs[0]!.effective.digest).toBe(catalogs[1]!.effective.digest);
    const results = await Promise.all(inputs.map(input => brain.run(input)));
    for (const result of results) expect(result).toMatchObject({ status: 'succeeded', text: expect.stringContaining('"words":3') });
    expect(results[0]!.sessionId).not.toBe(results[1]!.sessionId); expect(wires).toHaveLength(4);
    expect((await native.instances.ensureHost(native.instance.id)).pid).toBe(originalPid);
    await brain.close(); await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    for (const value of await Promise.all(inputs.map(input => catalog(input.cwd)))) expect(value.catalog.items).toEqual([expect.objectContaining({ name: 'demo_text_statistics' })]);
    expect(await Promise.all(inputs.map(input => brain.run(input)))).toEqual(results); expect(wires).toHaveLength(4); expect(errors).toEqual([]);
    await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), runtimeVersion: native.runtimeVersion,
      actualNativeHost: true, actualModelInference: false, paidProviderRequests: 0, productionProfileReadOrWritten: false,
      nativePluginInstalls: 1, profilesCreated: native.instances.list().length, companionsUsed: 2, sameCapabilityRevision: true,
      sameSharedProcessDuringExecution: true, separateTaskSessions: true, pluginRetainedAcrossHostRestart: true,
      receiptReplayModelRequests: 0, nativeToolExecutions: 2, providerRequests: wires.length }, null, 2) + '\n');
  } finally {
    await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 180000);
