import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { BotMemoryService, type BotMemoryScope, type BotMemoryWrite, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
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
it.each([false, true])('recovers a lost write through the real HTTP tool and retention paths; irrecoverable=%s', async irrecoverable => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-write-receipt-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-write-receipt-')) throw Error('Invalid fixture cleanup root');
  const memory = new DurableMemory(path.join(root, 'memory'));
  if (irrecoverable) memory.rememberReceipt = async () => { memory.proofs++; return { found: true, receipt: { state: 'unknown' } }; };
  const app = new BotAppBrain({ root: path.join(root, 'app-brain'), reconcileTool: (call, signal) => service.reconcileToolReceipt(call, signal),
    fetchFn: async (url, init) => {
      if (new URL(String(url)).hostname !== 'model.invalid') return fetch(url, init);
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0].content), current = body.messages.findLast((message: { role: string }) => message.role === 'user');
      const trigger = (() => { try { return JSON.parse(current.content).trigger?.content; } catch { return undefined; } })();
      const firstWrite = trigger === '请记住我喜欢麦茶' && !body.messages.some((message: { role: string }) => message.role === 'tool');
      const delta = firstWrite ? { tool_calls: [{ index: 0, id: 'memory-save', type: 'function', function: { name: 'memory_write', arguments: JSON.stringify({ content: '用户明确偏好麦茶。' }) } }] }
        : { content: system.includes('对话记忆编码器') ? '{"notes":[]}' : '已经核实保存回执，可以继续聊天；索引由后台处理。' };
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: firstWrite ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  const worker = new BotDshBrain({ getHost: async () => { throw Error('This fixture cannot launch DSH'); } });
  const service: BotService = new BotService({ root, brain: new BotBrainRouter({ app, worker }), memory, brainRuntime: 'worldlinebox', prewarmMemory: false,
    model: () => ({ apiFormat: 'openai_chat', model: 'local-protocol', baseUrl: 'http://model.invalid/v1', apiKey: 'fixture', contextWindow: 1000000 }), onEvent: () => undefined });
  const until = async (check: () => boolean) => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('Receipt recovery did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    const state = await service.handle({ type: 'state' }), room = state.snapshot!.conversations.find(conversation => conversation.kind === 'direct')!.id;
    const sent = await service.handle({ type: 'message.send', conversationId: room, requestId: 'save', content: '请记住我喜欢麦茶' });
    if (irrecoverable) {
      await until(() => memory.proofs > 0);
      await service.handle({ type: 'reply.cancel', messageId: sent.replyMessageIds![0]! });
    } else await until(() => service.store.eventForReply(sent.replyMessageIds![0]!)?.status === 'done');
    expect(memory.writes).toBe(1); expect(memory.proofs).toBeGreaterThanOrEqual(1);
    const next = await service.handle({ type: 'message.send', conversationId: room, requestId: 'next', content: '还能继续聊天吗' });
    await until(() => service.store.eventForReply(next.replyMessageIds![0]!)?.status === 'done');
    expect(memory.writes).toBe(1);
    if (irrecoverable) {
      const prior = service.store.eventForReply(sent.replyMessageIds![0]!)!;
      expect(prior.status).toBe('cancelled'); expect(service.store.pendingCancelledNativeAdmissions(prior.laneId)).toEqual([]);
    }
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
