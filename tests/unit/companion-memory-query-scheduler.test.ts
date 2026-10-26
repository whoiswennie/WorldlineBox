import { expect, it, vi } from 'vitest';
import { CompanionMemoryQueryScheduler } from '../../src/main/companions/memory-query-scheduler';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

it('lets an independent dream graph run beside foreground while owner withdrawal drains both graphs', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), started = deferred(), release = deferred();
  const dream = scheduler.run('fish', async () => { started.resolve(); await release.promise; },
    { priority: 'background', lane: 'dream-v1' });
  await started.promise;
  const drainFinished = vi.fn(), drain = scheduler.drain('fish').then(drainFinished);
  expect(await scheduler.run('fish', () => 'foreground ready', { priority: 'foreground' })).toBe('foreground ready');
  expect(drainFinished).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(scheduler.snapshot('fish')).toEqual({ running: 'background', foreground: 0, background: 0 }));
  release.resolve(); await Promise.all([dream, drain]); expect(drainFinished).toHaveBeenCalledOnce();
  expect(scheduler.snapshot('fish')).toEqual({ foreground: 0, background: 0 });
});

it('serializes one owner and lets foreground pass queued background without interrupting running work', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), started = deferred(), release = deferred();
  const order: string[] = [];
  const running = scheduler.run('fish', async () => { order.push('running'); started.resolve(); await release.promise; }, { priority: 'background' });
  await started.promise;
  const background = scheduler.run('fish', () => { order.push('background'); }, { priority: 'background' });
  const foreground = scheduler.run('fish', () => { order.push('foreground'); return 42; }, { priority: 'foreground' });
  expect(scheduler.snapshot('fish')).toEqual({ running: 'background', foreground: 1, background: 1 });
  expect(order).toEqual(['running']);
  release.resolve();
  expect(await foreground).toBe(42);
  await Promise.all([running, background]);
  expect(order).toEqual(['running', 'foreground', 'background']);
  await scheduler.drain('fish');
  expect(scheduler.snapshot('fish')).toEqual({ foreground: 0, background: 0 });
});

it('keeps FIFO within priorities and admits waiting background after a bounded foreground burst', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), started = deferred(), release = deferred();
  const order: string[] = [];
  const blocker = scheduler.run('fish', async () => { started.resolve(); await release.promise; }, { priority: 'background' });
  await started.promise;
  const background = [1, 2].map(index => scheduler.run('fish', () => { order.push(`b${index}`); }, { priority: 'background' }));
  const foreground = Array.from({ length: 18 }, (_, index) => scheduler.run('fish', () => { order.push(`f${index + 1}`); }, { priority: 'foreground' }));
  release.resolve();
  await Promise.all([blocker, ...foreground, ...background]);
  expect(order).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'b1',
    'f9', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15', 'f16', 'b2', 'f17', 'f18']);
});

it('runs independent owners concurrently while retaining each owner lane', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), fishStarted = deferred(), releaseFish = deferred(), birdStarted = deferred();
  const fish = scheduler.run('fish', async () => { fishStarted.resolve(); await releaseFish.promise; }, { priority: 'foreground' });
  await fishStarted.promise;
  const nextFish = vi.fn();
  const queuedFish = scheduler.run('fish', nextFish, { priority: 'foreground' });
  const bird = scheduler.run('bird', () => { birdStarted.resolve(); }, { priority: 'background' });
  await birdStarted.promise;
  await bird;
  expect(nextFish).not.toHaveBeenCalled();
  releaseFish.resolve();
  await Promise.all([fish, queuedFish]);
  expect(nextFish).toHaveBeenCalledOnce();
});

it('rejects a cancelled queued foreground immediately and never starts it', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), started = deferred(), release = deferred(), controller = new AbortController();
  const running = scheduler.run('fish', async () => { started.resolve(); await release.promise; }, { priority: 'background' });
  await started.promise;
  const task = vi.fn(), reason = new Error('cancel queued recall');
  const cancelled = scheduler.run('fish', task, { priority: 'foreground', signal: controller.signal });
  const rejected = expect(cancelled).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  expect(task).not.toHaveBeenCalled();
  expect(scheduler.snapshot('fish')).toEqual({ running: 'background', foreground: 0, background: 0 });
  const next = scheduler.run('fish', () => 'next', { priority: 'foreground' });
  release.resolve();
  expect(await next).toBe('next');
  await running;
});

