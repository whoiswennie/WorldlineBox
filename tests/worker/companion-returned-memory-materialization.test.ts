import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { CompanionMemoryFileReadiness } from '../../src/main/companions/memory-file-readiness';
import { CompanionMemoryFilesPending } from '../../src/main/companions/memory-files-pending';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); });

function fixture(returned?: () => CompanionMemory[]) {
  const f = managedMemoryFiles(); fixtures.push(f);
  const readiness = new CompanionMemoryFileReadiness({ request: f.request, library: f.library, sources: f.sources, history: f.history });
  const storage = { request: async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    // Only the outer response shape is controlled for mixed-owner/skip cases.
    // Every ensure, source/Registry read and final fence still uses actual SQL.
    if (returned && command.type === 'memory.records.filter') return { ok: true, memories: returned() };
    return f.store.request(command);
  } };
  const subject = Object.assign(Object.create(CompanionService.prototype), { storage, fileReadiness: readiness, liveFiles: f.live,
    resettingCompanions: new Set<string>(), sourceValidationRevision: 0, evidenceRevision: 0,
    options: { report: vi.fn() }, memory: { schedule: vi.fn() } }) as {
      call(command: CompanionStorageCommand, signal?: AbortSignal, origin?: 'memory-files'): Promise<CompanionStorageResponse>;
      resettingCompanions: Set<string>;
    };
  const command = (notes: readonly CompanionMemory[]): CompanionStorageCommand => ({ type: 'memory.records.filter', ...f.scope, ids: notes.map(note => note.id) });
  return { f, subject, readiness, command };
}

it('materializes prepared returned notes in one owner session and checks their shared sources once', async () => {
  const t = fixture(), sources = [t.f.source('共同依据一。'), t.f.source('共同依据二。')];
  const notes = ['第一条', '第二条', '第三条'].map(label => t.f.record(label, sources.map(source => source.id)));
  await t.f.publish();
  const command = t.command(notes), before = t.f.store.request(command).memories!;
  const ensure = vi.spyOn(t.readiness, 'ensure'), reads = vi.spyOn(CompanionArtifactRegistry.prototype, 'readMany');
  const actual = t.f.live.materialize.bind(t.f.live), sourceBatches: number[] = [];
  const materialize = vi.spyOn(t.f.live, 'materialize').mockImplementation(async (owner, selected) => {
    const start = reads.mock.calls.length, result = await actual(owner, selected);
    sourceBatches.push(...reads.mock.calls.slice(start).filter(([inputs]) => inputs.length && inputs.every(input => input.consumer === 'source_verification')).map(([inputs]) => inputs.length));
    return result;
  });
  const result = await t.subject.call(command);
  expect(result.memories).toEqual(before); expect(result.memoryFilesPending).toBeUndefined();
  expect(ensure.mock.calls.map(([scope, id, revision]) => ({ scope, id, revision }))).toEqual(before.map(note => ({
    scope: { companionId: note.companionId, conversationId: note.sourceConversationId }, id: note.id, revision: note.contentRevision,
  })));
  expect(materialize).toHaveBeenCalledTimes(1); expect(materialize.mock.calls[0]).toEqual(['alice', before]);
  expect(sourceBatches).toEqual([sources.length]);
});

