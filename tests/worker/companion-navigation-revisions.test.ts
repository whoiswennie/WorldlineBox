import { afterEach, expect, it, vi } from 'vitest';
import { stat, utimes, writeFile } from 'node:fs/promises';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { companionMemoryDescriptorSchema } from '../../src/shared/companion-memory';
import { companionMemorySnapshotRevisionScopeKey, normalizeCompanionMemorySnapshotRevisionScope,
  type CompanionMemorySnapshotRevisionScope } from '../../src/shared/companion-memory-snapshot-revisions';
import { CompanionMemoryStore } from '../../src/companions/memory-store';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
afterEach(async () => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) await f.close(); });
function full(f: ReturnType<typeof fixture>, scope: CompanionMemorySnapshotRevisionScope) {
  return f.store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!;
}
async function navigation(f: ReturnType<typeof fixture>, scopes: CompanionMemorySnapshotRevisionScope[]) {
  const registry = await f.artifacts('alice');
  const paths: string[] = [];
  for (let index = 0; index < scopes.length; index++) {
    const scope = scopes[index]!, snapshot = full(f, { ...scope, contentKinds: ['episode_memory'] }), relativePath = `记忆/导航/fixture-${index}.md`;
    await registry.publish({ artifactId: `navigation:fixture:${index}`, kind: 'navigation', producer: { kind: 'system', id: 'vcp-navigation' },
      relativePath, expectedRevision: null, content: '---\n' + JSON.stringify({ schema: 'worldlinebox.companion-navigation-v2', scope,
        sourceRevision: snapshot.semanticRevision ?? snapshot.revision }) + '\n---\n正式导航正文。', sourceRefs: [], dependencyRefs: [],
      visibility: { scope: 'owner' }, allowedConsumers: ['navigation', 'audit'], retentionClass: 'current', operationId: `fixture:nav:${index}` });
    paths.push(relativePath);
  }
  return paths;
}

it('returns exactly the original scoped snapshot revisions and authorized descriptors without transporting prose', async () => {
  const f = fixture(), first = f.source('前一条准确来源。'), second = f.source('后一条准确来源。');
  f.record('PRIVATE_BODY_NOT_IN_METADATA_1', [first.id]); f.record('PRIVATE_BODY_NOT_IN_METADATA_2', [second.id]);
  const knowledge = f.store.request({ type: 'memory.record', ...f.scope, candidate: { ...f.candidate('PRIVATE_KNOWLEDGE', [first.id]), artifactKind: 'knowledge' } }).memories![0]!;
  f.index();
  const scopes: CompanionMemorySnapshotRevisionScope[] = [
    { ...f.scope, beforeSequence: second.sequence, contentKinds: ['episode_memory'] },
    { ...f.scope, beforeSequence: second.sequence + 1, contentKinds: ['episode_memory'] },
    { ...f.scope, contentKinds: ['knowledge', 'episode_memory'] },
    { ...f.scope, contentKinds: ['episode_memory', 'knowledge'] },
    { ...f.scope, contentKinds: ['knowledge'], publishedOnly: true },
  ];
  const response = f.store.request({ type: 'memory.snapshot.revisions', scopes });
  expect(response.ok).toBe(true); expect(response.memorySnapshotRevisions?.groups).toHaveLength(scopes.length);
  response.memorySnapshotRevisions!.groups.forEach((group, index) => {
    const expected = full(f, scopes[index]!);
    expect(group).toEqual({ scope: normalizeCompanionMemorySnapshotRevisionScope(scopes[index]!), valid: true,
      revision: expected.revision, semanticRevision: expected.semanticRevision, memories: expected.notes.map(note => companionMemoryDescriptorSchema.parse(note)) });
  });
  expect(response.memorySnapshotRevisions!.groups[0]!.semanticRevision).not.toBe(response.memorySnapshotRevisions!.groups[1]!.semanticRevision);
  expect(response.memorySnapshotRevisions!.groups[2]).toEqual(response.memorySnapshotRevisions!.groups[3]);
  expect(response.memorySnapshotRevisions!.groups[4]!.memories).toEqual([]);
  expect(JSON.stringify(response)).not.toContain('PRIVATE_');
  expect(knowledge.contentRevision).toBeDefined();
  await f.publish();
  const published = f.store.request({ type: 'memory.snapshot.revisions', scopes: [scopes[4]!] }).memorySnapshotRevisions!.groups[0]!;
  expect(published.memories.some(note => note.id === knowledge.id)).toBe(true);
});

