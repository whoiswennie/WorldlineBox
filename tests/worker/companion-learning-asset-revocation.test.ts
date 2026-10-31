import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';
import { CompanionsStore } from '../../src/companions/store';
import { companionLearningAssets } from '../../src/main/companions/learning-assets';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { importNoConflict } from './import-no-conflict';
import type { CompanionLearningGrant } from '../../src/shared/companion-learning';
import type { AssetSummary } from '../../src/shared/asset-types';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { CompanionService } from '../../src/main/companions/service';
import { detachedCompanionExecutionValidation, memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionLearningAssetValidation } from '../../src/shared/companion-learning';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

const fixtures: Array<{ root: string; library: LibraryService; store: CompanionsStore }> = [];
const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (file: string, options?: { readonly: boolean }) => {
  prepare(sql: string): { get(): { data_version: number } }; close(): void;
};
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); f.library.closeAll(); removeOwnedDirectorySync(f.root); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-authorization-')), library = new LibraryService();
  const opened = library.createLibrary({ selectedParentPath: root, displayName: '真实授权资料' });
  const books = library.createManagedFolder({ libraryId: opened.libraryId, name: 'Books' }), outside = library.createManagedFolder({ libraryId: opened.libraryId, name: 'Other' });
  const store = new CompanionsStore(path.join(root, 'companions.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核验实际来源。', model: '', avatar: 'sister' as const, active: true, proactive: false })));
  fixtures.push({ root, library, store });
  let unavailable = false;
  const request = async (command: WorkerCommand): Promise<WorkerResult> => {
    if (unavailable) throw new Error('isolated backend temporarily unavailable');
    switch (command.type) {
      case 'library.list': return { ok: true, type: 'library.list', libraries: library.listLibraries() };
      case 'library.open': return { ok: true, type: 'library.opened', library: library.openLibrary(command.selectedLibraryPath) };
      case 'folder.list': return { ok: true, type: 'folder.list', folders: library.listManagedFolders(command.libraryId) };
      case 'linked-folder.list': return { ok: true, type: 'linked-folder.list', folders: library.listLinkedFolders(command.libraryId) };
      case 'asset.learning.page': return { ok: true, type: 'asset.learning.page', ...library.listLearningAssets(command) };
      case 'media.get-asset-path': return { ok: true, type: 'media.asset-path', assetId: command.assetId, absolutePath: library.resolveAssetPath(command.libraryId, command.assetId) };
      default: throw new Error('Unexpected canonical request ' + command.type);
    }
  };
  const assets = companionLearningAssets({ request, memoryRoot: path.join(root, 'private-memory'), storageRequest: async command => store.request(command) });
  const grant = (owner = 'alice', wholeLibrary = false) => store.request({ type: 'learning.grant', companionId: owner, libraryId: opened.libraryId,
    libraryName: opened.displayName, libraryPath: opened.libraryPath, folderId: wholeLibrary ? undefined : books.folderId, autonomous: false, intervalMinutes: 30 }).learning!.grants.at(-1)!;
  const add = (name = 'book.md', content = '本资料要求先核验来源。') => { const file = path.join(root, name); writeFileSync(file, content); return importNoConflict(library, opened.libraryId, file, books.folderId).assets[0]!; };
  const read = async (grant: CompanionLearningGrant, asset: AssetSummary) => {
    const actual = await assets.read(grant, asset);
    store.request({ type: 'learning.run', companionId: grant.companionId, id: grant.id, expectedRevision: grant.revision });
    const job = store.request({ type: 'learning.claim', excludedOwners: [grant.companionId === 'alice' ? 'bob' : 'alice'] }).learningJob!;
    store.request({ type: 'learning.begin', id: job.id, leaseToken: job.leaseToken, assetId: asset.assetId, assetRevisionId: actual.revisionId, offset: 0 });
    const result = store.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: asset.assetId, assetRevisionId: actual.revisionId,
      assetName: asset.displayName, offset: 0, content: actual.content, more: false });
    const receipt = result.learning!.reads.find(receipt => receipt.assetId === asset.assetId && receipt.status === 'read')!;
    const note = store.request({ type: 'memory.record', companionId: grant.companionId, conversationId: 'world_' + grant.companionId,
      candidate: { artifactKind: 'knowledge', content: actual.content, tags: ['资料'], sourceMessageIds: [receipt.sourceMessageId], evidence: [{ sourceMessageId: receipt.sourceMessageId, quote: actual.content }] } }).memories![0]!;
    return { receipt, note, actual };
  };
  return { root, library, opened, store, books, outside, assets, grant, add, read, request, backend: (value: boolean) => { unavailable = value; } };
}

