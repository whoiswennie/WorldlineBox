import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionKnowledgeService } from '../../src/main/companions/knowledge-service';
import { companionExternalExecutionAvailability } from '../../src/main/companions/capability-availability';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import { companionLearningAssets } from '../../src/main/companions/learning-assets';
import { LibraryService } from '../../src/worker/library-service';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
function removeFixture(root: string) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('capability-availability-')) throw new Error('Unexpected capability fixture root.');
  rmSync(root, { recursive: true, force: true });
}

it('describes only actual DSH run readiness, leaving missing observations unknown', () => {
  expect(companionExternalExecutionAvailability(undefined, false).status).toBe('not_configured');
  expect(companionExternalExecutionAvailability(undefined, true).status).toBe('unknown');
  const base = { supported: true, instances: [] };
  expect(companionExternalExecutionAvailability(base, true).status).toBe('no_instance');
  const selected = { ...base, instances: [{ id: 'actual' }], cli: { selectedInstanceId: 'actual' } } as Parameters<typeof companionExternalExecutionAvailability>[0];
  expect(companionExternalExecutionAvailability(selected, true).status).toBe('unknown');
  for (const status of ['cold', 'warming', 'failed', 'ready'] as const) {
    const actual = { ...selected!, executionReadiness: { instanceId: 'actual', status, updatedAt: 'now' } };
    expect(companionExternalExecutionAvailability(actual, true).status).toBe(status === 'ready' ? 'ready' : 'not_ready');
    expect(companionExternalExecutionAvailability(actual, true).admission).toBe('can_request_host_preparation');
    expect(companionExternalExecutionAvailability({ ...actual, executionReadiness: { ...actual.executionReadiness, instanceId: 'other' } }, true).status).toBe('unknown');
  }
  expect(companionExternalExecutionAvailability({ ...selected!, instances: [], executionReadiness: { instanceId: 'actual', status: 'ready', updatedAt: 'now' } }, true))
    .toMatchObject({ status: 'no_instance', admission: 'requires_instance_configuration' });
});

it('pages only current owner grant metadata, refreshes names and revocation, and never opens assets or a cold worker', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'capability-availability-'));
  let store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: id,
    model: '', avatar: 'sister', active: true, proactive: false })));
  const room = store.openPrivate('alice'), other = store.openPrivate('bob');
  let currentName = '当前目录', changeDuringResolve: 'revoke' | 'insert' | undefined;
  const assets: CompanionLearningAssets = { catalog: vi.fn(async () => []),
    grant: vi.fn(async input => {
      if (changeDuringResolve === 'revoke') {
        changeDuringResolve = undefined;
        const grant = store.request({ type: 'learning.status', companionId: 'alice' }).learning!.grants.find(item => item.folderId === input.folderId)!;
        store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
      }
      if (changeDuringResolve === 'insert') {
        changeDuringResolve = undefined;
        store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'allowed-library', libraryName: '新库名', libraryPath: path.join(root, 'library'),
          folderId: 'newly-inserted-folder', folderName: '新目录', autonomous: false, intervalMinutes: 30 });
      }
      return { libraryName: currentName, libraryPath: path.join(root, 'library'), folderName: '更名-' + input.folderId };
    }), page: vi.fn(async () => ({ assets: [], hasMore: false })), asset: vi.fn(async () => undefined),
    read: vi.fn(async () => { throw new Error('No body read is allowed.'); }) };
  const getCold = vi.fn(async () => { throw new Error('No cold worker may start for metadata.'); });
  const bridge = new CompanionKnowledgeService({ request: async command => store.request(command), assets,
    runtime: { get: async () => { throw new Error('No encoder may start for metadata.'); }, close: async () => undefined, getCold } });
  try {
    for (let index = 0; index < 23; index++) store.request({ type: 'learning.grant', companionId: 'alice', libraryId: 'allowed-library',
      libraryName: '旧库名', libraryPath: path.join(root, 'library'), folderId: 'folder-' + index, folderName: '旧目录名', autonomous: false, intervalMinutes: 30 });
    const scope = { companionId: 'alice', conversationId: room.id };
    const first = await bridge.sourceCatalog(scope);
    expect(first.sources).toHaveLength(20); expect(first).toMatchObject({ hasMore: true, nextCursor: '20', total: 23 });
    expect(assets.grant).toHaveBeenCalledTimes(20); expect(first.sources?.every(item => item.libraryName === currentName && item.folderName?.startsWith('更名-'))).toBe(true);
    const second = await bridge.sourceCatalog(scope, first.nextCursor);
    expect(second.sources).toHaveLength(3); expect(second.hasMore).toBe(false);
    expect(new Set([...first.sources!, ...second.sources!].map(item => item.grantId)).size).toBe(23);
    expect((await bridge.sourceCatalog({ companionId: 'bob', conversationId: other.id })).sources).toEqual([]);
    await expect(bridge.sourceCatalog({ companionId: 'alice', conversationId: other.id })).rejects.toThrow();
    currentName = '再次更名';
    expect((await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'sources', limit: 1 })).sources![0]!.libraryName).toBe(currentName);
    const removed = first.sources![0]!;
    store.request({ type: 'learning.revoke', companionId: 'alice', id: removed.grantId, expectedRevision: removed.grantRevision });
    expect((await bridge.sourceCatalog(scope)).sources!.some(item => item.grantId === removed.grantId)).toBe(false);
    changeDuringResolve = 'revoke';
    await expect(bridge.sourceCatalog(scope, undefined, 2)).rejects.toThrow('目录在读取期间已变化');
    changeDuringResolve = 'insert';
    await expect(bridge.sourceCatalog(scope, undefined, 1)).rejects.toThrow('目录在读取期间已变化');
    store.close();
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), []);
    const restarted = await bridge.sourceCatalog(scope, undefined, 1);
    expect(restarted.sources![0]!.libraryName).toBe(currentName);
    const serialized = JSON.stringify(restarted);
    expect(serialized).not.toContain('libraryPath'); expect(serialized).not.toContain(root);
    expect(assets.catalog).not.toHaveBeenCalled(); expect(assets.page).not.toHaveBeenCalled();
    expect(assets.read).not.toHaveBeenCalled(); expect(assets.asset).not.toHaveBeenCalled(); expect(getCold).not.toHaveBeenCalled();
  } finally {
    store.close();
    removeFixture(root);
  }
});

