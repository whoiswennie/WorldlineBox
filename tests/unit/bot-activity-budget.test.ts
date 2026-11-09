import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotScheduler } from '../../src/main/companion-bot/scheduler';
import { BotActivityLimitError, type BotActivityBudgetPolicy } from '../../src/main/companion-bot/activity-budget';
import type { BotClaim } from '../../src/main/companion-bot/types';

const stores: BotStore[] = [], schedulers: BotScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.close(100); for (const store of stores.splice(0)) store.close();
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

it('leaves an interactive companion slot while two other automatic companions are waiting', async () => {
  const f = fixture();
  for (const id of ['bob', 'carol']) f.automatic(`auto-${id}`, `root-${id}`, id);
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
