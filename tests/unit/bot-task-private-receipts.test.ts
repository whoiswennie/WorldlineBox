import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { BotTaskReports } from '../../src/main/companion-bot/task-report';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotWorkflowRuntime } from '../../src/main/companion-bot/workflow-runtime';
import { BotDelegationRuntime } from '../../src/main/companion-bot/delegation-runtime';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';
import type { BotEvent } from '../../src/main/companion-bot/types';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';
import type { BotMemoryMessage, BotMemoryScope } from '../../src/main/companion-bot/memory-service';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';

const stores: BotStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('wlb-private-notice-')) throw Error('Unexpected privacy fixture cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
});
const file = (id: string): BotMediaRef => ({ id, name: id + '.txt', url: 'bot-media://fixture/' + id, kind: 'file', mimeType: 'text/plain', size: 10 });
function fixture(kind: 'peer' | 'group' = 'peer', filename = ':memory:') {
  const store = new BotStore(filename, { activityBudget: { maxTasks: 1000, maxPendingTasks: 1000, maxDerivedEvents: 1000, maxPendingInbox: 1000, maxActions: 1000 } }); stores.push(store);
  for (const id of ['alice', 'bob', 'carol']) store.createCompanion({ id, name: id, persona: '独立的伙伴身份与协作。' });
  const room = kind === 'peer' ? store.openPeer('alice', 'bob') : store.createGroup({ title: '共同任务群', memberIds: ['alice', 'bob'], participationMode: 'all' });
  const workflows = new BotWorkflowRuntime(store), companionRuntime = new BotCompanionRuntime(store, { taskAuthority: task => workflows.taskAuthority(task) }), runtime = new BotTaskRuntime(store);
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, companionRuntime, taskRuntime: runtime, workflows, delegations: new BotDelegationRuntime(store), options: {}, maintenanceAbort: new AbortController() });
  const source = (owner: string, content: string) => store.enqueue({ conversationId: room.id, senderId: owner === 'alice' ? 'bob' : 'alice', source: 'companion', recipientIds: [owner], content }).events[0]!;
  const task = (owner: string, secret: string) => {
    const origin = source(owner, '请完成本次只读任务。');
    const work = store.createTask({ id: 'work-' + secret, companionId: owner, conversationId: room.id, sourceEventId: origin.id, goal: 'GOAL_' + secret, extra: { title: 'TITLE_' + secret } });
    companionRuntime.bindTask(work); store.updateTask(work.id, { status: 'running' });
    runtime.startEffect(work, { callId: 'report-' + secret, toolName: 'worker_report', argsHash: 'a'.repeat(64), argumentsPreview: 'report' });
    new BotTaskReports(store).record(store.getTask(work.id)!, 'report-' + secret, { state: 'ready', summary: 'RESULT_' + secret,
      verification: ['VERIFICATION_' + secret], nativeSessionId: BotDshBrain.sessionId('worker-' + work.id), nativeCallId: 'report-' + secret });
    runtime.commitEffect(work, { callId: 'report-' + secret, toolName: 'worker_report', argsHash: 'a'.repeat(64), isError: false });
    store.updateTask(work.id, { status: 'succeeded', summary: 'RESULT_' + secret });
    return { work: store.getTask(work.id)!, origin };
  };
  const notice = (owner: ReturnType<typeof task>, text: string, attachments?: BotMediaRef[], recipientIds = [owner.work.companionId]) => {
    const before = store.historyProjectionHead(room.id);
    expect(store.enqueueTaskNotice({ conversationId: room.id, source: 'task', senderId: 'task-service', sourceMessageId: 'notice-' + text,
      recipientIds, kind: 'task_done', content: text, attachments, payload: { taskId: owner.work.id },
      causationId: owner.origin.id, correlationId: owner.origin.correlationId })).toEqual({ deferred: false });
    return store.historyProjectionPage(room.id, { after: before, through: store.historyProjectionHead(room.id) })[0]!.message;
  };
  const current = (owner: string) => {
    const event = source(owner, '当前房间里实际说了什么？');
    store.taskTransaction(sql => sql.prepare("UPDATE bot_inbox SET status='running',lease_token=?,lease_until=? WHERE id=?").run('scope-test', Date.now() + 60000, event.id));
    store.bindEventNativeEpoch(event.id, 1); return store.getEvent(event.id)!;
  };
  let calls = 0;
  const execute = (event: BotEvent, name: string, args: Record<string, unknown> = {}) => (service as unknown as {
    executeTool(event: BotEvent, call: BotToolCall, signal: AbortSignal): Promise<unknown>;
  }).executeTool(event, { laneId: event.laneId, eventId: event.id, callId: 'scope-' + ++calls, name, args }, new AbortController().signal);
  return { store, room, runtime, companionRuntime, task, notice, current, execute };
}

