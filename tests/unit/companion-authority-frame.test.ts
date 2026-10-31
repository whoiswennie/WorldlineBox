import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, memoCompanionExecutionAuthorities, withCompanionExecutionValidation,
  type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';

const scope = { companionId: 'alice', conversationId: 'room' };
function proof(id = 'action'): CompanionExecutionSourceProof {
  return { kind: 'action', id, ...scope, sourceMessageIds: ['card'], capability: {
    name: 'agenda', callId: id, invocationId: 'run', agendaRunId: 'run', inputHash: 'a'.repeat(64) } };
}
const allowed = (proofs: readonly CompanionExecutionSourceProof[]) => new Map(proofs.map(proof => [proof.id, true]));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it('admits each nested authority once and verifies the whole consumed set freshly at the outer return', async () => {
  const identity = {}, proofs = Array.from({ length: 40 }, (_, n) => proof('action_' + n)), verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => allowed(items));
  await withCompanionExecutionValidation(async () => {
    for (let n = 0; n < 15; n++) await withCompanionExecutionValidation(async () => {
      expect((await memoCompanionExecutionAuthorities(proofs, verify, identity)).size).toBe(40);
    });
    expect(verify).toHaveBeenCalledOnce();
  });
  expect(verify).toHaveBeenCalledTimes(2); expect(verify.mock.calls.map(([items]) => items.length)).toEqual([40, 40]);
  await memoCompanionExecutionAuthorities(proofs, verify, identity);
  expect(verify).toHaveBeenCalledTimes(4);
});

it('coalesces concurrent initial checks, admits only new proofs, and fences their union', async () => {
  const identity = {}, a = proof('a'), b = proof('b'), gate = deferred<void>(), entered = deferred<void>();
  const verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => { if (verify.mock.calls.length === 1) { entered.resolve(); await gate.promise; } return allowed(items); });
  const pending = withCompanionExecutionValidation(async () => {
    const readers = Array.from({ length: 20 }, () => memoCompanionExecutionAuthorities([a], verify, identity));
    await entered.promise; expect(verify).toHaveBeenCalledOnce(); gate.resolve(); await Promise.all(readers);
    await memoCompanionExecutionAuthorities([a, b], verify, identity);
  });
  await pending;
  expect(verify.mock.calls.map(([items]) => items.map(item => item.id))).toEqual([['a'], ['b'], ['a', 'b']]);
});

it('withholds the outer result when live authority is revoked after a cached admission', async () => {
  const identity = {}, item = proof(); let authorized = true, published = false;
  const verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => new Map(items.map(item => [item.id, authorized])));
  await expect(withCompanionExecutionValidation(async () => {
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(true);
    authorized = false;
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(true);
    return 'OLD_BODY';
  }).then(() => { published = true; })).rejects.toThrow('授权已经变化');
  expect(published).toBe(false); expect(verify).toHaveBeenCalledTimes(2);
});

it('never revives an initially rejected exact proof inside the same gate', async () => {
  const identity = {}, item = proof(); let authorized = false;
  const verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => new Map(items.map(item => [item.id, authorized])));
  await withCompanionExecutionValidation(async () => {
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(false);
    authorized = true;
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(false);
  });
  expect(verify).toHaveBeenCalledOnce();
});

it('treats an explicit legacy repair as a new binding and does not fence its rejected predecessor', async () => {
  const identity = {}, item = { ...proof(), invalidated: true };
  const verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => new Map(items.map(item => [item.id, !item.invalidated])));
  await withCompanionExecutionValidation(async () => {
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(false);
    item.invalidated = false;
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(true);
  });
  expect(verify.mock.calls.map(([items]) => items[0]!.invalidated)).toEqual([true, false, false]);
});

