import { describe, expect, it } from 'vitest';

import { AsyncGate } from '../../src/main/async-gate';

describe('AsyncGate', () => {
  it('keeps at most `limit` tasks in the critical section', async () => {
    const gate = new AsyncGate(2);
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];

    const run = async (id: number): Promise<number> => gate.run(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      started.push(id);
      await Promise.resolve();
      inFlight -= 1;
      return id;
    });

    await expect(Promise.all([run(1), run(2), run(3), run(4), run(5)]))
      .resolves.toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
  });

  it('releases the slot when work rejects', async () => {
    const gate = new AsyncGate(1);
    await expect(gate.run(async () => {
      throw new Error('open failed');
    })).rejects.toThrow('open failed');
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
    expect(gate.active).toBe(0);
  });
});