it.each(['peer', 'group'] as const)('keeps Worker receipts private in %s history while preserving UI cards and explicit public chat', kind => {
  const f = fixture(kind), a = f.task('alice', 'ALICE_PRIVATE'), b = f.task('bob', 'BOB_PRIVATE');
  const own = f.notice(a, 'ALICE_PRIVATE_RECEIPT'), hidden = f.notice(b, 'BOB_PRIVATE_RECEIPT'), misrouted = f.notice(b, 'BOB_BROADCAST_RECEIPT', undefined, ['alice', 'bob']);
  const shared = f.store.enqueue({ conversationId: f.room.id, senderId: 'bob', source: 'companion', recipientIds: [], content: '我愿意分享的天气结论：公开内容。' }).message;
  expect(f.store.isMessageVisibleToCompanion(own.id, 'alice')).toBe(true);
  expect(f.store.isMessageVisibleToCompanion(hidden.id, 'alice')).toBe(false);
  expect(f.store.isMessageVisibleToCompanion(misrouted.id, 'alice')).toBe(false);
  expect(f.store.isMessageVisibleToCompanion(hidden.id, 'bob')).toBe(true);
  expect(f.store.isMessageVisibleToCompanion(shared.id, 'alice')).toBe(true);
  expect(f.store.isMessageVisibleToCompanion(shared.id, 'carol')).toBe(false);
  const query = { throughSourceSequence: Number.MAX_SAFE_INTEGER, limit: 200, maxChars: 256000 };
  const ui = f.store.recentPublishedMessages(f.room.id, query);
  expect(ui.map(message => message.id)).toEqual(expect.arrayContaining([own.id, hidden.id, misrouted.id, shared.id]));
  const alice = f.store.recentPublishedMessages(f.room.id, { ...query, companionId: 'alice' });
  expect(JSON.stringify(alice)).toContain('ALICE_PRIVATE_RECEIPT'); expect(JSON.stringify(alice)).not.toContain('BOB_PRIVATE_RECEIPT');
  expect(JSON.stringify(alice)).not.toContain('BOB_BROADCAST_RECEIPT'); expect(alice.map(message => message.id)).toContain(shared.id);
  const publicOnly = f.store.recentPublishedMessages(f.room.id, { ...query, publicOnly: true });
  expect(publicOnly.map(message => message.id)).toContain(shared.id); expect(publicOnly.some(message => message.senderId === 'task-service')).toBe(false);
});

