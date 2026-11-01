import { readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { canonicalProjectionInputs, canonicalProjectionInputsAndFiles } from '../../src/main/companions/canonical-projection-inputs';
import { createCompanionExecutionValidationSession, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { validateFreshCompanionRecallInputs } from '../../src/main/companions/memory-history-descriptor-witness';
import { CompanionMemoryLiveFileError } from '../../src/main/companions/memory-live-files';

async function fixture() {
  const f = managedMemoryFiles(), source = f.source('A shared, formally stored observation.'), a = f.record('The first source-backed observation.', [source.id]), b = f.record('The subsequent source-backed observation.', [source.id], [a.id]);
  await f.publish();
  const scope = { ...f.scope, beforeSequence: source.sequence }, expected = f.store.request({ type: 'memory.projection.state', ...scope }).memoryProjectionState!;
  const projection = f.store.request({ type: 'memory.projection.page', ...scope, expected }).memoryProjectionPage!.notes;
  const notes = [b, a].map(note => projection.find(item => item.id === note.id)!);
  f.commands.length = 0;
  return { f, a, b, source, scope, notes };
}

it('returns exactly the previous candidate bodies/order/receipts with one query-scope history admission and final union', async () => {
  const h = await fixture();
  try {
    const legacy = await withCompanionExecutionValidation(async () => {
      const inputs = await canonicalProjectionInputs(h.f.history, h.scope, h.notes, h.f.library);
      return h.f.live.projectionNotes('alice', inputs);
    });
    const oldCalls = h.f.commands.filter(command => command.type === 'memory.revisions.describe').length;
    expect(h.f.commands.some(command => command.type === 'memory.library.scope.read')).toBe(true);
    h.f.commands.length = 0;
    const current = await canonicalProjectionInputsAndFiles(h.f.history, h.scope, h.notes, h.f.library);
    expect(current).toEqual(legacy); expect(current.notes.map(note => note.id)).toEqual([h.b.id, h.a.id]);
    const reads = h.f.commands.filter(command => command.type === 'memory.revisions.describe');
    expect(reads).toHaveLength(2); expect(oldCalls).toBeGreaterThan(reads.length);
    expect(reads.every(command => command.type === 'memory.revisions.describe' && command.beforeSequence === h.scope.beforeSequence && command.conversationId === h.scope.conversationId)).toBe(true);
    expect(h.f.commands.some(command => command.type === 'memory.library.scope.read')).toBe(false);
  } finally { await h.f.close(); }
});

it('keeps a lawful old revision receipt when the current body advances, without using SQL as the historical prose', async () => {
  const h = await fixture();
  try {
    h.f.store.request({ type: 'memory.revise', ...h.f.scope, id: h.b.id, expectedVersion: h.b.version,
      candidate: h.f.candidate('A later source-backed observation.', [h.source.id], [h.a.id]) });
    await h.f.publish();
    const current = await canonicalProjectionInputsAndFiles(h.f.history, h.scope, h.notes, h.f.library);
    expect(current.notes[0]!.content).toBe(h.b.content); expect(current.receipts[0]!.contentRevision).toBe(h.b.contentRevision);
    expect(await h.f.live.validate('alice', current.receipts)).toBe(true);
    await unlink(h.f.historyFile(h.b.id, h.b.contentRevision!));
    await expect(canonicalProjectionInputsAndFiles(h.f.history, h.scope, h.notes, h.f.library)).rejects.toThrow();
  } finally { await h.f.close(); }
});

it('retains cursor and owner fences instead of borrowing the owner-private descriptor admission', async () => {
  const h = await fixture();
  try {
    await withCompanionExecutionValidation(async () => {
      await canonicalProjectionInputsAndFiles(h.f.history, h.scope, h.notes, h.f.library);
      await expect(canonicalProjectionInputsAndFiles(h.f.history, { ...h.scope, beforeSequence: h.source.sequence - 1 }, h.notes, h.f.library)).rejects.toThrow();
    });
    await expect(canonicalProjectionInputsAndFiles(h.f.history, { ...h.scope, companionId: 'bob' }, h.notes, h.f.library)).rejects.toThrow();
  } finally { await h.f.close(); }
});

it('rejects a real same-stat input edit and SQL withdrawal at the unchanged final boundaries', async () => {
  const h = await fixture(), frame = createCompanionExecutionValidationSession();
  try {
    await frame.run(() => canonicalProjectionInputsAndFiles(h.f.history, h.scope, h.notes, h.f.library));
    const file = h.f.historyFile(h.a.id, h.a.contentRevision!), before = await stat(file), original = await readFile(file, 'utf8');
    const altered = original.replace('first', 'other'); expect(Buffer.byteLength(altered)).toBe(Buffer.byteLength(original));
    await writeFile(file, altered); await utimes(file, before.atime, before.mtime);
    await expect(frame.validate()).rejects.toThrow();
  } finally { frame.close(); await h.f.close(); }
  const j = await fixture(), sql = createCompanionExecutionValidationSession();
  try {
    await sql.run(() => canonicalProjectionInputsAndFiles(j.f.history, j.scope, j.notes, j.f.library));
    j.f.store.request({ type: 'memory.forget', ...j.f.scope, sourceMessageIds: [j.source.id] });
    await expect(sql.validate()).rejects.toThrow();
  } finally { sql.close(); await j.f.close(); }
});

it('opens a separate fresh focusing gate and rejects an edit after initial candidate capture', async () => {
  const h = await fixture(), frame = createCompanionExecutionValidationSession();
  try {
    const captured = await frame.run(() => canonicalProjectionInputsAndFiles(h.f.history, h.scope, h.notes, h.f.library));
    const file = h.f.noteFile(h.b), original = await readFile(file, 'utf8'); await writeFile(file, original.replace('subsequent', 'subsequenx'));
    await expect(frame.run(() => validateFreshCompanionRecallInputs(async () => {
      expect(await h.f.live.validate('alice', captured.receipts)).toBe(true);
      await canonicalProjectionInputs(h.f.history, h.scope, h.notes, h.f.library);
    }))).rejects.toThrow();
  } finally { frame.close(); await h.f.close(); }
});

it('materializes a current batch with one current-note RPC, no source pages, and unchanged ordering', async () => {
  const h = await fixture();
  try {
    const actual = await h.f.live.materialize('alice', [h.b, h.a, h.b]);
    expect(actual.notes).toEqual([h.b, h.a, h.b]); expect(actual.receipts.map(receipt => receipt.noteId)).toEqual([h.b.id, h.a.id, h.b.id]);
    expect(h.f.commands.filter(command => command.type === 'memory.library.read-many')).toHaveLength(1);
    expect(h.f.commands.some(command => command.type === 'memory.library.read')).toBe(false);
    expect(h.f.commands.filter(command => command.type === 'cognition.registry.read').length).toBeLessThan(8);
  } finally { await h.f.close(); }
});

it('reports only the actual unavailable note and rejects a foreign note before a batch can mix owners', async () => {
  const h = await fixture();
  try {
    await unlink(h.f.noteFile(h.b));
    const error = await h.f.live.materialize('alice', [h.a, h.b]).catch(error => error as unknown);
    expect(error).toBeInstanceOf(CompanionMemoryLiveFileError);
    expect((error as CompanionMemoryLiveFileError).noteIds).toEqual([h.b.id]);
    await expect(h.f.live.materialize('alice', [{ ...h.a, companionId: 'bob' }])).rejects.toMatchObject({ noteIds: [h.a.id] });
  } finally { await h.f.close(); }
});

it('cancels an in-flight current-note batch without returning prose or persisting source invalidation', async () => {
  const h = await fixture(), controller = new AbortController(), frame = createCompanionExecutionValidationSession(controller.signal);
  try {
    h.f.intercept(command => { if (command.type === 'memory.library.read-many') controller.abort(new DOMException('Actual batch cancelled.', 'AbortError')); });
    await expect(frame.run(() => h.f.live.materialize('alice', [h.a, h.b]))).rejects.toThrow();
    expect(h.f.commands.some(command => command.type === 'execution.invalidate')).toBe(false);
  } finally { frame.close(); h.f.intercept(); await h.f.close(); }
});
