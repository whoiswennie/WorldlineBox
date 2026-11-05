import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')))('archives a cold original source with both semantic and chat providers unavailable', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-source-only-'));
  const service = new BotMemoryService({ root: home, runtime: async () => ({ nodePath, packageRoot }),
    embedding: async () => ({ baseUrl: 'http://127.0.0.1:9/document', queryBaseUrl: 'http://127.0.0.1:9/query', apiKey: 'unavailable',
      model: 'archive-metadata-only', dimension: 64, modelSignature: 'archive-source-only' }),
    chat: async () => ({ baseUrl: 'http://127.0.0.1:9', apiKey: 'unavailable', model: 'unavailable' }) });
  try {
    const scope = { companionId: 'archive-owner', conversationId: 'direct', securityDomainId: 'direct' };
    const original = { id: 'source-1', role: 'user' as const, content: '有网络故障也不能丢掉这条原话。', timestamp: 1793614000000 };
    const result = await service.appendHistory(scope, [original]);
    expect(result).toMatchObject({ appended: [{ messageId: original.id, episode: 'episode-00000000' }] });
    const [domain] = await readdir(home);
    const history = JSON.parse(await readFile(path.join(home, domain!, 'sessions/agent/id-archive-owner/id-episode-00000000/history.json'), 'utf8'));
    expect(history).toEqual([expect.objectContaining(original)]);
    expect(await service.appendHistory(scope, [original])).toMatchObject({ appended: [] });
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});
// This verifies the real module, SQLite/native receipt path and CDS transport.
// Provider vectors are deliberate protocol fixtures, not a recall-quality test.
it.skipIf(!existsSync(path.join(packageRoot, 'node_modules', 'better-sqlite3')) || !existsSync(nodePath))('runs original VCP writes, version receipts, RAG, resident TopicMemo and bounded histories', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-runtime-'));
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { response.writeHead(404).end(); return; }
    const payload = JSON.parse(body); const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: 'fixture64',
      data: inputs.map((_: string, index: number) => ({ object: 'embedding', index, embedding: Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0.01) })),
      usage: { prompt_tokens: 8, total_tokens: 8 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server failed');
  const base = `http://127.0.0.1:${address.port}`;
  const logs: string[] = [];
  const options: BotMemoryOptions = { root: home, runtime: async () => ({ nodePath, packageRoot }),
    embedding: async () => ({ baseUrl: base + '/document', queryBaseUrl: base + '/query', apiKey: 'fixture', model: 'fixture64', dimension: 64, modelSignature: 'fixture64-v1' }),
    chat: async () => ({ baseUrl: base, apiKey: 'fixture', model: 'fixture-no-chat' }), requestTimeoutMs: 60000,
    onLog: line => logs.push(line) };
  let service = new BotMemoryService(options);
  const scope = { companionId: '测试伙伴', conversationId: 'dm', securityDomainId: 'dm' };
  try {
    const fact = { sourceEventId: 'decision-17', sourceRootEventId: 'root-decision-17', sourceMessageIds: ['msg-100', 'answer-100'],
      content: '项目 ADR-017 的最终决定是使用 SQLite 保存消息。', tags: 'SQLite,项目决策', waitForIndex: true };
    const write = await service.remember(scope, fact);
    expect(write).toMatchObject({ indexed: 1, pending: 0 });
    const repeated = await service.remember(scope, fact);
    expect(repeated).toMatchObject({ indexed: 1 });
    const search = await service.tool(scope, 'LightMemo', { query: 'ADR-017 最终用了什么保存消息' });
    expect(JSON.stringify(search)).toContain('SQLite');
    const prepared = await service.prepareTurn({ scope, requestId: 'question-17', messages: [{ id: 'question-17', role: 'user', content: 'ADR-017 最终用了什么保存消息？', timestamp: Date.now() }] });
    expect(prepared.evidence).toContain('SQLite');
    expect(prepared.status).toBe('ready');
    expect(prepared.metadata.oneRing).toBeTruthy();
    await expect(service.prepareTurn({ scope, requestId: 'question-17', messages: [{ id: 'late', role: 'assistant', content: '群里较早的回复刚完成', timestamp: Date.now() }] }))
      .rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    expect(await service.resumePrepared({ scope, requestId: 'question-17' })).toEqual(prepared);
    await service.prepareTurn({ scope, requestId: 'root-decision-17', messages: [{ id: 'msg-100', role: 'user', content: '原始决策', timestamp: 1793610000100 }] });
    await service.finishTurn(prepared, '最终选择 SQLite。', true);
    const messages = Array.from({ length: 101 }, (_, i) => ({ id: `msg-${i}`, role: 'user' as const, content: `事件${i} SQLite 决策`, timestamp: 1793610000000 + i }));
    await service.appendHistory(scope, messages);
    await service.appendHistory(scope, messages.slice(-2));
    const status = await service.status(scope); expect(status).toMatchObject({ historyMessages: 101, indexed: 1 });
    const topics = await service.tool(scope, 'TopicMemo', {});
    expect(JSON.stringify(topics)).toContain('episode-00000000'); expect(JSON.stringify(topics)).toContain('episode-00000001');
    const content = await service.tool(scope, 'TopicMemo', { topic_id: 'episode-00000001' });
    expect(JSON.stringify(content)).toContain('事件100');
    // Initialize original Tantivy first, then ingest into the same episode.
    // This must update search visibility without a full managed-home reconcile.
    expect(JSON.stringify(await service.tool(scope, 'DeepMemo', { keyword: '事件100' }))).toContain('事件100');
    await service.appendHistory(scope, [{id:'incremental-after-index',role:'user',content:'唯一锚点 NATIVEINCREMENTAL2026 原始索引更新。',timestamp:1793610001002}]);
    expect(JSON.stringify(await service.tool(scope, 'DeepMemo', { keyword: 'NATIVEINCREMENTAL2026' }))).toContain('原始索引更新');
    const dirs = await readdir(home); expect(dirs).toHaveLength(1);
    const domainFiles = await readdir(path.join(home, dirs[0]!));
    expect(domainFiles).toContain('bot-adapter.sqlite'); expect(domainFiles).not.toContain('prepared'); expect(domainFiles).not.toContain('completed');
    const catalog = await service.list(scope); expect(catalog).toHaveLength(1);
    const forgetting = service.forget(scope, { id: catalog[0]!.id });
    // Queue reads and a replay while the original worker is still deleting and
    // releasing its home lock. All must run on the legal replacement generation.
    const concurrentQuery = service.tool(scope, 'LightMemo', { query: 'ADR-017 最终用了什么保存消息' });
    const concurrentHistory = service.tool(scope, 'TopicMemo', { topic_id: 'episode-00000001' });
    const concurrentReplay = service.remember(scope, fact);
    const [forget, removed, afterForget, replay] = await Promise.all([forgetting, concurrentQuery, concurrentHistory, concurrentReplay]);
    expect(forget).toMatchObject({ forgotten: true, sourceEventIds: ['root-decision-17','decision-17'], sourceMessageIds: ['msg-100', 'answer-100'], physicalSourceErasure: false });
    expect(forget.revision).toBe('1');
    await expect(service.resumePrepared({ scope, requestId: 'root-decision-17' })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' });
    // Domain retirement/reopen proves that neither cached vectors nor a restart
    // resurrect the note. Its source replay is accepted as withdrawn, not saved.
    expect(await service.list(scope)).toEqual([]);
    expect(replay).toMatchObject({ withdrawn: true, indexed: 0 });
    await service.appendHistory(scope, [messages[100]!]);
    expect(JSON.stringify(afterForget)).not.toContain('事件100');
    expect(JSON.stringify(removed)).not.toContain('SQLite');
    await expect(service.forget(scope, { id: '../outside.txt' })).rejects.toThrow('Owned memory id');
    await service.remember(scope, { sourceEventId: 'manual-note', content: '独立人工笔记，撤回时没有原聊天消息ID。' });
    const manual = (await service.list(scope))[0]!;
    await service.close();
    // Reproduce the durable crash point: the withdrawal transaction committed,
    // but deletion and the application's context-epoch update did not run.
    const interrupted = spawnSync(nodePath, ['-e', `
      const D=require('better-sqlite3');const db=new D(process.argv[1]);
      db.transaction(()=>{const now=new Date().toISOString();
        db.prepare("INSERT INTO tombstones VALUES('note',?,?)").run(process.argv[2],now);
        db.prepare("INSERT INTO tombstones VALUES('event','manual-note',?)").run(now);
        db.prepare("UPDATE mutations SET state='withdrawing' WHERE id=?").run(process.argv[2]);
        db.prepare("UPDATE metadata SET value=value+1 WHERE key='forget-revision'").run();
      })();db.close();
    `, path.join(home, dirs[0]!, 'bot-adapter.sqlite'), manual.id], { cwd: packageRoot, encoding: 'utf8', windowsHide: true });
    expect(interrupted.status, interrupted.stderr).toBe(0);
    service = new BotMemoryService(options);
    // The source-only catalog can truthfully show cleanup still pending without
    // booting the semantic engine. The first actual memory activation repairs it.
    expect(await service.list(scope)).toEqual([expect.objectContaining({ id: manual.id, indexState: 'withdrawing', content: '' })]);
    await service.status(scope);
    expect(await service.list(scope)).toEqual([]);
    const withdrawal = await service.withdrawnSources(scope);
    expect(withdrawal.revision).toBe('2');
    const manualForget = await service.forget(scope, { id: manual.id });
    expect(manualForget.revision).toBe('2'); expect(manualForget.sourceMessageIds).toEqual([]);
    expect((await service.withdrawnSources(scope)).revision).toBe('2');
  } catch (error) {
    throw new Error(`${String(error)}\n${logs.join('').slice(-12000)}`, { cause: error });
  } finally {
    await service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 90000);

it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')))('retires a real resident worker on deadline instead of only rejecting a Promise', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-abort-'));
  const client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs');
  const session = client.createSession({ home, nodePath });
  try {
    await expect(session.request('status', {}, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'MEMORY_TIMEOUT' });
    await session.close().catch(() => undefined);
    await expect(session.request('status')).rejects.toThrow('closed');
  } finally { await session.close().catch(() => undefined); await rm(home, { recursive: true, force: true }); }
}, 10000);