it('filters before SQL history and task limits, so private receipts cannot crowd out the visible conversation or the owner tasks', () => {
  const f = fixture(), own = f.task('alice', 'ONLY_OWN_TASK'), foreign = f.task('bob', 'FOREIGN_TASK');
  const shared = f.store.enqueue({ conversationId: f.room.id, senderId: 'bob', source: 'companion', recipientIds: [], content: '真正公开的上一句。' }).message;
  for (let i = 0; i < 120; i++) {
    f.notice(foreign, 'FOREIGN_BURST_' + i);
    f.store.createTask({ id: 'foreign-' + i, companionId: 'bob', conversationId: f.room.id, sourceEventId: foreign.origin.id, goal: 'FOREIGN_GOAL_' + i });
  }
  const visible = f.store.recentPublishedMessages(f.room.id, { throughSourceSequence: Number.MAX_SAFE_INTEGER, companionId: 'alice', limit: 1 });
  expect(visible.map(message => message.id)).toEqual([shared.id]);
  expect(f.runtime.routerTasks({ companionId: 'alice', conversationId: f.room.id }).map(task => task.id)).toEqual([own.work.id]);
  expect(f.runtime.visibleTasks(f.room.id).some(task => task.companionId === 'bob')).toBe(true);
});

it('advances full publication cursors across private-only pages without archiving another companion receipt or its attached private file', async () => {
  const f = fixture(), a = f.task('alice', 'ALICE_PROJECT'), b = f.task('bob', 'BOB_PROJECT');
  const own = f.notice(a, 'MY_INTERNAL_RESULT');
  for (let i = 0; i < 40; i++) f.notice(b, 'PRIVATE_FOREIGN_RESULT_' + i, i === 39 ? [file('foreign-private-attachment')] : undefined);
  const publicFile = file('shared-published-file');
  const publication = f.store.enqueue({ conversationId: f.room.id, senderId: 'bob', source: 'companion', recipientIds: [], content: '这是主动交付给房间的报告。',
    attachments: [publicFile], sourceIds: [b.origin.id] }).message;
  const scope: BotMemoryScope = { companionId: 'alice', conversationId: f.room.id, securityDomainId: f.room.securityDomainId }, archived: BotMemoryMessage[] = [];
  const memory = { appendHistory: vi.fn(async (_scope: BotMemoryScope, messages: BotMemoryMessage[]) => { archived.push(...messages); return { archived: true }; }) };
  const projector = new BotHistoryProjector({ store: f.store, memory }), head = f.store.historyProjectionHead(f.room.id);
  expect((await projector.project(scope)).through).toBe(head);
  expect(archived.map(message => message.id)).toEqual(expect.arrayContaining([own.id, publication.id]));
  expect(JSON.stringify(archived)).not.toContain('PRIVATE_FOREIGN_RESULT'); expect(JSON.stringify(archived)).not.toContain('foreign-private-attachment');
  expect((await projector.project(scope)).projected).toBe(0);
  const catalog = f.store.modelAttachments(scope);
  expect(catalog.map(ref => ref.id)).toContain(publicFile.id); expect(catalog.map(ref => ref.id)).not.toContain('foreign-private-attachment');
  expect(f.store.modelAttachments({ ...scope, companionId: 'bob' }).map(ref => ref.id)).toContain('foreign-private-attachment');
});

