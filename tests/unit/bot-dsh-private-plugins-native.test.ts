import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { preserveBotNativeJournals } from '../fixtures/bot-native-journal-evidence';
import { dshTaskCapabilityQuerySchema } from '../../src/shared/dsh-task-spec';

type Capability = { tools: Array<{ name: string }>; skills: unknown[]; effective: { digest: string; toolCount: number };
  scope?: { kind: string; revision: string; sourceRevision: string; pending: boolean; deferredActiveWorkers: number };
  catalog?: { items: Array<{ kind: string; name: string; description: string }>; total: number; nextOffset?: number };
  detail?: { tool?: { name: string; parameters: object } } };
type Demo = { profile: 'A' | 'B'; tool: string; args: Record<string, unknown>; hold?: boolean };
type Wire = { messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>; tools?: Array<{ function: { name: string } }> };
const messageText = (value: Wire['messages'][number]['content']) => typeof value === 'string' ? value : (value ?? []).map(block => block.text ?? '').join('\n');

/** Installed rc1, genuine native bundle manager and tool loop. Only the model
 * response transport is a deterministic localhost driver, with no billing. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('isolates native plugin catalogs and private notebook state, pages discovery, and hot updates without restarting the app', async () => {
  const a = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const b = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const output = path.resolve('artifacts/superagent-bot-development/private-native-plugins', path.basename(a.root)); await mkdir(output, { recursive: true });
  const checkpoint = (stage: string) => writeFile(path.join(output, 'stage.json'), JSON.stringify({ stage, roots: [a.root, b.root] }));
  const wires: Array<{ profile: string; tools: string[]; result?: string }> = [];
  let held = false, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (request.url === '/bot/tool') {
        if (request.headers.authorization !== 'Bearer ' + 'd'.repeat(64)) throw Error('Invalid demo callback credential');
        expect(['worker_effect_start', 'worker_effect_commit']).toContain(body.name);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
          result: body.name === 'worker_effect_start' ? { state: 'admitted', callId: body.callId } : { recorded: true } })); return;
      }
      const wire = body as Wire, lastUser = wire.messages.findLastIndex(message => message.role === 'user' && messageText(message.content).includes('DEMO_REQUEST='));
      const marker = messageText(wire.messages[lastUser]?.content).match(/DEMO_REQUEST=([^\n]+)/u);
      if (!marker) throw Error('Actual native model request lost the authorized demo input');
      const demo = JSON.parse(marker[1]!) as Demo;
      const tools = wire.tools?.map(tool => tool.function.name) ?? [], receipt = wire.messages.slice(lastUser + 1).findLast(message => message.role === 'tool');
      wires.push({ profile: demo.profile, tools, ...(receipt ? { result: messageText(receipt.content) } : {}) });
      expect(tools).toContain(demo.tool);
      if (demo.profile === 'B') expect(tools).not.toContain('demo_palette');
      if (demo.hold && receipt) { held = true; await hold; }
      const delta = receipt ? { content: 'DEMO_RESULT=' + messageText(receipt.content) } : { tool_calls: [{ index: 0, id: `call-${wires.length}`,
        type: 'function', function: { name: demo.tool, arguments: JSON.stringify(demo.args) } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: receipt ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No demo model port');
  const [clientA, clientB] = await Promise.all([a, b].map(native => native.instances.ensureHost(native.instance.id))).catch(async error => {
    await writeFile(path.join(output, 'startup-failure.json'), JSON.stringify({ error: String(error), logs: await Promise.all([a, b].map(async native => ({
      root: native.root, text: await readFile(path.join(native.instances.getRoot(native.instance.id), 'logs/host.log'), 'utf8').catch(() => '') }))) }, null, 2));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await Promise.all([a.close(), b.close()]); throw error;
  });
  if (!clientA || !clientB) throw Error('Two owned native Hosts are required.');
  const brainA = new BotDshBrain({ getHost: async () => ({ client: clientA }) }), brainB = new BotDshBrain({ getHost: async () => ({ client: clientB }) });
  const spec = (name: string) => 'file:' + path.resolve('resources/dsh-demo-plugins', name).replaceAll('\\', '/');
  const install = (client: typeof clientA, name: string) => client.request('/plugins', { action: 'add', spec: spec(name) }, undefined, 420000);
  const discover = (client: typeof clientA, cwd: string, query: object) => client.request<Capability>('/capabilities', { sessionId: 'demo-discovery', cwd, query, companion: true });
  let sequence = 0;
  const dispatched = new Map<string, BotDshRun>();
  const execute = (demo: Demo) => {
    const native = demo.profile === 'A' ? a : b, brain = demo.profile === 'A' ? brainA : brainB, id = `demo-${demo.profile}-${++sequence}`;
    const input: BotDshRun = { role: 'worker', workerAccess: 'full', laneId: `worker-${id}`, eventId: `event-${id}`, cwd: path.join(native.root, 'work', id),
      system: 'Execute exactly the authorized demo tool, then return its actual rendered result. No other file or network work.', prompt: 'DEMO_REQUEST=' + JSON.stringify(demo), tools: [],
      callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'd'.repeat(64) },
      model: { apiFormat: 'openai_chat', model: 'local-native-demo', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-no-billing' } };
    dispatched.set(id, input); return brain.run(input);
  };
  try {
    await checkpoint('installing');
    await Promise.all([install(clientA, 'palette'), b.instances.plugin(b.instance.id, 'add', spec('text-statistics'),
      { id: 'demo-launcher-install', signal: AbortSignal.timeout(420000), log: async () => undefined, update: async () => undefined })]);
    await Promise.all([install(clientA, 'notebook'), install(clientB, 'notebook')]);
    await checkpoint('installed-initial-bundles');
    const summaryA = await discover(clientA, a.instance.workspacePath, { kind: 'summary' });
    expect(summaryA.tools).toEqual([]); expect(summaryA.skills).toEqual([]); expect(summaryA.effective.toolCount).toBeGreaterThan(2);
    const catalog = async (client: typeof clientA, cwd: string) => {
      const names: string[] = []; let offset = 0;
      for (;;) {
        const page = await discover(client, cwd, { kind: 'catalog', category: 'tool', query: 'demo_', offset, limit: 1 });
        expect(page.tools).toEqual([]); expect(JSON.stringify(page.catalog)).not.toMatch(/parameters|inputSchema/u);
        expect(page.catalog!.items.length).toBeLessThanOrEqual(1); names.push(...page.catalog!.items.map(item => item.name));
        if (page.catalog!.nextOffset === undefined) return { names, digest: page.effective.digest };
        offset = page.catalog!.nextOffset;
      }
    };
    const initialA = await catalog(clientA, a.instance.workspacePath), initialB = await catalog(clientB, b.instance.workspacePath);
    expect(initialA.names.sort()).toEqual(['demo_notebook', 'demo_palette']); expect(initialB.names.sort()).toEqual(['demo_notebook', 'demo_text_statistics']);
    await checkpoint('initial-catalog-verified');
    const beforeUiOnly = await discover(clientA, a.instance.workspacePath, { kind: 'summary' });
    await install(clientA, 'ui-only');
    await checkpoint('ui-only-installed');
    const installed = await clientA.request('/plugins', { action: 'list' }, undefined, 120000);
    expect(installed).toEqual(expect.arrayContaining([expect.objectContaining({ name: '@worldlinebox-demo/ui-only', installed: true, enabled: true })]));
    await checkpoint('ui-only-listed');
    const afterUiOnly = await discover(clientA, a.instance.workspacePath, { kind: 'summary' });
    expect(afterUiOnly.effective).toEqual(beforeUiOnly.effective);
    expect((await catalog(clientA, a.instance.workspacePath)).names).toEqual(initialA.names);
    await checkpoint('ui-only-no-capability-growth');
    const detail = await discover(clientA, a.instance.workspacePath, { kind: 'tool', name: 'demo_palette' });
    expect(detail.detail?.tool).toMatchObject({ name: 'demo_palette', parameters: { required: ['hex'] } });
    expect(dshTaskCapabilityQuerySchema.safeParse({ kind: 'catalog', limit: 31 }).success).toBe(false);
    await checkpoint('executing-native-demo-tools');
    const firstWorker = await execute({ profile: 'A', tool: 'demo_palette', args: { hex: '#2244CC' } });
    expect(firstWorker.text).toContain('#DDBB33');
    expect((await execute({ profile: 'B', tool: 'demo_text_statistics', args: { text: 'hello world\n你好🙂' } })).text).toContain('"words":3');
    await execute({ profile: 'A', tool: 'demo_notebook', args: { key: 'shared', text: 'PRIVATE_NOTE_A' } });
    await execute({ profile: 'B', tool: 'demo_notebook', args: { key: 'shared', text: 'PRIVATE_NOTE_B' } });
    const readA = await execute({ profile: 'A', tool: 'demo_notebook', args: { key: 'shared' } }), readB = await execute({ profile: 'B', tool: 'demo_notebook', args: { key: 'shared' } });
    expect(readA.text).toContain('PRIVATE_NOTE_A'); expect(readA.text).not.toContain('PRIVATE_NOTE_B');
    expect(readB.text).toContain('PRIVATE_NOTE_B'); expect(readB.text).not.toContain('PRIVATE_NOTE_A');
    const [stateA, stateB] = await Promise.all([a, b].map(native => readFile(path.join(native.instance.homePath, 'plugin-data/worldlinebox-demo-notebook/notes.json'), 'utf8')));
    expect(JSON.parse(stateA!)).toEqual({ shared: 'PRIVATE_NOTE_A' }); expect(JSON.parse(stateB!)).toEqual({ shared: 'PRIVATE_NOTE_B' });
    await checkpoint('isolated-private-state-verified');
    await install(clientA, 'text-statistics');
    const updatedA = await catalog(clientA, a.instance.workspacePath), unchangedB = await catalog(clientB, b.instance.workspacePath);
    expect(updatedA.names.sort()).toEqual(['demo_notebook', 'demo_palette', 'demo_text_statistics']);
    expect(updatedA.digest).not.toBe(initialA.digest); expect(unchangedB).toEqual(initialB);
    const hotInput = dispatched.get('demo-A-1')!;
    const sameWorker = await brainA.run({ ...hotInput, taskContinuation: { id: 'hot-plugin-continuation', text: 'DEMO_REQUEST='
      + JSON.stringify({ profile: 'A', tool: 'demo_text_statistics', args: { text: 'same existing session' } }) } });
    expect(sameWorker.sessionId).toBe(firstWorker.sessionId); expect(sameWorker.text).toContain('"words":3');
    await clientA.request('/plugins', { action: 'toggle', spec: '@worldlinebox-demo/palette', enabled: false });
    await vi.waitFor(async () => expect((await catalog(clientA, a.instance.workspacePath)).names).not.toContain('demo_palette'), { timeout: 10000 });
    await clientA.request('/plugins', { action: 'remove', spec: '@worldlinebox-demo/palette' }, undefined, 120000);
    await clientA.health(); await clientB.health();
    const running = execute({ profile: 'A', tool: 'demo_notebook', args: { key: 'shared' }, hold: true });
    const runningInput = dispatched.get(`demo-A-${sequence}`)!;
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 15000 });
    expect(await clientA.request('/idle', {})).toMatchObject({ idle: false, known: true, activeTurns: expect.any(Number) });
    await checkpoint('hot-install-while-worker-turn-is-active');
    const installedDuringTurn = await install(clientA, 'palette') as { application: string };
    expect(installedDuringTurn.application).toBe('applied');
    expect((await catalog(clientA, a.instance.workspacePath)).names).toContain('demo_palette');
    await clientA.request('/plugins', { action: 'toggle', spec: '@worldlinebox-demo/palette', enabled: false });
    expect((await catalog(clientA, a.instance.workspacePath)).names).not.toContain('demo_palette');
    await clientA.request('/plugins', { action: 'toggle', spec: '@worldlinebox-demo/palette', enabled: true });
    const healthyCatalog = await catalog(clientA, a.instance.workspacePath);
    expect(healthyCatalog.names).toEqual(expect.arrayContaining(['demo_palette', 'demo_notebook', 'demo_text_statistics']));
    const invalidPackage = path.join(a.root, 'not-a-native-bundle'); await mkdir(invalidPackage);
    await writeFile(path.join(invalidPackage, 'package.json'), JSON.stringify({ name: '@worldlinebox-demo/no-bundle', version: '1.0.0', type: 'module', main: 'index.js' }));
    await writeFile(path.join(invalidPackage, 'index.js'), 'export const name="intentionally-not-a-bundle";\n');
    const failedInstall = await clientA.request<{ application: string }>('/plugins', { action: 'add', spec: 'file:' + invalidPackage.replaceAll('\\', '/') }, undefined, 120000);
    expect(failedInstall.application).toBe('failed');
    expect(await catalog(clientA, a.instance.workspacePath)).toEqual(healthyCatalog);
    expect(await clientA.request('/idle', {})).toMatchObject({ idle: false, known: true });
    await clientA.health(); await clientB.health();
    await checkpoint('nested-default-preset-install-while-worker-active');
    const beforeHistoryPath = path.join(output, 'native-history-before.json');
    await preserveBotNativeJournals(a.root, beforeHistoryPath, value => value);
    const beforeHistory = (JSON.parse(await readFile(beforeHistoryPath, 'utf8')) as Array<{ path: string; records: unknown[] }>).find(journal => journal.path.includes(firstWorker.sessionId));
    expect(beforeHistory).toBeDefined();
    const nestedPackage = path.join(a.root, 'nested-default-bundle'); await mkdir(nestedPackage);
    await writeFile(path.join(nestedPackage, 'package.json'), JSON.stringify({ name: '@worldlinebox-demo/nested-default', version: '1.0.0', type: 'module', main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    await writeFile(path.join(nestedPackage, 'index.js'), `export const name='demo-nested-default';export const inject=['tools'];export function apply(ctx){ctx.tools.register({name:'demo_nested_default',description:'A pure tool inside the native default preset, not globally registered.',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},output:{schema:{type:'object',properties:{value:{type:'string'},scope:{type:'string'}},required:['value','scope'],additionalProperties:false},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async a=>({value:a.value,scope:'NESTED_DEFAULT_PROOF'})});}\n`);
    // Derive the fixture from this actual installed runtime's declaration,
    // retaining its native expressions, services and tools across versions.
    const nativeStandard = await readFile(path.join(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!, 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), 'utf8');
    const nativeConfig = nativeStandard.slice(nativeStandard.indexOf('      config:')).split('\n').map(line => line.slice(4)).join('\n');
    await writeFile(path.join(nestedPackage, 'cordis.patch.yml'), '- id: preset-standard\n' + nativeConfig
      + '\n      - id: demo-nested-default\n        name: "@worldlinebox-demo/nested-default"\n');
    const nestedInstall = await clientA.request<{ application: string }>('/plugins', { action: 'add', spec: 'file:' + nestedPackage.replaceAll('\\', '/') }, undefined, 120000);
    expect(nestedInstall.application).toBe('applied');
    const nestedCatalog = await discover(clientA, a.instance.workspacePath, { kind: 'catalog', query: 'demo_nested_default', category: 'tool', limit: 10 });
    expect(nestedCatalog.catalog?.items).toEqual([expect.objectContaining({ name: 'demo_nested_default' })]);
    expect(nestedCatalog.scope).toMatchObject({ kind: 'companion-worker', pending: true });
    expect(nestedCatalog.scope!.deferredActiveWorkers).toBeGreaterThan(0);
    const boundActive = await clientA.request<Capability>(`/sessions/${BotDshBrain.sessionId(runningInput.laneId)}/capabilities`);
    expect(boundActive.tools.map(tool => tool.name)).not.toContain('demo_nested_default');
    expect(boundActive.scope?.revision).not.toBe(nestedCatalog.scope?.revision);
    release(); expect((await running).status).toBe('succeeded');
    // The native SDK has no atomic ingress-close + same-Session rebind API.
    // Keep every historical Worker on its exact scope, including while idle,
    // rather than cancelling a possible direct Workbench/plugin followup.
    const retained = await clientA.request<Capability>(`/sessions/${firstWorker.sessionId}/capabilities`);
    expect(retained.tools.map(tool => tool.name)).not.toContain('demo_nested_default');
    expect(retained.scope).toMatchObject({ pending: true }); expect(retained.scope?.revision).not.toBe(nestedCatalog.scope?.revision);
    const nestedResult = await execute({ profile: 'A', tool: 'demo_nested_default', args: { value: 'new worker current native scope' } });
    expect(nestedResult.sessionId).not.toBe(firstWorker.sessionId); expect(nestedResult.text).toContain('NESTED_DEFAULT_PROOF');
    const current = await clientA.request<Capability>(`/sessions/${nestedResult.sessionId}/capabilities`);
    expect(current.tools.map(tool => tool.name)).toContain('demo_nested_default'); expect(current.scope?.revision).toBe(nestedCatalog.scope?.revision);
    const afterHistoryPath = path.join(output, 'native-history-after.json');
    await preserveBotNativeJournals(a.root, afterHistoryPath, value => value);
    const afterHistory = (JSON.parse(await readFile(afterHistoryPath, 'utf8')) as Array<{ path: string; records: unknown[] }>).find(journal => journal.path === beforeHistory!.path);
    expect(afterHistory?.records.slice(0, beforeHistory!.records.length)).toEqual(beforeHistory!.records);
    const callsBeforeDuplicate = wires.length; await brainA.run(hotInput); expect(wires).toHaveLength(callsBeforeDuplicate);
    const afterHotChange = await brainA.run({ ...hotInput, taskContinuation: { id: 'palette-after-live-change', text: 'DEMO_REQUEST='
      + JSON.stringify({ profile: 'A', tool: 'demo_palette', args: { hex: '#2244CC' } }) } });
    expect(afterHotChange.sessionId).toBe(firstWorker.sessionId); expect(afterHotChange.text).toContain('#DDBB33');
    await vi.waitFor(async () => expect(await clientA.request('/idle', {})).toMatchObject({ idle: true, known: true }), { timeout: 10000 });
    const ownedPids = [clientA.pid, clientB.pid]; expect(ownedPids.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);
    const processMemory = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${ownedPids.join(',')} | Select-Object Id,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 })) as Array<{ Id: number; WorkingSet64: number; PrivateMemorySize64: number }>;
    expect(processMemory.map(value => value.Id).sort()).toEqual([...ownedPids].sort());
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ actualNativeHost: true, usesPaidModel: false, runtimeVersion: a.runtimeVersion,
      pids: [clientA.pid, clientB.pid], distinctProfiles: a.instance.homePath !== b.instance.homePath, nativeToolsExecuted: 3, notebookStateIsolated: true,
      catalogPagedWithoutSchemas: true, fullSchemaOnlyOnDetail: true, uiOnlyInstalledWithoutModelCapabilityGrowth: true,
      launcherAndNativeManagerEntrancesVerified: true, existingWorkerUsedHotRegisteredTool: true,
      hotCatalogChangedWithoutAppRestart: true, nativeHostPidsUnchanged: true,
      installAndToggleWhileWorkerTurnActive: true, failedInstallRolledBackWithoutLosingExistingTools: true,
      actualCompanionPresetCatalog: true, nestedDefaultPresetRevisionObserved: true, activeWorkerRetainedOldRevision: true,
      existingWorkerScopeRetainedWithoutUnsafeRecomposition: true, newWorkerExecutedCurrentNestedPresetTool: true, durableDuplicateDidNotReplayTools: true,
      originalNativeHistoryPrefixUnchanged: true,
      idleProbeRefusedActiveWorker: true, processMemory: { stage: 'idle after native plugin acceptance', unit: 'bytes', samples: processMemory,
        scope: 'Two owned native Web Host PIDs only; native default bundles plus demo plugins, no local LLM. Excludes WorldlineBox and model server. Do not extrapolate to arbitrary plugins.' },
      initialA, initialB, updatedA, unchangedB, wires }, null, 2));
  } catch (error) {
    const diagnostic = await Promise.all([a, b].map(async native => {
      const profile = path.join(native.instance.homePath, 'profiles/web'), logs = await readdir(path.join(profile, '.plugin-manager/logs'), { recursive: true }).catch(() => []);
      return { root: native.root, hostLog: await readFile(path.join(native.instances.getRoot(native.instance.id), 'logs/host.log'), 'utf8').catch(() => ''),
        pluginLogs: await Promise.all(logs.filter(value => value.endsWith('pnpm.log')).slice(-4).map(async value => ({ path: value,
          content: (await readFile(path.join(profile, '.plugin-manager/logs', value), 'utf8')).slice(-30000) }))) };
    }));
    await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), diagnostic }, null, 2)); throw error;
  } finally {
    release(); await writeFile(path.join(output, 'requests.json'), JSON.stringify(wires, null, 2));
    await Promise.allSettled([brainA.close(), brainB.close()]); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([a.close(), b.close()]);
  }
}, 600000);
