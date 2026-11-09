import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until<T>(read: () => T | undefined | Promise<T | undefined>) {
  const end = Date.now() + 5000;
  for (;;) { const found = await read(); if (found !== undefined) return found; if (Date.now() >= end) throw new Error('Controlled service fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(memoryError?: Error) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-real-progress-')), preparation = gate(), completion = gate(), reported: unknown[] = [];
  let run: BotDshRun | undefined, prepares = 0;
  const memory = new class extends BotMemoryService {
    override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
      prepares++; await preparation.promise; if (memoryError) throw memoryError;
      return { requestId: input.requestId, inputHash: 'controlled', scope: input.scope, messages: input.messages, metadata: {}, evidence: '', events: [], omittedChars: 0, status: 'ready' };
    }
    override async finishTurn() { return { recorded: true }; }
    override async appendHistory() { return { archived: true }; }
    override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
    override async remember() { return { state: 'indexed', indexed: true, durable: true }; }
    override async catalog() { return { items: [], tags: [], total: 0 }; }
    override async close() {}
  }({ root, runtime: async () => { throw new Error('No native runtime for controlled fixture'); }, embedding: async () => { throw new Error('No paid embedding'); } });
  const host = vi.fn(async () => { throw new Error('Native adapter progress must not start DSH'); });
  const brain = new class extends BotDshBrain {
    override async run(input: BotDshRun): Promise<BotDshResult> {
      if (input.laneId.startsWith('memory-encoder-')) return { text: '{"notes":[]}', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', inputContextCommitted: true };
      run = input; await completion.promise;
      return { text: '你好，我在。', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', inputContextCommitted: true };
    }
    override async archive() {}
  }({ getHost: host });
  const service = new BotService({ root, brain, memory, model: () => ({ model: 'controlled-local', apiKey: 'never-used-fixture', baseUrl: 'http://127.0.0.1:9', apiFormat: 'openai_chat' }),
    onEvent: () => undefined, report: error => { reported.push(error); } });
  const initial = (await service.handle({ type: 'state' })).snapshot!, conversationId = initial.conversations[0]!.id;
  cleanups.push(async () => { preparation.resolve(); completion.resolve(); await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  const send = (content = '你好') => service.handle({ type: 'message.send', conversationId, content, requestId: 'controlled' });
  const reply = async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.find(message => message.senderId !== 'user');
  const emit = (type: string, text?: string, toolName?: string) => run!.onEvent?.({ type, text, toolName, sequence: 1, receivedAt: new Date().toISOString() });
  return { service, preparation, completion, reported, host, send, reply, emit, conversationId, get run() { return run; }, get prepares() { return prepares; } };
}
it('projects actual memory/model/compaction/tool phases, retaining text across tools and returning to generation without token-wide snapshots', async () => {
  const f = await fixture(); await f.send();
  await until(async () => (await f.reply())?.progress?.phase === 'recalling-memory' ? true : undefined);
  f.preparation.resolve(); await until(() => f.run);
  expect((await f.reply())?.progress?.phase).toBe('waiting-model');
  f.emit('text_stream', '先答一半'); expect(await f.reply()).toMatchObject({ content: '先答一半', progress: { phase: 'generating' } });
  f.emit('tool_call', undefined, 'memory_history'); expect(await f.reply()).toMatchObject({ content: '先答一半', progress: { phase: 'using-tool', toolName: 'memory_history' } });
  f.emit('tool_reconciling', undefined, 'memory_history'); expect((await f.reply())?.progress).toEqual({ phase: 'using-tool', toolName: 'memory_history' });
  f.emit('tool_result'); expect((await f.reply())?.progress?.phase).toBe('preparing-context');
  f.emit('context_compacting'); expect((await f.reply())?.progress?.phase).toBe('compacting-context');
  f.emit('model_request'); expect((await f.reply())?.progress?.phase).toBe('waiting-model');
  f.emit('text_stream', '继续回答'); expect(await f.reply()).toMatchObject({ content: '继续回答', progress: { phase: 'generating' } });
  f.completion.resolve(); await until(async () => (await f.reply())?.status === 'sent' ? true : undefined);
  expect((await f.reply())?.progress).toBeUndefined(); expect(f.host).not.toHaveBeenCalled();
});
it('keeps a crashed memory preparation terminal and readable, preserves the source and reports the original technical error once', async () => {
  const original = Object.assign(new Error('Memory session closed (exit 3221226505)'), { code: 'MEMORY_SESSION_CLOSED' }), f = await fixture(original);
  await f.send(); await until(() => f.prepares ? true : undefined); f.preparation.resolve();
  await until(async () => (await f.reply())?.status === 'failed' ? true : undefined);
  expect((await f.reply())?.error).toBe('记忆服务异常退出，本条消息已保留；可重试。');
  expect(f.service.store.messagesPage(f.conversationId).items.find(message => message.senderId === 'user')?.content).toBe('你好');
  expect(f.prepares).toBe(1); expect(f.reported).toEqual([original]); expect(f.run).toBeUndefined(); expect(f.host).not.toHaveBeenCalled();
});
it('persists a v3 interaction diary even when semantic encoding returns no notes', async () => {
  const f = await fixture(); await f.send('刚刚我们一起讨论了桌面整理，尚未动手。'); f.preparation.resolve(); await until(() => f.run); f.completion.resolve();
  await until(async () => (await f.reply())?.status === 'sent' ? true : undefined);
  const companionId = f.service.store.getConversation(f.conversationId)!.memberIds.find(id => id !== 'user')!;
  const scope = { companionId, conversationId: f.conversationId, securityDomainId: f.service.store.getConversation(f.conversationId)!.securityDomainId };
  await until(() => f.service.store.memoryActivity(scope).capture.withNotes === 1 ? true : undefined);
  const response = await f.service.handle({ type: 'memory.catalog', companionId, conversationId: f.conversationId, limit: 24 });
  expect(response.memory).toMatchObject({ total: 0, activity: { capture: { empty: 0, withNotes: 1, unknownDone: 0, queued: 0, running: 0 } } });
  expect(f.host).not.toHaveBeenCalled();
});
