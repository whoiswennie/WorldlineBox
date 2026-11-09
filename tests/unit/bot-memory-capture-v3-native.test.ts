import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotMemoryService, type BotMemoryOptions, type BotMemoryScope } from '../../src/main/companion-bot/memory-service';
import { captureBotMemory, type BotMemoryCaptureInput } from '../../src/main/companion-bot/memory-capture';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotService } from '../../src/main/companion-bot/service';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const available = existsSync(nodePath) && existsSync(path.join(packageRoot, 'node_modules', 'better-sqlite3'));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function nativeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-native-diary-concurrency-'));
  const unexpected: string[] = [], logs: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { unexpected.push(request.url ?? ''); response.writeHead(404).end(); return; }
    const input = JSON.parse(body).input, rows = Array.isArray(input) ? input : [input];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: 'fixture64',
      data: rows.map((_: unknown, index: number) => ({ object: 'embedding', index, embedding: Array.from({ length: 64 }, (_, i) => i ? .01 : 1) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned embedding endpoint');
  const base = `http://127.0.0.1:${address.port}`;
  const options: BotMemoryOptions = { root: path.join(root, 'memory'), maxActiveDomains: 4, runtime: async () => ({ packageRoot, nodePath }),
    embedding: async () => ({ baseUrl: base + '/document', queryBaseUrl: base + '/query', apiKey: 'fixture', model: 'fixture64', dimension: 64, modelSignature: 'fixture64-v1' }),
    chat: async () => ({ baseUrl: base, apiKey: 'fixture', model: 'no-chat' }), onLog: line => logs.push(line) };
  const memories: BotMemoryService[] = [];
  const memory = () => { const item = new BotMemoryService(options); memories.push(item); return item; };
  const cleanup = async () => {
    for (const item of memories) await item.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-native-diary-concurrency-')) throw Error('Unexpected fixture cleanup target');
    await rm(root, { recursive: true, force: true });
  };
  const notes = async (scope: BotMemoryScope) => {
    const notebook = path.join(options.root, hash(JSON.stringify([scope.companionId, scope.securityDomainId])), 'dailynote', 'Companion');
    const files = await readdir(notebook); return Promise.all(files.filter(name => name.endsWith('.txt')).map(name => readFile(path.join(notebook, name), 'utf8')));
  };
  return { root, options, memory, cleanup, unexpected, logs, notes };
}

it.skipIf(!available)('uses real VCP DailyNote/index receipts for concurrent companions and audiences without duplicate diaries after replay or restart', async () => {
  const f = await nativeFixture();
  try {
    const memory = f.memory(), run = vi.fn<BotMemoryCaptureInput['brain']['run']>(async input => ({ status: 'succeeded', text: '{"notes":[]}', eventId: input.eventId, sessionId: input.laneId }));
    const scopes: BotMemoryScope[] = [
      { companionId: 'alice', conversationId: 'alice-dm', securityDomainId: 'alice-dm' },
      { companionId: 'alice', conversationId: 'shared-group', securityDomainId: 'shared-group' },
      { companionId: 'bob', conversationId: 'bob-dm', securityDomainId: 'bob-dm' },
    ];
    const jobs = [scopes[0]!, scopes[1]!, scopes[2]!, scopes[0]!].map((scope, index): BotMemoryCaptureInput => ({
      memory, brain: { run, archive: async () => undefined }, scope, cwd: path.join(f.root, 'encoder'), jobId: 'job-' + index, sourceEventId: 'completed-turn-' + index,
      policyVersion: 3, completed: true, capturedAt: '2026-11-09T08:00:00Z', answerMessageId: 'answer-' + index,
      model: { apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', model: 'fixture' }, callback: { url: 'http://127.0.0.1:9', token: 'unused' },
      messages: [{ id: 'source-' + index, senderId: index === 1 ? 'bob' : 'user', senderName: index === 1 ? 'Bob' : '用户', role: 'user', content: '并发互动需求 ' + index, timestamp: 1794211200000 }],
      answer: '这是第 ' + index + ' 次原生会话的实际公开答复。',
    }));
    expect(await Promise.all([...jobs, jobs[0]!, jobs[1]!].map(input => captureBotMemory(input)))).toEqual(Array(6).fill({ notes: 1 }));
    expect(run).toHaveBeenCalledTimes(4);
    for (let index = 0; index < scopes.length; index++) {
      const scope = scopes[index]!, entries = await memory.list(scope), texts = await f.notes(scope);
      expect(entries).toHaveLength(index === 0 ? 2 : 1); expect(texts).toHaveLength(entries.length);
      expect(entries.every(note => note.indexState === 'indexed')).toBe(true);
      expect(texts.every(text => text.includes('互动日记') && text.includes('来源事件：completed-turn-'))).toBe(true);
    }
    expect((await f.notes(scopes[1]!))[0]).toContain('Bob (bob)');
    await memory.close();
    const restarted = f.memory();
    expect(await captureBotMemory({ ...jobs[0]!, memory: restarted })).toEqual({ notes: 1 });
    expect(run).toHaveBeenCalledTimes(4); expect(await restarted.list(scopes[0]!)).toHaveLength(2);
    expect(await f.notes(scopes[0]!)).toHaveLength(2); expect(f.unexpected).toEqual([]);
  } catch (error) { throw new Error(String(error) + '\n' + f.logs.join('').slice(-4000), { cause: error }); }
  finally { await f.cleanup(); }
}, 90_000);

it.skipIf(!available)('recovers a persisted service capture queue after restart without creating another native DailyNote', async () => {
  const f = await nativeFixture(), services: BotService[] = [];
  const makeBrain = (failExtraction: boolean) => {
    const brain = new BotDshBrain({ getHost: async () => { throw Error('No real DSH process in this VCP integration test'); } });
    vi.spyOn(brain, 'run').mockImplementation(async input => {
      const encoder = input.laneId.startsWith('memory-encoder-');
      if (encoder && failExtraction) throw Error('Simulated interruption after the indexed interaction diary');
      return { status: 'succeeded', text: encoder ? '{"notes":[]}' : '工作已完成，以下是公开答复。', eventId: input.eventId, sessionId: input.laneId };
    });
    vi.spyOn(brain, 'archive').mockResolvedValue(); return brain;
  };
  const open = (brain: BotDshBrain) => { const service = new BotService({ root: path.join(f.root, 'service'), memory: f.memory(), brain,
    model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused', model: 'fixture' }), onEvent: () => undefined }); services.push(service); return service; };
  const until = async (check: () => boolean, timeout = 40000) => { const deadline = Date.now() + timeout; while (!check()) { if (Date.now() > deadline) throw Error('Durable native diary queue did not settle'); await new Promise(resolve => setTimeout(resolve, 25)); } };
  try {
    const first = open(makeBrain(true)), state = (await first.handle({ type: 'state' })).snapshot!, room = state.conversations[0]!;
    const sent = await first.handle({ type: 'message.send', conversationId: room.id, content: '请记录这次完成的实际互动。', requestId: 'durable-diary-once' });
    const event = first.store.eventForReply(sent.replyMessageIds![0]!)!;
    await until(() => first.store.getEvent(event.id)?.status === 'done');
    const scope = { companionId: event.companionId, conversationId: room.id, securityDomainId: room.id };
    await until(() => first.store.taskTransaction(sql => Number((sql.prepare("SELECT COUNT(*) AS n FROM bot_memory_jobs WHERE kind='capture' AND error LIKE '%Simulated interruption%'").get() as { n: number }).n)) > 0);
    expect(await f.notes(scope)).toHaveLength(1);
    await first.shutdown();
    const next = open(makeBrain(false)); await next.handle({ type: 'state', conversationId: room.id });
    await until(() => next.store.taskTransaction(sql => Number((sql.prepare("SELECT COUNT(*) AS n FROM bot_memory_jobs WHERE kind='capture' AND status='done'").get() as { n: number }).n)) === 1);
    const jobs = next.store.taskTransaction(sql => sql.prepare("SELECT id,status FROM bot_memory_jobs WHERE kind='capture'").all()) as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(1); expect(JSON.parse(next.store.getMetadata('memory-capture-result:' + jobs[0]!.id)!)).toMatchObject({ policyVersion: 3, notes: 1 });
    expect(await f.notes(scope)).toHaveLength(1);
    expect((await f.notes(scope))[0]).toContain('请记录这次完成的实际互动。');
    expect(f.unexpected).toEqual([]);
  } catch (error) { throw new Error(String(error) + '\n' + f.logs.join('').slice(-4000), { cause: error }); }
  finally { for (const service of services) await service.shutdown(); await f.cleanup(); }
}, 90_000);
