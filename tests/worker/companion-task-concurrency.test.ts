import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

let root: string, file: string, store: CompanionsStore;
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '按各自目标执行', model: '', avatar: 'sister' as const, active: true, proactive: false }));
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'companion-task-concurrency-')); file = path.join(root, 'messages.sqlite'); store = new CompanionsStore(file, seeds); });
afterEach(() => { store.close(); removeOwnedDirectorySync(root); vi.useRealTimers(); });
function queued(id: string, owner = 'alice', room = store.openPrivate(owner).id) {
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '独立目标 ' + id, replyDirective: 'none' });
  const work = { id, companionId: owner, conversationId: room, sourceMessageId: source.id, status: 'queued' as const, proactive: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.request({ type: 'work.enqueue', work }); return work;
}
const policy = (owner = 'alice') => store.request({ type: 'tasks.concurrency.get', companionId: owner }).taskConcurrency!.policies[0]!;

it('admits three independent jobs across private/group entrances and keeps the fourth queued', () => {
  const group = store.request({ type: 'conversation.create-group', title: '群聊', memberIds: ['alice', 'bob'] }).conversation!;
  queued('a'); queued('b', 'alice', group.id); queued('c'); queued('d', 'alice', group.id);
  expect(policy()).toMatchObject({ limit: 3, active: 0, queued: 4 });
  expect(['a', 'b', 'c'].map(() => store.request({ type: 'work.claim' }).work?.id)).toEqual(['a', 'b', 'c']);
  expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
  expect(policy()).toMatchObject({ limit: 3, active: 3, queued: 1 });
});

it('reduces future admission without killing running work and preserves the owner policy across restart', () => {
  for (const id of ['one', 'two', 'three', 'four']) queued(id);
  for (let n = 0; n < 3; n++) store.request({ type: 'work.claim' });
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  expect(policy()).toMatchObject({ limit: 1, active: 3 });
  store.request({ type: 'work.status', id: 'one', status: 'done' }); store.request({ type: 'work.status', id: 'two', status: 'cancelled' });
  expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
  store.request({ type: 'work.status', id: 'three', status: 'done' });
  expect(store.request({ type: 'work.claim' }).work?.id).toBe('four');
  store.close(); store = new CompanionsStore(file, seeds);
  expect(policy().limit).toBe(1);
});

it('shares each owner budget between standalone actions and replies without counting a bound child twice', () => {
  const first = queued('first'), second = queued('second');
  store.request({ type: 'work.claim' }); store.request({ type: 'work.claim' });
  const messageId = store.request({ type: 'loop.get', sourceMessageId: first.sourceMessageId, companionId: 'alice' }).loop!.messageId!;
  const child = store.createAction({ companionId: 'alice', conversationId: first.conversationId, sourceMessageId: first.sourceMessageId,
    parentMessageId: messageId, title: '父任务的工具步骤', status: 'queued' });
  expect(store.request({ type: 'tasks.capacity.claim-action', id: child.id }).taskCapacityClaimed).toBe(true);
  expect(policy().active).toBe(2);
  const standalone = store.createAction({ companionId: 'alice', conversationId: second.conversationId, sourceMessageId: second.sourceMessageId, title: '独立工具目标', status: 'queued' });
  expect(store.request({ type: 'tasks.capacity.claim-action', id: standalone.id }).taskCapacityClaimed).toBe(true);
  const blocked = store.createAction({ companionId: 'alice', conversationId: second.conversationId, sourceMessageId: second.sourceMessageId, title: '等待中的独立目标', status: 'queued' });
  expect(store.request({ type: 'tasks.capacity.claim-action', id: blocked.id }).taskCapacityClaimed).toBe(false);
  expect(policy().active).toBe(3);
  queued('other-owner', 'bob'); expect(store.request({ type: 'work.claim' }).work?.id).toBe('other-owner');
  expect(policy('bob').active).toBe(1);
});