it('reopens only an existing exact granted library for current metadata after restart without reading or enumerating assets', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'capability-availability-'));
  const library = new LibraryService();
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'reader', name: 'reader', description: '', persona: '认真', model: '', avatar: 'sister', active: true, proactive: false }]);
  const commands: WorkerCommand[] = [];
  const request = async (command: WorkerCommand): Promise<WorkerResult> => {
    commands.push(command);
    switch (command.type) {
      case 'library.list': return { ok: true, type: 'library.list', libraries: library.listLibraries() };
      case 'library.open': return { ok: true, type: 'library.opened', library: library.openLibrary(command.selectedLibraryPath) };
      case 'folder.list': return { ok: true, type: 'folder.list', folders: library.listManagedFolders(command.libraryId) };
      case 'linked-folder.list': return { ok: true, type: 'linked-folder.list', folders: library.listLinkedFolders(command.libraryId) };
      default: throw new Error('Asset enumeration or content access is prohibited in metadata projection: ' + command.type);
    }
  };
  const assets = companionLearningAssets({ request, memoryRoot: path.join(root, 'private-memory') });
  const getCold = vi.fn(async () => { throw new Error('Metadata must not initialize cold.'); });
  const bridge = new CompanionKnowledgeService({ request: async command => store.request(command), assets,
    runtime: { get: async () => { throw new Error('No encoder for metadata.'); }, close: async () => undefined, getCold } });
  try {
    const created = library.createLibrary({ displayName: '真实当前资料库', selectedParentPath: root });
    const folder = library.createManagedFolder({ libraryId: created.libraryId, name: 'Old' });
    const scope = { companionId: 'reader', conversationId: store.openPrivate('reader').id };
    const grant = store.request({ type: 'learning.grant', companionId: 'reader', libraryId: created.libraryId, libraryName: '旧存储库名', libraryPath: created.libraryPath,
      folderId: folder.folderId, folderName: '旧目录名', autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
    library.renameManagedFolder({ libraryId: created.libraryId, folderId: folder.folderId, newName: 'Renamed' });
    library.closeAll(); commands.length = 0;
    expect(library.listLibraries()).toEqual([]);
    const catalog = await bridge.sourceCatalog(scope);
    expect(catalog.available).toBe(true);
    expect(catalog.sources).toEqual([{ grantId: grant.id, grantRevision: grant.revision, libraryId: created.libraryId,
      libraryName: created.displayName, folderId: folder.folderId, folderName: 'Renamed' }]);
    expect(commands.filter(command => command.type === 'library.open')).toEqual([{ type: 'library.open', selectedLibraryPath: grant.libraryPath }]);
    expect(commands.every(command => ['library.list', 'library.open', 'folder.list', 'linked-folder.list'].includes(command.type))).toBe(true);
    await expect(assets.describe!({ ...grant, libraryPath: path.join(root, 'different-root') })).rejects.toThrow('位置');
    await expect(assets.describe!({ ...grant, folderId: 'ungranted-unknown-folder' })).rejects.toThrow('目录');
    library.closeAll();
    await expect(assets.describe!({ ...grant, libraryId: 'different-library-id' })).rejects.toThrow('身份');
    store.request({ type: 'learning.revoke', companionId: 'reader', id: grant.id, expectedRevision: grant.revision });
    commands.length = 0;
    expect((await bridge.sourceCatalog(scope)).sources).toEqual([]);
    expect(commands).toEqual([]); expect(getCold).not.toHaveBeenCalled();
  } finally { library.closeAll(); store.close(); removeFixture(root); }
});
