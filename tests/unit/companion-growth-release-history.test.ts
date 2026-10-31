import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionArtifact } from '../../src/shared/companion-artifact';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';

vi.mock('electron', () => ({ app: {}, net: {}, clipboard: {}, dialog: {}, ipcMain: {}, protocol: {}, shell: {}, utilityProcess: {}, safeStorage: {} }));

function fixture() {
  const records = Array.from({ length: 23 }, (_, index) => ({ artifactId: 'release:' + (23 - index), ownerId: 'alice', kind: 'growth_publish',
    allowedConsumers: ['audit'], contentRevision: 1, contentHash: String(index).padStart(64, '0') } as CompanionArtifact));
  const read = vi.fn(async ({ artifactId }: { artifactId: string }) => ({ artifact: records.find(record => record.artifactId === artifactId)!, text: 'EXACT_BODY_' + artifactId }));
  const page = vi.fn(async ({ afterId, limit }: { afterId?: string; limit: number }) => {
    const offset = afterId ? records.findIndex(record => record.artifactId === afterId) + 1 : 0, items = records.slice(offset, offset + limit), hasMore = offset + items.length < records.length;
    return { items, hasMore, ...(hasMore ? { nextId: items.at(-1)!.artifactId } : {}) };
  });
  const registry = { page, read, get: vi.fn(async (id: string) => records.find(record => record.artifactId === id)) };
  let epoch = 0;
  const host: CompanionService = Object.assign(Object.create(CompanionService.prototype) as CompanionService, { initialization: Promise.resolve(), resettingCompanions: new Set(),
    storage: { request: vi.fn(async (input: { type: string }) => input.type === 'memory.lifecycle.state' ? { ok: true, memoryLifecycleState: { revocationEpoch: epoch } } : { ok: true, state: { companions: [{ id: 'alice' }] } }) }, assetProfiles: { artifacts: vi.fn(async () => registry) } });
  return { host, records, registry, page, read, revoke: () => ++epoch };
}
const command = (afterId?: string): Extract<CompanionWorkspaceRequest, { type: 'growth.releases.read' }> => ({ type: 'growth.releases.read', companionId: 'alice', expectedRevocationEpoch: 0, ...(afterId ? { afterId } : {}) });
it('reads twenty exact formal bodies and then the remaining older records through the registry keyset cursor', async () => {
  const f = fixture(), first = (await f.host.manageGrowthReleases(command())).growthReleasePage!;
  expect(first.items).toHaveLength(20); expect(first).toMatchObject({ companionId: 'alice', hasMore: true, nextId: 'release:4' });
  expect(first.items[0]).toEqual({ id: 'release:23', revision: 1, content: 'EXACT_BODY_release:23' });
  const last = (await f.host.manageGrowthReleases(command(first.nextId))).growthReleasePage!;
  expect(last.items.map(item => item.id)).toEqual(['release:3', 'release:2', 'release:1']); expect(last.hasMore).toBe(false);
  expect(f.page.mock.calls.map(([value]) => value)).toEqual([
    { consumer: 'audit', kind: 'growth_publish', newestFirst: true, limit: 20 },
    { consumer: 'audit', kind: 'growth_publish', newestFirst: true, limit: 20, afterId: 'release:4' },
  ]); expect(f.read).toHaveBeenCalledTimes(23);
});
it('rejects foreign or non-growth cursors, changed bodies and a non-advancing continuation instead of returning mixed history', async () => {
  const f = fixture();
  f.registry.get.mockResolvedValueOnce({ ...f.records[0]!, ownerId: 'bob' });
  await expect(f.host.manageGrowthReleases(command('release:23'))).rejects.toThrow('分页位置已失效'); expect(f.page).not.toHaveBeenCalled();
  f.registry.get.mockResolvedValueOnce({ ...f.records[0]!, kind: 'persona_current' });
  await expect(f.host.manageGrowthReleases(command('release:23'))).rejects.toThrow('分页位置已失效'); expect(f.page).not.toHaveBeenCalled();
  f.read.mockResolvedValueOnce({ artifact: { ...f.records[0]!, contentRevision: 2 }, text: 'CHANGED_BODY' });
  await expect(f.host.manageGrowthReleases(command())).rejects.toThrow('读取期间版本已变化');
  f.page.mockResolvedValueOnce({ items: [f.records[1]!], hasMore: true, nextId: 'release:23' });
  await expect(f.host.manageGrowthReleases(command('release:23'))).rejects.toThrow('分页位置未前进');
});
it('returns only an invalidated empty page when withdrawal changes the epoch before or during an older-page read', async () => {
  const before = fixture(); before.revoke();
  const stale = await before.host.manageGrowthReleases(command('release:4'));
  expect(stale.ok).toBe(false); expect(stale.growthReleasePage).toEqual({ companionId: 'alice', items: [], hasMore: false, revocationEpoch: 1 }); expect(before.read).not.toHaveBeenCalled();
  const during = fixture(), original = during.read.getMockImplementation()!;
  during.read.mockImplementationOnce(async input => { during.revoke(); return original(input); });
  const changed = await during.host.manageGrowthReleases(command());
  expect(changed.ok).toBe(false); expect(changed.growthReleasePage?.items).toEqual([]); expect(changed.growthReleasePage?.revocationEpoch).toBe(1);
});