it('counts actual autonomous-learning leases against the shared owner budget and releases only that grant', () => {
  queued('chat-one'); queued('chat-two'); queued('chat-three');
  store.request({ type: 'work.claim' }); store.request({ type: 'work.claim' });
  const grant = store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'library', libraryName: '明确授权资料',
    libraryPath: root, autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
  store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const reading = store.request({ type: 'learning.claim' }).learningJob!;
  expect(reading?.id).toBe(grant.id);
  expect(policy().active).toBe(3);
  expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
  store.request({ type: 'learning.advance', id: grant.id, leaseToken: reading.leaseToken, more: false, reason: '当前资料页已读完' });
  expect(policy().active).toBe(2);
  expect(store.request({ type: 'work.claim' }).work?.id).toBe('chat-three');
});

it('admits a learning goal only within the remaining capacity and keeps chat running when the goal is paused', () => {
  queued('first-chat'); queued('second-chat'); queued('third-chat');
  store.request({ type: 'work.claim' }); store.request({ type: 'work.claim' });
  const goal = store.request({ type: 'learning.goals.create', companionId: 'alice', text: '持续核实获准资料', materials: [], allowWeb: false }).learningGoal!;
  const claimed = store.request({ type: 'learning.goals.claim' }).learningGoalJob!;
  expect(claimed?.goal.id).toBe(goal.id);
  expect(policy().active).toBe(3);
  expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
  store.request({ type: 'learning.goals.update', companionId: 'alice', id: goal.id, expectedRevision: goal.revision, state: 'paused' });
  expect(policy().active).toBe(2);
  expect(store.request({ type: 'work.claim' }).work?.id).toBe('third-chat');
});

it('recovers expired worker leases one at a time after the owner reduces the cap', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const orders = ['one', 'two', 'three'].map(title => store.request({ type: 'work-order.create', ...scope,
    title, instruction: '保留原目标并继续尚未完成的步骤。' }).workOrder!);
  const original = orders.map(() => store.request({ type: 'work-order.claim', companionId: 'alice', leaseMs: 1000 }).workOrderClaim!);
  expect(policy().active).toBe(3);
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  vi.setSystemTime(Date.now() + 1001);
  expect(policy().active).toBe(0);
  const recovered = store.request({ type: 'work-order.claim', companionId: 'alice', leaseMs: 1000 }).workOrderClaim!;
  expect(recovered.order.id).toBe(orders[0]!.id);
  expect(recovered.order.instruction).toBe(orders[0]!.instruction);
  expect(recovered.leaseToken).not.toBe(original[0]!.leaseToken);
  expect(policy().active).toBe(1);
  expect(store.request({ type: 'work-order.claim', companionId: 'alice' }).workOrderClaim).toBeUndefined();
});

it('keeps a live native child in its expired parent slot while allowing that same parent to recover', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  store.request({ type: 'tasks.concurrency.set', companionId: 'alice', limit: 1 });
  const order = store.request({ type: 'work-order.create', ...scope, title: '继续原执行器', instruction: '保持当前执行进度。' }).workOrder!;
  store.request({ type: 'work-order.claim', companionId: 'alice', leaseMs: 1000 });
  const child = store.createAction({ ...scope, sourceMessageId: order.sourceMessageId, workOrderId: order.id, title: '仍在执行的步骤', status: 'queued' });
  expect(store.request({ type: 'tasks.capacity.claim-action', id: child.id }).taskCapacityClaimed).toBe(true);
  vi.setSystemTime(Date.now() + 1001);
  expect(policy().active).toBe(1);
  queued('new-target');
  expect(store.request({ type: 'work.claim' }).work).toBeUndefined();
  expect(store.request({ type: 'work-order.claim', companionId: 'alice' }).workOrderClaim?.order.id).toBe(order.id);
  expect(policy().active).toBe(1);
  expect(store.request({ type: 'action.get', id: child.id }).action?.status).toBe('running');
});
