import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import Database from 'better-sqlite3';

let root: string, store: BotStore;
it('persists multiple chat pins across reopening and unpins without changing conversation identity or permissions', () => {
  const a = store.openDirect('alice'), b = store.openDirect('bob');
  store.setConversationPinned(a.id, true); store.setConversationPinned(b.id, true);
  store.close(); store = new BotStore(path.join(root, 'bot.sqlite'));
  expect(store.getConversation(a.id)).toEqual({ ...a, pinned: true });
  expect(store.getConversation(b.id)).toEqual({ ...b, pinned: true });
  store.setConversationPinned(a.id, false);
  expect(store.getConversation(a.id)).toEqual(a);
  expect(store.getConversation(b.id)?.pinned).toBe(true);
  expect(() => store.setConversationPinned('missing', true)).toThrow('不存在');
});
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'worldline-bot-store-'));
  // These SQL ordering fixtures deliberately exceed normal activity capacity.
  store = new BotStore(path.join(root, 'bot.sqlite'), { activityBudget: { maxTasks: 1000, maxPendingTasks: 1000 } });
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '认真核对事实。' });
  store.createCompanion({ id: 'bob', name: 'Bob', persona: '简明直接。' });
});
afterEach(() => {
  store.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldline-bot-store-')) throw new Error('Invalid test cleanup');
  rmSync(resolved, { recursive: true, force: true });
});
it('keeps stable direct conversations while security domains of groups remain separate', () => {
  const direct = store.openDirect('alice');
  expect(store.openDirect('alice').id).toBe(direct.id);
  const group = store.createGroup({ title: '项目群', memberIds: ['alice', 'bob'] });
  expect(group.memberIds.sort()).toEqual(['alice', 'bob', 'user']);
  expect(group.securityDomainId).not.toBe(direct.securityDomainId);
  expect(() => store.createGroup({ title: '错群', memberIds: ['unknown'] })).toThrow('不存在');
});
it('removes the rejected development appearance column without changing identities, conversations or queued work', () => {
  const conversation = store.openDirect('alice'), queued = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '迁移前未处理的消息', sourceMessageId: 'before-v7' });
  const alice = store.getCompanion('alice'); store.close();
  const DevelopmentDatabase = Database as new (filename: string) => { exec(sql: string): void; close(): void };
  const development = new DevelopmentDatabase(path.join(root, 'bot.sqlite'));
  development.exec("ALTER TABLE bot_companions ADD COLUMN appearance_mode TEXT NOT NULL DEFAULT 'normal'; UPDATE bot_companions SET appearance_mode='power-save'; PRAGMA user_version=7"); development.close();
  store = new BotStore(path.join(root, 'bot.sqlite'));
  expect(store.getCompanion('alice')).toEqual(alice); expect(store.getConversation(conversation.id)).toEqual(conversation);
  expect(store.taskTransaction(sql => sql.prepare('PRAGMA table_info(bot_companions)').all()).some(raw => (raw as { name: string }).name === 'appearance_mode')).toBe(false);
  expect(store.claim({ workerId: 'after-migration' })?.event.id).toBe(queued.events[0]!.id);
});
it('upgrades v14 lifecycle metadata atomically and refuses data from a future task-state schema', () => {
  const LifecycleDatabase = Database as new (filename: string, options?: { readonly?: boolean }) => { exec(sql: string): void; pragma(sql: string, options?: { simple?: boolean }): unknown; close(): void };
  const conversation = store.openDirect('alice');
  const source = store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: 'before-v15', content: '迁移前来源' }).events[0]!;
  const queued = { id: 'archived-task', goal: 'preserved historical task', extra: { workerPrompt: 'original prompt' } };
  store.taskTransaction(sql => sql.prepare('INSERT INTO bot_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(queued.id, conversation.id, 'alice', source.id, queued.goal, 'queued', 'historical-attempt', null, null, null, null, source.receivedAt, source.receivedAt, JSON.stringify(queued.extra)));
  const filename = store.filename; store.close();
  const legacy = new LifecycleDatabase(filename);
  legacy.exec(`DROP TABLE bot_task_presence_events; DROP TABLE bot_task_history_clear_targets;
    DROP INDEX bot_tasks_visible_scope_status; DROP INDEX bot_tasks_visible_created;
    DROP INDEX bot_tasks_visible_activity; DROP INDEX bot_tasks_visible_global_activity;
    DROP INDEX bot_tasks_presence_active_v2; DROP INDEX bot_inbox_presence_active; PRAGMA user_version=14`);
  legacy.close(); store = new BotStore(filename);
  expect(store.taskTransaction(sql => sql.prepare('PRAGMA user_version').get())).toMatchObject({ user_version: 21 });
  expect(store.taskTransaction(sql => sql.prepare('SELECT status,goal,extra_json FROM bot_tasks WHERE id=?').get(queued.id))).toMatchObject({ status: 'queued', goal: queued.goal, extra_json: JSON.stringify(queued.extra) });
  expect(store.companionPresence([{ id: 'alice', updatedAt: store.getCompanion('alice')!.updatedAt }], true).alice!.counts.activeTasks).toBe(0);
  expect(store.taskTransaction(sql => sql.prepare("SELECT name FROM sqlite_master WHERE name IN ('bot_task_presence_events','bot_task_history_clear_targets','bot_tasks_visible_scope_status')").all())).toHaveLength(3);
  const futurePath = path.join(root, 'future.sqlite'), future = new LifecycleDatabase(futurePath);
  future.pragma('user_version=22'); future.close();
  expect(() => new BotStore(futurePath)).toThrow('拒绝降级');
  const unchanged = new LifecycleDatabase(futurePath, { readonly: true });
  try { expect(unchanged.pragma('user_version', { simple: true })).toBe(22); } finally { unchanged.close(); }
});
it('deduplicates one transport message and rejects reuse of its ID for different content', () => {
  const conversation = store.openDirect('alice');
  const input = { conversationId: conversation.id, senderId: 'user', content: '早上好', sourceMessageId: 'transport-1' };
  const first = store.enqueue(input), second = store.enqueue(input);
  expect(second).toEqual(first);
  expect(store.messagesPage(conversation.id).items).toHaveLength(2);
  expect(() => store.enqueue({ ...input, content: '修改后的其他请求' })).toThrow('不同内容');
});
it('fans group ingress out once per companion and does not confuse different sources with same message ID', () => {
  const conversation = store.createGroup({ title: '群聊', memberIds: ['alice', 'bob'], participationMode: 'all' });
  const first = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '大家好', sourceMessageId: 'same', sourceInstanceId: 'desktop' });
  const other = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '手机消息', sourceMessageId: 'same', sourceInstanceId: 'mobile' });
  expect(first.events.map(event => event.companionId).sort()).toEqual(['alice', 'bob']);
  expect(new Set([...first.events, ...other.events].map(event => event.id)).size).toBe(4);
  expect(first.events.every(event => event.senderType === 'user' && event.audienceScopeId === conversation.audienceScopeId)).toBe(true);
});
it('rejects sender impersonation, membership bypass and cross-channel world events', () => {
  const conversation = store.openDirect('alice');
  expect(() => store.enqueue({ conversationId: conversation.id, senderId: 'bob', content: '冒充来信' })).toThrow('不属于');
  expect(() => store.enqueue({ conversationId: conversation.id, senderId: 'alice', content: '冒充用户', source: 'user' })).toThrow('不匹配');
  expect(() => store.enqueue({ conversationId: conversation.id, senderId: 'world', content: '世界通知', source: 'world' })).toThrow('世界会话');
  expect(() => store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '错误目标', recipientIds: ['bob'] })).toThrow('目标');
});
it('claims different lanes concurrently but holds later messages in the same lane', () => {
  const a = store.openDirect('alice'), b = store.openDirect('bob');
  const first = store.enqueue({ conversationId: a.id, senderId: 'user', content: 'a1' }).events[0]!;
  const later = store.enqueue({ conversationId: a.id, senderId: 'user', content: 'a2' }).events[0]!;
  const other = store.enqueue({ conversationId: b.id, senderId: 'user', content: 'b1' }).events[0]!;
  const claimedA = store.claim({ workerId: 'worker', now: 1000 })!, claimedB = store.claim({ workerId: 'worker', now: 1000 })!;
  expect(claimedA.event.id).toBe(first.id); expect(claimedB.event.id).toBe(other.id);
  expect(store.claim({ workerId: 'worker', now: 1000 })).toBeUndefined();
  store.settle({ eventId: first.id, leaseToken: claimedA.leaseToken, status: 'done', content: '完成A1' });
  expect(store.claim({ workerId: 'worker', now: 1001 })?.event.id).toBe(later.id);
});
it('runs explicitly addressed group teammates concurrently while keeping each companion in order',()=>{
  const room=store.createGroup({title:'协作',memberIds:['alice','bob'],participationMode:'all'});
  const ingress=store.enqueue({conversationId:room.id,senderId:'user',content:'开始项目'});
  const coordinator=store.claim({workerId:'coordinator',serialCompanions:true})!;
  expect(coordinator).toBeTruthy();const other=store.claim({workerId:'other-root',serialCompanions:true})!;expect(other).toBeTruthy();
  const target=ingress.events.find(event=>event.companionId!==coordinator.event.companionId)!.companionId;
  const work=store.enqueue({conversationId:room.id,senderId:coordinator.event.companionId,source:'companion',content:'独立实现',recipientIds:[target],payload:{directedPeer:true}});
  expect(store.claim({workerId:'busy-teammate',serialCompanions:true})).toBeUndefined();
  store.settle({eventId:other.event.id,leaseToken:other.leaseToken,status:'done',content:'已阅读需求'});
  const teammate=store.claim({workerId:'teammate',serialCompanions:true})!;expect(teammate.event.id).toBe(work.events[0]!.id);
  store.enqueue({conversationId:room.id,senderId:coordinator.event.companionId,source:'companion',content:'后续实现',recipientIds:[target],payload:{directedPeer:true}});
  expect(store.claim({workerId:'no-second-teammate',serialCompanions:true})).toBeUndefined();
});
it('recovers expired leases across a cold reopen and fences late publication', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '恢复测试' }).events[0]!;
  const oldClaim = store.claim({ workerId: 'dead', now: 1000, leaseMs: 100 })!;
  store.close(); store = new BotStore(path.join(root, 'bot.sqlite'));
  const recovered = store.claim({ workerId: 'new', now: 1100, leaseMs: 1000 })!;
  expect(recovered.event.id).toBe(event.id); expect(recovered.event.attempts).toBe(2);
  expect(store.settle({ eventId: event.id, leaseToken: oldClaim.leaseToken, status: 'done', content: '过期答案' })).toBe(false);
  expect(store.settle({ eventId: event.id, leaseToken: recovered.leaseToken, status: 'done', content: '恢复后的答案' })).toBe(true);
  expect(store.getMessage(event.replyMessageId)?.content).toBe('恢复后的答案');
  expect(store.pendingOutbox()).toHaveLength(1);
});
it('cancels a running event and prevents a late draft or final from reviving it', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '取消测试' }).events[0]!;
  const claim = store.claim({ workerId: 'worker' })!;
  expect(store.updateDraft(event.id, claim.leaseToken, '部分回复')).toBe(true);
  expect(store.cancelEvent(event.id)).toBe(true);
  expect(store.updateDraft(event.id, claim.leaseToken, '迟到流')).toBe(false);
  expect(store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '迟到完成' })).toBe(false);
  expect(store.eventForReply(event.replyMessageId)?.status).toBe('cancelled');
  expect(store.getMessage(event.replyMessageId)?.status).toBe('cancelled');
  expect(store.pendingOutbox()).toHaveLength(0);
});
it('keeps outbox projection durable and acknowledges it independently', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '持久投递' }).events[0]!;
  const claim = store.claim({ workerId: 'worker' })!;
  expect(store.markDispatched(event.id, claim.leaseToken, 'dsh-event-1')).toBe(true);
  store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '真实结果' });
  store.close(); store = new BotStore(path.join(root, 'bot.sqlite'));
  expect(store.getEvent(event.id)?.dshEventId).toBe('dsh-event-1');
  expect(store.pendingOutbox()).toEqual([{ id: event.replyMessageId, eventId: event.id, conversationId: conversation.id, messageId: event.replyMessageId }]);
  store.acknowledgeOutbox(event.replyMessageId); expect(store.pendingOutbox()).toHaveLength(0);
});
it('paginates without duplicates and keeps queued, future and other-channel messages out of model windows', () => {
  const conversation = store.openDirect('alice'), other = store.openDirect('bob');
  for (let i = 0; i < 5; i++) store.enqueue({ conversationId: conversation.id, senderId: 'user', content: `历史${i}` });
  const trigger = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '当前请求' });
  store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '未来消息' });
  store.enqueue({ conversationId: other.id, senderId: 'user', content: '私密其他会话' });
  const first = store.messagesPage(conversation.id, { limit: 4 }), second = store.messagesPage(conversation.id, { limit: 4, before: first.nextBefore });
  expect(first.hasMore).toBe(true); expect(new Set([...first.items, ...second.items].map(message => message.id)).size).toBe(8);
  const history = store.recentMessages(conversation.id, { throughSequence: trigger.message.sequence, limit: 3 });
  expect(history.map(message => message.content)).toEqual(['历史3', '历史4', '当前请求']);
  expect(history.every(message => message.status === 'sent')).toBe(true);
});
it('persists memory work atomically with the reply and fences late indexing acknowledgements', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '记住这个决定' }).events[0]!;
  const claim = store.claim({ workerId: 'router' })!;
  const payload = { scope: { companionId: 'alice', conversationId: conversation.id, securityDomainId: conversation.securityDomainId },
    requestId: 'request-1', eventId: event.id, metadata: { exact: ['不可替换的', '请求状态'] }, text: '决定已说明', completed: true };
  store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '决定已说明',
    memoryJobs: [{ key: event.id, kind: 'response', payload }] });
  store.close(); store = new BotStore(path.join(root, 'bot.sqlite'));
  const pending = store.listPendingMemory(); expect(pending).toHaveLength(1); expect(pending[0]?.payload).toEqual(payload);
  expect(store.enqueueMemoryJob({ key: event.id, kind: 'response', payload }).id).toBe(pending[0]!.id);
  expect(() => store.enqueueMemoryJob({ key: event.id, kind: 'response', payload: { ...payload, completed: false } })).toThrow('不同载荷');
  const old = store.claimMemoryJob({ workerId: 'old', now: 1000, leaseMs: 100 })!;
  const current = store.claimMemoryJob({ workerId: 'new', now: 1100, leaseMs: 1000 })!;
  expect(current.job.attempts).toBe(2);
  expect(store.settleMemoryJob({ id: old.job.id, leaseToken: old.leaseToken, status: 'done' })).toBe(false);
  expect(store.settleMemoryJob({ id: current.job.id, leaseToken: current.leaseToken, status: 'done' })).toBe(true);
  expect(store.listPendingMemory()).toHaveLength(0);
});
it('does not commit a final reply if its required memory job cannot be persisted', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '不能丢掉记录' }).events[0]!;
  const claim = store.claim({ workerId: 'router' })!;
  expect(() => store.settle({ eventId: event.id, leaseToken: claim.leaseToken, status: 'done', content: '不能静默成功',
    memoryJobs: [{ key: event.id, kind: 'capture', payload: { text: '汉'.repeat(800000) } }] })).toThrow('2MB');
  expect(store.getEvent(event.id)?.status).toBe('running'); expect(store.getMessage(event.replyMessageId)?.status).toBe('running');
  expect(store.pendingOutbox()).toHaveLength(0); expect(store.listPendingMemory()).toHaveLength(0);
});
it('serializes memory work per security domain while allowing other domains and prioritizing response closure', () => {
  const scope = { companionId: 'alice', securityDomainId: 'one' };
  store.enqueueMemoryJob({ id: 'capture', kind: 'capture', payload: { scope } });
  store.enqueueMemoryJob({ id: 'response', kind: 'response', payload: { scope } });
  store.enqueueMemoryJob({ id: 'other', kind: 'capture', payload: { scope: { ...scope, securityDomainId: 'two' } } });
  const first = store.claimMemoryJob({ workerId: 'worker', now: 1000 })!;
  const other = store.claimMemoryJob({ workerId: 'worker', now: 1000 })!;
  expect(first.job.id).toBe('response'); expect(other.job.id).toBe('other');
  expect(store.claimMemoryJob({ workerId: 'worker', now: 1000 })).toBeUndefined();
  store.settleMemoryJob({ id: first.job.id, leaseToken: first.leaseToken, status: 'done' });
  expect(store.claimMemoryJob({ workerId: 'worker', now: 1000 })?.job.id).toBe('capture');
});
it('uses durable fair claim ordering even when all completions share the same clock tick', () => {
  const a = store.openDirect('alice'), b = store.openDirect('bob');
  for (const conversation of [a, b]) for (let i = 0; i < 3; i++) store.enqueue({ conversationId: conversation.id, senderId: 'user', content: `${conversation.title}:${i}` });
  const order: string[] = [];
  for (let i = 0; i < 6; i++) {
    const claim = store.claim({ workerId: 'worker', now: 1000 })!;
    order.push(claim.event.companionId); store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: 'ok' });
  }
  expect(order).toEqual(['alice', 'bob', 'alice', 'bob', 'alice', 'bob']);
});
