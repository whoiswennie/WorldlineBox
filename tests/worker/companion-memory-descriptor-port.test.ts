import { expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryLiveFiles } from '../../src/main/companions/memory-live-files';
import { companionMemoryTypeScope } from '../../src/main/companions/memory-type-scope';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

it('checks authorized note descriptors without opening canonical bodies or returning SQL prose', async () => {
  const f = managedMemoryFiles(), secret = 'BODY_MUST_NOT_ESCAPE_513';
  const ensure = vi.fn(async () => { throw new Error('Canonical body reads must use the body gate'); }), materialize = vi.fn();
  const host = Object.assign(Object.create(CompanionService.prototype), { storage: { request: async (command: CompanionStorageCommand) => f.store.request(command) },
    fileReadiness: { ensure }, liveFiles: { materialize }, resettingCompanions: new Set(), sourceValidationRevision: 0, evidenceRevision: 0,
    options: { report: () => undefined }, memory: { schedule: () => undefined } }) as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  try {
    const note = f.record(secret), response = await host.call({ type: 'memory.records.describe', ...f.scope, ids: [note.id] });
    expect(response.memoryDescriptors).toHaveLength(1);
    expect(response.memoryDescriptors?.[0]).toMatchObject({ id: note.id, version: note.version, artifactKind: note.artifactKind, contentRevision: note.contentRevision });
    expect(JSON.stringify(response)).not.toContain(secret); expect(response).not.toHaveProperty('memories');
    expect(ensure).not.toHaveBeenCalled(); expect(materialize).not.toHaveBeenCalled();
    await expect(host.call({ type: 'memory.records.filter', ...f.scope, ids: [note.id] })).rejects.toThrow('Canonical body reads');
    expect(ensure).toHaveBeenCalledOnce();
    const other = f.store.openPrivate('bob');
    expect((await host.call({ type: 'memory.records.describe', companionId: 'bob', conversationId: other.id, ids: [note.id] })).memoryDescriptors).toEqual([]);
    expect((await host.call({ type: 'memory.records.describe', ...f.scope, beforeSequence: 0, ids: [note.id] })).memoryDescriptors).toEqual([]);
    f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
    expect((await host.call({ type: 'memory.records.describe', ...f.scope, ids: [note.id] })).memoryDescriptors).toEqual([]);
  } finally { await f.close(); }
});

it('uses body-free descriptors for context type/version predicates and execution readsets', async () => {
  const f = managedMemoryFiles(), commands: CompanionStorageCommand[] = [];
  const request = async (command: CompanionStorageCommand) => { commands.push(command);
    if (command.type === 'memory.records.filter') throw new Error('A predicate must not ask for note bodies');
    return f.store.request(command);
  };
  const service = new CompanionMemoryService({ request, busy: () => true, changed: () => undefined, report: () => undefined,
    configFor: async () => { throw new Error('A metadata predicate must not request generation configuration'); },
    fetchFn: async () => { throw new Error('A metadata predicate must not request a model'); } });
  try {
    const note = f.record('已通过独立正文门使用过的内容。');
    const context = { revision: 'captured', profileKey: 'captured-profile', text: '已读上下文', typeScope: companionMemoryTypeScope('facts'),
      evidence: { dependencyCoverage: 'complete', dependencies: [{ id: note.id, version: note.version }] } };
    expect(await service.contextValid(f.scope, context)).toBe(true);
    const readset = captureCompanionExecutionReadset(f.scope, { memories: [{ id: note.id, version: note.version }] });
    expect(await verifyCompanionExecutionReadset(readset, f.scope, { request })).toBe(true);
    expect(commands.filter(command => command.type === 'memory.records.describe')).toHaveLength(3);
    f.store.request({ type: 'memory.forget', ...f.scope, id: note.id });
    expect(await service.contextValid(f.scope, context)).toBe(false);
    expect(await verifyCompanionExecutionReadset(readset, f.scope, { request })).toBe(false);
  } finally { await service.close(); await f.close(); }
});

it('resolves only trusted owner metadata for canonical file sessions while preserving file and owner checks', async () => {
  const f = managedMemoryFiles();
  const resolveOwnerMetadata = vi.fn(async (ownerId: string) => f.store.request({ type: 'state', companionId: ownerId, includeConversations: false, includeHidden: true }).state?.companions.find(owner => owner.id === ownerId));
  const library = new CompanionMemoryLibrary({ libraryDirectory: f.directory, artifacts: f.artifacts, request: f.request, resolveOwnerMetadata });
  const live = new CompanionMemoryLiveFiles({ library, history: f.history });
  try {
    const notes = [f.record('第一条正式文件。'), f.record('第二条正式文件。')]; await f.publish(); f.commands.length = 0;
    expect((await live.materialize('alice', notes)).notes.map(note => note.content)).toEqual(notes.map(note => note.content));
    expect(resolveOwnerMetadata).toHaveBeenCalledOnce();
    expect(f.commands.some(command => command.type === 'state')).toBe(false);
    resolveOwnerMetadata.mockImplementationOnce(async () => f.store.request({ type: 'state', companionId: 'bob', includeConversations: false }).state?.companions[0]);
    await expect(live.materialize('alice', notes)).rejects.toThrow('伙伴不存在或已移除');
  } finally { await library.close(); await f.close(); }
});
