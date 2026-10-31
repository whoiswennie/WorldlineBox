import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { companionMemoryArtifactPath } from '../../src/main/companions/artifact-registry';
import type { MemoryBodyCleanupCursor } from '../../src/main/companions/memory-library';
import type { CompanionArtifact } from '../../src/shared/companion-artifact';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
async function records(f: ReturnType<typeof fixture>) {
  const raw = f.source('即将撤回的真实原始依据。'), note = f.record('正式的经历正文。', [raw.id]); await f.publish();
  const registry = await f.artifacts('alice'), source = (await registry.get(`source:${raw.id}:r1`))!, artifacts: CompanionArtifact[] = [(await registry.get(`memory:${note.id}`))!];
  for (const kind of ['knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'] as const) artifacts.push(await registry.publish({ artifactId: 'fixture:' + kind, kind,
    producer: { kind: 'system', id: 'fixture-system' }, relativePath: kind === 'dream_fiction' ? '演化/联想/fixture.md' : companionMemoryArtifactPath(kind, '真实资料', 'fixture_' + kind),
    expectedRevision: null, content: '需要保护的 ' + kind, sourceRefs: [{ artifactId: source.artifactId, contentRevision: source.contentRevision, contentHash: source.contentHash }], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'current', operationId: 'fixture:publish:' + kind }));
  return { raw, note, registry, source, artifacts };
}
async function drain(f: ReturnType<typeof fixture>, limit = 2) {
  let cursor: MemoryBodyCleanupCursor | undefined; const conflicts: Array<{ file: string; message: string }> = []; let checked = 0;
  for (let iteration = 0; iteration < 40; iteration++) { const page = await f.library.purgeRevoked('alice', { limit, cursor }); checked += page.checked; conflicts.push(...page.conflicts); if (!page.pending) return { checked, conflicts }; cursor = page.nextCursor; }
  throw new Error('Cleanup did not reach its bounded cursor end');
}
it('removes exact revoked bodies across all six memory domains through indexed resumable debt, then stops revisiting them', async () => {
  const f = fixture(), setup = await records(f); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [setup.raw.id] }); await f.sources.flush('alice'); await f.history.flush('alice'); f.commands.length = 0;
  const result = await drain(f); expect(result.conflicts).toEqual([]); expect(result.checked).toBe(6);
  for (const artifact of setup.artifacts) { expect(existsSync(f.file(artifact.relativePath))).toBe(false); expect((await setup.registry.get(artifact.artifactId, true))?.publicationState).toBe('revoked'); }
  expect((await drain(f)).checked).toBe(0); expect(f.commands.some(command => command.type === 'memory.library.page')).toBe(false);
  expect(f.commands.filter(command => command.type === 'cognition.registry.page').every(command => command.publicationState === 'revoked' && command.bodyCleanupRequired === true)).toBe(true);
});
it('preserves unknown changed bytes as a retryable conflict while purging other formally revoked memories', async () => {
  const f = fixture(), setup = await records(f), changed = setup.artifacts.find(artifact => artifact.kind === 'knowledge')!; writeFileSync(f.file(changed.relativePath), 'UNKNOWN_EXTERNAL_REPLACEMENT');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [setup.raw.id] }); await f.sources.flush('alice'); await f.history.flush('alice');
  expect((await drain(f)).conflicts).toEqual([expect.objectContaining({ file: changed.relativePath })]); expect(readFileSync(f.file(changed.relativePath), 'utf8')).toBe('UNKNOWN_EXTERNAL_REPLACEMENT');
  f.restart(); expect((await drain(f)).checked).toBe(1); expect(readFileSync(f.file(changed.relativePath), 'utf8')).toBe('UNKNOWN_EXTERNAL_REPLACEMENT');
});
it('recovers a body-removal/cleanup-receipt crash without recreating the missing body from SQL', async () => {
  const f = fixture(), setup = await records(f); await setup.registry.revoke(setup.source.artifactId);
  f.intercept(command => { if (command.type === 'cognition.registry.body-removed') { f.intercept(); throw new Error('CRASH_BEFORE_CLEANUP_RECEIPT'); } });
  const first = await f.library.purgeRevoked('alice', { limit: 1 }); expect(first.conflicts).toHaveLength(1); expect(existsSync(f.noteFile(setup.note))).toBe(false);
  f.restart(); expect((await drain(f)).conflicts).toEqual([]); expect(existsSync(f.noteFile(setup.note))).toBe(false); expect((await drain(f)).checked).toBe(0);
});
it('clears exact pending private memory bytes and stages when source withdrawal precedes registry commit', async () => {
  const f = fixture(), raw = f.source('真实待撤回来源。'), note = f.record('已登记来源入口。', [raw.id]); await f.sources.flush('alice'); const registry = await f.artifacts('alice'), source = (await registry.get(`source:${raw.id}:r1`))!;
  const operationId = 'memory:interrupted:r1:fixture';
  f.intercept(command => { if (command.type === 'cognition.registry.publication.transition' && command.nextState === 'file_published') { f.intercept(); throw new Error('CRASH_BEFORE_MEMORY_METADATA_COMMIT'); } });
  await expect(registry.publish({ artifactId: 'memory:interrupted', kind: 'knowledge', producer: { kind: 'system', id: 'memory-commit' }, relativePath: '记忆/知识/资料/interrupted.md', expectedRevision: null, content: 'UNCOMMITTED_PRIVATE_KNOWLEDGE', sourceRefs: [{ artifactId: source.artifactId, contentRevision: 1, contentHash: source.contentHash }], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['audit'], retentionClass: 'current', operationId })).rejects.toThrow('CRASH');
  const publication = (await registry.publication(operationId))!; expect(existsSync(f.file(publication.items[0]!.next.relativePath))).toBe(true); await registry.revoke(source.artifactId);
  expect((await drain(f)).conflicts).toEqual([]); expect(existsSync(f.file(publication.items[0]!.next.relativePath))).toBe(false);
  for (const item of publication.items) expect(existsSync(f.file(item.stage))).toBe(false); expect((await registry.publication(operationId))?.stagesCleanedAt).toBeDefined(); expect(note.id).toBeDefined();
});