it('keeps each batch owner and room permission independent, and never treats a denied scope as an empty authorized snapshot', () => {
  const f = fixture(); f.record('仅Alice可见的经历。');
  const denied = { ...f.scope, companionId: 'bob', contentKinds: ['episode_memory'] as const };
  const scopes: CompanionMemorySnapshotRevisionScope[] = [{ ...f.scope, contentKinds: ['episode_memory'] }, { ...denied, contentKinds: [...denied.contentKinds] }];
  const result = f.store.request({ type: 'memory.snapshot.revisions', scopes }).memorySnapshotRevisions!;
  expect(result.groups[0]?.valid).toBe(true); expect(result.groups[0]?.memories).toHaveLength(1);
  expect(result.groups[1]).toMatchObject({ valid: false, revision: '', memories: [] });
});

it('deduplicates four navigation files by complete normalized scope only, and opens a fresh batch on the next gate', async () => {
  const f = fixture(), first = f.source('第一条。'), second = f.source('第二条。');
  f.record('第一条经历。', [first.id]); f.record('第二条经历。', [second.id]); await f.publish();
  const a = { ...f.scope, beforeSequence: second.sequence }, b = { ...f.scope, beforeSequence: second.sequence + 1 };
  const paths = await navigation(f, [a, a, b, b]);
  const run = () => withCompanionExecutionValidation(() => f.library.withDocuments('alice', session => session.timelineValidMany!(paths.map(path => ({ path }))), { readOnly: true }));
  f.commands.length = 0;
  expect([...(await run()).values()]).toEqual([true, true, true, true]);
  const batches = f.commands.filter(command => command.type === 'memory.snapshot.revisions');
  expect(batches).toHaveLength(2);
  for (const batch of batches) if (batch.type === 'memory.snapshot.revisions') {
    expect(batch.scopes).toHaveLength(2); expect(new Set(batch.scopes.map(companionMemorySnapshotRevisionScopeKey)).size).toBe(2);
  }
  expect(f.commands.some(command => command.type === 'memory.snapshot')).toBe(false);
  expect(f.commands.some(command => command.type === 'memory.library.read' || command.type === 'memory.library.read-many')).toBe(false);
  f.commands.length = 0; expect([...(await run()).values()]).toEqual([true, true, true, true]);
  expect(f.commands.filter(command => command.type === 'memory.snapshot.revisions')).toHaveLength(2);
});

it('shares repeated single-file calls only in the same finite scope while preserving one final union batch', async () => {
  const f = fixture(); f.record('当前导航依据。'); await f.publish(); const paths = await navigation(f, [f.scope, f.scope]);
  f.commands.length = 0;
  await withCompanionExecutionValidation(() => f.library.withDocuments('alice', async session => {
    expect(await session.timelineValid(paths[0]!)).toBe(true); expect(await session.timelineValid(paths[1]!)).toBe(true);
  }, { readOnly: true }));
  expect(f.commands.filter(command => command.type === 'memory.snapshot.revisions')).toHaveLength(2);
});

it.each(['forget', 'body'] as const)('rejects late %s changes after the exact navigation predicate was consumed', async mutation => {
  const f = fixture(), source = f.source('准确来源。'), note = f.record('原始经历。', [source.id]); await f.publish();
  const paths = await navigation(f, [f.scope]);
  await expect(withCompanionExecutionValidation(() => f.library.withDocuments('alice', async session => {
    expect(await session.timelineValid(paths[0]!)).toBe(true);
    if (mutation === 'forget') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
    else { f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('同源改写的新正文。', [source.id]) }); f.index(); }
  }, { readOnly: true }))).rejects.toThrow(/导航.*来源|语义版本/u);
});

it('keeps annotation-only changes outside the semantic predicate while retaining exact canonical navigation byte checks', async () => {
  const f = fixture(), note = f.record('没有改写正文的经历。'); await f.publish(); const paths = await navigation(f, [f.scope]);
  await withCompanionExecutionValidation(() => f.library.withDocuments('alice', async session => {
    expect(await session.timelineValid(paths[0]!)).toBe(true);
    f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: note.version, diaryName: note.diaryName ?? '', tags: ['仅更新分类'] }); f.index();
  }, { readOnly: true }));
  await expect(withCompanionExecutionValidation(() => f.library.withDocuments('alice', async session => {
    expect(await session.timelineValid(paths[0]!)).toBe(true);
    const file = f.file(paths[0]!), before = await stat(file);
    await writeFile(file, (await (await f.artifacts('alice')).read({ artifactId: 'navigation:fixture:0', consumer: 'navigation' })).text.replace('正式导航正文', '篡改导航正文'));
    await utimes(file, before.atime, before.mtime);
  }, { readOnly: true }))).rejects.toThrow();
});

it('propagates coded snapshot unavailability instead of returning a false navigation or an empty scope', () => {
  const f = fixture(), error = Object.assign(new Error('Injected physical snapshot read unavailable'), { code: 'SQLITE_IOERR_READ' });
  vi.spyOn(CompanionMemoryStore.prototype, 'snapshot').mockImplementation(() => { throw error; });
  expect(() => f.store.request({ type: 'memory.snapshot.revisions', scopes: [f.scope] })).toThrow(error);
});
