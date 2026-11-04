import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import Database from 'better-sqlite3';

let root: string, store: BotStore;
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
  const queued = store.createTask({ conversationId: conversation.id, companionId: 'alice', sourceEventId: source.id, goal: '保留未执行的任务', extra: { workerPrompt: '原始输入' } });
  const filename = store.filename; store.close();
  const legacy = new LifecycleDatabase(filename);
  legacy.exec(`DROP TABLE bot_task_presence_events; DROP TABLE bot_task_history_clear_targets;
    DROP INDEX bot_tasks_visible_scope_status; DROP INDEX bot_tasks_visible_created;
    DROP INDEX bot_tasks_visible_activity; DROP INDEX bot_tasks_visible_global_activity;
    DROP INDEX bot_tasks_presence_active_v2; DROP INDEX bot_inbox_presence_active; PRAGMA user_version=14`);
  legacy.close(); store = new BotStore(filename);
  expect(store.taskTransaction(sql => sql.prepare('PRAGMA user_version').get())).toMatchObject({ user_version: 17 });
  expect(store.getTask(queued.id)).toMatchObject({ status: 'queued', goal: queued.goal, extra: { workerPrompt: '原始输入' } });
  expect(store.companionPresence([{ id: 'alice', updatedAt: store.getCompanion('alice')!.updatedAt }], true).alice!.counts.activeTasks).toBe(1);
  expect(store.taskTransaction(sql => sql.prepare("SELECT name FROM sqlite_master WHERE name IN ('bot_task_presence_events','bot_task_history_clear_targets','bot_tasks_visible_scope_status')").all())).toHaveLength(3);
  const futurePath = path.join(root, 'future.sqlite'), future = new LifecycleDatabase(futurePath);
  future.pragma('user_version=18'); future.close();
  expect(() => new BotStore(futurePath)).toThrow('拒绝降级');
  const unchanged = new LifecycleDatabase(futurePath, { readonly: true });
  try { expect(unchanged.pragma('user_version', { simple: true })).toBe(18); } finally { unchanged.close(); }
});
it('filters task backoff before limiting and gives ready cancellations precedence without spinning native retries', () => {
  const conversation = store.openDirect('alice');
  const source = store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: 'task-source', content: '任务来源' }).events[0]!;
  for (let index = 0; index < 100; index++) store.createTask({ id: `blocked-${index}`, conversationId: conversation.id, companionId: 'alice', sourceEventId: source.id,
    goal: '旧的未知执行等待核对', extra: { retryAt: Date.now() + 60000, nativeAttempted: true } });
  const ready = store.createTask({ id: 'ready-101', conversationId: conversation.id, companionId: 'alice', sourceEventId: source.id, goal: '现在可执行' });
  const stopped = store.createTask({ id: 'cancel-without-admission', conversationId: conversation.id, companionId: 'alice', sourceEventId: source.id,
    goal: '尚未执行的取消', extra: { cancelRequested: true, nativeAttempted: false, retryAt: Date.now() + 60000 } });
  expect(store.pendingTasks(100).map(task => task.id)).toEqual([stopped.id, ready.id]);
  store.updateTask(stopped.id, { extra: { cancelRequested: true, nativeAttempted: true, retryAt: Date.now() + 60000 } });
  expect(store.pendingTasks(100).map(task => task.id)).toEqual([ready.id]);
});
it('finds every active domain task without the UI recent-100 limit or another audience', async () => {
  const conversation = store.openDirect('alice'), other = store.createGroup({ title: '别的受众', memberIds: ['alice'] });
  const source = store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: 'active-source', content: '来源' }).events[0]!;
  const old = store.createTask({ id: '000-old-active', conversationId: conversation.id, companionId: 'alice', sourceEventId: source.id, goal: '旧的进行中任务' });
  await new Promise(resolve => setTimeout(resolve, 5));
  for (let index = 0; index < 101; index++) {
    const task = store.createTask({ id: `zzz-recent-${String(index).padStart(3, '0')}`, conversationId: conversation.id, companionId: 'alice', sourceEventId: source.id, goal: '已结束的近任务' });
    store.updateTask(task.id, { status: 'succeeded' });
  }
  const foreign = store.enqueue({ conversationId: other.id, senderId: 'user', sourceMessageId: 'other', content: '别域来源' }).events[0]!;
  store.createTask({ conversationId: other.id, companionId: 'alice', sourceEventId: foreign.id, goal: '别域活跃任务' });
  expect(store.listTasks(conversation.id).some(task => task.id === old.id)).toBe(false);
  expect(store.activeDomainTasks('alice', conversation.securityDomainId).map(task => task.id)).toEqual([old.id]);
});
it('migrates only unresolved cancelled native admissions into an indexed durable retirement queue', () => {
  const conversation = store.openDirect('alice');
  const admit = (id: string) => {
    store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: id, content: '准备原生事件' });
    const claim = store.claim({ workerId: 'fixture' })!;
    store.bindEventNativeEpoch(claim.event.id, 1);
    store.trackNativeAdmission({ eventId: claim.event.id, epoch: 1, nativeLaneId: claim.event.laneId, system: 'identity', cwd: root, inputBytes: 40 });
    store.markDispatched(claim.event.id, claim.leaseToken, claim.event.id); store.cancelEvent(claim.event.id); return claim.event;
  };
  const unresolved = admit('unresolved'), resolved = admit('resolved');
  expect(store.resolveCancelledNativeAdmission({ eventId: resolved.id, epoch: 1, absent: true })).toBe(true);
  const unsent = store.enqueue({ conversationId: conversation.id, senderId: 'user', sourceMessageId: 'unsent', content: '从未投递' }).events[0]!;
  store.cancelEvent(unsent.id);
  const filename = store.filename; store.close();
  const LegacyDatabase = Database as new (filename: string) => { exec(sql: string): void; close(): void };
  const legacy = new LegacyDatabase(filename); legacy.exec('DROP TABLE bot_native_retirements; PRAGMA user_version=3'); legacy.close();
  store = new BotStore(filename);
  expect(store.pendingCancelledNativeAdmissions(unresolved.laneId).map(item => item.eventId)).toEqual([unresolved.id]);
  expect(store.readyNativeRetirementLanes()).toEqual([unresolved.laneId]);
  expect(store.beginNativeRetirement(unresolved.laneId)).toBe(true); expect(store.beginNativeRetirement(unresolved.laneId)).toBe(false);
  expect(store.resolveCancelledNativeAdmission({ eventId: unresolved.id, epoch: 1, absent: true })).toBe(true);
  expect(store.pendingCancelledNativeAdmissions(unresolved.laneId)).toEqual([]); expect(store.readyNativeRetirementLanes()).toEqual([]);
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
it('binds DSH Sessions once per lane and rejects changed bindings', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '初始化会话' }).events[0]!;
  expect(store.saveSession(event.laneId, 'session-a').sessionId).toBe('session-a');
  expect(store.saveSession(event.laneId, 'session-a').sessionId).toBe('session-a');
  expect(() => store.saveSession(event.laneId, 'session-b')).toThrow('已绑定');
});
it('binds tasks to their origin and rejects cross-lane or stale attempt receipts', () => {
  const conversation = store.openDirect('alice');
  const event = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '做一项任务' }).events[0]!;
  expect(() => store.createTask({ conversationId: conversation.id, companionId: 'bob', sourceEventId: event.id, goal: '非法' })).toThrow('不属于');
  const task = store.createTask({ id: 'task-1', conversationId: conversation.id, companionId: 'alice', sourceEventId: event.id, goal: '生成文件' });
  expect(() => store.updateTask(task.id, { status: 'succeeded', attemptId: 'old-attempt' })).toThrow('过期');
  expect(store.updateTask(task.id, { status: 'running', dshTaskId: 'native-task-1' }).dshTaskId).toBe('native-task-1');
  store.updateTask(task.id, { status: 'succeeded', summary: '完成' });
  expect(() => store.updateTask(task.id, { status: 'running' })).toThrow('已结束');
  expect(store.listTasks(conversation.id)).toHaveLength(1);
  expect(store.createTask({ id: task.id, conversationId: conversation.id, companionId: 'alice', sourceEventId: event.id, goal: '生成文件' }).status).toBe('succeeded');
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
