import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionLearningService, CompanionLearningReadError, type CompanionLearningAssets } from '../../src/main/companions/learning-service';
import type { AssetSummary } from '../../src/shared/asset-types';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';

const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionLearningService>(), releases: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-22T10:00:00Z'); });
afterEach(async () => { releases.splice(0).forEach(release => release()); for (const service of services) await service.close(); services.clear();
  for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const asset = (id = 'asset-one'): AssetSummary => ({ assetId: id, displayName: id + '.md', currentRevisionId: 'revision', relativeFilePath: id + '.md', mediaType: 'text' } as AssetSummary);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-service-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob', 'charlie'].map(id => ({ id, name: id, description: '', persona: '读资料不等于亲历。', model: '', avatar: 'sister', proactive: false, active: true }))); stores.add(store);
  const assets = { catalog: vi.fn(async () => []), grant: vi.fn(async () => ({ libraryName: '授权资料库', libraryPath: root })),
    page: vi.fn<CompanionLearningAssets['page']>(async () => ({ assets: [asset()], hasMore: false })),
    read: vi.fn<CompanionLearningAssets['read']>(async () => ({ content: '实际读取的资料。', revisionId: 'revision_hash', truncated: false })) };
  const request = vi.fn(async (command: CompanionStorageCommand) => store.request(command)), end = vi.fn(async () => undefined), report = vi.fn();
  const service = new CompanionLearningService({ assets, request, end, report, changed: vi.fn(), configured: () => true }); services.add(service);
  const grant = (owner = 'alice', autonomous = true) => store.request({ type: 'learning.grant', companionId: owner, libraryId: 'library', libraryName: '授权资料库', libraryPath: root, autonomous, intervalMinutes: 30 }).learning!.grants[0]!;
  return { root, store, service, assets, request, end, report, grant };
}

it('never reads an ungranted or non-autonomous source without a human run request', async () => {
  const f = fixture(); await f.service.tick(); f.grant('alice', false); await f.service.tick();
  expect(f.assets.page).not.toHaveBeenCalled(); expect(f.assets.read).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
});

it('automatically reads a newly granted source without a run command and preserves an existing manual grant', async () => {
  const f = fixture(); f.grant('bob', false);
  const command = companionWorkspaceRequestSchema.parse({ type: 'memory.learning.grant', companionId: 'alice', libraryId: 'library' });
  if (command.type !== 'memory.learning.grant') throw new Error('Unexpected parsed learning request');
  await f.service.handle(command);
  await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(1));
  const status = f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!;
  expect(status.grants[0]).toMatchObject({ autonomous: true, reads: 1 });
  expect(f.assets.read).toHaveBeenCalledOnce();
  expect(f.assets.read.mock.calls[0]![0]).toMatchObject({ companionId: 'alice', autonomous: true });
  const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(capture.sourceMessageIds).toContain(status.reads[0]!.sourceMessageId);
  expect(f.request.mock.calls.some(([request]) => request.type === 'learning.run')).toBe(false);
  expect(f.store.request({ type: 'learning.status', companionId: 'bob' }).learning!.grants[0]).toMatchObject({ autonomous: false, reads: 0 });
  expect(f.report).not.toHaveBeenCalled();
});

it('reports missing global model configuration as waiting without reading or recording anything', async () => {
  const f = fixture(); f.grant();
  const service = new CompanionLearningService({ assets: f.assets, request: f.request, configured: () => false,
    changed: vi.fn(), report: f.report }); services.add(service);
  await service.tick(); await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.grants[0]).toMatchObject({ status: 'waiting' }));
  expect(f.assets.page).not.toHaveBeenCalled(); expect(f.assets.read).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob).toBeUndefined();
});

it('keeps durable status and a successful revocation visible when the asset catalog is unavailable', async () => {
  const f = fixture(), grant = f.grant('alice', false); f.assets.catalog.mockRejectedValue(new Error('Asset Worker unavailable.'));
  expect(await f.service.handle({ type: 'memory.learning.status', companionId: 'alice' })).toMatchObject({ ok: true,
    learning: { grants: [{ id: grant.id }], libraries: [] } });
  const removed = await f.service.handle({ type: 'memory.learning.revoke', companionId: 'alice', id: grant.id, expectedRevision: grant.revision });
  expect(removed).toMatchObject({ ok: true, learning: { grants: [], libraries: [] } });
  expect(f.report).toHaveBeenCalledTimes(2); expect(f.assets.read).not.toHaveBeenCalled();
});

