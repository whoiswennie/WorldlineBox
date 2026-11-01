import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { companionMemoryDocumentCatalogStamp } from '../../src/main/companions/memory-document-catalog';
import { companionMemorySourceArtifactId, companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { readMemoryDocumentPage } from '../../src/main/companions/memory-document-page';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionConnection } from '../../src/companions/store';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
function fixture() { const f = managedMemoryFiles(); fixtures.push(f); return f; }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const list = (f: ReturnType<typeof fixture>) => f.documents.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '记忆/经历', recordsOnly: true, limit: 64 });
async function ready(f: ReturnType<typeof fixture>) {
  await vi.waitFor(async () => { const result = await list(f); expect(result.ok, result.error).toBe(true); expect(result.documents?.index?.state).toBe('ready'); }, { interval: 25, timeout: 15000 });
}

it('admits a real page in note batches without building individual source pages or tag-job reads', async () => {
  const f = fixture(), source = f.source('一批笔记共享准确的同一个来源。');
  const notes = Array.from({ length: 12 }, (_, index) => f.record(`正式日记第${index}篇。`, [source.id]));
  await f.publish(); await ready(f); f.commands.length = 0;
  const page = await list(f);
  expect(page.ok, page.error).toBe(true);
  expect(page.documents?.items.map(item => item.noteId).sort()).toEqual(notes.map(note => note.id).sort());
  expect(page.documents?.items.every(item => item.sourceCount === 1 && item.readOnly && item.category === 'diary')).toBe(true);
  expect(f.commands.filter(command => command.type === 'memory.library.read')).toHaveLength(0);
  expect(f.commands.filter(command => command.type === 'memory.tags.status')).toHaveLength(0);
  const batches = f.commands.filter(command => command.type === 'memory.library.read-many');
  expect(batches).toHaveLength(2); // One current admission plus one fresh final SQL witness.
  for (const batch of batches) if (batch.type === 'memory.library.read-many') expect([...batch.ids].sort()).toEqual(notes.map(note => note.id).sort());
});

it('uses a bounded versioned stamp for lawful long tag sets and retains every equality input', async () => {
  const f = fixture(), source = f.source('包含很多真实分类标签的日记。');
  const tags = Array.from({ length: 30 }, (_, index) => `分类${index}：读书运动与生活习惯`);
  const note = f.store.request({ type: 'memory.record', ...f.scope, candidate: { ...f.candidate('有正式来源的标签日记。', [source.id]), tags } }).memories![0]!;
  f.index(); await f.publish();
  const page = await list(f); expect(page.ok, page.error).toBe(true);
  expect(page.documents?.items.find(item => item.noteId === note.id)?.tags).toEqual(tags);
  const stamps = f.commands.flatMap(command => command.type === 'document.catalog.touch' ? [command.stamp]
    : command.type === 'document.catalog.put' ? command.entries.map(entry => entry.stamp) : []);
  expect(stamps.length).toBeGreaterThan(0); expect(stamps.every(stamp => /^v2:[a-f0-9]{64}$/u.test(stamp))).toBe(true);
  const artifact = await (await f.artifacts('alice')).get(`memory:${note.id}`);
  const entry = { artifact: artifact!, hash: artifact!.contentHash, state: 'tracked' as const, noteId: note.id };
  const stamp = companionMemoryDocumentCatalogStamp(entry, note);
  expect(companionMemoryDocumentCatalogStamp(entry, { ...note, tags: [...tags, '另一完整标签'] })).not.toBe(stamp);
  expect(companionMemoryDocumentCatalogStamp({ ...entry, hash: 'b'.repeat(64) }, note)).not.toBe(stamp);
  expect(companionMemoryDocumentCatalogStamp(entry, { ...note, version: note.version + 1 })).not.toBe(stamp);
});

it.each(['body', 'annotation', 'withdrawal'] as const)('rejects a late same-source %s mutation at the actual batch final fence', async mutation => {
  const f = fixture(), source = f.source('这个来源本身保持不变。'), note = f.record('当前正式正文。', [source.id]);
  await f.publish(); await ready(f); let batches = 0, changed = false;
  f.intercept(command => {
    if (command.type !== 'memory.library.read-many' || ++batches !== 2) return;
    changed = true; f.intercept();
    if (mutation === 'body') f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('同源的新正文尚未出版。', [source.id]) });
    else if (mutation === 'annotation') f.store.request({ type: 'memory.library.organize', companionId: 'alice', id: note.id, expectedVersion: note.version, diaryName: note.diaryName ?? '', tags: ['新标签'] });
    else f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
  });
  const page = await list(f);
  expect(changed).toBe(true); expect(page.ok).toBe(false); expect(page.documents).toBeUndefined();
});

it('never presents another owner or SQL-only unprinted prose as a current directory preview', async () => {
  const f = fixture(), source = f.source('准确旧来源。'), note = f.record('已出版旧正文。', [source.id]);
  await f.publish(); await ready(f);
  const foreign = await f.documents.handle({ type: 'memory.documents.list', companionId: 'bob', directory: '记忆/经历', recordsOnly: true, limit: 64 });
  expect(foreign.ok, foreign.error).toBe(true); expect(foreign.documents?.items).toEqual([]);
  f.store.request({ type: 'memory.revise', ...f.scope, id: note.id, expectedVersion: note.version, candidate: f.candidate('SQL新正文不能当目录预览。', [source.id]) });
  const page = await list(f); expect(page.ok).toBe(false); expect(page.documents).toBeUndefined();
});

it.each([false, true])('keeps exact source revision tuples on a real page, independently of input order (reverse=%s)', async reverse => {
  const f = fixture(), source = f.source('第一版来源正文。'); f.record('引用第一版来源的日记。', [source.id]); await f.publish();
  const registry = await f.artifacts('alice'), old = await registry.get(companionMemorySourceArtifactId(source.id, 1));
  const content = '第二版来源正文。', checksum = createHash('sha256').update(content).digest('hex');
  const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
  try {
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    db.prepare('UPDATE messages SET content=?,revision=2 WHERE id=?').run(content, source.id);
  } finally { db.close(); }
  const relativePath = companionMemorySourceFilePath({ sourceId: source.id, sourceRevision: 2, sourceChecksum: checksum });
  await registry.publish({ artifactId: companionMemorySourceArtifactId(source.id, 2), kind: 'source_evidence',
    producer: { kind: 'host', id: 'fixture-source-publisher' }, relativePath, expectedRevision: null, content,
    sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['source_verification', 'audit'],
    retentionClass: 'evidence', operationId: 'fixture:source:r2' });
  const paths = [old!.relativePath, relativePath]; if (reverse) paths.reverse();
  const page = await withCompanionExecutionValidation(() => f.library.withDocuments('alice', session => readMemoryDocumentPage(session, paths), { readOnly: true }));
  expect(page.map(value => value.path)).toEqual([relativePath]); expect(page[0]?.content).toBe(content);
  const stale = await f.documents.handle({ type: 'memory.documents.read', companionId: 'alice', path: old!.relativePath, sourceLimit: 1 });
  expect(stale.ok).toBe(false); expect(stale.document).toBeUndefined();
});
