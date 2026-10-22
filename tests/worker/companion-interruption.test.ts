import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageResponseSchema } from '../../src/shared/companion-storage';
let store: CompanionsStore, root: string;
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, persona: '独立且尊重边界', description: '', model: '', avatar: 'sister', active: true, proactive: true }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-20T10:00:00Z'); root = mkdtempSync(path.join(tmpdir(), 'companion-interrupt-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const id of ['alice', 'bob']) {
    const s = scope(id), routine = store.request({ type: 'routine.get', ...s }).routine!;
    store.request({ type: 'routine.configure', ...s, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
  }
  advance(20000);
});
afterEach(() => { store.close(); if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-interrupt-')) throw new Error('Unexpected fixture'); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function scope(id: string) { return { companionId: id, conversationId: store.openPrivate(id).id }; }
function advance(ms: number) { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; }

it.each(['sleeping', 'eating', 'resting', 'working'])('interrupts a real %s peer through an actual urgent message, then restores the preserved activity', phase => {
  const bob = scope('bob'), alice = scope('alice'), routine = store.request({ type: 'routine.get', ...bob }).routine!;
  store.request({ type: 'routine.configure', ...bob, expectedRevision: routine.revision, patch: { timeZone: 'UTC',
    ...(phase === 'sleeping' ? { sleepAt: '09:00', wakeAt: '11:00' } : {}),
    ...(phase === 'eating' ? { meals: [{ name: '用餐', at: '10:00', durationMinutes: 30 }] } : {}),
    ...(phase === 'resting' ? { habits: [{ id: 'rest', title: '休息', kind: 'rest', at: '10:00', durationMinutes: 30 }] } : {}),
  } });
  if (phase === 'working') {
    const source = store.appendMessage({ conversationId: bob.conversationId, authorId: 'user', content: '专注处理工作', replyDirective: 'none' });
    store.request({ type: 'world.work.begin', ...bob, workId: 'original_work', kind: 'action', sourceMessageId: source.id });
  }
  expect(advance(30000).actors.find(actor => actor.companionId === 'bob')?.activity).toBe(phase);
  store.request({ type: 'world.tool', ...alice, arguments: { action: 'message', recipientIds: ['bob'], text: '有件事现在需要先听你说，能先回应一下吗？', urgent: true } });
  let job = store.request({ type: 'social.job.claim' }).socialJob;
  for (let i = 0; i < 20 && !job; i++) { advance(600); job = store.request({ type: 'social.job.claim' }).socialJob; }
  expect(job).toMatchObject({ companionId: 'bob', urgent: true, status: 'running' });
  expect(store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === 'bob')?.activity).not.toBe('sleeping');
  const before = store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!;
  expect(before.events.some(event => event.kind === 'social_interrupt')).toBe(true);
  expect(before.links.find(link => link.targetId === 'bob')?.status).toBe('phone');
  advance(1300); store.request({ type: 'social.job.complete', id: job!.id, leaseToken: job!.leaseToken!, text: '我先听你说，处理完再接着刚才的事。' });
  const resumed = advance(30000).actors.find(actor => actor.companionId === 'bob')!;
  expect(resumed.activity).toBe(phase);
  expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.events.some(event => event.kind === 'social_resume')).toBe(true);
  expect(() => store.request({ type: 'world.tool', ...alice, arguments: { action: 'message', recipientIds: ['bob'], text: '再打扰一次', urgent: true } })).toThrow('已经发起紧急联系');
});

it('keeps a manually dormant peer unloaded even when an urgent source exists', () => {
  store.setCompanionActive('bob', false); const alice = scope('alice');
  expect(() => store.request({ type: 'world.tool', ...alice, arguments: { action: 'message', recipientIds: ['bob'], text: '急事，需要你回应。', urgent: true } })).toThrow('手动激活');
  advance(1300); expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  advance(10000); expect(store.request({ type: 'social.job.claim' }).socialJob).toBeUndefined();
  const world = store.request({ type: 'world.snapshot' }).world!;
  expect(world.actors.some(actor => actor.companionId === 'bob')).toBe(false); expect(world.scenes.some(scene => scene.ownerId === 'bob')).toBe(false);
  expect(store.request({ type: 'social.graph', companionId: 'alice' }).socialGraph!.nodes.find(node => node.id === 'bob')).toBeUndefined(); // Rejected contact cannot invent a relationship.
});