function validationHost(assets: ReturnType<typeof companionLearningAssets>) {
  const changed = vi.fn(), reset = vi.fn(async () => undefined), report = vi.fn();
  const host = Object.assign(Object.create(CompanionService.prototype), { options: { learningAssets: assets, report }, assetValidations: new Map(),
    memory: { changed }, knowledge: { reset } }) as { validateAssets(filter?: { companionId?: string; libraryId?: string }): Promise<CompanionLearningAssetValidation> };
  return { host, changed, reset, report };
}

it('admits the same finite asset filter once, verifies it fresh at the gate end, and keeps standalone/new gates fresh', async () => {
  const f = fixture(), { host } = validationHost(f.assets), revalidate = vi.spyOn(f.assets, 'revalidate');
  await withCompanionExecutionValidation(async () => {
    for (let index = 0; index < 39; index++) await host.validateAssets({ companionId: 'alice' });
    expect(revalidate).toHaveBeenCalledOnce();
  });
  expect(revalidate).toHaveBeenCalledTimes(2);
  await host.validateAssets({ companionId: 'alice' }); await host.validateAssets({ companionId: 'alice' });
  expect(revalidate).toHaveBeenCalledTimes(4);
  await withCompanionExecutionValidation(async () => { await host.validateAssets({ companionId: 'alice' }); await host.validateAssets({ companionId: 'alice' }); });
  expect(revalidate).toHaveBeenCalledTimes(6);
});

it.each(['membership', 'same-revision-bytes'] as const)('rejects a real asset %s change during the final canonical witness and preserves actual withdrawal side effects', async change => {
  const f = fixture(), grant = f.grant(), asset = f.add(), original = await f.read(grant, asset), { host, changed } = validationHost(f.assets);
  const actual = f.assets.revalidate.bind(f.assets); let maintenanceChecks = 0;
  const revalidate = vi.spyOn(f.assets, 'revalidate').mockImplementation(async filter => {
    const result = await actual(filter);
    if (result.changedCompanionIds.length) {
      // Main's real invalidation callback can retract canonical publications.
      // Its new witnesses must belong to maintenance, never the sealed old
      // publication gate whose content is about to be refused.
      await memoCompanionExecutionWitnesses(['retraction'], { identity: {}, scope: 'maintenance', revision: () => 0,
        read: async keys => new Map(keys.map(key => [key, 'actual revoked receipt'])), verify: async () => { maintenanceChecks++; } });
    }
    return result;
  });
  await expect(withCompanionExecutionValidation(async () => {
    await host.validateAssets({ companionId: 'alice' }); await host.validateAssets({ companionId: 'alice' });
    await memoCompanionExecutionWitnesses(['actual-file'], { identity: {}, scope: 'canonical', revision: () => 0,
      read: async keys => new Map(keys.map(key => [key, 'actual body'])), verify: async () => {
        if (change === 'membership') f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
        else f.library.saveTextAsset({ libraryId: f.opened.libraryId, assetId: asset.assetId, content: '同一个修订号下，真实正文已变化。', expectedRevisionId: asset.currentRevisionId, createRevision: false });
      } });
  })).rejects.toThrow('授权资料已经变化');
  expect(revalidate).toHaveBeenCalledTimes(2); expect(changed).toHaveBeenCalledWith('alice'); expect(maintenanceChecks).toBe(1);
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads.find(read => read.id === original.receipt.id)?.status).toBe('withdrawn');
});

