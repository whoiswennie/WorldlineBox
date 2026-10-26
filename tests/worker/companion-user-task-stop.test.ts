import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { companionDshReceipt } from '../../src/shared/companion-dsh-receipt';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

let root: string, database: string, store: CompanionsStore, room: string;
const seeds = [{ id: 'owner', name: '伙伴', description: '', persona: '如实说明', model: '', avatar: 'sister' as const, active: true, proactive: false }];
const stop = { actor: 'user' as const, reason: 'user_requested' as const, requestedAt: '2026-10-26T05:00:00.000Z' };
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'companion-user-task-stop-')); database = path.join(root, 'messages.sqlite'); store = new CompanionsStore(database, seeds); room = store.openPrivate('owner').id; });
afterEach(() => { store.close(); removeOwnedDirectorySync(root); });

it('persists exact user reply stop, rejects late publication, and clears active suppression only on explicit retry', () => {
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '原始目标', replyDirective: 'none' });
  const work = { id: 'specific-work', companionId: 'owner', conversationId: room, sourceMessageId: source.id, status: 'queued' as const,
    proactive: false, createdAt: stop.requestedAt, updatedAt: stop.requestedAt };
  store.request({ type: 'work.enqueue', work });
  const loop = store.request({ type: 'loop.get', companionId: 'owner', sourceMessageId: source.id }).loop!;
  store.request({ type: 'work.status', id: work.id, status: 'cancelled' });
  store.request({ type: 'task-stop.record', kind: 'reply', taskId: work.id, companionId: 'owner', conversationId: room, title: '原始目标', stop });
  expect(() => store.request({ type: 'loop.save', checkpoint: { ...loop, status: 'done', turns: [{ text: '迟到结果', rawText: '迟到结果', calls: [] }] } })).toThrow('用户已停止');
  store.close(); store = new CompanionsStore(database, seeds);
  expect(store.getMessage(loop.messageId!).replyProgress).toMatchObject({ phase: 'cancelled', stop, finishedAt: stop.requestedAt });
  expect(store.request({ type: 'task-stop.list', companionId: 'owner', conversationId: room }).userTaskStops).toEqual([expect.objectContaining({ taskId: work.id, stop })]);
  store.request({ type: 'work.enqueue', work, resume: true });
  expect(store.request({ type: 'task-stop.list', companionId: 'owner', conversationId: room }).userTaskStops).toEqual([]);
  expect(store.getMessage(loop.messageId!).replyProgress?.stop).toBeUndefined();
});

it('keeps user-stopped actions terminal while retaining a late native cleanup ID and excluding failure wording', () => {
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '只读检查文件', replyDirective: 'none' });
  const action = store.createAction({ companionId: 'owner', conversationId: room, sourceMessageId: source.id, title: '只读检查', status: 'queued' });
  store.updateAction(action.id, { status: 'cancelled' });
  store.request({ type: 'task-stop.record', kind: 'action', taskId: action.id, companionId: 'owner', conversationId: room, title: action.title, stop });
  store.updateAction(action.id, { status: 'failed', error: 'Aborted', taskId: 'late-native-task' });
  expect(store.getAction(action.id)).toMatchObject({ status: 'cancelled', stop, taskId: 'late-native-task' });
  expect(store.getAction(action.id).error).toBeUndefined();
  expect(companionDshReceipt(store.getAction(action.id))).toMatchObject({ stop, stopMeaning: expect.stringContaining('用户手动停止') });
  expect(companionDshReceipt(store.getAction(action.id)).error).toBeUndefined();
});

it('rejects cross-owner and non-cancelled stop receipts instead of fabricating a human decision', () => {
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '正常运行', replyDirective: 'none' });
  const action = store.createAction({ companionId: 'owner', conversationId: room, sourceMessageId: source.id, title: '当前工作', status: 'queued' });
  expect(() => store.request({ type: 'task-stop.record', kind: 'action', taskId: action.id, companionId: 'owner', conversationId: room, title: action.title, stop })).toThrow('已停止');
  expect(() => store.request({ type: 'task-stop.record', kind: 'action', taskId: action.id, companionId: 'another-owner', conversationId: room, title: action.title, stop })).toThrow('当前伙伴');
});

it('resumes a manually stopped activity at its saved step and history after revalidating its original source', () => {
  const scope = { companionId: 'owner', conversationId: room };
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '先观察然后等一会儿继续这个目标', replyDirective: 'none' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id, clientId: 'manual-resume', title: '持续核对', goal: source.content }).activityTask!;
  const leased = store.request({ type: 'activity.claim' }).activityTask!;
  expect(leased?.id).toBe(task.id);
  const advanced = store.request({ type: 'activity.commit', id: task.id, leaseToken: leased.leaseToken!,
    decision: { status: 'continue', action: null, wait: { kind: 'delay', seconds: 1 }, summary: '已经完成第一步，保存等待' },
    executionReadset: captureCompanionExecutionReadset(scope, { sources: [{ id: source.id, conversationId: room,
      checksum: createHash('sha256').update(source.content).digest('hex') }] }) }).activityTask!;
  expect(advanced.step).toBe(1);
  store.request({ type: 'activity.cancel', ...scope, id: task.id });
  store.request({ type: 'task-stop.record', kind: 'activity', taskId: task.id, ...scope, title: task.title, stop });
  const resumed = store.request({ type: 'activity.resume', ...scope, id: task.id }).activityTask!;
  expect(resumed).toMatchObject({ id: task.id, status: 'queued', step: 1, goal: task.goal });
  expect(resumed.history).toEqual(advanced.history);
  expect(resumed.stop).toBeUndefined();
  expect(store.request({ type: 'activity.claim' }).activityTask).toMatchObject({ id: task.id, step: 1 });
});