it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')))('evicts an actually killed idle worker and reacquires its home lease before durable source recovery', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-killed-worker-'));
  const client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs');
  const sessions: Array<{ pid: number; closed: Promise<void> }> = [];
  const service = new BotMemoryService({ root: home, runtime: async () => ({ nodePath, packageRoot }),
    embedding: async () => ({ baseUrl: 'http://127.0.0.1:9/document', queryBaseUrl: 'http://127.0.0.1:9/query', apiKey: 'unused',
      model: 'source-only', dimension: 64, modelSignature: 'source-only-recovery' }),
    createSession: options => { const session = client.createSession(options); sessions.push(session); return session; } });
  const scope = { companionId: 'killed-owner', conversationId: 'dm', securityDomainId: 'dm' };
  const first = { id: 'before-crash', role: 'user' as const, content: '已确认落盘的原话。', timestamp: 1793614000000 };
  try {
    await service.appendHistory(scope, [first]);
    const original = sessions[0]!; expect(Number.isSafeInteger(original.pid) && original.pid > 0).toBe(true);
    process.kill(original.pid);
    await expect(original.closed).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED' });
    const recovered = await service.appendHistory(scope, [first, { ...first, id: 'after-crash', content: '恢复后新增的原话。' }]);
    expect(sessions).toHaveLength(2); expect(sessions[1]!.pid).not.toBe(original.pid);
    expect(recovered).toMatchObject({ appended: [{ messageId: 'after-crash' }] });
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
}, 30000);