it('rejects final asset unavailability without withdrawing evidence, then allows an independent recovered gate', async () => {
  const f = fixture(), grant = f.grant(), read = await f.read(grant, f.add()), { host, changed } = validationHost(f.assets);
  await expect(withCompanionExecutionValidation(async () => {
    await host.validateAssets({ companionId: 'alice' }); f.backend(true);
  })).rejects.toThrow('暂时无法核验');
  expect(changed).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads.find(item => item.id === read.receipt.id)?.status).toBe('read');
  f.backend(false);
  await expect(withCompanionExecutionValidation(() => host.validateAssets({ companionId: 'alice' }))).resolves.toMatchObject({ unavailableCompanionIds: [] });
});

it('does not cache an initial unavailable asset result or omit the later healthy final fence', async () => {
  const f = fixture(); await f.read(f.grant(), f.add()); const { host, changed } = validationHost(f.assets), revalidate = vi.spyOn(f.assets, 'revalidate');
  await withCompanionExecutionValidation(async () => {
    f.backend(true); expect((await host.validateAssets({ companionId: 'alice' })).unavailableCompanionIds).toEqual(['alice']);
    f.backend(false); expect((await host.validateAssets({ companionId: 'alice' })).unavailableCompanionIds).toEqual([]);
    await host.validateAssets({ companionId: 'alice' }); expect(revalidate).toHaveBeenCalledTimes(2);
  });
  expect(revalidate).toHaveBeenCalledTimes(3); expect(changed).not.toHaveBeenCalled();
});

it('retains the final asset fence when a caught retry throws after an earlier unavailable result was consumed', async () => {
  const f = fixture(); await f.read(f.grant(), f.add()); const { host, changed } = validationHost(f.assets), actual = f.assets.revalidate.bind(f.assets);
  let calls = 0; f.backend(true);
  vi.spyOn(f.assets, 'revalidate').mockImplementation(filter => {
    if (++calls === 2) return Promise.reject(new Error('actual adapter transport failure'));
    return actual(filter);
  });
  await expect(withCompanionExecutionValidation(async () => {
    expect((await host.validateAssets({ companionId: 'alice' })).unavailableCompanionIds).toEqual(['alice']);
    await expect(host.validateAssets({ companionId: 'alice' })).rejects.toThrow('actual adapter transport failure');
  })).rejects.toThrow('暂时无法核验');
  expect(calls).toBe(3); expect(changed).not.toHaveBeenCalled();
});

it('does not use an older in-flight asset snapshot as its final fence after real membership changes', async () => {
  const f = fixture(), asset = f.add(); await f.read(f.grant(), asset); const { host } = validationHost(f.assets), actual = f.assets.revalidate.bind(f.assets);
  let release!: () => void, started!: () => void, calls = 0, pending!: Promise<CompanionLearningAssetValidation>;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(f.assets, 'revalidate').mockImplementation(async filter => {
    const result = await actual(filter);
    if (++calls === 2) { started(); await held; }
    return result;
  });
  const operation = withCompanionExecutionValidation(async () => {
    await host.validateAssets({ companionId: 'alice' });
    pending = detachedCompanionExecutionValidation(() => host.validateAssets({ companionId: 'alice' }));
    await entered;
    f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
  });
  await entered; await Promise.resolve(); release();
  await expect(operation).rejects.toThrow('授权资料已经变化'); await pending;
  expect(calls).toBe(3);
});

