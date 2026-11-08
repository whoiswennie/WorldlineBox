import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotStore, botLaneRetentionKey } from '../../src/main/companion-bot/store';
import { BotAppBrainStore } from '../../src/main/companion-bot/app-brain-store';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotRetention } from '../../src/main/companion-bot/retention';
import { botHostHistoryRebuildKey } from '../../src/main/companion-bot/host-migration';
import { botTaskNoticeAudienceKey, isolateLegacyTaskNoticeContext, refreshTaskNoticeAudienceRebuild } from '../../src/main/companion-bot/task-notice-audience-migration';
import type { BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

const roots: string[] = [], stores: BotStore[] = [], brains: BotAppBrain[] = [];
afterEach(async () => {
  for (const brain of brains.splice(0)) await brain.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-notice-audience-')) throw new Error('Invalid owned test root');
    rmSync(root, { recursive: true, force: true });
  }
});
const secret = 'OWNER_ONLY_WORKER_RECEIPT_967321';
function fixture(kind: 'peer' | 'group' = 'peer') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-notice-audience-')); roots.push(root);
  const store = new BotStore(path.join(root, 'bot.sqlite')); stores.push(store);
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '作为独立伙伴自然聊天' });
  const room = kind === 'peer' ? store.openPeer('alice', 'bob') : store.createGroup({ title: '一起讨论', memberIds: ['alice', 'bob'], participationMode: 'all' });
  const ownerSource = store.enqueue({ conversationId: room.id, senderId: 'alice', recipientIds: ['bob'], content: 'Bob去整理自己的资料' });
  const owner = store.claim({ workerId: 'owner' })!;
  store.settle({ eventId: owner.event.id, leaseToken: owner.leaseToken, status: 'done', content: '我会整理。' });
  const task = store.createTask({ conversationId: room.id, companionId: 'bob', sourceEventId: owner.event.id, goal: '只属于Bob的任务' });
  store.updateTask(task.id, { status: 'succeeded', summary: secret });
  const notice = store.enqueue({ conversationId: room.id, senderId: 'task-service', source: 'task', kind: 'task_done',
    recipientIds: ['bob'], content: secret, payload: { taskId: task.id } });
  const ownNotice = store.claim({ workerId: 'owner-notice' })!;
  store.settle({ eventId: ownNotice.event.id, leaseToken: ownNotice.leaseToken, status: 'done', content: '这是Bob主动公开发布的成果。' });
  const publicPost = store.enqueue({ conversationId: room.id, senderId: 'bob', recipientIds: ['alice'], content: '这是我已经公开告诉你的结论。' });
  const previous = store.claim({ workerId: 'previous' })!;
  store.settle({ eventId: previous.event.id, leaseToken: previous.leaseToken, status: 'done', content: '我记得我们公开聊的内容。' });
  store.saveSession(previous.event.laneId, 'old-app-session');
  store.setMetadata(botLaneRetentionKey(previous.event.laneId), JSON.stringify({ epoch: 1, turns: 127, bytes: 500000,
    handoff: { summaryText: secret, tail: [{ text: secret }] } }));
  store.setMetadata(`delivered:${previous.event.laneId}`, JSON.stringify({ ids: [notice.message.id, publicPost.message.id] }));
  const next = () => {
    store.enqueue({ conversationId: room.id, senderId: 'bob', recipientIds: ['alice'], content: '继续刚才的讨论。' });
    return store.claim({ workerId: 'current' })!;
  };
  return { root, store, room, task: store.getTask(task.id)!, notice, previous, publicPost, ownerSource, next };
}

