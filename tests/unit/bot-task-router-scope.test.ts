import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BotService } from '../../src/main/companion-bot/service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class Memory extends BotMemoryService {
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> { return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'scope', metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { archived: true }; }
  override async finishTurn() { return { recorded: true }; }
  override async close() {}
}

it('binds a real main-brain task-list callback to its own companion and room while the user owner can explicitly view another group companion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-router-task-scope-')), tools: string[] = [];
  const host = vi.fn(async () => { throw Error('Task catalogue inspection must not start DSH.'); });
  let calls = 0;
  const app = new BotAppBrain({ root: path.join(root, 'router'), fetchFn: async (url, init) => {
    if (new URL(String(url)).pathname === '/bot/tool') return fetch(url, init);
    calls++; const body = JSON.parse(String(init!.body)) as { messages: Array<{ role: string; content: string }> };
    const result = body.messages.findLast(message => message.role === 'tool'); if (result) tools.push(result.content);
    return Response.json({ choices: [{ finish_reason: result ? 'stop' : 'tool_calls', message: result ? { content: '已读取我的任务。' }
      : { content: '', tool_calls: [{ id: 'own-list', type: 'function', function: { name: 'dsh_task_control', arguments: JSON.stringify({ operation: 'list', companionId: 'bob', conversationId: 'attempt-other-room', limit: 30 }) } }] } }] });
  } });
  const service = new BotService({ root, brainRuntime: 'worldlinebox', brain: new BotBrainRouter({ app, worker: new BotDshBrain({ getHost: host }) }),
    memory: new Memory({ root: path.join(root, 'memory'), runtime: async () => { throw Error('No VCP fixture'); }, embedding: async () => { throw Error('No embedding fixture'); } }),
    model: () => ({ apiFormat: 'openai_chat', model: 'local-scope-protocol', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture-no-billing', contextWindow: 65536, maxTokens: 512 }), onEvent: () => undefined });
  cleanup.push(async () => { await service.shutdown(); if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-router-task-scope-')) throw Error('Invalid scope cleanup'); await rm(root, { recursive: true, force: true }); });
  await service.handle({ type: 'state' }); for (const id of ['alice', 'bob']) service.store.createCompanion({ id, name: id, persona: '公开角色' });
  const group = service.store.createGroup({ title: '共有任务群', memberIds: ['alice', 'bob'], participationMode: 'mentions' }), direct = service.store.openDirect('alice');
  const seed = (conversationId: string, companionId: string, id: string) => {
    const source = service.store.enqueue({ conversationId, senderId: 'user', recipientIds: [companionId], sourceMessageId: `source-${id}`, content: '既有任务来源' }).events[0]!;
    const claim = service.store.claim({ workerId: 'seed' })!; expect(claim.event.id).toBe(source.id);
    service.store.settle({ eventId: source.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
    service.store.createTask({ id, conversationId, companionId, sourceEventId: source.id, goal: id, extra: { nativeAttempted: true, retryAt: Date.now() + 60000 } });
  };
  seed(group.id, 'alice', 'ALICE_OWN_GROUP_TASK'); seed(group.id, 'bob', 'BOB_OTHER_COMPANION_TASK'); seed(direct.id, 'alice', 'ALICE_OTHER_PRIVATE_ROOM_TASK');
  const userView = await service.handle({ type: 'task.list', conversationId: group.id, companionId: 'bob', filter: 'all', page: 0, limit: 6 });
  expect(userView.taskPage!.items.map(task => task.id)).toEqual(['BOB_OTHER_COMPANION_TASK']); expect(userView.taskPage!.total).toBe(1);
  expect(userView.taskPage!.activeCount).toBe(1); expect(userView.taskPage!.queuedCount).toBe(1);
  const sent = await service.handle({ type: 'message.send', conversationId: group.id, requestId: 'list-my-tasks', content: '@alice 请列出你的任务。' });
  service.store.taskTransaction(sql => { for (const row of sql.prepare('SELECT id FROM bot_inbox WHERE source_record_id=?').all(sent.messageId)) service.store.setMetadata(`skipCapture:${(row as { id: string }).id}`, 'true'); });
  const deadline = Date.now() + 10000; while (!tools.length) { if (Date.now() > deadline) throw Error('Real task-list callback did not return.'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const result = JSON.parse(tools[0]!) as { items: Array<{ id: string; companionId: string; conversationId: string }>; total: number; activeCount: number; queuedCount: number };
  expect(result.items.map(task => task.id)).toEqual(['ALICE_OWN_GROUP_TASK']); expect(result.items[0]).toMatchObject({ companionId: 'alice', conversationId: group.id });
  expect(result).toMatchObject({ total: 1, activeCount: 1, queuedCount: 1 });
  expect(tools[0]).not.toMatch(/BOB_OTHER_COMPANION_TASK|ALICE_OTHER_PRIVATE_ROOM_TASK/u); expect(calls).toBe(2); expect(host).not.toHaveBeenCalled();
});