it('revokes moved sources, derived memory and frozen history only for grants that lost membership, then requires a fresh actual read after restore', async () => {
  const f = fixture(), asset = f.add(), alice = f.grant(), bob = f.grant('bob', true), a = await f.read(alice, asset), b = await f.read(bob, asset);
  const scope = { companionId: 'alice', conversationId: 'world_alice' }, frozen = { id: a.note.id, sources: a.note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) };
  const derived = f.store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'knowledge', content: '基于资料的新认识。', tags: [], sourceMessageIds: [a.receipt.sourceMessageId],
    evidence: [{ sourceMessageId: a.receipt.sourceMessageId, quote: a.actual.content }], relatedMemoryIds: [a.note.id] } }).memories![0]!;
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
  expect(await f.assets.revalidate({ libraryId: f.opened.libraryId })).toMatchObject({ changedCompanionIds: ['alice'], unavailableCompanionIds: [], revokedSourceCount: 1 });
  expect(f.store.request({ type: 'memory.frozen.valid', ...scope, memories: [frozen] }).memoryFrozenValid).toBe(false);
  expect(() => f.store.request({ type: 'memory.revision.read', ...scope, id: a.note.id, contentRevision: 1 })).toThrow();
  expect(f.store.request({ type: 'memory.records.filter', ...scope, ids: [derived.id] }).memories).toEqual([]);
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: 'world_bob', ids: [b.receipt.sourceMessageId] }).memorySources).toHaveLength(1);
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.books.folderId, conflictStrategy: 'keep-both' });
  const fresh = await f.read(alice, asset);
  expect(fresh.receipt.sourceMessageId).not.toBe(a.receipt.sourceMessageId);
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [a.receipt.sourceMessageId] }).memorySources).toEqual([]);
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: [] });
});

it.each(['revision', 'same-revision-bytes', 'trash', 'permanent'] as const)('withdraws real asset evidence after %s without touching another asset', async kind => {
  const f = fixture(), first = f.add(), second = f.add('second.md', '另一份仍获准的资料。'), grant = f.grant();
  const one = await f.read(grant, first), two = await f.read(grant, second);
  if (kind === 'revision' || kind === 'same-revision-bytes') f.library.saveTextAsset({ libraryId: f.opened.libraryId, assetId: first.assetId, content: '修订后的不同事实。', expectedRevisionId: first.currentRevisionId, createRevision: kind === 'revision' });
  else { f.library.trashAssets({ libraryId: f.opened.libraryId, assetIds: [first.assetId] }); if (kind === 'permanent') f.library.deleteAssetsPermanent({ libraryId: f.opened.libraryId, assetIds: [first.assetId] }); }
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: ['alice'], revokedSourceCount: 1 });
  const status = f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!;
  expect(status.reads.find(read => read.id === one.receipt.id)?.status).toBe('withdrawn');
  expect(status.reads.find(read => read.id === two.receipt.id)?.status).toBe('read');
  expect(status.grants).toHaveLength(1);
});

it('fails closed during transient backend errors without permanently withdrawing evidence', async () => {
  const f = fixture(), grant = f.grant(), read = await f.read(grant, f.add()); f.backend(true);
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: ['alice'], revokedSourceCount: 0 });
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads[0]!.status).toBe('read');
  f.backend(false); expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: [] });
  expect(f.store.request({ type: 'memory.records.filter', companionId: 'alice', conversationId: 'world_alice', ids: [read.note.id] }).memories).toHaveLength(1);
});

it('binds single-use bounded snapshots to current grant revision and covers grants with no hot read', () => {
  const f = fixture(), grant = f.grant();
  const page = f.store.request({ type: 'learning.assets.snapshot', companionId: 'alice', limit: 1 }).learningAssetSnapshot!;
  expect(page.entries).toHaveLength(1); expect(page.entries[0]!.asset).toBeUndefined();
  f.store.request({ type: 'learning.update', companionId: 'alice', id: grant.id, expectedRevision: 1, autonomous: false, intervalMinutes: 60 });
  const stale = f.store.request({ type: 'learning.assets.validate', token: page.token, checks: [{ index: 0, state: 'revoked' }] }).learningAssetValidation!;
  expect(stale).toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: ['alice'] });
  expect(() => f.store.request({ type: 'learning.assets.validate', token: page.token, checks: [{ index: 0, state: 'revoked' }] })).toThrow('已使用');
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.grants).toHaveLength(1);
});

