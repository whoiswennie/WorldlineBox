import { linkSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { companionMemorySourceArtifactId } from '../../src/main/companions/memory-source-files';
import { CompanionService } from '../../src/main/companions/service';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMemoryFileReceipt } from '../../src/shared/companion-memory-files';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-27T10:00:00Z'); });
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); vi.useRealTimers(); });

it('shares exact canonical receipts across overlapping historical contexts and rechecks them in the next gate', async () => {
  const f = fixture(), source = f.source('共同且有权使用的真实原始来源。');
  const notes = ['甲', '乙', '丙'].map(name => f.record(name + '的正式经历。', [source.id])); await f.publish();
  const receipts = (await f.live.materialize('alice', notes)).receipts;
  const subject = Object.assign(Object.create(CompanionService.prototype), { liveFiles: f.live,
    storage: { request: async (command: Parameters<typeof f.store.request>[0]) => f.store.request(command) } }) as {
      memoryFilesValid(owner: string, values: readonly CompanionMemoryFileReceipt[]): Promise<boolean> };
  const validations = vi.spyOn(f.live, 'validate');
  await withCompanionExecutionValidation(async () => {
    expect(await subject.memoryFilesValid('alice', [receipts[0]!, receipts[1]!])).toBe(true);
    expect(await subject.memoryFilesValid('alice', [receipts[1]!, receipts[2]!])).toBe(true);
    expect(await subject.memoryFilesValid('alice', [receipts[2]!, receipts[0]!])).toBe(true);
    expect(validations.mock.calls.map(([, batch]) => batch.map(item => item.noteId))).toEqual([
      [notes[0]!.id, notes[1]!.id], [notes[2]!.id],
    ]);
  });
  expect(await subject.memoryFilesValid('alice', [receipts[1]!])).toBe(true);
  expect(validations).toHaveBeenCalledTimes(3);
  const target = f.noteFile(notes[1]!); writeFileSync(target, '未知的外部改写。');
  expect(await subject.memoryFilesValid('alice', [receipts[1]!])).toBe(false);
});

it('checks shared canonical sources through one batched registry read across selected notes', async () => {
  const f = fixture(), sources = Array.from({ length: 12 }, (_, index) => f.source('共同原始来源 ' + index));
  const notes = [f.record('第一条正式有据日记。', sources.map(source => source.id)), f.record('第二条正式有据日记。', sources.map(source => source.id))];
  await f.publish(); f.commands.length = 0;
  const batches = vi.spyOn(CompanionArtifactRegistry.prototype, 'readMany');
  try {
    expect((await f.live.materialize('alice', notes)).notes.map(note => note.id)).toEqual(notes.map(note => note.id));
    const sourceBatches = batches.mock.calls.filter(([inputs]) => inputs.every(input => input.consumer === 'source_verification'));
    expect(sourceBatches).toHaveLength(1); expect(sourceBatches[0]![0]).toHaveLength(12);
    const metadataBatches = f.commands.filter(command => command.type === 'cognition.registry.read' && command.artifactIds?.length === 12);
    expect(metadataBatches).toHaveLength(1);
    // The final SQL fence covers both notes and all shared sources together.
    expect(f.commands.filter(command => command.type === 'cognition.registry.read' && command.artifactIds?.length === 14)).toHaveLength(2);
  } finally { batches.mockRestore(); }
});