it('binds Router tools to the caller owner even when they guess another participant task or notice ids', async () => {
  const f = fixture(), a = f.task('alice', 'ALICE_TOOL'), b = f.task('bob', 'BOB_TOOL');
  const hidden = f.notice(b, 'BOB_UNPUBLISHED_RAW_WEATHER'), own = f.notice(a, 'ALICE_TOOL_RECEIPT');
  const publication = f.store.enqueue({ conversationId: f.room.id, senderId: 'bob', source: 'companion', recipientIds: [], content: '我发在房间里的正式结论。' }).message;
  const event = f.current('alice');
  for (const section of ['delivery', 'verification']) {
    await expect(f.execute(event, 'dsh_task_result_read', { taskId: b.work.id, section, companionId: 'bob' })).rejects.toThrow('不属于');
    expect(await f.execute(event, 'dsh_task_result_read', { taskId: a.work.id, section })).toMatchObject({ text: expect.stringContaining(section === 'delivery' ? 'RESULT_ALICE_TOOL' : 'VERIFICATION_ALICE_TOOL') });
  }
  await expect(f.execute(event, 'dsh_task_control', { operation: 'status', taskId: b.work.id })).rejects.toThrow('协调视图');
  expect(await f.execute(event, 'dsh_task_control', { operation: 'status', taskId: a.work.id })).toMatchObject({ summary: 'RESULT_ALICE_TOOL' });
  const list = await f.execute(event, 'dsh_task_control', { operation: 'list', companionId: 'bob' });
  expect(JSON.stringify(list)).not.toContain('BOB_TOOL'); expect(list).toMatchObject({ total: 1 });
  const state = await f.execute(event, 'agent_state');
  expect(JSON.stringify(state)).not.toContain(b.work.id); expect(state).toMatchObject({ tasks: [expect.objectContaining({ id: a.work.id })] });
  await expect(f.execute(event, 'chat_read_message', { messageId: hidden.id, companionId: 'bob' })).rejects.toThrow('会话范围');
  expect(await f.execute(event, 'chat_read_message', { messageId: own.id })).toMatchObject({ text: 'ALICE_TOOL_RECEIPT' });
  expect(await f.execute(event, 'chat_read_message', { messageId: publication.id })).toMatchObject({ text: publication.content });
  f.companionRuntime.withdraw(a.work.id);
  await expect(f.execute(event, 'dsh_task_result_read', { taskId: a.work.id })).rejects.toThrow('协调视图');
});

it('persists exact private-notice exclusions without withdrawing a real public answer or file citing the same source, including VCP acknowledgement replay', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wlb-private-notice-')); directories.push(directory);
  const filename = path.join(directory, 'bot.sqlite'), f = fixture('peer', filename), foreign = f.task('bob', 'FOREIGN_COLD_SOURCE');
  const hidden = f.notice(foreign, 'RAW_PRIVATE_WEATHER_SOURCE'), ref = file('legitimately-shared-report');
  const publication = f.store.enqueue({ conversationId: f.room.id, senderId: 'bob', source: 'companion', recipientIds: [],
    content: '我现在主动在房间里分享这个结果与报告。', attachments: [ref], sourceIds: [hidden.id] }).message;
  const scope = { companionId: 'alice', conversationId: f.room.id, securityDomainId: f.room.securityDomainId };
  expect(f.store.withdrawPrivateNoticeSources(scope.companionId, scope.securityDomainId, [hidden.id])).toBe(1);
  const assertExact = (store: BotStore) => {
    expect(store.isPrivateNoticeSourceExcluded(scope.companionId, scope.securityDomainId, hidden.id)).toBe(true);
    expect(store.withdrawnIn(scope.companionId, scope.securityDomainId, [hidden.id, publication.id])).toEqual(new Set([hidden.id]));
    expect(store.isMessageVisibleToCompanion(publication.id, scope.companionId)).toBe(true);
    expect(store.modelAttachments(scope).map(value => value.id)).toContain(ref.id);
    expect(store.withdrawnMessagesPage(scope).items).toEqual([expect.objectContaining({ messageId: hidden.id, eventIds: [], exactPrivateNotice: true })]);
  };
  assertExact(f.store);
  // Native tombstone acknowledgements repeat the targeted id. The general
  // loader must retain that exact meaning rather than recursively escalating.
  expect(f.store.withdrawSources(scope.companionId, scope.securityDomainId, [hidden.id])).toBe(0); assertExact(f.store);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = new BotStore(filename); stores.push(reopened); assertExact(reopened);
  expect(reopened.withdrawSources(scope.companionId, scope.securityDomainId, [hidden.id])).toBe(0); assertExact(reopened);
  // Ordinary user withdrawal retains its established source/attachment cascade.
  expect(reopened.withdrawSources(scope.companionId, scope.securityDomainId, [publication.id])).toBeGreaterThan(0);
  expect(reopened.modelAttachments(scope).map(value => value.id)).not.toContain(ref.id);
});