it('holds exact readsets/capability bindings and does not accept mutation of a previously consumed proof', async () => {
  const identity = {}, item = { ...proof(), executionReadset: captureCompanionExecutionReadset(scope) };
  const checks: string[] = [];
  const verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => {
    checks.push(...items.map(item => item.capability!.inputHash)); return allowed(items);
  });
  await withCompanionExecutionValidation(async () => {
    await memoCompanionExecutionAuthorities([item], verify, identity);
    item.capability!.inputHash = 'b'.repeat(64); item.executionReadset.beforeSequence = 2;
    await memoCompanionExecutionAuthorities([item], verify, identity);
  });
  expect(checks).toEqual(['a'.repeat(64), 'b'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
  expect(verify.mock.calls[2]![0][0]!.executionReadset?.beforeSequence).toBeUndefined();
});

it.each(['missing', 'throws'] as const)('rejects an uncertain final fence (%s) without publishing', async mode => {
  const identity = {}, item = proof(); let calls = 0;
  const verify = async (items: readonly CompanionExecutionSourceProof[]) => {
    if (++calls === 2) { if (mode === 'throws') throw new Error('UNAVAILABLE'); return new Map<string, boolean>(); }
    return allowed(items);
  };
  await expect(withCompanionExecutionValidation(async () => { await memoCompanionExecutionAuthorities([item], verify, identity); return 'OLD_BODY'; })).rejects.toThrow();
  expect(calls).toBe(2);
});

it('retries a temporarily unavailable initial admission rather than caching it as a withdrawal', async () => {
  const identity = {}, item = proof(); let calls = 0;
  const verify = async (items: readonly CompanionExecutionSourceProof[]) => { if (++calls === 1) throw new Error('UNAVAILABLE'); return allowed(items); };
  await withCompanionExecutionValidation(async () => {
    await expect(memoCompanionExecutionAuthorities([item], verify, identity)).rejects.toThrow('UNAVAILABLE');
    expect((await memoCompanionExecutionAuthorities([item], verify, identity)).get(item.id)).toBe(true);
  });
  expect(calls).toBe(3);
});

it('shares sequential session phases, validates once before dispatch and seals its old authorities', async () => {
  const session = createCompanionExecutionValidationSession(), identity = {}, item = proof(), verify = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => allowed(items));
  try {
    await session.run(() => memoCompanionExecutionAuthorities([item], verify, identity));
    await session.run(() => memoCompanionExecutionAuthorities([item], verify, identity));
    expect(verify).toHaveBeenCalledOnce();
    await Promise.all([session.validate(), session.validate()]); expect(verify).toHaveBeenCalledTimes(2);
    await expect(session.run(() => memoCompanionExecutionAuthorities([item], verify, identity))).rejects.toThrow();
  } finally { session.close(); }
});

it('cancels a final fence immediately and does not reuse its late result in another task', async () => {
  const controller = new AbortController(), identity = {}, item = proof(), gate = deferred<void>(), entered = deferred<void>(), reason = new Error('USER_STOPPED');
  let calls = 0;
  const verify = async (items: readonly CompanionExecutionSourceProof[]) => { if (++calls === 2) { entered.resolve(); await gate.promise; } return allowed(items); };
  const pending = withCompanionExecutionValidation(async () => memoCompanionExecutionAuthorities([item], verify, identity), controller.signal);
  await entered.promise; controller.abort(reason); await expect(pending).rejects.toBe(reason); gate.resolve();
  await expect(memoCompanionExecutionAuthorities([item], verify, identity)).resolves.toEqual(new Map([[item.id, true]]));
  expect(calls).toBe(4);
});

it('isolates different storage authorities even for identical action IDs', async () => {
  const item = proof(), first = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => allowed(items)), second = vi.fn(async (items: readonly CompanionExecutionSourceProof[]) => new Map(items.map(item => [item.id, false])));
  await withCompanionExecutionValidation(async () => {
    expect((await memoCompanionExecutionAuthorities([item], first, {})).get(item.id)).toBe(true);
    expect((await memoCompanionExecutionAuthorities([item], second, {})).get(item.id)).toBe(false);
  });
  expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledOnce();
});

it('rejects recursive verifiers instead of waiting for their own pending admission', async () => {
  const identity = {}, item = proof();
  const verify = async (): Promise<ReadonlyMap<string, boolean>> => memoCompanionExecutionAuthorities([item], verify, identity);
  await expect(memoCompanionExecutionAuthorities([item], verify, identity)).rejects.toThrow('递归');
});