it.each(['peer', 'group'] as const)('isolates only foreign private notices in an old %s domain while preserving public history, tasks and native workers', async kind => {
  const f = fixture(kind), current = f.next(), laneId = current.event.laneId;
  const worker = f.store.createTask({ conversationId: f.room.id, companionId: 'alice', sourceEventId: f.previous.event.id, goal: '还在运行的独立Worker' });
  f.store.updateTask(worker.id, { status: 'running', sessionId: 'native-worker-session', dshTaskId: 'native-worker-task' });
  const workerBefore = f.store.getTask(worker.id), visibleBefore = f.store.messagesPage(f.room.id).items;
  expect(f.store.isMessageVisibleToCompanion(f.notice.message.id, 'alice')).toBe(false);
  expect(f.store.isMessageVisibleToCompanion(f.notice.message.id, 'bob')).toBe(true);
  const isolated = isolateLegacyTaskNoticeContext({ store: f.store, event: current.event });
  expect(isolated).toEqual({ state: 'isolated', sourceIds: [f.notice.message.id], epoch: 2 });
  expect(f.store.getLane(laneId)).toMatchObject({ epoch: 2, sessionId: undefined });
  expect(f.store.getLane(f.notice.events[0]!.laneId)?.epoch).toBe(1);
  expect(f.store.getLaneRetention(laneId)).toEqual({ epoch: 2, turns: 0, bytes: 0 });
  expect(f.store.getMetadata(`delivered:${laneId}`)).toBeUndefined();
  expect(f.store.getMetadata(botHostHistoryRebuildKey(laneId))).not.toContain(secret);
  expect(f.store.getMetadata(`native-recovery-floor:${laneId}`)).toBe('2');
  expect(f.store.withdrawnMessagesPage(current.event).items.map(item => item.messageId)).toEqual([f.notice.message.id]);
  expect(f.store.withdrawnIn('bob', f.room.securityDomainId, [f.notice.message.id]).size).toBe(0);
  expect(f.store.withdrawnIn('alice', f.room.securityDomainId, [f.publicPost.message.id, f.previous.event.replyMessageId]).size).toBe(0);
  expect(f.store.messagesPage(f.room.id).items).toEqual(visibleBefore);
  expect(f.store.getTask(f.task.id)).toEqual(f.task); expect(f.store.getTask(worker.id)).toEqual(workerBefore);
  const handoff = vi.fn(), retention = new BotRetention({ store: f.store, root: f.root, brain: { handoff }, model: () => model, callback: async () => ({ url: 'http://127.0.0.1:1', token: 'test' }) });
  expect(await retention.beforeTurn(current.event, new AbortController().signal)).toMatchObject({ epoch: 2, handoff: undefined });
  expect(handoff).not.toHaveBeenCalled();
});

it('is durable across restart and refreshes the rebuild marker after a VCP revision rotation', () => {
  const f = fixture(), current = f.next();
  isolateLegacyTaskNoticeContext({ store: f.store, event: current.event });
  f.store.rotateDomain('alice', f.room.securityDomainId);
  refreshTaskNoticeAudienceRebuild(f.store, current.event);
  expect(JSON.parse(f.store.getMetadata(botHostHistoryRebuildKey(current.event.laneId))!)).toMatchObject({ epoch: 3 });
  const reopened = new BotStore(f.store.filename); stores.push(reopened);
  expect(isolateLegacyTaskNoticeContext({ store: reopened, event: current.event })).toEqual({ state: 'current', sourceIds: [], epoch: 3 });
  expect(reopened.getLane(current.event.laneId)?.epoch).toBe(3);
});

it.each(['frozen', 'epoch', 'admission'] as const)('defers a current %s reservation without changing its receipt, epoch or retry marker', reservation => {
  const f = fixture(), current = f.next(), laneId = current.event.laneId;
  if (reservation === 'frozen') f.store.setMetadata(`native-input:${current.event.id}`, JSON.stringify({ prompt: 'identical-frozen-input', nativeLaneId: laneId }));
  else f.store.bindEventNativeEpoch(current.event.id, 1);
  if (reservation === 'admission') f.store.trackNativeAdmission({ eventId: current.event.id, epoch: 1, nativeLaneId: laneId, system: 'old', cwd: f.root, inputBytes: 10 });
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: current.event })).toMatchObject({ state: 'deferred', epoch: 1 });
  expect(f.store.getMetadata(botTaskNoticeAudienceKey('alice', f.room.securityDomainId))).toBeUndefined();
  expect(f.store.getMetadata(`delivered:${laneId}`)).toBeDefined();
  expect(f.store.withdrawnMessagesPage(current.event).items).toEqual([]);
  expect(f.store.getLane(laneId)?.sessionId).toBe('old-app-session');
});