it('keeps a genuinely parked exact revision pending while batching only the ready notes and retaining every returned id', async () => {
  const t = fixture(), source = t.f.source('共享且已正式发布的依据。');
  const ready = [t.f.record('可用甲。', [source.id]), t.f.record('可用乙。', [source.id])]; await t.f.publish();
  const pending = t.f.record('已经提交，但正式历史发布被搁置。', [source.id]);
  const descriptor = t.f.store.request({ type: 'memory.files.inspect', ...t.f.scope, id: pending.id, contentRevision: pending.contentRevision! }).memoryFileReadiness!;
  const job = t.f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'history_files', id: descriptor.historyJob!.id }).jobDisposition!;
  const parked = t.f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'history_files', id: job.id,
    inputVersion: job.inputVersion, expectedRevision: job.revision, operationId: randomUUID(), action: 'park' });
  expect(parked.ok).toBe(true);
  const command = t.command([ready[0]!, pending, ready[1]!]), before = t.f.store.request(command).memories!;
  const materialize = vi.spyOn(t.f.live, 'materialize'), ensure = vi.spyOn(t.readiness, 'ensure');
  const result = await t.subject.call(command);
  expect(result.memories).toEqual(before); expect(result.memoryFilesPending).toBe(true);
  expect(ensure.mock.calls.map(([, id]) => id)).toEqual(before.map(note => note.id));
  expect(materialize).toHaveBeenCalledTimes(1);
  expect(materialize.mock.calls[0]).toEqual(['alice', before.filter(note => note.id !== pending.id)]);
  expect(t.f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'history_files', id: job.id }).jobDisposition?.state).toBe('parked');
});

it('retains committed notes if the owner materialization itself is pending, and rechecks on the next call', async () => {
  const t = fixture(), notes = [t.f.record('已提交甲。'), t.f.record('已提交乙。')]; await t.f.publish();
  const command = t.command(notes), before = t.f.store.request(command).memories!;
  const materialize = vi.spyOn(t.f.live, 'materialize').mockRejectedValueOnce(new CompanionMemoryFilesPending());
  const first = await t.subject.call(command); expect(first.memories).toEqual(before); expect(first.memoryFilesPending).toBe(true);
  const next = await t.subject.call(command); expect(next.memories).toEqual(before); expect(next.memoryFilesPending).toBeUndefined();
  expect(materialize).toHaveBeenCalledTimes(2);
});

it('separates owner groups and excludes reset, forgotten, invalid and revisionless entries without changing the response', async () => {
  let returned: CompanionMemory[] = [];
  const t = fixture(() => returned), alice = t.f.record('Alice 的正式记录。'), source = t.f.source('Bob 的真实依据。', 'bob');
  const bobScope = { companionId: 'bob', conversationId: source.conversationId };
  const bob = t.f.store.request({ type: 'memory.record', ...bobScope, candidate: t.f.candidate('Bob 的正式记录。', [source.id]) }).memories![0]!;
  await t.f.publish('alice'); await t.f.publish('bob');
  returned = [alice, { ...alice, status: 'forgotten' }, bob, { ...alice, status: 'invalid' }, { ...alice, contentRevision: undefined }];
  const before = structuredClone(returned), ensure = vi.spyOn(t.readiness, 'ensure'), materialize = vi.spyOn(t.f.live, 'materialize');
  expect((await t.subject.call(t.command([alice]))).memories).toEqual(before);
  expect(materialize.mock.calls).toEqual([['alice', [alice]], ['bob', [bob]]]);
  expect(ensure.mock.calls.map(([scope]) => scope)).toEqual([t.f.scope, bobScope]);
  t.subject.resettingCompanions.add('bob'); materialize.mockClear(); ensure.mockClear();
  expect((await t.subject.call(t.command([alice]))).memories).toEqual(before);
  expect(materialize.mock.calls).toEqual([['alice', [alice]]]); expect(ensure).toHaveBeenCalledTimes(1);
});

it.each(['missing-current', 'withdrawn-source'] as const)('continues to reject actual %s data instead of returning SQL bodies', async mode => {
  const t = fixture(), source = t.f.source('不能绕过的正式来源。');
  const notes = [t.f.record('甲。', [source.id]), t.f.record('乙。', [source.id])]; await t.f.publish();
  if (mode === 'missing-current') unlinkSync(t.f.noteFile(notes[1]!));
  else {
    const ensure = t.readiness.ensure.bind(t.readiness); let checked = 0;
    vi.spyOn(t.readiness, 'ensure').mockImplementation(async (...args) => {
      const result = await ensure(...args);
      if (++checked === notes.length) expect(t.f.store.request({ type: 'memory.forget', ...t.f.scope, sourceMessageIds: [source.id] }).ok).toBe(true);
      return result;
    });
  }
  await expect(t.subject.call(t.command(notes))).rejects.toThrow();
});
