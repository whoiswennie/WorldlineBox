import { expect, it, vi } from 'vitest';
import { drainCompanionOwnerPublication } from '../../src/main/companions/owner-publication-drain';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
it('requires a fresh pass after a late write without delaying an earlier receipt', async () => {
  const inflight = new Map<string, Promise<void>>(), first = deferred(), second = deferred();
  const work = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const original = drainCompanionOwnerPublication(inflight, 'alice', work);
  await Promise.resolve(); expect(work).toHaveBeenCalledOnce();
  let laterFinished = false;
  const later = drainCompanionOwnerPublication(inflight, 'alice', work).then(() => { laterFinished = true; });
  first.resolve(); await original;
  expect(work).toHaveBeenCalledTimes(2); expect(laterFinished).toBe(false);
  second.resolve(); await later; await Promise.resolve(); expect(inflight.size).toBe(0);
});
it('settles a failed generation while a later write receives a fresh successful pass', async () => {
  const inflight = new Map<string, Promise<void>>(), gate = deferred();
  const work = vi.fn().mockImplementationOnce(async () => { await gate.promise; throw new Error('first source remains held'); }).mockResolvedValue(undefined);
  const original = drainCompanionOwnerPublication(inflight, 'alice', work), failed = expect(original).rejects.toThrow('remains held');
  await Promise.resolve(); const later = drainCompanionOwnerPublication(inflight, 'alice', work);
  gate.resolve(); await failed; await later;
  expect(work).toHaveBeenCalledTimes(2); await Promise.resolve(); expect(inflight.size).toBe(0);
});
it('does not serialize another owner behind a blocked publication', async () => {
  const inflight = new Map<string, Promise<void>>(), gate = deferred();
  const blocked = drainCompanionOwnerPublication(inflight, 'alice', () => gate.promise), peer = vi.fn(async () => undefined);
  await drainCompanionOwnerPublication(inflight, 'bob', peer);
  expect(peer).toHaveBeenCalledOnce(); expect(inflight.has('alice')).toBe(true);
  gate.resolve(); await blocked;
});
