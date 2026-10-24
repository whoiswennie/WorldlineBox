import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionCredentials } from '../../src/main/companions/credentials';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { generateCompanionText, type CompanionModelConfig } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { Companion } from '../../src/shared/companions';

const ports = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: ports.launch },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() } }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Owner-routing fixture cleanup failed.');
});

it('routes actual concurrent native focus through each owner selection and cancels one without retiring its peer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-native-owner-model-'));
  cleanups.push(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-native-owner-model-')) throw Error('Unsafe owner-routing fixture cleanup.');
    await removeOwnedDirectory(root);
  });
  const children = new Set<number>(); let peakChildren = 0;
  const betaFocusPids: number[] = [], betaRoot = path.join('generation', createHash('sha256').update('beta').digest('hex'));
  ports.launch.mockImplementation((file: string) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete environment.NODE_PATH;
    const child = fork(file, [], { execPath: process.execPath, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child.pid!); peakChildren = Math.max(peakChildren, children.size);
    child.once('exit', () => children.delete(child.pid!));
    let scopeRoot = '';
    return { postMessage: (message: { command?: { type: string; configuration?: { dataRoot: string } } }) => {
      if (message.command?.type === 'initialize') scopeRoot = message.command.configuration!.dataRoot;
      if (message.command?.type === 'preprocess' && scopeRoot.includes(betaRoot)) betaFocusPids.push(child.pid!);
      return child.send(message);
    }, on: child.on.bind(child), kill: () => child.kill() };
  });
  const embeddingServer = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    const body = JSON.parse(text) as { input: string[] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: body.input.map((_input, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
  });
  await new Promise<void>(resolve => embeddingServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { await new Promise<void>(resolve => { embeddingServer.close(() => resolve()); embeddingServer.closeAllConnections(); }); });
  const address = embeddingServer.address(); if (!address || typeof address === 'string') throw Error('Missing fixture embedding endpoint.');
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [
    { id: 'alpha', name: 'Alpha', description: '', persona: '保留来源', model: '', avatar: 'sister', active: true, proactive: false,
      llm: { apiFormat: 'anthropic', baseUrl: 'https://alpha.invalid', model: 'owner-selected-alpha' } },
    { id: 'beta', name: 'Beta', description: '', persona: '保留来源', model: '', avatar: 'sister', active: true, proactive: false,
      llm: { apiFormat: 'gemini_native', baseUrl: 'https://beta.invalid', model: 'owner-selected-beta' } },
  ]);
  cleanups.push(async () => { store.close(); });
  const rows = ['alpha', 'beta'].map(owner => {
    const conversation = store.openPrivate(owner), content = `${owner} promised ${owner === 'alpha' ? 'cedar tea' : 'amber coffee'} for the routing experiment.`;
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content, replyDirective: 'none' });
    // The test supplies existing journal material. It validates routing and
    // native indexing/focus, independently of model journal extraction quality.
    for (;;) {
      const capture = store.request({ type: 'memory.jobs.claim', companionId: owner }).memoryJob;
      if (!capture) break;
      store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken, notes: [] });
    }
    const note = store.request({ type: 'memory.record', companionId: owner, conversationId: conversation.id,
      candidate: { content, tags: [owner, 'routing'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] } }).memories![0]!;
    return { owner, conversation, content, note };
  });
  const credentials = new CompanionCredentials(root);
  await credentials.save('alpha', 'alpha-local-fixture-key'); await credentials.save('beta', 'beta-local-fixture-key');
  const globalConfig = vi.fn((): CompanionModelConfig => ({ apiFormat: 'openai_chat', model: 'unconfigured-global', apiKey: '' }));
  // Invoke Main's actual configuration resolver with its real credential store;
  // no Main background subsystems are constructed for this isolated route test.
  const configFor = (companion: Companion): Promise<CompanionModelConfig> => Reflect.apply(
    Reflect.get(CompanionService.prototype, 'configFor'), { dormantCompanions: new Set(), credentials, options: { getConfig: globalConfig } }, [companion]);
  const gateway = new VcpChatGateway(); cleanups.push(() => gateway.close());
  const calls: Array<{ owner: string; context: { system: string; user: string }; model: string; url: string; headerKey: string }> = [];
  let blockNextAlphaFocus = false, blockedSignal: AbortSignal | undefined;
  const runtime = new CompanionVcpRuntime({ dataRoot: path.join(root, 'native'), vendorRoot: path.resolve('vendor/vcp-memory'),
    workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), generationProfile: { adapter: 'fixture-generic-text-v1' },
    resolveEmbedding: async () => ({ baseUrl: `http://127.0.0.1:${address.port}/document`, queryBaseUrl: `http://127.0.0.1:${address.port}/query`,
      model: 'controlled-embedding', modelSignature: 'owner-route-test-space', dimension: 4, apiKey: 'local-embedding-fixture' }),
    resolveGenerationPlugins: async ({ ownerId, config }) => {
      const snapshot = Object.freeze({ ...config });
      const route = await gateway.registerOwnerRoute({ ownerId, semanticProfile: { apiFormat: snapshot.apiFormat, model: snapshot.model },
        credential: snapshot.apiKey, generate: (context, signal) => generateCompanionText(context, snapshot, signal, { timeoutMs: 15000,
          fetchFn: async (url, init) => {
            const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
            calls.push({ owner: ownerId, context, model: body.model ?? decodeURIComponent(String(url)), url: String(url),
              headerKey: headers.get(snapshot.apiFormat === 'anthropic' ? 'x-api-key' : 'x-goog-api-key') ?? '' });
            if (calls.length > 16) throw Error('Controlled native route request budget exceeded.');
            if (ownerId === 'alpha' && blockNextAlphaFocus && context.system.startsWith('你是 VCP 记忆处理单元')) {
              blockedSignal = signal;
              return new Promise<Response>((_resolve, reject) => {
                const cancel = () => reject(new Error('Fixture provider operation cancelled.'));
                if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
              });
            }
            const own = rows.find(row => row.owner === ownerId)!;
            const text = context.system.startsWith('你是 VCP 记忆处理单元')
              ? `这是我获取的所有相关知识/记忆[[${own.content}]]` : `${own.content}\nTag: ${ownerId}, routing`;
            return new Response(JSON.stringify(snapshot.apiFormat === 'anthropic' ? { content: [{ type: 'text', text }] }
              : { candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
          } }) });
      return { plugins: { chat: route.chat }, dispose: route.dispose };
    } });
  cleanups.push(async () => { await runtime.close(); expect(children.size).toBe(0); });
  const report = vi.fn();
  const memory = new CompanionMemoryService({ runtime, cacheRoot: path.join(root, 'views'), configFor, fetchFn: async () => { throw Error('Unexpected journal model request.'); },
    request: async command => { const response = store.request(command); if (response.worldClock) response.worldClock.backlog = false; return response; },
    changed: () => undefined, report, busy: () => false });
  cleanups.push(() => memory.close());
  memory.schedule(0);
  await vi.waitFor(() => {
    for (const row of rows) expect(store.request({ type: 'memory.snapshot', companionId: row.owner, conversationId: row.conversation.id }).memorySnapshot!.notes.map(note => note.id)).toContain(row.note.id);
  }, { timeout: 30000, interval: 100 });
  const search = (row: typeof rows[number], query = 'routing experiment') => memory.search({ companionId: row.owner, conversationId: row.conversation.id, query }, 'passive');
  const results = await Promise.all(rows.map(row => search(row)));
  for (const [index, result] of results.entries()) {
    expect(result.memoryContext!.text).toContain(rows[index]!.content);
    expect(result.memoryContext!.text).not.toContain(rows[1 - index]!.content);
  }
  expect(calls.some(call => call.owner === 'alpha' && call.context.system.startsWith('你是 VCP 记忆处理单元'))).toBe(true);
  expect(calls.some(call => call.owner === 'beta' && call.context.system.startsWith('你是 VCP 记忆处理单元'))).toBe(true);
  for (const call of calls) {
    expect(call.url).toContain(`${call.owner}.invalid`); expect(call.model).toContain(`owner-selected-${call.owner}`);
    expect(call.headerKey).toBe(`${call.owner}-local-fixture-key`);
    expect(call.context.user).not.toContain(rows.find(row => row.owner !== call.owner)!.content);
  }
  expect(globalConfig).not.toHaveBeenCalled();
  blockNextAlphaFocus = true;
  const cancelled = search(rows[0]!, 'routing experiment cedar tea cancellation');
  const cancelledExpectation = expect(cancelled).rejects.toThrow();
  await vi.waitFor(() => expect(blockedSignal).toBeDefined(), { timeout: 15000, interval: 50 });
  const peer = await search(rows[1]!, 'routing experiment amber coffee unaffected');
  expect(peer.memoryContext!.text).toContain(rows[1]!.content);
  const peerPid = betaFocusPids.at(-1)!; expect(children.has(peerPid)).toBe(true);
  await memory.invalidate('alpha');
  await cancelledExpectation;
  await vi.waitFor(() => expect(blockedSignal!.aborted).toBe(true));
  expect(children.has(peerPid)).toBe(true);
  expect((await search(rows[1]!, 'routing experiment amber coffee after peer cancellation')).memoryContext!.text).toContain(rows[1]!.content);
  expect(betaFocusPids.at(-1)).toBe(peerPid);
  expect(peakChildren).toBeLessThanOrEqual(4);
}, 120000);
