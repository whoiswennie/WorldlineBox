import { fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import type { VcpMemoryEmbeddingConfig } from '../../src/main/vcp-memory/contracts';
import { vcpMemoryNotebookFolder } from '../../src/main/vcp-memory/contracts';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const roots: string[] = [], clients: VcpMemoryClient[] = [], servers: Server[] = [];
const workerPath = path.resolve('src/main/vcp-memory/worker.cjs');
const vendorRoot = path.resolve('vendor/vcp-memory');

function launch(file: string): VcpMemoryTransport {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete environment.NODE_PATH;
  const child = fork(file, [], { execPath: process.execPath, env: environment, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr?.resume();
  return { postMessage: message => { child.send(message as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
}
async function fixture() {
  const controls = { hangQuery: false, hangDocument: false };
  const transports: VcpMemoryTransport[] = [];
  const requests: Array<{ path: string; model: string; input: string[]; dimensions: number }> = [];
  const chatRequests: string[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const part of request) text += part.toString();
    const body = JSON.parse(text) as { model: string; input: string[]; dimensions: number };
    if (request.url === '/chat/v1/chat/completions') {
      chatRequests.push(text);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: '2026-10-21: alpha borrowed the blue umbrella and promised to return it.\nTag: alpha, umbrella' } }] }));
      return;
    }
    requests.push({ path: request.url!, ...body });
    if (controls.hangQuery && request.url?.startsWith('/query/')) return;
    if (controls.hangDocument && request.url?.startsWith('/document/')) return;
    const vector = (input: string) => /cocoa/iu.test(input) ? [0, 1, 0, 0]
      : /alpha/iu.test(input) ? [1, 0, 0, 0] : /beta/iu.test(input) ? [0, 0, 1, 0] : [0, 0, 0, 1];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: body.input.map((input, index) => ({ index, embedding: vector(input) })) }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-runtime-')); roots.push(root);
  const embedding: VcpMemoryEmbeddingConfig = { baseUrl: `http://127.0.0.1:${address.port}/document`,
    queryBaseUrl: `http://127.0.0.1:${address.port}/query`, model: 'synthetic-fixture', modelSignature: 'fixture-space', apiKey: 'fixture-key', dimension: 4 };
  const createClient = (config = embedding, maxOpenScopes = 4, requestTimeoutMs = 30_000, dataRoot = root) => {
    const client = new VcpMemoryClient({ dataRoot, vendorRoot, workerPath, embedding: config,
      launch: file => { const transport = launch(file); transports.push(transport); return transport; }, maxOpenScopes, requestTimeoutMs }); clients.push(client); return client;
  };
  return { root, requests, embedding, createClient, controls, transports, chatRequests };
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-runtime-')) throw new Error('Unsafe fixture cleanup.');
    await removeOwnedDirectory(root);
  }
});

