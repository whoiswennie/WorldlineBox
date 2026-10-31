import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryViewCache } from '../../src/main/companions/memory-view-cache';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeOwnedDirectory(root); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-owner-view-cache-')); roots.push(root);
  const directoryForOwner = vi.fn(async (owner: string) => path.join(root, owner, '.运行', '索引', 'views'));
  return { root, directoryForOwner, cache: new CompanionMemoryViewCache({ directoryForOwner }, { maxViews: 1, maxArtifacts: 1 }),
    directory: (owner: string) => path.join(root, owner, '.运行', '索引', 'views') };
}
const artifacts: VcpMemoryTimelineArtifacts = { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: 'actual_revision', agents: [] };

it('stores every view and timeline in its owner directory while enforcing one shared residency budget', async () => {
  const f = await fixture(), expected = new Map<string, string>();
  for (const owner of ['alice', 'bob']) {
    const prepared = await f.cache.prepare(owner + ':owner-v2', 'model', []); await prepared.commit(); expected.set(owner, prepared.scopeId);
    await f.cache.saveArtifacts(owner + ':owner-v2', 'model', artifacts);
    expect(f.cache.snapshot()).toMatchObject({ persistent: true, views: 1, artifacts: 1 });
    expect((await readdir(f.directory(owner))).sort()).toHaveLength(2);
  }
  const restored = new CompanionMemoryViewCache({ directoryForOwner: f.directoryForOwner }, { maxViews: 1 });
  for (const owner of ['alice', 'bob']) expect((await restored.prepare(owner + ':owner-v2', 'model', [])).scopeId).toBe(expected.get(owner));
  expect((await readdir(f.root)).sort()).toEqual(['alice', 'bob']);
});

it('invalidates only the requested owner directory, including disk-only views and artifacts', async () => {
  const f = await fixture();
  for (const owner of ['alice', 'bob']) { const prepared = await f.cache.prepare(owner + ':owner-v2', 'model', []); await prepared.commit(); await f.cache.saveArtifacts(owner + ':owner-v2', 'model', artifacts); }
  const bobFiles = await readdir(f.directory('bob')); f.directoryForOwner.mockClear();
  const purged = await f.cache.invalidateOwner('alice'); expect(purged).toHaveLength(1);
  expect(f.directoryForOwner.mock.calls.every(([owner]) => owner === 'alice')).toBe(true);
  expect(await readdir(f.directory('alice'))).toEqual([]); expect(await readdir(f.directory('bob'))).toEqual(bobFiles);
  expect((await f.cache.loadArtifacts('bob:owner-v2', 'model'))?.sourceRevision).toBe('actual_revision');
});

it('derives owner solely from a strict internal identity and rejects path or newline injection before resolving files', async () => {
  const f = await fixture();
  for (const identity of ['../bob:owner-v2', 'alice\nbob:owner-v2', 'alice', 'alice:', ':owner-v2']) await expect(f.cache.prepare(identity, 'model', [])).rejects.toThrow('宿主伙伴身份');
  await expect(f.cache.invalidateOwner('../bob')).rejects.toThrow('标识'); expect(f.directoryForOwner).not.toHaveBeenCalled();
  const invalid = new CompanionMemoryViewCache({ directoryForOwner: async () => 'relative-cache' });
  await expect(invalid.prepare('alice:owner-v2', 'model', [])).rejects.toThrow('绝对目录');
});