it('records goal-driven asset reads in the same authorization ledger and redacts withdrawn rounds', async () => {
  const f = fixture(), grant = f.grant(), asset = f.add(), actual = await f.assets.read(grant, asset);
  const goal = f.store.request({ type: 'learning.goals.create', companionId: 'alice', text: '学习已授权资料。', materials: [{ kind: 'library', grantId: grant.id }], allowWeb: false }).learningGoal!;
  const job = f.store.request({ type: 'learning.goals.claim' }).learningGoalJob!;
  expect(job.goal.id).toBe(goal.id);
  f.store.request({ type: 'learning.goals.source', id: goal.id, leaseToken: job.leaseToken, read: { id: randomUUID(), kind: 'asset', grantId: grant.id, assetId: asset.assetId,
    title: asset.displayName, uri: 'asset:' + asset.assetId, revision: actual.revisionId, contentHash: createHash('sha256').update(actual.content).digest('hex'),
    readAt: new Date().toISOString(), characters: actual.content.length, excerpt: actual.content, truncated: false } });
  f.library.trashAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId] });
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: ['alice'], revokedSourceCount: 1 });
  const round = f.store.request({ type: 'learning.goals.rounds', companionId: 'alice', id: goal.id }).learningRounds!.items[0]!;
  expect(round.reads[0]).toMatchObject({ title: '已撤回的学习资料', excerpt: '', sourceMessageId: undefined });
});

it('revokes a grant when its exact persisted library path now belongs to a different real library, preserving other libraries', async () => {
  const f = fixture(), grant = f.grant(), read = await f.read(grant, f.add());
  const other = f.library.createLibrary({ selectedParentPath: f.root, displayName: '另一座资料库' });
  const otherGrant = f.store.request({ type: 'learning.grant', companionId: 'alice', libraryId: other.libraryId, libraryName: other.displayName,
    libraryPath: other.libraryPath, autonomous: false, intervalMinutes: 30 }).learning!.grants.find(item => item.libraryId === other.libraryId)!;
  f.library.closeLibrary(f.opened.libraryId);
  const preserved = path.join(f.root, 'preserved-original-library');
  for (const target of [f.opened.libraryPath, preserved]) expect(path.relative(f.root, target)).not.toMatch(/^\.\./u);
  renameSync(f.opened.libraryPath, preserved);
  const replacement = f.library.createLibrary({ selectedParentPath: f.root, displayName: f.opened.displayName });
  expect(path.resolve(replacement.libraryPath)).toBe(path.resolve(f.opened.libraryPath)); expect(replacement.libraryId).not.toBe(f.opened.libraryId);
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: ['alice'], unavailableCompanionIds: [], revokedSourceCount: 1 });
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.grants.map(item => item.id)).toEqual([otherGrant.id]);
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'world_alice', ids: [read.receipt.sourceMessageId] }).memorySources).toEqual([]);
});

it('keeps repeated unchanged canonical verification and management eligibility read-only', async () => {
  const f = fixture(), grant = f.grant(); await f.read(grant, f.add());
  const fresh = companionLearningAssets({ request: f.request, memoryRoot: path.join(f.root, 'private-memory'), storageRequest: async command => f.store.request(command) });
  const observer = new Sqlite(path.join(f.root, 'companions.sqlite'), { readonly: true });
  try {
    const version = () => observer.prepare('PRAGMA data_version').get().data_version, before = version();
    const watermark = f.store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState!;
    for (let i = 0; i < 3; i++) expect(await fresh.revalidate()).toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: [] });
    expect(version()).toBe(before);
    expect(f.store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState).toEqual(watermark);
  } finally { observer.close(); }
});

it('tracks cold-only actual reads without creating an experience and revokes their authorization on asset moves', async () => {
  const f = fixture(), grant = f.grant(), asset = f.add();
  await f.assets.read(grant, asset);
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
  expect(f.store.request({ type: 'memory.library.page', companionId: 'alice' }).memoryPage!.items).toEqual([]);
  const before = f.store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState!;
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: ['alice'], unavailableCompanionIds: [], revokedSourceCount: 0 });
  expect(f.store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState!.revocationEpoch).toBeGreaterThan(before.revocationEpoch);
});