describe('unchanged VCP core behind isolated worker processes', () => {
  it('detaches its own dependency junctions on close and safely purges an interrupted worker without touching their sources', async () => {
    const { root, createClient } = await fixture(), client = createClient(), scope = { scopeId: 'dependency-link-cleanup' };
    const directory = path.join(root, createHash('sha256').update(scope.scopeId).digest('hex'));
    const sources = [path.resolve('node_modules/@dqbd/tiktoken/package.json'), path.join(vendorRoot, 'rust-vexus-lite/index.js')];
    const hashes = await Promise.all(sources.map(file => readFile(file).then(data => createHash('sha256').update(data).digest('hex'))));
    await client.remember(scope, { id: 'source', content: 'alpha dependency ownership', tags: ['alpha'] });
    for (const name of ['node_modules', 'rust-vexus-lite']) expect((await lstat(path.join(directory, 'runtime', name))).isSymbolicLink()).toBe(true);
    await client.closeScope(scope);
    for (const name of ['node_modules', 'rust-vexus-lite']) await expect(lstat(path.join(directory, 'runtime', name))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await client.list(scope))[0]?.id).toBe('source');
    await client.interruptScope(scope);
    for (const name of ['node_modules', 'rust-vexus-lite']) await expect(lstat(path.join(directory, 'runtime', name))).rejects.toMatchObject({ code: 'ENOENT' });
    await client.purgeScope(scope);
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await Promise.all(sources.map(file => readFile(file).then(data => createHash('sha256').update(data).digest('hex'))))).toEqual(hashes);
  });
  it('routes real host notebooks through original DailyNote, RAG, LightMemo and timeline, then safely rehomes and deletes them', async () => {
    const { root, embedding, chatRequests } = await fixture();
    const client = new VcpMemoryClient({ dataRoot: root, vendorRoot, workerPath, embedding, launch, requestTimeoutMs: 30_000,
      plugins: { chat: { baseUrl: embedding.baseUrl.replace('/document', '/chat'), model: 'fixture-chat', apiKey: 'fixture-key' } } });
    clients.push(client);
    const scope = { scopeId: 'real-notebooks' }, notesRoot = path.join(root, createHash('sha256').update(scope.scopeId).digest('hex'), 'notes');
    const alpha = { id: 'alpha-book', content: 'alpha borrowed a blue umbrella', tags: ['alpha', 'umbrella'], diaryName: '生活日记本', author: 'WorldlineBox', occurredAt: '2026-10-21T12:00:00Z' };
    const beta = { id: 'beta-book', content: 'beta studies the garden plants', tags: ['beta', 'plants'], diaryName: '../资料[[VCPTimeLine::secret]]日记本\nNUL', author: 'WorldlineBox', occurredAt: alpha.occurredAt };
    const first = vcpMemoryNotebookFolder(alpha.diaryName), second = vcpMemoryNotebookFolder(beta.diaryName);
    const runtime = createRequire(import.meta.url)(path.resolve('src/main/vcp-memory/runtime.cjs')) as { notebookFolder(name?: string): string };
    for (const name of [undefined, 'memories', alpha.diaryName, beta.diaryName, 'Alpha', 'alpha', 'CON', '已整理', 'a'.repeat(160), '𠀀'.repeat(80)]) {
      expect(runtime.notebookFolder(name)).toBe(vcpMemoryNotebookFolder(name));
      expect(vcpMemoryNotebookFolder(name)).not.toMatch(/[\r\n/\\:[\]|<>]/u);
      expect(vcpMemoryNotebookFolder(name)).not.toContain('日记本');
      expect(vcpMemoryNotebookFolder(name).length).toBeLessThanOrEqual(100);
    }
    expect(vcpMemoryNotebookFolder('Alpha')).not.toBe(vcpMemoryNotebookFolder('alpha'));
    await client.replace(scope, [alpha, beta]);
    for (const [folder, content] of [[first, alpha.content], [second, beta.content]]) {
      expect((await readdir(path.join(notesRoot, folder!))).filter(file => file.endsWith('.md'))).toHaveLength(1);
      const list = await client.pluginCall(scope, 'DailyNoteManager', { command: 'list', folder, startDate: '2026-10-01', endDate: '2026-10-31' });
      expect(JSON.stringify(list.result)).toContain(content);
    }
    expect((await client.search(scope, { text: 'alpha umbrella' })).results[0]).toMatchObject({ id: alpha.id, diaryName: alpha.diaryName, sourceFile: expect.stringContaining(first) });
    const light = await client.pluginCall(scope, 'LightMemo', { folder: `${first},${second}`, query: 'alpha beta', k: 4, enginemode: 'rivermemo' });
    expect(JSON.stringify(light.result)).toContain(alpha.content); expect(JSON.stringify(light.result)).toContain(beta.content);
    const rag = await client.preprocess(scope, [{ role: 'system', content: `[[${first}|${second}日记本::RiverMemo]]` }, { role: 'user', content: 'alpha beta' }]);
    expect(JSON.stringify(rag.messages)).toContain(alpha.content); expect(JSON.stringify(rag.messages)).toContain(second);
    expect(JSON.stringify(rag.messages)).not.toContain('日记本::RiverMemo]]');
    const betaRag = await client.preprocess(scope, [{ role: 'system', content: `[[${first}|${second}日记本::RiverMemo]]` }, { role: 'user', content: 'beta plants' }]);
    expect(JSON.stringify(betaRag.messages)).toContain(beta.content);
    await client.timeline(scope, { operation: 'generateTimelines', agentName: 'WorldlineBox', options: { startMonth: '2026-10', endMonth: '2026-10' } });
    expect(chatRequests.join('\n')).toContain(alpha.content); expect(chatRequests.join('\n')).toContain(beta.content);
    const renamed = { ...alpha, diaryName: '自我认识' }, destination = vcpMemoryNotebookFolder(renamed.diaryName);
    await client.remember(scope, renamed);
    expect((await readdir(path.join(notesRoot, first))).filter(file => file.endsWith('.md'))).toEqual([]);
    expect((await client.search(scope, { text: 'alpha umbrella' })).results.find(hit => hit.id === alpha.id)).toMatchObject({ id: alpha.id, sourceFile: expect.stringContaining(destination) });
    await client.closeScope(scope);
    expect(await client.read(scope, alpha.id)).toEqual(renamed);
    await client.replace(scope, [renamed, beta]);
    expect((await readdir(path.join(notesRoot, destination))).filter(file => file.endsWith('.md'))).toHaveLength(1);
    await client.forget(scope, alpha.id); await client.forget(scope, beta.id);
    expect((await client.search(scope, { text: 'alpha beta' })).results).toEqual([]);
    await client.closeScope(scope);
    expect(await client.list(scope)).toEqual([]);
  });
  it('recovers an interrupted notebook migration from its original source deletion and pending native write journal', async () => {
    const { root, createClient, controls, requests } = await fixture(), client = createClient();
    const scope = { scopeId: 'interrupted-notebook-move' }, scopeRoot = path.join(root, createHash('sha256').update(scope.scopeId).digest('hex'));
    const first = { id: 'migration-note', content: 'alpha original notebook content', tags: ['alpha'], diaryName: '原日记本' };
    await client.remember(scope, first);
    const next = { ...first, content: 'beta recovered notebook content', tags: ['beta'], diaryName: '新资料' };
    controls.hangDocument = true;
    const written = client.remember(scope, next).then(() => undefined, error => error);
    const recordFile = path.join(scopeRoot, 'records', createHash('sha256').update(first.id).digest('hex') + '.json');
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(recordFile, 'utf8'))).toMatchObject({ indexState: 'pending', diaryName: next.diaryName, obsoleteRawPaths: [expect.stringContaining(vcpMemoryNotebookFolder(first.diaryName))] });
      expect(requests.some(request => request.path.startsWith('/document/') && request.input.some(input => input.includes(next.content)))).toBe(true);
    }, { timeout: 5000 });
    await client.interruptScope(scope); expect(await written).toBeInstanceOf(Error); controls.hangDocument = false;
    expect(await client.read(scope, first.id)).toEqual(next);
    expect((await readdir(path.join(scopeRoot, 'notes', vcpMemoryNotebookFolder(first.diaryName)))).filter(file => file.endsWith('.md'))).toEqual([]);
    expect((await client.search(scope, { text: 'beta' })).results[0]).toMatchObject({ id: first.id, content: next.content });
    expect(JSON.parse(await readFile(recordFile, 'utf8')).obsoleteRawPaths).toBeUndefined();
    expect(await client.list(scope)).toHaveLength(1);
  });
  it.runIf(process.platform === 'win32')('writes original diaries and native SQLite/River indices beyond MAX_PATH, then reopens and purges', async () => {
    const { root, embedding, createClient } = await fixture();
    const dataRoot = path.join(root, '伙伴资产库', '深层中文记忆目录'.repeat(12), '连续记忆子目录'.repeat(10));
    const scope = { scopeId: 'long-chinese-native-store' }, hash = createHash('sha256').update(scope.scopeId).digest('hex');
    const database = path.join(dataRoot, hash, 'store', 'knowledge_base.sqlite');
    expect(database.length).toBeGreaterThan(300);
    const client = createClient(embedding, 1, 30_000, dataRoot);
    const note = { id: 'long-path-note', content: 'alpha borrowed the umbrella', tags: ['alpha', 'umbrella'] };
    await client.remember(scope, note);
    expect((await stat(database)).isFile()).toBe(true);
    expect((await readdir(path.join(dataRoot, hash, 'notes', 'memories'))).some(file => file.endsWith('.md'))).toBe(true);
    expect((await client.search(scope, { text: 'alpha umbrella' })).results[0]).toMatchObject({ id: note.id, engine: 'river' });
    const context = await client.preprocess(scope, [{ role: 'system', content: '[[memories日记本::RiverMemo]]' }, { role: 'user', content: 'alpha umbrella' }]);
    expect(JSON.stringify(context.messages)).toContain(note.content);
    expect((await stat(path.join(dataRoot, hash, 'runtime', 'Plugin', 'RAGDiaryPlugin', 'folding_store.db'))).isFile()).toBe(true);
    await client.remember(scope, { ...note, content: 'cocoa is the new preference', tags: ['cocoa'] });
    await client.closeScope(scope);
    expect((await client.search(scope, { text: 'cocoa' })).results[0]?.content).toBe('cocoa is the new preference');
    await client.forget(scope, note.id);
    expect((await client.search(scope, { text: 'cocoa' })).results).toEqual([]);
    await client.purgeScope(scope);
    expect(await readdir(dataRoot)).toEqual([]);
  });

  it('ingests, searches, updates, deletes and reopens using real native River and purpose endpoints', async () => {
    const { requests, createClient } = await fixture();
    const client = createClient(), scope = { scopeId: 'companion-A/private-chat' };
    const note = { id: 'note-1', content: 'alpha remembers an umbrella loan', tags: ['alpha', 'umbrella'], metadata: { sourceMessageId: 'message-1' } };
    expect(await client.remember(scope, note)).toEqual({ id: note.id, indexed: true });
    expect(await client.read(scope, note.id)).toEqual(note);
    const recalled = await client.search(scope, { text: 'alpha umbrella', topK: 4 });
    expect(recalled.results[0]?.id).toBe(note.id);
    expect(recalled.results[0]?.engine).toBe('river');
    expect(recalled.diagnostics.nativeTopologyV3).toMatchObject({ jointUsed: true });
    expect(requests.some(request => request.path === '/document/v1/embeddings')).toBe(true);
    expect(requests.some(request => request.path === '/query/v1/embeddings')).toBe(true);
    expect(requests.every(request => request.dimensions === 4 && request.model === 'synthetic-fixture')).toBe(true);
    await client.remember(scope, { ...note, content: 'cocoa is the updated preference', tags: ['cocoa'] });
    expect((await client.search(scope, { text: 'cocoa' })).results[0]?.content).toBe('cocoa is the updated preference');
    await client.closeScope(scope);
    expect((await client.search(scope, { text: 'cocoa' })).results[0]?.id).toBe(note.id);
    expect(await client.forget(scope, note.id)).toEqual({ id: note.id, deleted: true });
    expect(await client.search(scope, { text: 'cocoa' })).toMatchObject({ results: [] });
    await client.closeScope(scope);
    expect(await client.list(scope)).toEqual([]);
  });

  it('physically separates private scopes and purges retired snapshot indices', async () => {
    const { root, createClient } = await fixture();
    const client = createClient(), first = { scopeId: 'A/private/revision1' }, second = { scopeId: 'A/group/revision2' };
    await client.replace(first, [{ id: 'same-id', content: 'alpha private fact', tags: ['alpha'] }]);
    await client.replace(second, [{ id: 'same-id', content: 'beta group fact', tags: ['beta'] }]);
    expect((await client.search(first, { text: 'alpha' })).results.map(hit => hit.content)).toEqual(['alpha private fact']);
    expect((await client.search(second, { text: 'beta' })).results.map(hit => hit.content)).toEqual(['beta group fact']);
    expect(await readdir(root)).toHaveLength(2);
    await client.purgeScope(first);
    expect(await readdir(root)).toEqual([createHash('sha256').update(second.scopeId).digest('hex')]);
    expect(await client.list(first)).toEqual([]);
  });

  it('rejects embedding space changes after reopening and bounds resident workers', async () => {
    const { createClient, embedding } = await fixture();
    const client = createClient(embedding, 1), first = { scopeId: 'first' }, second = { scopeId: 'second' };
    await client.remember(first, { id: 'one', content: 'alpha first note', tags: ['alpha'] });
    await client.remember(second, { id: 'two', content: 'beta second note', tags: ['beta'] });
    expect((await client.list(first))[0]?.id).toBe('one');
    await client.close();
    const changed = createClient({ ...embedding, modelSignature: 'different-space' });
    await expect(changed.list(first)).rejects.toMatchObject({ code: 'VCP_MEMORY_EMBEDDING_SPACE_MISMATCH' });
  });

  it('waits for busy scopes under concurrent load instead of evicting active ingestion', async () => {
    const { createClient, embedding } = await fixture();
    const client = createClient(embedding, 1);
    await Promise.all(['alpha', 'beta', 'cocoa'].map(name => client.remember({ scopeId: name }, { id: name, content: `${name} fact`, tags: [name] })));
    for (const name of ['alpha', 'beta', 'cocoa']) expect((await client.list({ scopeId: name }))[0]?.id).toBe(name);
  });

  it('terminates timed out and crashed workers, then replays persisted notes on the next request', async () => {
    const { createClient, embedding, controls, transports } = await fixture();
    const client = createClient(embedding, 1, 1_500), scope = { scopeId: 'recoverable' };
    await client.remember(scope, { id: 'one', content: 'alpha recoverable fact', tags: ['alpha'] });
    controls.hangQuery = true;
    await expect(client.search(scope, { text: 'alpha' })).rejects.toThrow(/timed out/u);
    controls.hangQuery = false;
    expect((await client.search(scope, { text: 'alpha' })).results[0]?.id).toBe('one');
    transports.at(-1)!.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await client.list(scope))[0]?.id).toBe('one');
    await client.purgeScope(scope);
  });

  it('resolves packaged production dependencies and native assets without workspace ancestry or NODE_PATH', async () => {
    const { root, embedding } = await fixture();
    const resources = path.join(root, 'resources');
    const packagedVendor = path.join(resources, 'vcp-memory'), packagedHost = path.join(resources, 'vcp-memory-host');
    await cp(path.resolve('.tools/vcp-memory-release/vcp-memory'), packagedVendor, { recursive: true });
    await cp(path.resolve('.tools/vcp-memory-release/vcp-memory-host'), packagedHost, { recursive: true });
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete environment.NODE_PATH;
    const modules = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readFile } from 'node:fs/promises';
      import { createRequire } from 'node:module';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const root = ${JSON.stringify(packagedVendor)};
      const require = createRequire(path.join(root, 'package.json'));
      const { runtimePackages } = JSON.parse(await readFile(path.join(root, 'peripheral-manifest.json'), 'utf8'));
      for (const name of runtimePackages) {
        const entry = require.resolve(name);
        const relative = path.relative(root, entry);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('External dependency: ' + name);
        await import(pathToFileURL(entry).href);
      }
      console.log(JSON.stringify(runtimePackages));
    `], { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000 });
    expect(modules.status, modules.stderr).toBe(0);
    expect(JSON.parse(modules.stdout.trim())).toHaveLength(12);
    const client = new VcpMemoryClient({ dataRoot: path.join(root, 'userData'), vendorRoot: packagedVendor,
      workerPath: path.join(packagedHost, 'worker.cjs'), embedding, launch, requestTimeoutMs: 30_000 });
    clients.push(client);
    const scope = { scopeId: 'packaged-style' };
    await client.remember(scope, { id: 'packaged', content: 'alpha packaged memory', tags: ['alpha'], occurredAt: '2026-10-21T12:00:00Z' });
    expect((await client.search(scope, { text: 'alpha' })).results[0]).toMatchObject({ id: 'packaged', engine: 'river' });
    const listing = await client.pluginCall(scope, 'DailyNoteManager', { command: 'list', folder: 'memories', startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(JSON.stringify(listing.result)).toContain('alpha packaged memory');
    const recalled = await client.pluginCall(scope, 'LightMemo', { query: 'alpha', folder: 'memories', k: 3, enginemode: 'rivermemo' });
    expect(JSON.stringify(recalled.result)).toContain('alpha packaged memory');
    const processed = await client.preprocess(scope, [{ role: 'system', content: '[[memories日记本::RiverMemo]]' }, { role: 'user', content: 'alpha' }]);
    expect(JSON.stringify(processed.messages)).toContain('alpha packaged memory');
    expect(await client.timeline(scope, { operation: 'listAgents' })).toBeInstanceOf(Array);
  });

  it('runs original DailyNote, management, LightMemo, RAG preprocessing and monthly timeline plugins', async () => {
    const { root, embedding } = await fixture();
    const client = new VcpMemoryClient({ dataRoot: root, vendorRoot, workerPath, embedding, launch, requestTimeoutMs: 30_000,
      plugins: { chat: { baseUrl: embedding.baseUrl.replace('/document', '/chat'), model: 'fixture-chat', apiKey: 'fixture-key' } } });
    clients.push(client);
    const scope = { scopeId: 'upstream-peripherals' };
    const capabilities = await client.capabilities(scope);
    expect(Object.keys(capabilities.plugins)).toHaveLength(5);
    expect(capabilities.timelineGenerationConfigured).toBe(true);
    const created = await client.pluginCall(scope, 'DailyNote', { command: 'create', maid: 'alpha', folder: 'alpha',
      Date: '2026-10-21', Content: 'alpha borrowed the blue umbrella and promised to return it.', Tag: 'alpha, umbrella' });
    expect(created).toMatchObject({ result: { status: 'success' }, indexed: true });
    const listing = await client.pluginCall(scope, 'DailyNoteManager', { command: 'list', folder: 'alpha', startDate: '2026-10-01', endDate: '2026-10-31' });
    expect(JSON.stringify(listing.result)).toContain('borrowed the blue umbrella');
    const recalled = await client.pluginCall(scope, 'LightMemo', { query: 'alpha umbrella', folder: 'alpha', k: 3, BM25: false });
    expect(JSON.stringify(recalled.result)).toContain('borrowed the blue umbrella');
    expect((await client.search(scope, { text: 'alpha umbrella' })).results[0]?.content).toContain('borrowed the blue umbrella');
    const processed = await client.preprocess(scope, [
      { role: 'system', content: 'Past experiences:\n[[alpha日记本::RiverMemo]]' },
      { role: 'user', content: 'alpha umbrella' },
    ]);
    expect(processed.messages[0]?.content).toContain('borrowed the blue umbrella');
    expect(processed.messages[0]?.content).not.toContain('[[alpha日记本');
    const directClass = createRequire(import.meta.url)(path.join(vendorRoot, 'Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor.js')) as new (options: { dailyNoteRootPath: string }) => { processContent(content: string): Promise<string> };
    const direct = new directClass({ dailyNoteRootPath: path.join(root, createHash('sha256').update(scope.scopeId).digest('hex'), 'notes') });
    const expectedDirect = await direct.processContent('{{alpha日记本}}');
    const actualDirect = await client.preprocess(scope, [{ role: 'system', content: '{{alpha日记本}}' }]);
    expect(actualDirect.messages[0]?.content).toBe(expectedDirect);
    const generated = await client.timeline(scope, { operation: 'generateTimelines', agentName: 'alpha', options: { startMonth: '2026-10', endMonth: '2026-10' } });
    expect(JSON.stringify(generated)).not.toContain('服务器 Key 未配置');
    const detail = await client.timeline(scope, { operation: 'getAgentDetail', agentName: 'alpha' });
    expect(JSON.stringify(detail)).toContain('2026-10');
    await client.timeline(scope, { operation: 'saveSummary', agentName: 'alpha', month: '2026-10', content: 'alpha borrowed an umbrella in October.' });
    const timeline = await client.preprocess(scope, [{ role: 'system', content: '[[VCPTimeLine::alpha]]' }, { role: 'user', content: 'alpha umbrella' }]);
    expect(JSON.stringify(timeline.messages)).toContain('alpha borrowed an umbrella in October.');
    expect((await client.exportNotes(scope)).some(note => note.content.includes('borrowed the blue umbrella'))).toBe(true);
    await client.closeScope(scope);
    await client.purgeScope(scope);
  });

  it('embeds only added source documents and new tags in an additive view', async () => {
    const { createClient, requests } = await fixture();
    const client = createClient(), scope = { scopeId: 'additive-view' };
    const first = { id: 'first', content: 'alpha first note', tags: ['alpha'], occurredAt: '2026-09-01T12:00:00Z' };
    const second = { id: 'second', content: 'beta added note', tags: ['beta'], occurredAt: '2026-10-01T12:00:00Z' };
    await client.replace(scope, [first]);
    await client.search(scope, { text: 'alpha' });
    const before = requests.length;
    await client.replace(scope, [first, second]);
    const newlyEmbedded = requests.slice(before).filter(request => request.path.startsWith('/document/')).flatMap(request => request.input);
    expect(newlyEmbedded.some(text => text.includes('beta added note'))).toBe(true);
    expect(newlyEmbedded.some(text => text.includes('alpha first note'))).toBe(false);
    expect((await client.search(scope, { text: 'beta' })).results[0]?.id).toBe('second');
  });

  it('carries unchanged monthly timeline artifacts across snapshots and rejects revoked or revised source inputs', async () => {
    const { createClient } = await fixture();
    const client = createClient(), first = { scopeId: 'timeline/rev1' }, next = { scopeId: 'timeline/rev2' }, revoked = { scopeId: 'timeline/revoked' };
    const september = { id: 'september', content: 'alpha September fact', tags: ['alpha'], author: 'WorldlineBox', occurredAt: '2026-09-10T12:00:00Z' };
    const october = { id: 'october', content: 'beta October fact', tags: ['beta'], author: 'WorldlineBox', occurredAt: '2026-10-10T12:00:00Z' };
    await client.replace(first, [september]);
    await client.timeline(first, { operation: 'saveTimelineFile', agentName: 'WorldlineBox', month: '2026-09', content: '[2026-09-10] - WorldlineBox\nalpha September history\nTag: alpha' });
    await client.timeline(first, { operation: 'saveSummary', agentName: 'WorldlineBox', month: '2026-09', content: 'September private alpha summary.' });
    const artifacts = await client.exportTimelineArtifacts(first, 'rev1');
    expect(artifacts.agents[0]?.months[0]?.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    await client.replace(next, [september, october]);
    expect(await client.importTimelineArtifacts(next, 'rev2', artifacts)).toEqual({ acceptedMonths: 1, skippedMonths: 0 });
    const current = await client.preprocess(next, [{ role: 'system', content: '[[VCPTimeLine::WorldlineBox]]' }, { role: 'user', content: 'alpha' }]);
    expect(JSON.stringify(current.messages)).toContain('September private alpha summary.');
    await client.replace(revoked, [october]);
    expect(await client.importTimelineArtifacts(revoked, 'revoked', artifacts)).toEqual({ acceptedMonths: 0, skippedMonths: 1 });
    await client.remember(next, { ...september, content: 'cocoa revised September fact', tags: ['cocoa'] });
    const changed = await client.preprocess(next, [{ role: 'system', content: '[[VCPTimeLine::WorldlineBox]]' }]);
    expect(JSON.stringify(changed.messages)).not.toContain('September private alpha summary.');
  });

  it('keeps identical bodies under independent IDs and recovers original manager consolidation through export', async () => {
    const { createClient } = await fixture();
    const client = createClient(), scope = { scopeId: 'independent-ids' };
    const common = { content: 'alpha duplicate diary body', tags: ['alpha'], author: 'WorldlineBox', occurredAt: '2026-10-21T01:02:03Z' };
    await client.remember(scope, { ...common, id: 'first-copy' });
    await client.remember(scope, { ...common, id: 'second-copy' });
    await client.remember(scope, { ...common, id: 'second-copy', content: 'cocoa updated second diary body', tags: ['cocoa'] });
    expect((await client.read(scope, 'first-copy'))?.content).toBe(common.content);
    expect((await client.read(scope, 'second-copy'))?.content).toBe('cocoa updated second diary body');
    await client.closeScope(scope);
    expect(await client.list(scope)).toHaveLength(2);
    const urls = (await client.exportNotes(scope)).map(note => String(note.metadata?.vcpSourceFile));
    expect(urls).toHaveLength(2);
    const organized = await client.pluginCall(scope, 'DailyNoteManager', { command: 'organize', urls: urls.join('\n'),
      maid: 'WorldlineBox', folder: 'memories', Date: '2026-10-21', Content: 'alpha consolidated daily experience', Tag: 'alpha, cocoa', fileName: 'consolidated' });
    expect(organized.result).toMatchObject({ status: 'success' });
    expect(await client.list(scope)).toEqual([]);
    const exported = await client.exportNotes(scope);
    expect(exported).toHaveLength(1);
    expect(exported[0]?.content).toContain('alpha consolidated daily experience');
    expect(exported[0]?.metadata?.vcpSourceFile).toBeTruthy();
    expect((await client.read(scope, exported[0]!.id))?.content).toContain('alpha consolidated');
    await client.forget(scope, exported[0]!.id);
    expect(await client.exportNotes(scope)).toEqual([]);
  });

  it('replays a journaled create after a worker is terminated during document embedding', async () => {
    const { root, createClient, embedding, controls, requests } = await fixture();
    const client = createClient(embedding, 1), scope = { scopeId: 'pending-create' };
    controls.hangDocument = true;
    const writing = client.remember(scope, { id: 'pending', content: 'alpha pending create', tags: ['alpha'], occurredAt: '2026-10-21T01:02:03Z' });
    const interrupted = expect(writing).rejects.toThrow(/interrupted/u);
    // Observe the actual embedding request before killing the worker. A short
    // wall-clock timeout could instead kill startup on a busy Windows runner.
    await vi.waitFor(() => expect(requests.some(request => request.path.startsWith('/document/'))).toBe(true), { timeout: 20_000 });
    await client.interruptScope(scope); await interrupted;
    controls.hangDocument = false;
    expect((await client.list(scope))[0]?.id).toBe('pending');
    const folder = path.join(root, createHash('sha256').update(scope.scopeId).digest('hex'), 'notes/memories');
    expect((await readdir(folder)).filter(file => file.endsWith('.md'))).toHaveLength(1);
  });

  it('cancels active network requests when the client closes and leaves recoverable source data', async () => {
    const { createClient, controls } = await fixture();
    const client = createClient(), scope = { scopeId: 'closing' };
    await client.remember(scope, { id: 'one', content: 'alpha closing fact', tags: ['alpha'] });
    controls.hangQuery = true;
    const searching = client.search(scope, { text: 'alpha' });
    const rejected = expect(searching).rejects.toThrow(/closing/u);
    await new Promise(resolve => setTimeout(resolve, 100));
    await client.close();
    await rejected;
    controls.hangQuery = false;
    expect((await createClient().list(scope))[0]?.id).toBe('one');
  });

  it('interrupts a busy scope immediately while the full pool has queued work and allows safe purge', async () => {
    const { createClient, controls, requests, transports } = await fixture();
    const client = createClient(undefined, 1), scope = { scopeId: 'interrupt-running' }, other = { scopeId: 'interrupt-queued' };
    await client.remember(scope, { id: 'one', content: 'alpha interrupt fact', tags: ['alpha'] });
    controls.hangQuery = true;
    const searching = client.search(scope, { text: 'alpha' });
    const rejectedSearch = expect(searching).rejects.toThrow(/interrupted/u);
    await vi.waitFor(() => expect(requests.some(request => request.path.startsWith('/query/'))).toBe(true));
    const queued = client.list(other);
    const rejectedQueued = expect(queued).rejects.toThrow(/interrupted/u);
    await new Promise(resolve => setTimeout(resolve, 50));
    await client.interruptScope(other);
    await rejectedQueued;
    expect(transports).toHaveLength(1);
    await client.interruptScope(scope);
    await rejectedSearch;
    controls.hangQuery = false;
    expect((await client.list(scope))[0]?.id).toBe('one');
    await client.interruptScope(scope);
    await client.purgeScope(scope);
    expect(await client.list(scope)).toEqual([]);
  });
});
