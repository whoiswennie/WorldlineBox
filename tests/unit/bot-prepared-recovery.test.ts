import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotDshBrain, BotDshDeliveryUnknownError, type BotDshResult, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
class ObservedMemory extends BotMemoryService {
  inputs: Array<Parameters<BotMemoryService['prepareTurn']>[0]> = [];
  resumed: string[] = [];
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { this.inputs.push(input); return super.prepareTurn(input); }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]) { this.resumed.push(input.requestId); return super.resumePrepared(input); }
}
class BrainBoundary extends BotDshBrain {
  calls: BotDshRun[] = [];
  constructor(private readonly handler: (input: BotDshRun) => Promise<string>) { super({ getHost: async () => { throw new Error('No real DSH Host or LLM in this test'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    this.calls.push(input);
    const text = input.laneId.startsWith('memory-encoder-') ? '{"notes":[]}' : await this.handler(input);
    return { text, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), status: 'succeeded', inputContextCommitted: true };
  }
  override async close() {}
  override async archive() {}
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(check: () => boolean, timeout = 15000) {
  const started = Date.now(); while (!check()) { if (Date.now() - started > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

// Uses the actual VCP Node/native SQLite worker and its strict prepared-input hash.
// Embeddings are a local protocol fixture; the brain is a controlled transport boundary.
it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'node_modules', 'better-sqlite3')))('resumes the exact VCP preparation when another group lane publishes an earlier reply during unknown delivery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-prepared-recovery-')), unexpected: string[] = [];
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-prepared-recovery-')) throw new Error('Invalid fixture cleanup target');
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { unexpected.push(request.url ?? ''); response.writeHead(404).end(); return; }
    const payload = JSON.parse(body), inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: 'fixture64',
      data: inputs.map((_: string, index: number) => ({ object: 'embedding', index, embedding: Array.from({ length: 64 }, (_, i) => i ? .01 : 1) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  const base = `http://127.0.0.1:${address.port}`, logs: string[] = [], bob = gate(), retry = gate(); let secondAttempts = 0;
  const memory = new ObservedMemory({ root: path.join(root, 'memory'), runtime: async () => ({ packageRoot, nodePath }),
    embedding: async () => ({ baseUrl: base + '/document', queryBaseUrl: base + '/query', apiKey: 'fixture', model: 'fixture64', dimension: 64, modelSignature: 'fixture64-v1' }),
    chat: async () => ({ baseUrl: base, apiKey: 'fixture', model: 'no-chat' }), onLog: line => logs.push(line) });
  const brain = new BrainBoundary(async input => {
    const prompt = JSON.parse(input.prompt), isAlice = prompt.envelope.companionId === DEFAULT_BOT_COMPANION_ID;
    if (!isAlice && prompt.trigger.content === 'second') { await bob.promise; return 'Bob较早的回复刚完成'; }
    if (isAlice && prompt.trigger.content === 'second') {
      if (++secondAttempts === 1) throw new BotDshDeliveryUnknownError('lost native event stream');
      await retry.promise; return 'Alice第二轮已从原始输入恢复';
    }
    return '普通回复';
  });
  const service = new BotService({ root, brain, memory, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: base, apiKey: 'fixture' }), onEvent: () => undefined });
  try {
    await service.handle({ type: 'state' });
    const bobId = 'zz-late-bob'; service.store.createCompanion({ id: bobId, name: 'Bob', persona: '另一位伙伴' });
    const group = await service.handle({ type: 'conversation.create', title: '恢复测试群', kind: 'group', memberIds: [DEFAULT_BOT_COMPANION_ID, bobId], participationMode: 'all' });
    const conversationId = group.conversationId!;
    await service.handle({ type: 'message.send', conversationId, content: 'first', requestId: 'first' });
    await waitFor(() => brain.calls.filter(call => !call.laneId.startsWith('memory-encoder-')).length === 2
      && brain.calls.filter(call => !call.laneId.startsWith('memory-encoder-')).every(call => service.store.getEvent(call.eventId)?.status === 'done'));
    await service.handle({ type: 'message.send', conversationId, content: 'second', requestId: 'second' });
    await waitFor(() => secondAttempts === 1);
    await waitFor(() => brain.calls.some(call => JSON.parse(call.prompt).envelope?.companionId === bobId && JSON.parse(call.prompt).trigger?.content === 'second'));
    const earlierBob = brain.calls.find(call => JSON.parse(call.prompt).envelope?.companionId === bobId && JSON.parse(call.prompt).trigger?.content === 'second')!;
    bob.resolve();
    await waitFor(() => service.store.getEvent(earlierBob.eventId)?.status === 'done');
    await waitFor(() => secondAttempts === 2);
    const attempts = brain.calls.filter(call => call.eventId === brain.calls.find(item => JSON.parse(item.prompt).trigger?.content === 'second' && JSON.parse(item.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID)!.eventId);
    const original = memory.inputs.find(input => input.requestId === attempts[0]!.eventId)!;
    expect(memory.inputs.filter(input => input.requestId === original.requestId)).toHaveLength(1);
    expect(memory.resumed).toContain(original.requestId);
    expect(attempts[1]!.prompt).toBe(attempts[0]!.prompt); expect(attempts[1]!.system).toBe(attempts[0]!.system);
    const late = service.store.getMessage(service.store.getEvent(earlierBob.eventId)!.replyMessageId)!;
    expect(original.messages.some(message => message.id === late.id)).toBe(false);
    await expect(memory.prepareTurn({ ...original, messages: [...original.messages, { id: late.id, role: 'user', content: late.content,
      timestamp: Date.parse(late.createdAt), senderId: late.senderId, senderName: late.senderName }] })).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    retry.resolve(); await waitFor(() => service.store.getEvent(original.requestId)?.status === 'done');
    expect(service.store.getMessage(service.store.getEvent(original.requestId)!.replyMessageId)?.content).toBe('Alice第二轮已从原始输入恢复');
    await service.handle({ type: 'message.send', conversationId, content: 'third', requestId: 'third' });
    await waitFor(() => brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).trigger.content === 'third' && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID));
    const third = brain.calls.find(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).trigger.content === 'third' && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID)!;
    expect(JSON.parse(third.prompt).history.filter((message: { id: string }) => message.id === late.id)).toEqual([expect.objectContaining({ content: late.content })]);
    await waitFor(() => service.store.getEvent(third.eventId)?.status === 'done');
    await service.handle({ type: 'message.send', conversationId, content: 'fourth', requestId: 'fourth' });
    await waitFor(() => brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).trigger.content === 'fourth' && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID));
    const fourth = brain.calls.find(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).trigger.content === 'fourth' && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID)!;
    expect(JSON.parse(fourth.prompt).history.some((message: { id: string }) => message.id === late.id)).toBe(false);
    expect(unexpected).toEqual([]);
  } catch (error) { throw new Error(`${String(error)}\n${logs.join('').slice(-8000)}`, { cause: error }); }
  finally {
    bob.resolve(); retry.resolve(); await service.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
