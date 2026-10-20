import { expect, it, vi } from 'vitest';
import { createCoalescedRefresh } from '../../src/renderer/companions/coalesced-refresh';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('coalesces a notification burst and starts a later independent refresh', async () => {
  const read = vi.fn(async () => undefined), refresh = createCoalescedRefresh(read);
  const first = refresh.trigger();
  expect(refresh.trigger()).toBe(first); expect(refresh.trigger()).toBe(first);
  await first; expect(read).toHaveBeenCalledTimes(1);
  await refresh.trigger(); expect(read).toHaveBeenCalledTimes(2);
});

it('accepts each completed read and combines all changes during it into one trailing read', async () => {
  const firstRead = deferred(), secondRead = deferred();
  let active = 0, maximumActive = 0;
  const results: number[] = [];
  const read = vi.fn(async () => {
    const index = read.mock.calls.length;
    maximumActive = Math.max(maximumActive, ++active);
    await (index === 1 ? firstRead : secondRead).promise;
    results.push(index); active--;
  });
  const refresh = createCoalescedRefresh(read), pending = refresh.trigger();
  await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1);
  for (let event = 0; event < 30; event++) expect(refresh.trigger()).toBe(pending);
  firstRead.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(results).toEqual([1]); expect(read).toHaveBeenCalledTimes(2);
  secondRead.resolve(); await pending;
  expect(results).toEqual([1, 2]); expect(maximumActive).toBe(1);
});

it('reports failures without unhandled rejection or retries when no new change exists', async () => {
  const cause = new Error('temporary IPC failure'), report = vi.fn(() => { throw new Error('reporting failed'); });
  const read = vi.fn(async () => { throw cause; }), refresh = createCoalescedRefresh(read, report);
  await expect(refresh.trigger()).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledWith(cause);
  await Promise.resolve(); expect(read).toHaveBeenCalledTimes(1);
  await refresh.trigger(); expect(read).toHaveBeenCalledTimes(2);
});

it('keeps a real trailing notification after the current read fails', async () => {
  const wait = deferred(), failure = new Error('read failed');
  const read = vi.fn().mockImplementationOnce(async () => { await wait.promise; throw failure; }).mockResolvedValue(undefined);
  const report = vi.fn(), refresh = createCoalescedRefresh(read, report), pending = refresh.trigger();
  await Promise.resolve(); refresh.trigger(); wait.resolve(); await pending;
  expect(read).toHaveBeenCalledTimes(2); expect(report).toHaveBeenCalledExactlyOnceWith(failure);
});

it('disposes before starting or while in flight without performing any late trailing reads', async () => {
  const never = vi.fn(), beforeStart = createCoalescedRefresh(never), skipped = beforeStart.trigger();
  beforeStart.dispose(); await skipped; await beforeStart.trigger(); expect(never).not.toHaveBeenCalled();
  const wait = deferred(), read = vi.fn(async () => wait.promise), inFlight = createCoalescedRefresh(read);
  const pending = inFlight.trigger(); await Promise.resolve(); inFlight.trigger();
  inFlight.dispose(); await inFlight.trigger(); wait.resolve(); await pending;
  expect(read).toHaveBeenCalledTimes(1);
});

it('bounds reads and concurrency during 40,000 continuous updates, catches up, and releases pending timers', async () => {
  vi.useFakeTimers();
  try {
    let version = 0, displayed = 0, active = 0, peak = 0;
    const read = vi.fn(async () => { const snapshot = version; peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 30)); displayed = snapshot; active--; });
    const refresh = createCoalescedRefresh(read, undefined, 500), pending = refresh.trigger();
    for (let batch = 0; batch < 400; batch++) {
      for (let event = 0; event < 100; event++) { version++; void refresh.trigger(); }
      await vi.advanceTimersByTimeAsync(25);
    }
    await vi.advanceTimersByTimeAsync(600); await pending;
    expect(displayed).toBe(40000); expect(peak).toBe(1); expect(read.mock.calls.length).toBeLessThanOrEqual(22);
    void refresh.trigger(); await vi.advanceTimersByTimeAsync(1); refresh.dispose(); await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
