import { expect, it, vi } from 'vitest';
import { createCompanionCheckpointProgressDrain } from '../../src/main/companions/checkpoint-progress-drain';
import { advanceCompanionReplyTiming, type CompanionReplyProgress } from '../../src/shared/companion-reply-progress';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('coalesces a held write and a burst into one follow-up complete checkpoint without skipping any UI milestone or cumulative time', async () => {
  const entered = deferred(), held = deferred(), report = vi.fn();
  let progress: CompanionReplyProgress = { revision: 1, phase: 'memory', detail: 'first', startedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
  progress = advanceCompanionReplyTiming(undefined, progress);
  const state = { progress, turns: [] as string[], context: 'the complete frozen input' }, writes: typeof state[] = [], notifications: CompanionReplyProgress[] = [];
  const drain = createCompanionCheckpointProgressDrain(async () => {
    writes.push(structuredClone(state));
    if (writes.length === 1) { entered.resolve(); await held.promise; }
  }, report);
  drain.request(); await entered.promise;
  for (let revision = 2; revision <= 20; revision++) {
    state.progress = advanceCompanionReplyTiming(state.progress, { ...state.progress, revision, detail: 'milestone ' + revision,
      updatedAt: new Date(Date.parse('2026-11-01T00:00:00.000Z') + revision * 100).toISOString() });
    notifications.push(structuredClone(state.progress)); drain.request();
  }
  state.turns.push('actual completed tool receipt');
  let finished = false; const barrier = drain.drain().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); expect(writes).toHaveLength(1);
  held.resolve(); await barrier;
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(state); expect(notifications).toHaveLength(19);
  expect(writes[1]!.progress.timing?.elapsedMs).toBe(2000); expect(report).not.toHaveBeenCalled();
});

it('keeps a critical drain waiting for its latest cancellation receipt while the follow-up write is still pending', async () => {
  const first = deferred(), entered = deferred(), second = deferred(), secondEntered = deferred(), states: string[] = [];
  let latest = 'running';
  const drain = createCompanionCheckpointProgressDrain(async () => {
    states.push(latest);
    if (states.length === 1) { entered.resolve(); await first.promise; }
    else { secondEntered.resolve(); await second.promise; }
  }, error => { throw error; });
  drain.request(); await entered.promise;
  latest = 'cancelled-with-actual-stop-receipt'; drain.request();
  let settled = false; const barrier = drain.drain().then(() => { settled = true; });
  first.resolve(); await secondEntered.promise; expect(settled).toBe(false);
  second.resolve(); await barrier; expect(states).toEqual(['running', 'cancelled-with-actual-stop-receipt']);
});

it.each([false, true])('settles one failed attempt without a busy retry and permits later progress (report throws=%s)', async throws => {
  const error = new Error('controlled storage unavailable'), report = vi.fn(() => { if (throws) throw Error('report unavailable'); });
  const write = vi.fn(async () => { if (write.mock.calls.length === 1) throw error; });
  const drain = createCompanionCheckpointProgressDrain(write, report);
  drain.request(); await drain.drain(); await Promise.resolve(); expect(write).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledExactlyOnceWith(error);
  drain.request(); await drain.drain(); expect(write).toHaveBeenCalledTimes(2);
});

it('does not serialize independent task drains behind a held checkpoint', async () => {
  const held = deferred(), entered = deferred(), first = createCompanionCheckpointProgressDrain(async () => { entered.resolve(); await held.promise; }, vi.fn());
  const write = vi.fn(async () => undefined), second = createCompanionCheckpointProgressDrain(write, vi.fn());
  first.request(); await entered.promise; second.request(); await second.drain(); expect(write).toHaveBeenCalledOnce();
  held.resolve(); await first.drain();
});

it('retains a request arriving at the final asynchronous cleanup boundary', async () => {
  let attempts = 0;
  const drain = createCompanionCheckpointProgressDrain(async () => {
    if (++attempts === 1) queueMicrotask(() => drain.request());
  }, vi.fn());
  drain.request(); await drain.drain(); expect(attempts).toBe(2);
});