it('does not apply an old invalid asset result after a newer successful actual read', async () => {
  const f = fixture(), grant = f.grant(), asset = f.add(); await f.assets.read(grant, asset);
  const snapshot = f.store.request({ type: 'learning.assets.snapshot', companionId: 'alice' }).learningAssetSnapshot!;
  await f.assets.read(grant, asset);
  const checks = snapshot.entries.map((entry, index) => ({ index, state: entry.asset ? 'revoked' as const : 'valid' as const }));
  expect(f.store.request({ type: 'learning.assets.validate', token: snapshot.token, checks }).learningAssetValidation)
    .toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: ['alice'], revokedSourceCount: 0 });
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: [], unavailableCompanionIds: [] });
});

it.each(['parked', 'abandoned'] as const)('keeps %s material holds and cumulative failures through exact source withdrawal and same-byte reauthorization', async heldState => {
  const f = fixture(), grant = f.grant(), peer = f.add('peer.md', '另一份资料仍然有效。'), preserved = await f.read(grant, peer), asset = f.add();
  const actual = await f.assets.read(grant, asset);
  f.store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const claim = f.store.request({ type: 'learning.claim' }).learningJob!;
  const began = f.store.request({ type: 'learning.begin', id: claim.id, leaseToken: claim.leaseToken, assetId: asset.assetId, assetRevisionId: actual.revisionId, offset: 0 }).jobDisposition!;
  f.store.request({ type: 'learning.defer', id: claim.id, leaseToken: claim.leaseToken, failureKind: 'processing', error: 'PRIVATE_READING_PROVIDER_ERROR', retryAfterMs: 1000 });
  const failed = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'learning', id: began.id }).jobDisposition!;
  const held = f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'learning', id: began.id, inputVersion: failed.inputVersion,
    expectedRevision: failed.revision, operationId: randomUUID(), action: heldState === 'parked' ? 'park' : 'abandon' }).jobDisposition!;
  expect(held).toMatchObject({ state: heldState, failureCount: 1, cycleFailureCount: 1 });
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
  expect(await f.assets.revalidate()).toMatchObject({ changedCompanionIds: ['alice'] });
  const withdrawn = f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'learning', id: began.id }).jobDisposition!;
  expect(withdrawn).toMatchObject({ id: held.id, state: heldState, failureCount: 1, cycleFailureCount: 1 });
  expect(withdrawn.lastError).toBeUndefined(); expect(withdrawn.revision).toBeGreaterThan(held.revision);
  expect(() => f.store.request({ type: 'jobs.control', ownerId: 'alice', kind: 'learning', id: began.id, inputVersion: held.inputVersion,
    expectedRevision: held.revision, operationId: randomUUID(), action: 'resume' })).toThrow();
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.books.folderId, conflictStrategy: 'keep-both' });
  const fresh = await f.assets.read(grant, asset); expect(fresh.revisionId).toBe(actual.revisionId);
  f.store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const next = f.store.request({ type: 'learning.claim' }).learningJob!;
  expect(f.store.request({ type: 'learning.begin', id: next.id, leaseToken: next.leaseToken, assetId: asset.assetId, assetRevisionId: fresh.revisionId, offset: 0 }).jobDisposition)
    .toMatchObject({ id: held.id, state: heldState, failureCount: 1 });
  expect(() => f.store.request({ type: 'learning.commit', id: next.id, leaseToken: next.leaseToken, assetId: asset.assetId,
    assetRevisionId: fresh.revisionId, assetName: asset.displayName, offset: 0, content: fresh.content, more: false })).toThrow();
  expect(f.store.request({ type: 'memory.records.filter', companionId: 'alice', conversationId: 'world_alice', ids: [preserved.note.id] }).memories).toHaveLength(1);
  // Whole-grant withdrawal has the same hold-preservation and privacy fence.
  f.store.request({ type: 'learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  expect(f.store.request({ type: 'jobs.inspect', ownerId: 'alice', kind: 'learning', id: held.id }).jobDisposition)
    .toMatchObject({ state: heldState, failureCount: 1, cycleFailureCount: 1 });
});