it('reads at most two independent owners and admits a third while the first file read is slow', async () => {
  const f = fixture(), pending = new Map<string, ReturnType<typeof deferred<{ content: string; revisionId: string; truncated: boolean }>>>();
  let active = 0, maximum = 0;
  for (const owner of ['alice', 'bob', 'charlie']) f.grant(owner);
  f.assets.read.mockImplementation(async grant => {
    active++; maximum = Math.max(maximum, active); const wait = deferred<{ content: string; revisionId: string; truncated: boolean }>();
    pending.set(grant.companionId, wait); releases.push(() => wait.resolve({ content: '真实片段', revisionId: 'revision_hash', truncated: false }));
    try { return await wait.promise; } finally { active--; }
  });
  await f.service.tick(); await vi.waitFor(() => expect(pending.size).toBe(2)); expect(maximum).toBe(2);
  pending.get('bob')!.resolve({ content: 'Bob真实读到的片段。', revisionId: 'revision_hash', truncated: false });
  await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'bob' }).learning!.reads).toHaveLength(1));
  await new Promise<void>(resolve => setImmediate(resolve)); await f.service.tick(); await vi.waitFor(() => expect(pending.has('charlie')).toBe(true));
  expect(maximum).toBe(2); expect(active).toBe(2); expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(0);
});

it('cancel plus drain waits for actual I/O and prevents the late read from becoming evidence', async () => {
  const f = fixture(), reading = deferred<{ content: string; revisionId: string; truncated: boolean }>(); f.grant();
  releases.push(() => reading.resolve({ content: '晚到结果', revisionId: 'revision_hash', truncated: false })); f.assets.read.mockReturnValue(reading.promise);
  await f.service.tick(); await vi.waitFor(() => expect(f.assets.read).toHaveBeenCalledOnce());
  f.service.cancel('alice'); let finished = false; const draining = f.service.drain('alice').then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(finished).toBe(false);
  reading.resolve({ content: '晚到结果', revisionId: 'revision_hash', truncated: false }); await draining;
  expect(finished).toBe(true); expect(f.end).toHaveBeenCalledOnce();
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
  expect(f.request.mock.calls.some(([command]) => command.type === 'learning.commit')).toBe(false);
});

it('drains a cancellation racing a claim before that claim is registered as active', async () => {
  const f = fixture(), gate = deferred<void>(); f.grant(); let claimed = false;
  const service = new CompanionLearningService({ assets: f.assets, changed: vi.fn(), report: f.report,
    request: async command => { const result = f.store.request(command); if (command.type === 'learning.claim' && result.learningJob && !claimed) { claimed = true; await gate.promise; } return result; } }); services.add(service);
  const pumping = service.tick(); await vi.waitFor(() => expect(claimed).toBe(true));
  service.cancel('alice'); const draining = service.drain('alice'); gate.resolve(); await pumping; await draining;
  expect(f.assets.page).not.toHaveBeenCalled(); expect(f.assets.read).not.toHaveBeenCalled();
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toEqual([]);
});

it('skips precisely unsupported candidates without treating them as read or starving later valid files', async () => {
  const f = fixture(), list = [asset('a_private'), asset('b_large'), asset('c_valid')]; f.grant();
  f.assets.page.mockImplementation(async (_grant, afterId) => ({ assets: list.filter(item => !afterId || item.assetId > afterId), hasMore: false }));
  f.assets.read.mockImplementation(async (_grant, item) => {
    if (item.assetId === 'a_private') throw new CompanionLearningReadError('private-source', '伙伴私有存档不作为来源。');
    return item.assetId === 'b_large' ? { content: '', revisionId: 'revision_hash', truncated: true }
      : { content: '最后一份授权资料的真实正文。', revisionId: 'revision_hash', truncated: false };
  });
  for (let index = 0; index < 3; index++) {
    await f.service.tick(); await vi.waitFor(() => expect(f.assets.read).toHaveBeenCalledTimes(index + 1));
    await new Promise<void>(resolve => setImmediate(resolve)); vi.setSystemTime(Date.now() + 1001);
  }
  await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(1));
  expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads[0]!.assetId).toBe('c_valid'); expect(f.report).not.toHaveBeenCalled();
});

it('keeps UTF-16 surrogate pairs intact across durable reading chunks', async () => {
  const f = fixture(); f.grant(); const content = '字'.repeat(11999) + '🌱' + '后续原文';
  f.assets.read.mockResolvedValue({ content, revisionId: 'revision_hash', truncated: false });
  await f.service.tick(); await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(1));
  const first = f.request.mock.calls.find(([command]) => command.type === 'learning.commit')![0];
  expect(first).toMatchObject({ offset: 0, nextOffset: 11999 });
  await new Promise<void>(resolve => setImmediate(resolve)); vi.setSystemTime(Date.now() + 1001); await f.service.tick();
  await vi.waitFor(() => expect(f.store.request({ type: 'learning.status', companionId: 'alice' }).learning!.reads).toHaveLength(2));
  const chunks = f.request.mock.calls.flatMap(([command]) => command.type === 'learning.commit' ? [command.content] : []);
  expect(chunks.join('')).toBe(content); expect(chunks[1]).toBe('🌱后续原文');
});
