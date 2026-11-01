import { createHash } from 'node:crypto';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { createCompanionExecutionValidationSession, memoCompanionExecutionAdmission, memoCompanionExecutionWitnesses } from '../../src/main/companions/source-execution-evidence';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function setup() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const aliceSource = f.source('甲方正式来源。'), bobSource = f.source('乙方正式来源。', 'bob');
  const alice = f.record('甲方事实。', [aliceSource.id]);
  const bob = f.store.request({ type: 'memory.record', companionId: 'bob', conversationId: f.store.openPrivate('bob').id,
    candidate: f.candidate('乙方事实。', [bobSource.id]) }).memories![0]!;
  f.index(); await f.publish(); await f.publish('bob');
  return { f, notes: [alice, bob] };
}

it('freshly reads independent owners together while keeping every SQL fence after all files and external assets', async () => {
  const timings: Array<{ phase: string; durationMs: number; checks: number }> = [];
  const { f, notes } = await setup(), session = createCompanionExecutionValidationSession(undefined, timing => {
    timings.push(timing);
    throw new Error('A diagnostic observer failed');
  });
  const first = deferred(), second = deferred(), release = deferred(), events: string[] = [];
  const identity = {}, sqlIdentity = {};
  try {
    await session.run(async () => {
      for (const [index, note] of notes.entries()) await memoCompanionExecutionWitnesses([note.id], {
        identity, scope: note.companionId, revision: () => 0,
        read: async () => new Map([[note.id, sha(await readFile(f.noteFile(note), 'utf8'))]]),
        verify: async values => {
          events.push('file-start:' + note.companionId); (index ? second : first).resolve();
          await release.promise;
          expect(sha(await readFile(f.noteFile(note), 'utf8'))).toBe(values[0]!.value);
          events.push('file-done:' + note.companionId);
        },
      });
      await memoCompanionExecutionAdmission('current-external-assets', { identity, read: async () => true, cacheable: () => true,
        verify: async () => { expect(events.filter(event => event.startsWith('file-done:'))).toHaveLength(2); events.push('assets'); } });
      for (const note of notes) await memoCompanionExecutionWitnesses([note.id], { identity: sqlIdentity, scope: note.companionId, phase: 'sql-authority', revision: () => 0,
        read: async () => new Map([[note.id, (await f.request({ type: 'cognition.registry.read', ownerId: note.companionId, artifactId: 'memory:' + note.id })).registryArtifact!]]),
        verify: async values => {
          expect(events).toContain('assets');
          const actual = (await f.request({ type: 'cognition.registry.read', ownerId: note.companionId, artifactId: 'memory:' + note.id })).registryArtifact;
          expect(actual).toEqual(values[0]!.value); events.push('sql:' + note.companionId);
        } });
    });
    const validating = session.validate();
    // Both distinct physical checks must be in flight before either may finish.
    await Promise.all([first.promise, second.promise]); expect(events).not.toContain('assets');
    release.resolve(); await validating;
    expect(events.slice(-2).sort()).toEqual(['sql:alice', 'sql:bob']);
    expect(timings.map(timing => timing.phase)).toEqual(['canonical', 'assets', 'sql', 'sources', 'authorities', 'certificates']);
    expect(timings.every(timing => timing.durationMs >= 0)).toBe(true);
  } finally { release.resolve(); session.close(); }
});