it('restarts a same-byte reauthorized partial material from zero and never restores its withdrawn prefix source', async () => {
  const f = fixture(), grant = f.grant(), asset = f.add('partial.md', '前半段有明确条件。后半段必须在新获权读取后重新检验。');
  const actual = await f.assets.read(grant, asset), size = 9;
  f.store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const job = f.store.request({ type: 'learning.claim' }).learningJob!;
  const original = f.store.request({ type: 'learning.begin', id: job.id, leaseToken: job.leaseToken, assetId: asset.assetId, assetRevisionId: actual.revisionId, offset: 0 }).jobDisposition!;
  const read = f.store.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: asset.assetId, assetRevisionId: actual.revisionId,
    assetName: asset.displayName, offset: 0, content: actual.content.slice(0, size), nextOffset: size, more: true }).learning!.reads[0]!;
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
  await f.assets.revalidate();
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [asset.assetId], targetFolderId: f.books.folderId, conflictStrategy: 'keep-both' });
  const fresh = await f.assets.read(grant, asset); expect(fresh.revisionId).toBe(actual.revisionId);
  f.store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const next = f.store.request({ type: 'learning.claim' }).learningJob!; expect(next.offset).toBe(0);
  expect(() => f.store.request({ type: 'learning.begin', id: next.id, leaseToken: next.leaseToken, assetId: asset.assetId, assetRevisionId: fresh.revisionId, offset: size })).toThrow();
  const began = f.store.request({ type: 'learning.begin', id: next.id, leaseToken: next.leaseToken, assetId: asset.assetId, assetRevisionId: fresh.revisionId, offset: 0 }).jobDisposition!;
  expect(began.id).not.toBe(original.id);
  const current = f.store.request({ type: 'learning.commit', id: next.id, leaseToken: next.leaseToken, assetId: asset.assetId, assetRevisionId: fresh.revisionId,
    assetName: asset.displayName, offset: 0, content: fresh.content, more: false }).learning!.reads.find(item => item.status === 'read')!;
  expect(current.sourceMessageId).not.toBe(read.sourceMessageId);
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'world_alice', ids: [read.sourceMessageId] }).memorySources).toEqual([]);
});

it('does not reset another lawful partial material cursor when a peer asset loses its folder authorization', async () => {
  const f = fixture(), grant = f.grant(), first = f.add(), prior = await f.read(grant, first), second = f.add('peer-partial.md', '另一份材料分段读取，游标与获权条件必须保持。');
  const actual = await f.assets.read(grant, second), size = 8;
  f.store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const job = f.store.request({ type: 'learning.claim' }).learningJob!;
  f.store.request({ type: 'learning.begin', id: job.id, leaseToken: job.leaseToken, assetId: second.assetId, assetRevisionId: actual.revisionId, offset: 0 });
  const partial = f.store.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: second.assetId, assetRevisionId: actual.revisionId,
    assetName: second.displayName, offset: 0, content: actual.content.slice(0, size), nextOffset: size, more: true }).learning!.reads.find(item => item.assetId === second.assetId)!;
  f.library.moveAssets({ libraryId: f.opened.libraryId, assetIds: [first.assetId], targetFolderId: f.outside.folderId, conflictStrategy: 'keep-both' });
  await f.assets.revalidate();
  f.store.request({ type: 'learning.run', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  const next = f.store.request({ type: 'learning.claim' }).learningJob!;
  expect(next).toMatchObject({ assetId: second.assetId, assetRevisionId: actual.revisionId, offset: size });
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'world_alice', ids: [partial.sourceMessageId] }).memorySources).toHaveLength(1);
  expect(f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'world_alice', ids: [prior.receipt.sourceMessageId] }).memorySources).toEqual([]);
});
