import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { BotMemoryService, type BotMemoryScope, type BotMemoryWrite, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';

class DurableMemory extends BotMemoryService {
  writes = 0; proofs = 0;
  private saved = new Map<string, Record<string, unknown>>();
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No native startup in this protocol fixture'); }, embedding: async () => { throw Error('No network embeddings'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, inputHash: 'fixture', messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async remember(_scope: BotMemoryScope, input: BotMemoryWrite) {
    if (!this.saved.has(input.sourceEventId)) {
      this.writes++;
      this.saved.set(input.sourceEventId, { id: input.sourceEventId, state: 'pending', durable: true, indexed: false });
      throw Object.assign(new Error('Old indexing wait lost the callback after the durable write'), { code: 'MEMORY_SYNC_TIMEOUT' });
    }
    return { receipts: [{ state: 'indexed' }], pending: 0, indexed: 1 };
  }
  override async rememberReceipt(_scope: BotMemoryScope, input: BotMemoryWrite) {
    this.proofs++; const receipt = this.saved.get(input.sourceEventId);
    return receipt ? { found: true, receipt } : { found: false };
  }
  override async close() {}
}
it.each([false, true])('recovers a lost durable write through the native HTTP callback without a replacement write; unresolved=%s', async unresolved => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-write-receipt-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-write-receipt-')) throw Error('Invalid fixture cleanup root');
  const memory = new DurableMemory(path.join(root, 'memory'));
  if (unresolved) memory.rememberReceipt = async () => { memory.proofs++; return memory.writes ? { found: true, receipt: { state: 'unknown' } } : { found: false }; };
  const brain = new BotDshBrain({ getHost: async () => { throw Error('No real DSH process in native HTTP protocol fixture'); } });
  vi.spyOn(brain, 'run').mockImplementation(async input => {
    if (input.prompt.includes('请记住我喜欢麦茶')) {
      const call = () => fetch(input.callback!.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'memory-save', name: 'memory_write', args: { content: '用户明确偏好麦茶。' } }) });
      const response = await call(), body = await response.json() as { ok: boolean; result?: unknown; error?: string };
      expect(body.ok).toBe(!unresolved);
      if (!unresolved) { expect(body.result).toMatchObject({ state: 'pending', durable: true }); expect(await (await call()).json()).toEqual(body); }
      else { expect(body.error).toContain('尚未确认'); expect((await call()).ok).toBe(false); }
      return { status: unresolved ? 'failed' : 'succeeded', text: unresolved ? '' : '已经核实保存回执。', eventId: input.eventId, sessionId: input.laneId };
    }
    return { status: 'succeeded', text: '可以继续聊天。', eventId: input.eventId, sessionId: input.laneId };
  });
  const service = new BotService({ root, brain, memory, prewarmMemory: false,
    model: () => ({ apiFormat: 'openai_chat', model: 'native-protocol', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }), onEvent: () => undefined });
  const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('Receipt recovery did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    const state = await service.handle({ type: 'state' }), room = state.snapshot!.conversations.find(conversation => conversation.kind === 'direct')!.id;
    const sent = await service.handle({ type: 'message.send', conversationId: room, requestId: 'save', content: '请记住我喜欢麦茶' });
    await until(() => ['done','failed'].includes(service.store.eventForReply(sent.replyMessageIds![0]!)?.status ?? ''));
    expect(memory.writes).toBe(1); expect(memory.proofs).toBeGreaterThanOrEqual(2);
    expect(service.store.eventForReply(sent.replyMessageIds![0]!)!.status).toBe(unresolved ? 'failed' : 'done');
    const next = await service.handle({ type: 'message.send', conversationId: room, requestId: 'next', content: '还能继续聊天吗' });
    await until(() => service.store.eventForReply(next.replyMessageIds![0]!)?.status === 'done');
    expect(memory.writes).toBe(1);
  } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
});
