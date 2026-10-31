import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources, memoCompanionExecutionValidation,
  withCompanionExecutionValidation, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const scope = { companionId: 'alice', conversationId: 'room_one' };
const message: CompanionMessage = { id: 'derived', ...scope, authorId: 'alice', kind: 'text', status: 'sent', sequence: 1,
  content: '经过来源核验的旧答复', attachments: [], createdAt: '2026-10-30T01:00:00.000Z' };
const readset = captureCompanionExecutionReadset(scope);
const proof: CompanionExecutionSourceProof = { kind: 'message', id: message.id, ...scope, sourceMessageIds: [message.id], executionReadset: readset,
  storageValidatedReadsetDigest: createHash('sha256').update(JSON.stringify(readset)).digest('hex'), storageValidatedAuthorityEpoch: 0 };

it('shares the checked dependency DAG across preparation phases while refreshing SQL attestation in every phase', async () => {
  const session = createCompanionExecutionValidationSession(), valid = vi.fn(async () => true);
  let epoch = 0, revision = 0;
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [{ ...proof, storageValidatedAuthorityEpoch: epoch }] };
    throw new Error('An authorized phase must not mutate any source');
  });
  const phase = () => guardCompanionExecutionSources({ type: 'message.get', id: message.id }, { ok: true, message }, { storage, valid, revision: () => revision });
  try {
    expect((await session.run(phase)).message?.content).toBe(message.content);
    expect(storage).toHaveBeenCalledTimes(2); expect(valid).toHaveBeenCalledOnce();
    revision += 2; // An observational background mutation is not a new source.
    expect((await session.run(phase)).message?.content).toBe(message.content);
    expect(storage).toHaveBeenCalledTimes(4); expect(valid).toHaveBeenCalledOnce();
    epoch++;
    expect((await session.run(phase)).message?.content).toBe(message.content);
    expect(storage).toHaveBeenCalledTimes(6); expect(valid).toHaveBeenCalledTimes(2);
  } finally { session.close(); }
});

it('retains the ancestor path when a nested phase tries to reenter its own pending proof', async () => {
  const session = createCompanionExecutionValidationSession(), repeated = vi.fn(async () => true);
  try {
    const result = await session.run(() => memoCompanionExecutionValidation('cyclic_source', () => 0,
      () => session.run(() => memoCompanionExecutionValidation('cyclic_source', () => 0, repeated))));
    expect(result).toBe(false); expect(repeated).not.toHaveBeenCalled();
  } finally { session.close(); }
});

it('clears proof reuse at dispatch without cancelling the remainder of an already running speaker', async () => {
  const session = createCompanionExecutionValidationSession(), validate = vi.fn(async () => true);
  const check = () => memoCompanionExecutionValidation('canonical_file', () => 0, validate);
  expect(await session.run(async () => {
    expect(await check()).toBe(true); expect(await check()).toBe(true); expect(validate).toHaveBeenCalledOnce();
    session.close(); session.close();
    // The same speaker continues through model dispatch and publication. Its
    // next host boundary must validate fresh instead of using preparation data.
    expect(await check()).toBe(true); expect(validate).toHaveBeenCalledTimes(2);
    return 'speaker_finished';
  })).toBe('speaker_finished');
  await expect(session.run(check)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await withCompanionExecutionValidation(check)).toBe(true); expect(validate).toHaveBeenCalledTimes(3);
});

it('does not reuse a legacy proof after its mutation generation changes between phases', async () => {
  const session = createCompanionExecutionValidationSession(), validate = vi.fn(async () => true);
  let revision = 0;
  const check = () => memoCompanionExecutionValidation('legacy_file', () => revision, validate);
  try {
    expect(await session.run(check)).toBe(true); expect(await session.run(check)).toBe(true);
    revision++;
    expect(await session.run(check)).toBe(true); expect(validate).toHaveBeenCalledTimes(2);
  } finally { session.close(); }
});

it('cancels a later preparation phase immediately and never turns its late false result into source withdrawal', async () => {
  const controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal);
  const reason = new Error('user_cancelled'), entered = deferred<void>(), io = deferred<void>();
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof] };
    throw new Error('Cancellation must never invalidate a healthy source');
  });
  expect(await session.run(async () => true)).toBe(true);
  let pending!: Promise<CompanionStorageResponse>;
  const result = session.run(() => pending = guardCompanionExecutionSources({ type: 'message.get', id: message.id }, { ok: true, message }, {
    storage, revision: () => 0, valid: async () => {
      entered.resolve(); await io.promise;
      try { return await withCompanionExecutionValidation(async () => true); } catch { return false; }
    },
  }));
  await entered.promise; controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  const stopped = expect(pending).rejects.toBe(reason);
  session.close(); io.resolve(); await stopped;
  expect(storage.mock.calls.map(([command]) => command.type)).toEqual(['execution.sources']);
  await expect(session.run(async () => true)).rejects.toBe(reason);
});

it('retains inherited task cancellation when a late branch attempts to create a new session', async () => {
  const controller = new AbortController(), reason = new Error('task_stopped'), io = deferred<void>(), work = vi.fn(async () => true);
  let background!: Promise<boolean>;
  await withCompanionExecutionValidation(async () => {
    background = io.promise.then(async () => {
      const session = createCompanionExecutionValidationSession();
      try { return await session.run(work); } finally { session.close(); }
    });
  }, controller.signal);
  controller.abort(reason);
  const stopped = expect(background).rejects.toBe(reason);
  io.resolve(); await stopped; expect(work).not.toHaveBeenCalled();
});