it('defers an old cancelled admission until its original retirement proves absence, then migrates a fresh event once', () => {
  const f = fixture(), old = f.next(), laneId = old.event.laneId;
  f.store.bindEventNativeEpoch(old.event.id, 1);
  f.store.trackNativeAdmission({ eventId: old.event.id, epoch: 1, nativeLaneId: laneId, system: 'old', cwd: f.root, inputBytes: 10 });
  f.store.cancelEvent(old.event.id);
  const current = f.next();
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: current.event })).toMatchObject({ state: 'deferred', reason: 'native-receipt-unsettled', epoch: 1 });
  expect(f.store.pendingCancelledNativeAdmissions(laneId)).toHaveLength(1);
  expect(f.store.resolveCancelledNativeAdmission({ eventId: old.event.id, epoch: 1, absent: true })).toBe(true);
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: current.event })).toMatchObject({ state: 'isolated', epoch: 2 });
  expect(f.store.getEvent(old.event.id)?.status).toBe('cancelled');
});

it('allows an already quarantined retired Router to isolate history without erasing its unknown effect journal', () => {
  const f = fixture(), old = f.next();
  f.store.bindEventNativeEpoch(old.event.id, 1); f.store.markDispatched(old.event.id, old.leaseToken, old.event.id);
  f.store.settle({ eventId: old.event.id, leaseToken: old.leaseToken, status: 'failed', content: '', metadata: [
    { key: `native-terminal-counted:${old.event.id}`, value: 'quarantined' }, { key: `native-admission:${old.event.id}`, value: '' },
  ] });
  const current = f.next();
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: current.event })).toMatchObject({ state: 'isolated', epoch: 2 });
  expect(f.store.getMetadata(`native-terminal-counted:${old.event.id}`)).toBe('quarantined');
  expect(f.store.getEvent(old.event.id)?.status).toBe('failed');
});

it('rolls back withdrawal, epoch and revision together when rebuild persistence fails', () => {
  const f = fixture(), current = f.next(), save = f.store.setMetadata.bind(f.store);
  const failure = vi.spyOn(f.store, 'setMetadata').mockImplementation((key, value) => {
    if (key === botHostHistoryRebuildKey(current.event.laneId)) throw new Error('simulated-disk-failure'); save(key, value);
  });
  expect(() => isolateLegacyTaskNoticeContext({ store: f.store, event: current.event })).toThrow('simulated-disk-failure');
  expect(f.store.getLane(current.event.laneId)?.epoch).toBe(1);
  expect(f.store.getMetadata(botTaskNoticeAudienceKey('alice', f.room.securityDomainId))).toBeUndefined();
  expect(f.store.withdrawnMessagesPage(current.event).items).toEqual([]); failure.mockRestore();
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: current.event })).toMatchObject({ state: 'isolated', epoch: 2 });
});

it('does not rotate a clean owner or a normal direct-user conversation', () => {
  const f = fixture();
  f.store.enqueue({ conversationId: f.room.id, senderId: 'alice', recipientIds: ['bob'], content: 'Bob这次请继续。' });
  const owner = f.store.claim({ workerId: 'owner-clean' })!;
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: owner.event })).toMatchObject({ state: 'clean', sourceIds: [], epoch: 1 });
  f.store.cancelEvent(owner.event.id);
  const direct = f.store.openDirect('alice'); f.store.enqueue({ conversationId: direct.id, senderId: 'user', content: '用户单聊' });
  const user = f.store.claim({ workerId: 'direct' })!;
  expect(isolateLegacyTaskNoticeContext({ store: f.store, event: user.event })).toMatchObject({ state: 'current', sourceIds: [], epoch: 1 });
  expect(f.store.getMetadata(botTaskNoticeAudienceKey('alice', direct.securityDomainId))).toBeUndefined();
});

const model = { apiFormat: 'openai_chat' as const, model: 'local-protocol-fixture', baseUrl: 'https://model.invalid/v1', apiKey: 'local-fixture' };
function runInput(root: string, laneId: string, eventId: string): BotDshRun {
  return { laneId, eventId, cwd: root, system: '你是Alice，当前只和Bob在伙伴私聊里说话。', prompt: '继续我们已公开聊的内容。',
    model, tools: [], callback: { url: 'http://127.0.0.1:1', token: 'fixture-unused' } };
}
const textResponse = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });

it('starts an actual AppBrain epoch without the old summary, old prompt, old assistant or full-result reader access', async () => {
  const f = fixture(), current = f.next(), isolated = isolateLegacyTaskNoticeContext({ store: f.store, event: current.event });
  const journal = new BotAppBrainStore(path.join(f.root, 'app-brain.sqlite')), laneId = current.event.laneId;
  const old = journal.admit({ laneId, eventId: 'old-private-leak', fingerprint: 'legacy', prompt: secret });
  journal.claim(old.eventId); journal.finish(old.eventId, 'succeeded', '旧助手回了' + secret); journal.release(old.eventId);
  journal.saveSummary(laneId, 0, { through: old.seq, text: '旧摘要：' + secret });
  expect(journal.durableResult(`${laneId}-epoch-${isolated.epoch}`, Number.MAX_SAFE_INTEGER, `turn:${old.eventId}`)).toEqual({ found: false });
  expect(journal.durableResult(laneId, Number.MAX_SAFE_INTEGER, `turn:${old.eventId}`).found).toBe(true); journal.close();
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = String(init?.body); expect(payload).not.toContain(secret); expect(payload).not.toContain('旧助手回了');
    return textResponse('Bob，我们接着聊。');
  });
  const brain = new BotAppBrain({ root: f.root, fetchFn }); brains.push(brain);
  expect(await brain.run(runInput(f.root, `${laneId}-epoch-${isolated.epoch}`, current.event.id))).toMatchObject({ text: 'Bob，我们接着聊。' });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const inspect = new BotAppBrainStore(path.join(f.root, 'app-brain.sqlite'));
  expect(inspect.summary(laneId).text).toContain(secret); expect(inspect.summary(`${laneId}-epoch-${isolated.epoch}`).text).toBe(''); inspect.close();
});

it('keeps unknown non-idempotent calls fenced across an isolated AppBrain epoch without republishing or leaking prior prompts', async () => {
  const f = fixture(), current = f.next(), laneId = current.event.laneId;
  isolateLegacyTaskNoticeContext({ store: f.store, event: current.event });
  const journal = new BotAppBrainStore(path.join(f.root, 'app-brain.sqlite'));
  const old = journal.admit({ laneId, eventId: 'quarantined-original', fingerprint: 'legacy', prompt: secret,
    binding: { system: '原事件', cwd: f.root, tools: [] } });
  journal.claim(old.eventId); journal.requestStep(old.eventId, 0);
  const call = { id: 'original-write', name: 'chat_send_file', arguments: JSON.stringify({ file: 'already-sent-once' }) };
  journal.commitAssistant(old.eventId, 0, { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] }, [call]);
  journal.invoke(old.eventId, call.id); journal.finish(old.eventId, 'quarantined', '', '未知写入保留原件'); journal.release(old.eventId); journal.close();
  const callTool = vi.fn(), reconcileTool = vi.fn(async (call: BotToolCall) => { void call; return { state: 'unknown' as const }; }), requests: string[] = [];
  const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(init?.body)); expect(requests.at(-1)).not.toContain(secret);
    if (requests.length === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'new-write', type: 'function',
      function: { name: 'chat_send_file', arguments: JSON.stringify({ file: 'do-not-resend' }) } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } });
    expect(requests.at(-1)).toContain('旧操作仍有未确认效果'); return textResponse('旧发送还需要核验，我们先聊别的。');
  });
  const brain = new BotAppBrain({ root: f.root, fetchFn, callTool, reconcileTool }); brains.push(brain);
  const result = await brain.run({ ...runInput(f.root, laneId + '-epoch-2', current.event.id),
    tools: [{ name: 'chat_send_file', description: '发送文件', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } }] });
  expect(result.status).toBe('succeeded'); expect(fetchFn).toHaveBeenCalledTimes(2); expect(callTool).not.toHaveBeenCalled();
  expect(reconcileTool).toHaveBeenCalledTimes(1); expect(reconcileTool.mock.calls[0]?.[0]).toMatchObject({ laneId, eventId: old.eventId, callId: call.id });
  const inspect = new BotAppBrainStore(path.join(f.root, 'app-brain.sqlite'));
  expect(inspect.unresolvedCalls(laneId + '-epoch-2')).toEqual([{ eventId: old.eventId, callId: call.id, name: call.name }]); inspect.close();
});