it('rejects a real cross-owner Registry withdrawal during external validation before granting SQL authority', async () => {
  const { f, notes } = await setup(), session = createCompanionExecutionValidationSession(), identity = {};
  const bob = notes[1]!, sqlReached = vi.fn();
  try {
    await session.run(async () => {
      for (const note of notes) await memoCompanionExecutionWitnesses([note.id], { identity, scope: note.companionId, revision: () => 0,
        read: async () => new Map([[note.id, await readFile(f.noteFile(note), 'utf8')]]),
        verify: async values => { expect(await readFile(f.noteFile(note), 'utf8')).toBe(values[0]!.value); } });
      await memoCompanionExecutionAdmission('external-withdrawal', { identity, read: async () => true, cacheable: () => true,
        verify: async () => { await (await f.artifacts('bob')).revoke('memory:' + bob.id); } });
      await memoCompanionExecutionWitnesses([bob.id], { identity, scope: 'current-bob-authority', phase: 'sql-authority', revision: () => 0,
        read: async () => new Map([[bob.id, (await f.request({ type: 'cognition.registry.read', ownerId: 'bob', artifactId: 'memory:' + bob.id })).registryArtifact!]]),
        verify: async () => {
          sqlReached(); const current = await f.request({ type: 'cognition.registry.read', ownerId: 'bob', artifactId: 'memory:' + bob.id });
          if (!current.registryArtifact) throw new Error('Actual Registry authority withdrawn');
        } });
    });
    await expect(session.validate()).rejects.toThrow('Registry authority withdrawn'); expect(sqlReached).toHaveBeenCalledOnce();
  } finally { session.close(); }
});

it('drains a started sibling physical check before returning a real same-stat byte mismatch', async () => {
  const { f, notes } = await setup(), session = createCompanionExecutionValidationSession(), identity = {};
  const entered = [deferred(), deferred()], release = [deferred(), deferred()], checked = deferred(); let settled = false;
  try {
    await session.run(async () => {
      for (const [index, note] of notes.entries()) await memoCompanionExecutionWitnesses([note.id], { identity, scope: note.companionId, revision: () => 0,
        read: async () => new Map([[note.id, await readFile(f.noteFile(note), 'utf8')]]), verify: async values => {
          entered[index]!.resolve(); await release[index]!.promise;
          const actual = await readFile(f.noteFile(note), 'utf8');
          if (actual !== values[0]!.value) { checked.resolve(); throw new Error('Actual canonical bytes changed'); }
        } });
    });
    const validating = session.validate(); void validating.then(() => { settled = true; }, () => { settled = true; });
    await Promise.all(entered.map(gate => gate.promise));
    const before = await stat(f.noteFile(notes[0]!)); await writeFile(f.noteFile(notes[0]!), '甲方假话。', 'utf8'); await utimes(f.noteFile(notes[0]!), before.atime, before.mtime);
    release[0]!.resolve(); await checked.promise; await Promise.resolve(); expect(settled).toBe(false);
    const failed = expect(validating).rejects.toThrow('Actual canonical bytes changed'); release[1]!.resolve(); await failed;
  } finally { release.forEach(gate => gate.resolve()); session.close(); }
});

it('returns task cancellation promptly and never starts later SQL checks after late physical completion', async () => {
  const { f, notes } = await setup(), controller = new AbortController(), session = createCompanionExecutionValidationSession(controller.signal), identity = {};
  const entered = [deferred(), deferred()], release = deferred(), late = [deferred(), deferred()], sql = vi.fn();
  try {
    await session.run(async () => {
      for (const [index, note] of notes.entries()) await memoCompanionExecutionWitnesses([note.id], { identity, scope: note.companionId, revision: () => 0,
        read: async () => new Map([[note.id, await readFile(f.noteFile(note), 'utf8')]]), verify: async () => {
          entered[index]!.resolve(); await release.promise; await readFile(f.noteFile(note), 'utf8'); late[index]!.resolve();
        } });
      await memoCompanionExecutionWitnesses(['must-not-run'], { identity, scope: 'cancelled-sql', phase: 'sql-authority', revision: () => 0,
        read: async () => new Map([['must-not-run', true]]), verify: async () => { sql(); } });
    });
    const validating = session.validate(); await Promise.all(entered.map(gate => gate.promise));
    const reason = new Error('User cancelled actual task'); controller.abort(reason); await expect(validating).rejects.toBe(reason);
    session.close(); release.resolve(); await Promise.all(late.map(gate => gate.promise)); await Promise.resolve(); expect(sql).not.toHaveBeenCalled();
    expect(f.store.request({ type: 'memory.records.filter', ...f.scope, ids: [notes[0]!.id] }).memories).toHaveLength(1);
  } finally { release.resolve(); session.close(); }
});
