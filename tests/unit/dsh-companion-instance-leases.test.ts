import { expect, it, vi } from 'vitest';
import { CompanionInstanceLeases, nativeIdleConfirmed } from '../../src/main/dsh/companion-instance-leases';

it('tracks independent uses and releases idempotently while invalidating in-flight idle proofs', () => {
  const leases = new CompanionInstanceLeases(), released = vi.fn();
  const first = leases.acquire('a', 'task', released), epoch = leases.epoch('a');
  const second = leases.acquire('a', 'question', released);
  expect(leases.count('a')).toBe(2); expect(leases.epoch('a')).toBeGreaterThan(epoch);
  first(); first(); expect(leases.count('a')).toBe(1); expect(released).toHaveBeenCalledTimes(1);
  expect(leases.count('b')).toBe(0); second(); expect(leases.count('a')).toBe(0);
});
it('requires explicit known zero counts for every native activity dimension', () => {
  const proof = { known: true, idle: true, activeTurns: 0, backgroundJobs: 0, pendingQuestions: 0, pendingInbox: 0, settling: 0, activeSubagents: 0 };
  expect(nativeIdleConfirmed(proof)).toBe(true);
  for (const key of ['activeTurns', 'backgroundJobs', 'pendingQuestions', 'pendingInbox', 'settling', 'activeSubagents']) {
    expect(nativeIdleConfirmed({ ...proof, [key]: 1 })).toBe(false);
    expect(nativeIdleConfirmed({ ...proof, [key]: undefined })).toBe(false);
  }
  expect(nativeIdleConfirmed({ ...proof, known: false })).toBe(false);
  expect(nativeIdleConfirmed({ idle: true })).toBe(false);
  expect(nativeIdleConfirmed(undefined)).toBe(false);
});