it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')))('reconnects one real catalog read after its worker is killed and preserves the durable original history', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-read-reconnect-')), resolved = path.resolve(home);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('bot-memory-read-reconnect-')) throw new Error('Unexpected owned recovery fixture');
  const client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs');
  const sessions: Array<{ pid: number; closed: Promise<void> }> = [];
  let interrupt = false;
  const service = new BotMemoryService({ root: home, runtime: async () => ({ nodePath, packageRoot }),
    embedding: async () => ({ baseUrl: 'http://127.0.0.1:9/document', queryBaseUrl: 'http://127.0.0.1:9/query', apiKey: 'unused',
      model: 'source-only', dimension: 64, modelSignature: 'read-reconnect-source-only' }),
    createSession: options => {
      const session = client.createSession(options); sessions.push(session);
      return { closed: session.closed, close: () => session.close(), request: async (operation, payload, requestOptions) => {
        if (interrupt && operation === 'bot.catalog') {
          interrupt = false; process.kill(session.pid); await session.closed.catch(() => undefined);
        }
        return session.request(operation, payload, requestOptions);
      } };
    } });
  const scope = { companionId: 'read-owner', conversationId: 'dm', securityDomainId: 'dm' };
  const original = { id: 'original-before-read-crash', role: 'user' as const, content: '用于隔离生命周期验证的原话。', timestamp: 1793614000000 };
  try {
    await service.appendHistory(scope, [original]); interrupt = true;
    const catalog = await service.catalog(scope, { limit: 1 }); expect(catalog).toMatchObject({ items: [], total: 0 });
    expect(sessions).toHaveLength(2); expect(sessions[1]!.pid).not.toBe(sessions[0]!.pid);
    const [domain] = await readdir(home);
    const history = JSON.parse(await readFile(path.join(home, domain!, 'sessions/agent/id-read-owner/id-episode-00000000/history.json'), 'utf8'));
    expect(history).toEqual([expect.objectContaining(original)]);
    expect(await service.appendHistory(scope, [original])).toMatchObject({ appended: [] });
  } finally { await service.close(); await rm(resolved, { recursive: true, force: true }); }
}, 30000);
