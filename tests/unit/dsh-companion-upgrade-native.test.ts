import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { RuntimeServiceLike } from '../../src/main/dsh/instance-service';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { preserveBotNativeJournals } from '../fixtures/bot-native-journal-evidence';

type Wire = { messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> }>; tools?: Array<{ function: { name: string } }> };
const text = (content: Wire['messages'][number]['content']) => typeof content === 'string' ? content : (content ?? []).map(block => block.text ?? '').join('\n');

/** Two real installed CLIs and native persistence; the local model transport
 * exercises genuine tools without any paid account. Fixture runtime metadata
 * is deliberately not represented as sealed-package integrity verification. */
it.runIf(!!process.env.WORLDLINEBOX_DSH_UPGRADE_PROGRAM && !!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)(
  'upgrades the real shared DSH Host and opens a new turn in the preserved Session', async () => {
    const previousProgram = path.resolve(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!), nextProgram = path.resolve(process.env.WORLDLINEBOX_DSH_UPGRADE_PROGRAM!);
    const native = await createBotNativeHost(previousProgram), previousRuntime = (native.instances as unknown as { options: { runtimes: RuntimeServiceLike } }).options.runtimes.get(native.instance.runtimeId);
    const nextManifest = JSON.parse(await readFile(path.join(nextProgram, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string };
    const nextRuntime = { ...previousRuntime, id: 'runtime-native-upgrade-rc1', version: nextManifest.version, source: nextProgram, contentSha256: '1'.repeat(64), sourceSha256: '1'.repeat(64) };
    const records = [previousRuntime, nextRuntime], programs = new Map([[previousRuntime.id, previousProgram], [nextRuntime.id, nextProgram]]);
    (native.instances as unknown as { options: { runtimes: RuntimeServiceLike } }).options.runtimes = {
      list: () => records, get: id => { const record = records.find(value => value.id === id); if (!record) throw Error('Unknown fixture runtime'); return record; },
      directory: id => programs.get(id)!, plan: id => ({ ...canonicalRuntimeEntryPaths(programs.get(id)!), env: {} }),
      verify: async (id, signal) => { signal?.throwIfAborted(); const manifest = JSON.parse(await readFile(path.join(programs.get(id)!, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
        expect(manifest.version).toBe(records.find(value => value.id === id)!.version); },
    };
    const output = path.resolve('artifacts/superagent-bot-development/native-shared-upgrade', path.basename(native.root)); await mkdir(output, { recursive: true });
    const stage = (value: string) => writeFile(path.join(output, 'stage.json'), JSON.stringify({ stage: value, root: native.root, previousVersion: previousRuntime.version, nextVersion: nextRuntime.version }));
    let modelRequests = 0, toolResponses = 0, primaryError: unknown, cleanupError: unknown;
    const server = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (request.url === '/bot/tool') {
          expect(request.headers.authorization).toBe('Bearer ' + 'e'.repeat(64));
          expect(['worker_effect_start', 'worker_effect_commit']).toContain(body.name);
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
            result: body.name === 'worker_effect_start' ? { state: 'admitted', callId: body.callId } : { recorded: true } })); return;
        }
        modelRequests++; const wire = body as Wire;
        const at = wire.messages.findLastIndex(message => message.role === 'user' && text(message.content).includes('UPGRADE_REQUEST='));
        const marker = text(wire.messages[at]?.content).match(/UPGRADE_REQUEST=([^\n]+)/u);
        if (!marker) throw Error('Native model input lost its authorized upgrade test request');
        expect(wire.tools?.map(tool => tool.function.name)).toContain('demo_palette');
        const input = JSON.parse(marker[1]!) as { hex: string }, receipt = wire.messages.slice(at + 1).findLast(message => message.role === 'tool');
        if (receipt) toolResponses++;
        const delta = receipt ? { content: 'UPGRADE_RESULT=' + text(receipt.content) } : { tool_calls: [{ index: 0, id: `upgrade-call-${modelRequests}`,
          type: 'function', function: { name: 'demo_palette', arguments: JSON.stringify({ hex: input.hex }) } }] };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: receipt ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
      } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw Error('No local model listener');
    const own = await native.instances.ensureCompanion('upgrade-shared-partner', '升级伙伴', native.instance);
    expect(own.id).toBe(native.instance.id);
    expect((await native.instances.ensureCompanion('another-shared-partner', '另一伙伴', native.instance)).id).toBe(own.id);
    expect(native.instances.list()).toHaveLength(1);
    const brain = new BotDshBrain({ getHost: async () => ({ client: await native.instances.ensureHost(own.id) }),
      acquireLease: () => native.instances.acquireCompanionLease(own.id, 'task') });
    const input: BotDshRun = { role: 'worker', workerAccess: 'full', laneId: 'worker-native-upgrade', eventId: 'work-native-upgrade',
      cwd: path.join(own.workspacePath, 'native-upgrade-task'), system: 'Use exactly demo_palette for the authorized colour, then return its actual tool result. No other operations.',
      prompt: 'UPGRADE_REQUEST=' + JSON.stringify({ hex: '#123456' }), tools: [], callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'e'.repeat(64) },
      model: { apiFormat: 'openai_chat', model: 'local-native-upgrade', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-native-upgrade-key' } };
    try {
      await stage('starting-shared-rc5'); const oldClient = await native.instances.ensureHost(own.id);
      const plugin = await oldClient.request<{ application: string }>('/plugins', { action: 'add', spec: 'file:' + path.resolve('resources/dsh-demo-plugins/palette').replaceAll('\\', '/') }, undefined, 420000);
      expect(plugin.application).toBe('applied'); await stage('rc5-plugin-installed');
      const first = await brain.run(input); expect(first.text).toContain('#EDCBA9'); expect(first.status).toBe('succeeded');
      const receiptPath = path.join(input.cwd, '.worldlinebox-brain', createHash('sha256').update(input.eventId).digest('hex') + '.json');
      const originalReceipt = await readFile(receiptPath);
      const preserved = new Map<string, Buffer>();
      const config = path.join(own.homePath, 'profiles/web/cordis.patch.yml'); preserved.set(config, await readFile(config));
      for (const [relative, value] of [['home/plugin-data/upgrade-proof/state.json', 'private plugin state'], ['home/attachments/upgrade-proof.png', 'original media bytes'],
        ['home/storages/upgrade-proof/value.json', 'native storage state'], ['agents/skills/upgrade-proof/SKILL.md', '---\nname: upgrade-proof\ndescription: Native upgrade preservation proof\n---\nKeep this exact skill.'],
        ['workspace/delivery.txt', 'original user delivery']] as const) {
        const filename = path.join(native.instances.getRoot(own.id), relative); await mkdir(path.dirname(filename), { recursive: true });
        const bytes = Buffer.from(value); await writeFile(filename, bytes); preserved.set(filename, bytes);
      }
      await preserveBotNativeJournals(native.root, path.join(output, 'native-history-before.json'), value => value.replaceAll('local-native-upgrade-key', '<redacted>'));
      const journals = JSON.parse(await readFile(path.join(output, 'native-history-before.json'), 'utf8')) as Array<{ path: string; records: unknown[] }>;
      const originalHistory = journals.find(journal => journal.path.includes(first.sessionId)); expect(originalHistory).toBeDefined();
      await stage('upgrading-same-shared-environment');
      await native.instances.upgradeCompanion(own.id, nextRuntime.id, { id: randomUUID(), signal: AbortSignal.timeout(360000), log: async () => undefined, update: async () => undefined });
      await stage('upgraded-same-shared-environment');
      const upgraded = native.instances.get(own.id); expect(upgraded).toMatchObject({ id: own.id, isDefault: true,
        runtimeId: nextRuntime.id, homePath: own.homePath, agentsPath: own.agentsPath, workspacePath: own.workspacePath, browserPartition: own.browserPartition });
      for (const [filename, bytes] of preserved) expect(await readFile(filename)).toEqual(bytes);
      expect(await readFile(receiptPath)).toEqual(originalReceipt);
      await stage('preserved-bytes-checked');
      const newClient = await native.instances.ensureHost(own.id); expect(newClient.pid).not.toBe(oldClient.pid);
      const inventory = await newClient.request<Array<{ name: string; installed: boolean; enabled: boolean }>>('/plugins', { action: 'list' });
      expect(inventory).toEqual(expect.arrayContaining([expect.objectContaining({ name: '@worldlinebox-demo/palette', installed: true, enabled: true })]));
      await stage('rc1-native-plugin-listed');
      const requestsBeforeReplay = modelRequests; expect((await brain.run(input)).text).toBe(first.text); expect(modelRequests).toBe(requestsBeforeReplay);
      await stage('duplicate-durable-receipt-not-replayed');
      const after = await brain.run({ ...input, eventId: 'post-upgrade-real-tool', prompt: 'UPGRADE_REQUEST=' + JSON.stringify({ hex: '#2244CC' }) });
      expect(after.sessionId).toBe(first.sessionId); expect(after.status).toBe('succeeded'); expect(after.text).toContain('#DDBB33');
      await stage('rc1-same-session-native-tool-completed');
      await preserveBotNativeJournals(native.root, path.join(output, 'native-history-after.json'), value => value.replaceAll('local-native-upgrade-key', '<redacted>'));
      const afterHistory = (JSON.parse(await readFile(path.join(output, 'native-history-after.json'), 'utf8')) as Array<{ path: string; records: unknown[] }>).find(journal => journal.path === originalHistory!.path);
      expect(afterHistory?.records.slice(0, originalHistory!.records.length)).toEqual(originalHistory!.records);
      await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ actualNativeHost: true, usesPaidModel: false, sealedIntegrityClaimed: false,
        fixtureRuntimeVerification: 'real program entry points and manifest identity; sealed importer verification remains separately tested',
        previousVersion: previousRuntime.version, nextVersion: nextRuntime.version, originalPid: oldClient.pid, upgradedPid: newClient.pid,
        sameSharedInstance: true, sameHomeAndPartition: true, sameNativeSession: true, originalHistoryPrefixUnchanged: true,
        originalReceiptUnchanged: true, duplicateDidNotReplayModelOrTools: true, nativePluginStillLoaded: true, preservedFiles: [...preserved.keys()].map(filename => path.relative(native.root, filename)),
        preservedNativeSnapshots: native.instances.snapshots().length, realToolResults: toolResponses, modelRequests }, null, 2));
      await stage('passed');
    } catch (error) {
      primaryError = error;
      await writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined, instance: native.instances.get(own.id),
        hostLog: await readFile(path.join(native.instances.getRoot(own.id), 'logs/host.log'), 'utf8').catch(() => '') }, null, 2));
    } finally {
      await brain.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      try { await native.close([{ id: own.id, name: own.name, runtimeId: native.instances.get(own.id).runtimeId }]); }
      catch (error) { cleanupError = error; }
    }
    if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Native upgrade and safe cleanup both failed.', { cause: primaryError });
    if (primaryError) throw primaryError;
    if (cleanupError) throw cleanupError;
  }, 600000);