it.each([false, true])('durably pauses and restores original work while respecting a later human edit=%s', edited => {
  const bob = scope('bob');
  let order = store.request({ type: 'work-order.create', ...bob, title: '原来的工作', instruction: '保留当前工作目标', clientId: 'original_order' }).workOrder!;
  order = store.request({ type: 'work-order.accept', ...bob, id: order.id, expectedRevision: order.revision }).workOrder!;
  const source = store.appendMessage({ conversationId: bob.conversationId, authorId: 'user', content: '现在请优先处理我的新事项。', replyDirective: 'none' });
  expect(store.request({ type: 'interruption.begin', ...bob, sourceMessageId: source.id }).interruption).toBeUndefined();
  store.request({ type: 'world.attention.record', ...bob, sourceMessageId: source.id, sourceChecksum: createHash('sha256').update(source.content).digest('hex'), urgency: 'urgent', confidence: 1, evidence: [source.content], reason: '玩家明确指定优先处理。' });
  const response = store.request({ type: 'interruption.begin', ...bob, sourceMessageId: source.id }), interruption = response.interruption!;
  expect(() => companionStorageResponseSchema.parse(response)).not.toThrow(); expect(interruption.orders.map(order => order.id)).toEqual([order.id]);
  order = store.request({ type: 'work-order.list', ...bob }).workOrderPage!.items[0]!; expect(order.status).toBe('paused');
  if (edited) store.request({ type: 'work-order.pause', ...bob, id: order.id, expectedRevision: order.revision, paused: true });
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  store.request({ type: 'interruption.recover' });
  const restored = store.request({ type: 'work-order.list', ...bob }).workOrderPage!.items[0]!;
  expect(restored.status).toBe(edited ? 'paused' : 'accepted'); expect(restored.instruction).toBe('保留当前工作目标');
  expect(store.request({ type: 'actions' }).actions).toHaveLength(0);
});

it('admits the interrupted request’s new work while holding unrelated accepted work until the priority request settles', () => {
  const bob = scope('bob');
  const source = store.appendMessage({ conversationId: bob.conversationId, authorId: 'user', content: '先处理这份紧急工作。', replyDirective: 'none' });
  store.request({ type: 'world.attention.record', ...bob, sourceMessageId: source.id, sourceChecksum: createHash('sha256').update(source.content).digest('hex'), urgency: 'urgent', confidence: 1, evidence: [source.content], reason: '玩家明确指定优先工作。' });
  const interruption = store.request({ type: 'interruption.begin', ...bob, sourceMessageId: source.id }).interruption!;
  const accept = (title: string, sourceMessageId?: string) => {
    const order = store.request({ type: 'work-order.create', ...bob, title, instruction: title, sourceMessageId }).workOrder!;
    return store.request({ type: 'work-order.accept', ...bob, id: order.id, expectedRevision: order.revision }).workOrder!;
  };
  const unrelated = accept('稍后再处理的普通工作');
  const priority = accept('本次紧急请求的工作', source.id);
  const claimed = store.request({ type: 'work-order.claim', companionId: 'bob' }).workOrderClaim!;
  expect(claimed.order.id).toBe(priority.id);
  store.request({ type: 'work-order.cancel', ...bob, id: priority.id, expectedRevision: claimed.order.revision });
  expect(store.request({ type: 'work-order.claim', companionId: 'bob' }).workOrderClaim).toBeUndefined();
  store.request({ type: 'interruption.end', id: interruption.id });
  expect(store.request({ type: 'work-order.claim', companionId: 'bob' }).workOrderClaim?.order.id).toBe(unrelated.id);
});