it('does not start already aborted work or retain an idle cancelled registration', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), controller = new AbortController(), task = vi.fn();
  controller.abort(new Error('already cancelled'));
  await expect(scheduler.run('fish', task, { priority: 'foreground', signal: controller.signal })).rejects.toThrow('already cancelled');
  const queuedController = new AbortController();
  const pending = scheduler.run('fish', task, { priority: 'background', signal: queuedController.signal });
  const rejected = expect(pending).rejects.toThrow('cancel before start');
  queuedController.abort(new Error('cancel before start'));
  await rejected;
  await scheduler.drainAll();
  expect(task).not.toHaveBeenCalled();
  expect(await scheduler.run('fish', () => 'fresh registration', { priority: 'foreground' })).toBe('fresh registration');
});

it('keeps an aborted executing task exclusive until its actual work settles', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), started = deferred(), release = deferred(), controller = new AbortController();
  const running = scheduler.run('fish', async () => { started.resolve(); await release.promise; }, { priority: 'background', signal: controller.signal });
  await started.promise;
  const next = vi.fn();
  const queued = scheduler.run('fish', next, { priority: 'foreground' });
  controller.abort();
  expect(scheduler.snapshot('fish')).toEqual({ running: 'background', foreground: 1, background: 0 });
  expect(next).not.toHaveBeenCalled();
  release.resolve();
  await Promise.all([running, queued]);
  expect(next).toHaveBeenCalledOnce();
});

it('releases the owner lane after synchronous and asynchronous task failures', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), failure = new Error('query failed');
  const synchronous = scheduler.run('fish', () => { throw failure; }, { priority: 'foreground' });
  const asynchronous = scheduler.run('fish', async () => { throw failure; }, { priority: 'foreground' });
  const accepted = scheduler.run('fish', () => 'recovered', { priority: 'background' });
  await expect(synchronous).rejects.toBe(failure);
  await expect(asynchronous).rejects.toBe(failure);
  expect(await accepted).toBe('recovered');
  await scheduler.drain('fish');
});

it('drains the already registered owner work while ignoring later arrivals and other owners', async () => {
  const scheduler = new CompanionMemoryQueryScheduler(), started = deferred(), release = deferred(), lateStarted = deferred(), releaseLate = deferred();
  const initial = scheduler.run('fish', async () => { started.resolve(); await release.promise; }, { priority: 'foreground' });
  await started.promise;
  const pending = scheduler.run('fish', () => 'registered before drain', { priority: 'background' });
  const drained = vi.fn();
  const drain = scheduler.drain('fish').then(drained);
  const late = scheduler.run('fish', async () => { lateStarted.resolve(); await releaseLate.promise; }, { priority: 'background' });
  const other = scheduler.run('bird', () => releaseLate.promise, { priority: 'foreground' });
  release.resolve();
  await Promise.all([initial, pending, drain, lateStarted.promise]);
  expect(drained).toHaveBeenCalledOnce();
  expect(scheduler.snapshot('fish').running).toBe('background');
  releaseLate.resolve();
  await Promise.all([late, other]);
  await scheduler.drainAll();
});

it('drains cancelled and rejected registrations and reports deterministic queued time with priority', async () => {
  let now = 100;
  const scheduler = new CompanionMemoryQueryScheduler({ now: () => now }), started = deferred(), release = deferred();
  const blocker = scheduler.run('fish', async info => { expect(info).toEqual({ priority: 'background', queuedMs: 0 }); started.resolve(); await release.promise; }, { priority: 'background' });
  await started.promise;
  const controller = new AbortController(), error = new Error('cancel');
  const cancelled = scheduler.run('fish', () => undefined, { priority: 'foreground', signal: controller.signal });
  const cancelledAssertion = expect(cancelled).rejects.toBe(error);
  const measured = scheduler.run('fish', info => info, { priority: 'foreground' });
  const failure = scheduler.run('fish', async () => { throw new Error('failed'); }, { priority: 'background' });
  const failureAssertion = expect(failure).rejects.toThrow('failed');
  const drain = scheduler.drain('fish');
  controller.abort(error);
  now = 175;
  release.resolve();
  expect(await measured).toEqual({ priority: 'foreground', queuedMs: 75 });
  await Promise.all([blocker, cancelledAssertion, failureAssertion, drain]);
  expect(scheduler.snapshot('fish')).toEqual({ foreground: 0, background: 0 });
});