it('reads native projection input from exact historical files in one owner session and rejects edited history', async () => {
  const f = fixture(), notes = [f.record('第一篇真实正文。'), f.record('第二篇真实正文。')]; await f.publish();
  const state = f.store.request({ type: 'memory.projection.state', ...f.scope }).memoryProjectionState!, descriptors = f.store.request({ type: 'memory.projection.page', ...f.scope, expected: state }).memoryProjectionPage!.notes;
  const sessions = vi.spyOn(f.library, 'withDocuments'); expect((await canonicalProjectionInputs(f.history, f.scope, descriptors, f.library)).map(note => note.content)).toEqual(descriptors.map(note => notes.find(expected => expected.id === note.id)!.content)); expect(sessions).toHaveBeenCalledTimes(1); sessions.mockRestore();
  const target = f.historyFile(notes[0]!.id, 1); writeFileSync(target, '外改历史。'); await expect(canonicalProjectionInputs(f.history, f.scope, descriptors, f.library)).rejects.toThrow(); expect(readFileSync(target, 'utf8')).toBe('外改历史。');
});
it('batches shared historical sources once per canonical input gate and reopens them at the next gate', async () => {
  const f = fixture(), sources = Array.from({ length: 12 }, (_, index) => f.source('共同历史依据 ' + index));
  const notes = [f.record('第一份有据历史。', sources.map(source => source.id)), f.record('第二份有据历史。', sources.map(source => source.id))];
  await f.publish();
  const state = f.store.request({ type: 'memory.projection.state', ...f.scope }).memoryProjectionState!;
  const descriptors = f.store.request({ type: 'memory.projection.page', ...f.scope, expected: state }).memoryProjectionPage!.notes;
  const batches = vi.spyOn(CompanionArtifactRegistry.prototype, 'readMany');
  try {
    expect((await canonicalProjectionInputs(f.history, f.scope, descriptors, f.library)).map(note => note.id).sort()).toEqual(notes.map(note => note.id).sort());
    const sourceBatches = () => batches.mock.calls.filter(([inputs]) => inputs.length && inputs.every(input => input.consumer === 'source_verification'));
    expect(sourceBatches()).toHaveLength(1);
    expect(sourceBatches()[0]![0]).toHaveLength(12);
    expect(f.commands.filter(command => command.type === 'memory.revisions.describe')).toHaveLength(2);
    await canonicalProjectionInputs(f.history, f.scope, descriptors, f.library);
    expect(sourceBatches()).toHaveLength(2);
    const artifact = await (await f.artifacts('alice')).get(companionMemorySourceArtifactId(sources[0]!.id, 1));
    expect(artifact).toBeDefined();
    writeFileSync(f.file(artifact!.relativePath), '外部改写原始依据。');
    await expect(canonicalProjectionInputs(f.history, f.scope, descriptors, f.library)).rejects.toThrow();
  } finally { batches.mockRestore(); }
});
it('materializes the exact registered canonical body under its owner without rescanning or cross-owner use', async () => {
  const f = fixture(), note = f.record('明确的正式正文。'); await f.publish(); f.commands.length = 0;
  const result = await f.live.materialize('alice', [note]); expect(result.notes[0]!.content).toBe(readFileSync(f.noteFile(note), 'utf8')); expect(result.receipts[0]).toMatchObject({ companionId: 'alice', noteId: note.id, contentRevision: 1 });
  expect(await f.live.validate('alice', result.receipts)).toBe(true); expect(await f.live.validate('bob', result.receipts)).toBe(false); await expect(f.live.materialize('bob', [note])).rejects.toThrow();
  expect(f.commands.some(command => command.type === 'memory.library.page' || command.type === 'cognition.registry.page')).toBe(false);
});
it('rejects unregistered moves and human body edits without importing or repairing either', async () => {
  const f = fixture(), note = f.record('不能被人类改写为新认识。'); await f.publish(); const before = await f.live.materialize('alice', [note]), target = f.noteFile(note), moved = path.join(path.dirname(target), '外部改名.md');
  renameSync(target, moved); expect(await f.live.validate('alice', before.receipts)).toBe(false); await expect(f.live.materialize('alice', [note])).rejects.toThrow(); renameSync(moved, target);
  writeFileSync(target, '未知外部改写。'); await expect(f.live.flush('alice', { noteIds: [note.id] })).rejects.toThrow(); await expect(f.live.materialize('alice', [note])).rejects.toThrow();
  expect(f.store.listMemory('alice')[0]!.content).toBe(note.content); expect(readFileSync(target, 'utf8')).toBe('未知外部改写。');
});
it('rechecks ctime and exact bytes in the same admission window after a same-size mtime-restored edit', async () => {
  const f = fixture(), note = f.record('第一版真实正文。'); await f.publish(); const result = await f.live.materialize('alice', [note]), window = {}, target = f.noteFile(note);
  expect(await f.live.validate('alice', result.receipts, window)).toBe(true); const before = statSync(target), edited = note.content.replace('第', '新'); expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(note.content));
  writeFileSync(target, edited); utimesSync(target, before.atime, before.mtime); expect(await f.live.validate('alice', result.receipts, window)).toBe(false);
});
it.each(['missing', 'hardlink'] as const)('does not trust SQLite or follow an alias when current body is %s', async mode => {
  const f = fixture(), note = f.record('必须以正式文件读取。'); await f.publish(); const result = await f.live.materialize('alice', [note]);
  if (mode === 'missing') unlinkSync(f.noteFile(note)); else linkSync(f.noteFile(note), path.join(f.root, 'alias.md'));
  expect(await f.live.validate('alice', result.receipts)).toBe(false); await expect(f.live.materialize('alice', [note])).rejects.toThrow(); await expect(f.live.flush('alice', { noteIds: [note.id] })).rejects.toThrow();
});
it('keeps a frozen task valid across lawful newer publication but rejects an external current-file edit', async () => {
  const f = fixture(), source = f.source('正式原始依据。'), note = f.record('原任务读到的版本。', [source.id]); await f.publish(); const original = await f.live.materialize('alice', [note]);
  const next = f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('后台真实修订。', [source.id]) }).memories![0]!;
  expect(await f.live.validate('alice', original.receipts)).toBe(true); await expect(f.live.materialize('alice', [next])).rejects.toThrow(); await f.publish();
  expect(await f.live.validate('alice', original.receipts)).toBe(true); expect((await f.live.materialize('alice', [next])).notes[0]!.content).toBe(next.content);
  writeFileSync(f.noteFile(next), '未登记的当前正文不能借旧历史通过。'); expect(await f.live.validate('alice', original.receipts)).toBe(false);
});
it('preserves independently authorized B-only r1 after later A+B r2 withdrawal, then rejects whole-note forgetting', async () => {
  const f = fixture(), b = f.source('真实B。'), a = f.source('真实A。'), note = f.record('仅依赖B的旧版本。', [b.id]); await f.publish(); const receipt = (await f.live.materialize('alice', [note])).receipts;
  f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('之后依据A与B。', [a.id, b.id]) }); await f.publish();
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [a.id] }); await f.sources.flush('alice'); await f.history.flush('alice');
  expect(await f.live.validate('alice', receipt)).toBe(true); f.store.request({ type: 'memory.forget', ...f.scope, id: note.id }); await f.sources.flush('alice'); await f.history.flush('alice'); expect(await f.live.validate('alice', receipt)).toBe(false);
});
it('does not overwrite concurrent external bytes with a newer SQL revision', async () => {
  const f = fixture(), source = f.source('真实来源。'), note = f.record('正式第一版。', [source.id]); await f.publish(); writeFileSync(f.noteFile(note), '外部改写必须保留。');
  f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('同时发生的真实后台修订。', [source.id]) });
  await f.sources.flush('alice'); expect(await f.history.flush('alice')).toMatchObject({ failed: 1 }); expect(readFileSync(f.noteFile(note), 'utf8')).toBe('外部改写必须保留。');
});
it('recovers history-committed/current-body-unpublished debt through the durable outbox after restart', async () => {
  const f = fixture(), note = f.record('不能在一次崩溃后永远丢出版任务。'); await f.sources.flush('alice');
  const history = new CompanionMemoryHistoryFiles({ library: f.library, afterPublish: async () => { throw new Error('CRASH_BEFORE_LIVE_BODY'); } }); expect(await history.flush('alice')).toMatchObject({ failed: 1, completed: 0 });
  f.restart(); vi.setSystemTime(Date.now() + 31_000); await f.history.flush('alice'); expect((await f.live.materialize('alice', [note])).notes[0]!.content).toBe(note.content);
});
it('keeps explicit writer batches bounded and ordered without using reconciliation to import new text', async () => {
  const f = fixture(), notes = Array.from({ length: 5 }, (_, index) => f.record('有据条目' + index)); await f.publish(); const ids = notes.map(note => note.id);
  const first = await f.live.flush('alice', { noteIds: ids, limit: 2, reconcile: true }); expect(first).toMatchObject({ checked: 2, published: 0, pending: true, nextCursor: 2 });
  const second = await f.live.flush('alice', { noteIds: ids, limit: 2, cursor: first.nextCursor }); expect(second.nextCursor).toBe(4);
  const final = await f.live.flush('alice', { noteIds: ids, limit: 2, cursor: second.nextCursor }); expect(final).toMatchObject({ checked: 1, pending: false }); expect((await f.live.materialize('alice', notes)).notes.map(note => note.id)).toEqual(ids);
});
