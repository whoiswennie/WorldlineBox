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
