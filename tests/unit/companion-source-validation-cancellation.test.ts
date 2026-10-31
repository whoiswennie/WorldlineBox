import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { detachedCompanionExecutionValidation, guardCompanionExecutionSources, memoCompanionExecutionValidation, withCompanionExecutionValidation,
  type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const scope = { companionId: 'alice', conversationId: 'room_one' };
const message: CompanionMessage = { id: 'derived', ...scope, authorId: 'alice', kind: 'text', status: 'sent', sequence: 1,
  content: '合法的原来源', attachments: [], createdAt: '2026-10-30T01:00:00.000Z' };
const proof: CompanionExecutionSourceProof = { kind: 'message', id: message.id, ...scope, sourceMessageIds: [message.id], executionReadset: captureCompanionExecutionReadset(scope) };

it('cancels a pending preparation immediately without waiting for its local I/O gate', async () => {
  const controller = new AbortController(), reason = new Error('user_cancelled'), entered = deferred<void>(), io = deferred<void>();
  let settled = false;
  const result = withCompanionExecutionValidation(async () => { entered.resolve(); await io.promise; settled = true; return true; }, controller.signal);
  await entered.promise;
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(settled).toBe(false);
  io.resolve();
});

it('does not turn a caught cancellation into false provenance or invalidate a healthy historical source', async () => {
  const controller = new AbortController(), reason = new Error('user_cancelled'), entered = deferred<void>(), io = deferred<void>();
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof] };
    throw new Error('Cancelled validation must not mutate or reread any source');
  });
  let background!: Promise<CompanionStorageResponse>;
  const result = withCompanionExecutionValidation(() => background = guardCompanionExecutionSources({ type: 'message.get', id: message.id }, { ok: true, message }, {
    storage, valid: async () => {
      entered.resolve(); await io.promise;
      // Mirrors filesystem/legacy guards that catch errors and return false.
      try { return await withCompanionExecutionValidation(async () => true); } catch { return false; }
    },
  }), controller.signal);
  await entered.promise;
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  const stopped = expect(background).rejects.toBe(reason);
  io.resolve(); await stopped;
  expect(storage.mock.calls.map(([command]) => command.type)).toEqual(['execution.sources']);
});

it('keeps inherited cancellation after the parent frame finishes and blocks a late branch from starting a fresh DAG', async () => {
  const controller = new AbortController(), reason = new Error('task_stopped'), io = deferred<void>(), work = vi.fn(async () => true);
  let background!: Promise<boolean>;
  expect(await withCompanionExecutionValidation(async () => {
    background = io.promise.then(() => withCompanionExecutionValidation(work));
    return true;
  }, controller.signal)).toBe(true);
  controller.abort(reason);
  const stopped = expect(background).rejects.toBe(reason);
  io.resolve(); await stopped;
  expect(work).not.toHaveBeenCalled();
});

it('does not reuse or continue an aborted shared memo and a separate task still validates normally', async () => {
  const controller = new AbortController(), reason = new Error('task_stopped'), io = deferred<boolean>(), entered = deferred<void>();
  const operation = vi.fn(async () => { entered.resolve(); return io.promise; });
  const result = withCompanionExecutionValidation(() => memoCompanionExecutionValidation('shared', () => 0, operation), controller.signal);
  await entered.promise; controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  io.resolve(true);
  const fresh = vi.fn(async () => true);
  expect(await withCompanionExecutionValidation(() => memoCompanionExecutionValidation('shared', () => 0, fresh), new AbortController().signal)).toBe(true);
  expect(fresh).toHaveBeenCalledOnce();
});

it('lets an explicitly detached autonomous job start after its scheduling foreground task was cancelled', async () => {
  const controller = new AbortController(), io = deferred<void>(), foreground = vi.fn(async () => true), background = vi.fn(async () => true);
  let oldBranch!: Promise<boolean>, newJob!: Promise<boolean>;
  await withCompanionExecutionValidation(async () => {
    oldBranch = io.promise.then(() => withCompanionExecutionValidation(foreground));
    newJob = io.promise.then(() => detachedCompanionExecutionValidation(() => withCompanionExecutionValidation(background)));
    return true;
  }, controller.signal);
  const reason = new Error('foreground_cancelled'); controller.abort(reason);
  const stopped = expect(oldBranch).rejects.toBe(reason);
  io.resolve(); await stopped;
  expect(await newJob).toBe(true);
  expect(foreground).not.toHaveBeenCalled(); expect(background).toHaveBeenCalledOnce();
});
