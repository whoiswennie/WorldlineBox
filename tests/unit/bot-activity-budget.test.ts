import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotScheduler } from '../../src/main/companion-bot/scheduler';
import { BotActivityLimitError, BotBackpressureError, type BotActivityBudgetPolicy } from '../../src/main/companion-bot/activity-budget';
import type { BotClaim } from '../../src/main/companion-bot/types';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const stores: BotStore[] = [], schedulers: BotScheduler[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.close(100); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-budget-recovery-')) throw Error('Invalid cleanup'); rmSync(root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});
function fixture(policy: Partial<BotActivityBudgetPolicy> = {}, filename = ':memory:') {
  const options = { activityBudget: { maxPendingInbox: 20, reservedInteractiveInbox: 2, maxPendingTasks: 10, reservedInteractiveTasks: 2, ...policy } };
  const store = new BotStore(filename, options); stores.push(store);
  for (const id of ['alice', 'bob', 'carol']) store.createCompanion({ id, name: id, persona: '伙伴' });
  const world = store.createGroup({ title: 'world', kind: 'world', memberIds: ['alice', 'bob', 'carol'] });
  const user = (id: string) => store.enqueue({ conversationId: world.id, senderId: 'user', sourceMessageId: id, recipientIds: ['alice'], content: '用户请求' }).events[0]!;
  const automatic = (id: string, correlationId: string, recipient = 'bob') => store.tryEnqueueAutomatic({ conversationId: world.id, senderId: 'world', source: 'world', sourceMessageId: id,
    recipientIds: [recipient], correlationId, content: '真实物理观察' });
  return { store, world, user, automatic, options };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('bounds branching activity by durable correlation rather than each branch and charges duplicates once', () => {
  const f = fixture({ maxDerivedEvents: 3, maxActions: 2 }), root = f.user('root');
  expect(f.automatic('one', root.correlationId).accepted).toBe(true);
  expect(f.automatic('one', root.correlationId).accepted).toBe(true);
  expect(f.automatic('two', root.correlationId, 'carol').accepted).toBe(true);
  expect(f.automatic('three', root.correlationId, 'alice').accepted).toBe(true);
  expect(f.automatic('four', root.correlationId).accepted).toBe(false);
  const claim = f.store.claim({ workerId: 'fixture' })!;
  f.store.reserveAutomaticAction(claim.event.id, 'call-one', 'world'); f.store.reserveAutomaticAction(claim.event.id, 'call-one', 'world');
  f.store.reserveAutomaticAction(claim.event.id, 'call-two', 'task');
  expect(() => f.store.reserveAutomaticAction(claim.event.id, 'call-three', 'memory_write')).toThrow(BotActivityLimitError);
  const fresh = f.user('new-user'); expect(fresh.correlationId).not.toBe(root.correlationId);
  expect(f.automatic('fresh-branch', fresh.correlationId).accepted).toBe(true);
});

it('enforces task and elapsed budgets but never swallows a terminal task notification', () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture({ maxTasks: 2, maxElapsedMs: 1000 }), root = f.user('root');
  const create = (id: string) => f.store.createTask({ id, conversationId: f.world.id, companionId: 'alice', sourceEventId: root.id, goal: '有限任务' });
  const first = create('task-one'); expect(create('task-one').id).toBe(first.id); create('task-two');
  expect(() => create('task-three')).toThrow(BotActivityLimitError);
  now += 1001; expect(f.automatic('expired', root.correlationId).accepted).toBe(false);
  expect(f.store.enqueueTaskNotice({ source: 'task', senderId: 'task-service', sourceMessageId: 'terminal-one', conversationId: f.world.id,
    recipientIds: ['alice'], correlationId: root.correlationId, content: '真实任务已经完成' })).toEqual({ deferred: false });
});

it('keeps interactive capacity, rejects unaccepted new input and durably defers lifecycle notices at the hard Inbox bound', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-budget-recovery-')); roots.push(root);
  const filename = path.join(root, 'bot.sqlite'), f = fixture({ maxPendingInbox: 3, reservedInteractiveInbox: 1 }, filename);
  expect(f.automatic('auto-one', 'auto-root', 'alice').accepted).toBe(true);
  expect(f.automatic('auto-two', 'auto-root', 'bob').accepted).toBe(true);
  expect(f.automatic('auto-three', 'other-root', 'carol').accepted).toBe(false);
  f.user('reserved-user'); expect(() => f.user('not-accepted')).toThrow(BotBackpressureError);
  const notice = { source: 'task' as const, senderId: 'task-service', sourceMessageId: 'terminal-once', conversationId: f.world.id, recipientIds: ['alice'], content: '终态回执' };
  expect(f.store.enqueueTaskNotice(notice)).toEqual({ deferred: true }); expect(f.store.enqueueTaskNotice(notice)).toEqual({ deferred: true });
  stores.splice(stores.indexOf(f.store), 1); f.store.close(); f.store = new BotStore(filename, f.options); stores.push(f.store);
  const first = f.store.claim({ workerId: 'fixture', preferInteractive: true })!;
  // The later user cannot overtake the older automatic event in this same lane.
  expect(first.event.source).toBe('world');
  f.store.settle({ eventId: first.event.id, leaseToken: first.leaseToken, status: 'done' });
  let noticeClaim: BotClaim | undefined;
  for (let index = 0; index < 4; index++) {
    const next = f.store.claim({ workerId: 'fixture', preferInteractive: true }); if (!next) break;
    if (next.event.source === 'task') noticeClaim = next;
    f.store.settle({ eventId: next.event.id, leaseToken: next.leaseToken, status: 'done' });
  }
  expect(noticeClaim?.event.content).toBe('终态回执');
  expect(f.store.messagesPage(f.world.id, { limit: 100 }).items.filter(message => message.senderId === 'task-service' && message.content === '终态回执')).toHaveLength(1);
});

