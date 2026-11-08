import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotMemoryService, type BotMemoryScope } from '../../src/main/companion-bot/memory-service';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it('forwards targeted source mode to the actual VCP protocol boundary and leaves ordinary withdrawals unmodified', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-notice-withdraw-')), calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const memory = new BotMemoryService({ root, runtime: async () => ({ nodePath: process.execPath, packageRoot: '/unused-protocol-fixture' }),
    embedding: async () => ({ baseUrl: 'http://127.0.0.1/document', queryBaseUrl: 'http://127.0.0.1/query', model: 'fixture', dimension: 8, modelSignature: 'protocol-fixture', apiKey: 'fixture' }),
    createSession: () => ({ close: async () => {}, request: async (operation: string, payload: Record<string, unknown>) => {
      calls.push({ operation, payload });
      if (operation === 'bot.sources.withdraw') return { withdrawn: true, revision: '1', sourceEventIds: [], sourceMessageIds: payload.sourceMessageIds };
      return { status: 'success', pending: 0, indexed: 0, uncertain: 0 };
    } }) });
  cleanups.push(async () => { await memory.close(); await rm(root, { recursive: true, force: true }); });
  const scope: BotMemoryScope = { companionId: 'alice', conversationId: 'peer', securityDomainId: 'peer' };
  await memory.withdrawSources(scope, { sourceEventIds: [], sourceMessageIds: ['private-notice'], mode: 'isolated-task-notices' });
  await memory.withdrawSources(scope, { sourceEventIds: [], sourceMessageIds: ['ordinary-user-withdrawal'] });
  expect(calls.filter(call => call.operation === 'bot.sources.withdraw').map(call => call.payload)).toEqual([
    { companionId: 'alice', sourceEventIds: [], sourceMessageIds: ['private-notice'], mode: 'isolated-task-notices' },
    { companionId: 'alice', sourceEventIds: [], sourceMessageIds: ['ordinary-user-withdrawal'] },
  ]);
});

it('splits one production outbox page into exact/private and ordinary batches, preserving public replies through acknowledgements and retry', async () => {
  const store = new BotStore(':memory:'); cleanups.push(async () => store.close());
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '长期伙伴' });
  const room = store.openPeer('alice', 'bob');
  const notice = store.enqueue({ conversationId: room.id, senderId: 'task-service', source: 'task', kind: 'task_done', recipientIds: ['bob'], content: '只给Bob的内部回执。' });
  const owner = store.claim({ workerId: 'owner' })!;
  store.settle({ eventId: owner.event.id, leaseToken: owner.leaseToken, status: 'done', content: 'Bob主动公开发出的结果。' });
  const ordinary = store.enqueue({ conversationId: room.id, senderId: 'alice', recipientIds: [], content: '另一条用户要求撤回的资料。' });
  const scope = { companionId: 'alice', conversationId: room.id, securityDomainId: room.securityDomainId };
  expect(store.withdrawPrivateNoticeSources('alice', room.securityDomainId, [notice.message.id])).toBe(1);
  store.withdrawSources('alice', room.securityDomainId, [ordinary.message.id]);
  expect(store.withdrawnMessagesPage(scope).items.map(item => ({ id: item.messageId, exact: item.exactPrivateNotice }))).toEqual([
    { id: notice.message.id, exact: true }, { id: ordinary.message.id, exact: undefined },
  ]);
  let failOrdinary = true;
  const withdrawSources = vi.fn(async (_scope: BotMemoryScope, input: Parameters<BotMemoryService['withdrawSources']>[1]) => {
    expect(input.sourceMessageIds).toHaveLength(1);
    const exact = input.sourceMessageIds[0] === notice.message.id;
    expect(input.mode).toBe(exact ? 'isolated-task-notices' : undefined);
    if (!exact && failOrdinary) throw new Error('ordinary-boundary-unavailable');
    return { withdrawn: true as const, revision: exact ? '1' : '2', sourceEventIds: [], sourceMessageIds: input.sourceMessageIds };
  });
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, options: { memory: { withdrawSources } }, maintenanceAbort: new AbortController(), loadedTombstones: new Map(),
    memoryMaintenance: { invalidate: vi.fn() }, scheduler: { cancel: vi.fn() }, taskRuns: new Map() });
  const controller = service as unknown as { flushSourceWithdrawals(scope: BotMemoryScope): Promise<void> };
  await expect(controller.flushSourceWithdrawals(scope)).rejects.toThrow('ordinary-boundary-unavailable');
  const cursors = () => store.taskTransaction(sql => sql.prepare("SELECT value FROM bot_metadata WHERE key LIKE 'native-withdrawal-cursor:%'").all());
  expect(cursors()).toEqual([]);
  expect(store.withdrawnIn('alice', room.securityDomainId, [owner.event.replyMessageId]).size).toBe(0);
  failOrdinary = false;
  await controller.flushSourceWithdrawals(scope);
  expect(withdrawSources).toHaveBeenCalledTimes(4); expect(cursors()).toHaveLength(1);
  expect(store.withdrawnIn('alice', room.securityDomainId, [owner.event.replyMessageId]).size).toBe(0);
  expect(store.getMessage(owner.event.replyMessageId)?.content).toBe('Bob主动公开发出的结果。');
  const before = withdrawSources.mock.calls.length; await controller.flushSourceWithdrawals(scope); expect(withdrawSources.mock.calls).toHaveLength(before);
});
