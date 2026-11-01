import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionArtifactRegistry } from '../../src/main/companions/artifact-registry';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import { detachedCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import type { VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); });

async function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const source = f.source('这是一项真实且可撤回的依据。'), note = f.record('由真实依据形成的经历。', [source.id]); await f.publish();
  const snapshot = f.store.request({ type: 'memory.snapshot', ...f.scope, contentKinds: ['episode_memory'] }).memorySnapshot!;
  const revision = snapshot.semanticRevision ?? snapshot.revision;
  const owner = companionMemoryIdentity(f.store.state().companions.find(owner => owner.id === 'alice')!);
  const artifacts: VcpMemoryTimelineArtifacts = { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision: revision, owner,
    agents: [{ agentName: owner.agentName, months: [{ month: '2026-10', sourceDigest: 'fixture-exact-source', content: '十月的真实经历概览。' }] }] };
  const registry = await f.artifacts('alice'), bodies = vi.spyOn(registry as unknown as { bytes(relative: string): Promise<Buffer> }, 'bytes');
  const valid = vi.fn(async () => {
    // These live SQL predicates still run on every callback, even when the
    // exact canonical input shares its first bytes within this publication.
    const current = f.store.request({ type: 'memory.records.describe', ...f.scope, ids: [note.id] }).memoryDescriptors;
    if (!current?.some(item => item.id === note.id && item.contentRevision === note.contentRevision)) return false;
    await registry.read({ artifactId: `memory:${note.id}`, consumer: 'audit' });
    return true;
  });
  return { f, note, source, registry, bodies, valid, artifacts };
}

it('shares a source first read only within one navigation publication and retains the fresh final read and live SQL callbacks', async () => {
  const t = await fixture();
  await t.f.library.publishTimelines(t.f.scope, t.artifacts, t.valid);
  expect(t.valid.mock.calls.length).toBeGreaterThanOrEqual(5);
  const sourcePath = t.f.noteFile(t.note).slice(t.registry.root.length + 1).replaceAll('\\', '/');
  // The preliminary validity check has its own initial/final pair. All later
  // publisher callbacks share exactly one more initial/final pair, not a TTL.
  expect(t.bodies.mock.calls.filter(([relative]) => relative === sourcePath)).toHaveLength(4);
  expect((await t.registry.page({ kind: 'navigation', limit: 8 })).items).toHaveLength(1);
  t.bodies.mockClear(); await t.valid();
  expect(t.bodies.mock.calls.filter(([relative]) => relative === sourcePath)).toHaveLength(2);
});

it.each(['same-stat-file-edit', 'source-withdrawal'] as const)('does not leave a committed navigation trusted if %s is discovered by its final fence', async change => {
  const t = await fixture(), original = CompanionArtifactRegistry.prototype.publish; let changed = false;
  vi.spyOn(CompanionArtifactRegistry.prototype, 'publish').mockImplementation(async function (this: CompanionArtifactRegistry, ...args) {
    const result = await original.apply(this, args);
    if (args[0].kind === 'navigation' && !changed) {
      changed = true;
      if (change === 'same-stat-file-edit') {
        const file = t.f.noteFile(t.note), before = statSync(file);
        writeFileSync(file, t.note.content.replace('真', '新')); utimesSync(file, before.atime, before.mtime);
      } else expect(t.f.store.request({ type: 'memory.forget', ...t.f.scope, sourceMessageIds: [t.source.id] }).ok).toBe(true);
    }
    return result;
  });
  await expect(t.f.library.publishTimelines(t.f.scope, t.artifacts, t.valid)).rejects.toThrow();
  expect(changed).toBe(true); expect((await t.registry.page({ kind: 'navigation', limit: 8 })).items).toEqual([]);
  const retired = (await t.registry.page({ kind: 'navigation', publicationState: 'revoked', limit: 8 })).items;
  expect(retired).toHaveLength(1);
  await expect(t.registry.read({ artifactId: retired[0]!.artifactId, consumer: 'navigation' })).rejects.toThrow();
});

it('does not withdraw a later exact same-id revision when failed-publication cleanup loses its CAS', async () => {
  const t = await fixture(), original = CompanionArtifactRegistry.prototype.publish; let replaced = false, replacementId = '', replacementText = '';
  vi.spyOn(CompanionArtifactRegistry.prototype, 'publish').mockImplementation(async function (this: CompanionArtifactRegistry, ...args) {
    const first = await original.apply(this, args);
    if (args[0].kind === 'navigation' && !replaced) {
      replaced = true; replacementId = first.artifactId; replacementText = args[0].content + '\n另一笔独立正式发布。';
      await detachedCompanionExecutionValidation(() => original.call(this, { ...args[0], content: replacementText,
        expectedRevision: first.contentRevision, operationId: 'fixture-replacement:' + randomUUID() }));
      writeFileSync(t.f.noteFile(t.note), '外部改写导致原读取窗口失效。');
    }
    return first;
  });
  await expect(t.f.library.publishTimelines(t.f.scope, t.artifacts, t.valid)).rejects.toThrow('未撤回新的版本');
  expect(replaced).toBe(true);
  const current = await t.registry.get(replacementId);
  expect(current).toMatchObject({ contentRevision: 2, publicationState: 'committed' });
  expect(readFileSync(t.f.file(current!.relativePath), 'utf8')).toBe(replacementText);
});

it('checks both exact fields in the same real SQL revoke transaction while preserving legacy revoke behavior', async () => {
  const t = await fixture(); await t.f.library.publishTimelines(t.f.scope, t.artifacts, t.valid);
  const artifact = (await t.registry.page({ kind: 'navigation', limit: 8 })).items[0]!;
  for (const expected of [{ contentRevision: artifact.contentRevision + 1, contentHash: artifact.contentHash },
    { contentRevision: artifact.contentRevision, contentHash: '0'.repeat(64) }]) {
    await expect(t.registry.revoke(artifact.artifactId, expected)).rejects.toThrow('未撤回新的版本');
    expect((await t.registry.get(artifact.artifactId))?.publicationState).toBe('committed');
  }
  expect(companionStorageCommandSchema.safeParse({ type: 'cognition.registry.revoke', ownerId: 'alice', artifactId: artifact.artifactId,
    expected: { contentRevision: artifact.contentRevision } }).success).toBe(false);
  await t.registry.revoke(artifact.artifactId, { contentRevision: artifact.contentRevision, contentHash: artifact.contentHash });
  expect((await t.registry.get(artifact.artifactId, true))?.publicationState).toBe('revoked');
  // Other callers still use their original unconditioned retraction semantics.
  expect(await t.registry.revoke(artifact.artifactId)).toContain(artifact.artifactId);
});
