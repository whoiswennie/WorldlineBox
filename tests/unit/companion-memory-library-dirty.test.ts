import { EventEmitter } from 'node:events';
import type { FSWatcher, watch } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { CompanionMemoryDirtyFiles } from '../../src/main/companions/memory-library-dirty';

function watcher() {
  const events = new EventEmitter();
  const value = Object.assign(events, { unref: () => events, close: () => queueMicrotask(() => events.emit('close')) }) as unknown as FSWatcher;
  return (() => value) as unknown as typeof watch;
}

it('bounds 1000 owner admissions to FIFO four and lets a queued cold owner precede hot rescans', async () => {
  let active = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), calls: string[] = [], counts = new Map<string, number>();
  const files = new CompanionMemoryDirtyFiles({ directory: 'C:/controlled-fixture', watch: watcher(), waitMs: 10000,
    reconcile: async (owner, batch) => {
      active++; peak = Math.max(peak, active);
      const round = (counts.get(owner) ?? 0) + 1; counts.set(owner, round); calls.push(owner + ':' + round);
      try { if (owner.startsWith('hot') && round === 1) { batch.rescan(); await gate; } }
      finally { active--; }
    } });
  const requests = Array.from({ length: 1000 }, (_, n) => files.prepare(n < 4 ? 'hot' + n : 'cold' + n));
  try {
    await vi.waitFor(() => expect(active).toBe(4)); expect(files.snapshot('hot0').global.queued).toBe(996);
    release(); await Promise.all(requests);
    expect(peak).toBe(4); expect(calls.indexOf('cold4:1')).toBeLessThan(calls.indexOf('hot0:2'));
    expect(calls).toHaveLength(1004); expect(files.snapshot('hot0').global).toEqual({ active: 0, queued: 0, limit: 4 });
  } finally { release(); await files.close(); }
});

it('drains a closed scheduler without admitting its queued owners or leaving promises behind', async () => {
  let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const files = new CompanionMemoryDirtyFiles({ directory: 'C:/controlled-fixture', watch: watcher(), waitMs: 10000,
    reconcile: async () => { entered++; await gate; } });
  const requests = Array.from({ length: 20 }, (_, n) => files.prepare('owner' + n));
  await vi.waitFor(() => expect(entered).toBe(4)); const closing = files.close(); release();
  await closing; await Promise.all(requests); expect(entered).toBe(4);
  expect(files.snapshot('owner0')).toMatchObject({ running: false, global: { active: 0, queued: 0 } });
});
