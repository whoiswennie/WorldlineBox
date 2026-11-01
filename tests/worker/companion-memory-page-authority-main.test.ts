import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CompanionConnection } from '../../src/companions/store';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import { companionMemorySourceArtifactId, companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { readMemoryDocumentPage } from '../../src/main/companions/memory-document-page';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const value = managedMemoryFiles({ pageAuthority: true }); fixtures.push(value); return value; };
afterEach(async () => { for (const value of fixtures.splice(0)) await value.close(); });
const page = (f: ReturnType<typeof fixture>, paths: string[]) => withCompanionExecutionValidation(() =>
  f.library.withDocuments('alice', session => readMemoryDocumentPage(session, paths), { readOnly: true }));

it('reads an actual mixed canonical page with one initial and one fresh final authority packet', async () => {
  const f = fixture(), source = f.source('整页共享同一条真实来源。');
  const notes = [f.record('第一份准确日记。', [source.id]), f.record('第二份准确日记。', [source.id])]; await f.publish();
  const registry = await f.artifacts('alice'), sourceFile = await registry.get(companionMemorySourceArtifactId(source.id, 1));
  const snapshot = f.store.request({ type: 'memory.snapshot', ...f.scope, contentKinds: ['episode_memory'] }).memorySnapshot!;
  for (const [name, revision] of [['current', snapshot.semanticRevision!], ['old', 'not-the-current-revision']]) {
    await registry.publish({ artifactId: 'navigation:' + name, kind: 'navigation', producer: { kind: 'system', id: 'vcp-navigation' },
      relativePath: `记忆/导航/${name}.md`, expectedRevision: null,
      content: '---\n' + JSON.stringify({ schema: 'worldlinebox.companion-navigation-v2', scope: f.scope, sourceRevision: revision }) + '\n---\n受管导航。',
      sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['navigation', 'audit'], retentionClass: 'current', operationId: 'fixture:navigation:' + name });
  }
  const historyPaths = notes.map(note => path.relative(path.join(f.directory, 'alice'), f.historyFile(note.id, 1)).split(path.sep).join('/'));
  const paths = [...notes.map(companionMemoryRegisteredPath), ...historyPaths, sourceFile!.relativePath, '记忆/导航/current.md', '记忆/导航/old.md'];
  f.commands.length = 0;
  const result = await page(f, paths);
  expect(result.map(value => value.path)).toEqual(paths.filter(value => value !== '记忆/导航/old.md'));
  expect(result.filter(value => value.note).map(value => value.content)).toEqual(notes.map(note => note.content));
  const packets = f.commands.filter(command => command.type === 'memory.documents.authority');
  expect(packets).toHaveLength(2); expect(packets[0]).toEqual(packets[1]);
  expect(f.commands.some(command => ['memory.library.read-many', 'memory.snapshot.revisions', 'memory.revisions.describe', 'memory.sources.headers'].includes(command.type))).toBe(false);
});

it.each(['body', 'annotation', 'withdrawal'] as const)('rejects a late same-source %s change in its fresh final packet', async mutation => {
  const f = fixture(), source = f.source('原始来源保持同一条。'), note = f.record('规范文件中的旧正文。', [source.id]); await f.publish();
  let packets = 0, changed = false;
  f.intercept(command => {
    if (command.type !== 'memory.documents.authority' || ++packets !== 2) return;
    changed = true; f.intercept();
    if (mutation === 'body') f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('SQL新正文不能替换尚未出版的页面。', [source.id]) });
    else if (mutation === 'annotation') f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id,
      expectedVersion: note.version, diaryName: note.diaryName ?? '', tags: ['新的完整标签'] });
    else f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
  });
  await expect(page(f, [companionMemoryRegisteredPath(note)])).rejects.toThrow();
  expect(changed).toBe(true); expect(packets).toBe(2);
});

it('still checks actual canonical bytes after initial SQL packet consumption', async () => {
  const f = fixture(), source = f.source('字节核验不能只相信SQL回执。'), note = f.record('规范正文保持准确。', [source.id]); await f.publish();
  let packets = 0, changed = false;
  f.intercept(async command => {
    if (command.type === 'memory.documents.authority') packets++;
    if (changed || !packets || command.type !== 'cognition.registry.read' || !command.artifactIds?.includes(companionMemorySourceArtifactId(source.id, 1))) return;
    changed = true; const target = f.noteFile(note), before = await stat(target);
    await writeFile(target, note.content.replace('准确', '篡改'), 'utf8'); await utimes(target, before.atime, before.mtime);
  });
  await expect(page(f, [companionMemoryRegisteredPath(note)])).rejects.toThrow(); expect(changed).toBe(true);
});

it.each([false, true])('retains exact immutable source revisions in either page order (reverse=%s)', async reverse => {
  const f = fixture(), source = f.source('旧的第一版来源。'); f.record('引用旧版本的日记。', [source.id]); await f.publish();
  const registry = await f.artifacts('alice'), old = await registry.get(companionMemorySourceArtifactId(source.id, 1));
  const content = '当前第二版来源。', checksum = createHash('sha256').update(content).digest('hex');
  const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  try {
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    db.prepare('UPDATE messages SET content=?,revision=2 WHERE id=?').run(content, source.id);
  } finally { db.close(); }
  const currentPath = companionMemorySourceFilePath({ sourceId: source.id, sourceRevision: 2, sourceChecksum: checksum });
  await registry.publish({ artifactId: companionMemorySourceArtifactId(source.id, 2), kind: 'source_evidence', producer: { kind: 'host', id: 'fixture-source-publisher' },
    relativePath: currentPath, expectedRevision: null, content, sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' },
    allowedConsumers: ['source_verification', 'audit'], retentionClass: 'evidence', operationId: 'fixture:current-source:r2' });
  const paths = [old!.relativePath, currentPath]; if (reverse) paths.reverse();
  const result = await page(f, paths); expect(result.map(value => value.path)).toEqual([currentPath]); expect(result[0]?.content).toBe(content);
});