it('reserves task slots for explicit user mandates while bounding automatic task floods', () => {
  const f = fixture({ maxTasks: 10, maxPendingTasks: 3, reservedInteractiveTasks: 1 });
  const input = f.automatic('source', 'automatic-root', 'alice'); if (!input.accepted) throw Error('Fixture event rejected');
  const source = input.events[0]!;
  const auto = (id: string) => f.store.createTask({ id, sourceEventId: source.id, conversationId: f.world.id, companionId: 'alice', goal: '自动任务' });
  auto('auto-one'); auto('auto-two'); expect(() => auto('auto-three')).toThrow(BotBackpressureError);
  const user = f.user('user-reserved'); f.store.createTask({ id: 'user-task', sourceEventId: user.id, conversationId: f.world.id, companionId: 'alice', goal: '用户委派' });
  expect(auto('auto-one').id).toBe('auto-one');
  expect(() => f.store.createTask({ sourceEventId: user.id, conversationId: f.world.id, companionId: 'alice', goal: '超额' })).toThrow(BotBackpressureError);
});

it('leaves an interactive execution slot while two automatic lanes are waiting', async () => {
  const f = fixture();
  for (const id of ['alice', 'bob', 'carol']) f.automatic(`auto-${id}`, `root-${id}`, id);
  const started: BotClaim[] = [], release = new Map<string, () => void>();
  const scheduler = new BotScheduler(f.store, { concurrency: 3, handle: async claim => {
    started.push(claim); await new Promise<void>(resolve => release.set(claim.event.id, resolve));
    f.store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done' });
  } }); schedulers.push(scheduler); scheduler.start(); await tick();
  expect(started).toHaveLength(2);
  const direct = f.store.openDirect('alice');
  const interactive = f.store.enqueue({ conversationId: direct.id, senderId: 'user', content: '现在回应我' }).events[0]!;
  scheduler.wake(); await tick(); expect(started.at(-1)?.event.id).toBe(interactive.id);
  for (const done of release.values()) done(); await tick();
  for (const done of release.values()) done(); await tick();
});

it('fences and cancels a main turn at its finite processing deadline', async () => {
  const f = fixture(), root = f.user('deadline'), errors: Error[] = [];
  const scheduler = new BotScheduler(f.store, { turnTimeoutMs: 15, onError: error => errors.push(error), handle: async (_claim, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } }); schedulers.push(scheduler); scheduler.start();
  await new Promise(resolve => setTimeout(resolve, 45));
  expect(f.store.getEvent(root.id)?.status).toBe('cancelled'); expect(errors[0]?.message).toContain('时间预算'); expect(scheduler.runningCount).toBe(0);
});
