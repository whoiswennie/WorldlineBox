import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionDocumentCatalogStore } from '../../src/companions/document-catalog-store';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemoryDocuments } from '../../src/main/companions/memory-documents';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';
import type { CompanionMemoryDocument } from '../../src/shared/companion-memory-documents';

const roots: string[] = [], closes: Array<() => Promise<void> | void> = [];
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-document-catalog-')) throw new Error('Invalid test cleanup path');
    rmSync(root, { recursive: true, force: true });
  }
});
const metadata = (index: number, tags = ['日常']): CompanionMemoryDocument => ({ path: `日记/${String(index).padStart(7, '0')}.md`, name: `${index}.md`, title: `第 ${index} 篇日记`, directory: '日记',
  kind: 'document', category: 'diary', updatedAt: '2026-10-21T00:00:00.000Z', bytes: 100, revision: 'r' + index, contentHash: 'a'.repeat(64), tags, readOnly: false, syncState: 'untracked' });

it('queries 100,000 persisted documents with bounded pages and Chinese full-text/tag search beyond the first page', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-document-catalog-')); roots.push(root);
  const db = new Database(path.join(root, 'catalog.sqlite')); closes.push(() => db.close());
  db.pragma('journal_mode=WAL');
  const catalog = new CompanionDocumentCatalogStore(db as unknown as CompanionConnection); catalog.initialize();
  const started = performance.now(), rss = process.memoryUsage().rss;
  for (let first = 0; first < 100_000; first += 200) {
    catalog.execute({ type: 'document.catalog.put', companionId: 'alice', generation: 'one', entries: Array.from({ length: 200 }, (_, offset) => {
      const index = first + offset;
      return { document: metadata(index, index === 99_999 ? ['海边', '约定'] : ['日常']), text: index === 99_999 ? '秋日沿着防波堤看海，带上热茶和一本书。' : `今天的日记编号 ${index}，傍晚回家之后看书，整理房间，照顾阳台的植物。`, stamp: String(index) };
    }) });
  }
  const indexedMs = performance.now() - started;
  const query = (text: string, tags: string[] = []) => {
    const at = performance.now();
    const result = catalog.execute({ type: 'document.catalog.query', companionId: 'alice', directory: '', query: text, tags, limit: 64 })!.documentCatalog!;
    return { result, ms: performance.now() - at };
  };
  const cold = query('防波堤'), shortChinese = query('看海'), combined = query('热茶', ['海边', '约定']), page = query('');
  expect(cold.result.paths).toEqual(['日记/0099999.md']);
  expect(shortChinese.result.paths).toEqual(cold.result.paths); expect(combined.result.paths).toEqual(cold.result.paths);
  expect(page.result.paths).toHaveLength(64); expect(page.result.total).toBe(100_000); expect(page.result.hasMore).toBe(true);
  const repeated = Array.from({ length: 10 }, () => query('防波堤').ms).sort((a, b) => a - b);
  // These generous bounds detect accidental hydration of all 100k documents, not machine-specific speed.
  expect(Math.max(cold.ms, shortChinese.ms, page.ms)).toBeLessThan(3000);
  const report = { documents: 100_000, indexedMs, firstPageMs: page.ms, chineseTrigramMs: cold.ms, twoCharacterChineseMs: shortChinese.ms, tagCombinedMs: combined.ms,
    repeatedMedianMs: repeated[5], rssDeltaMiB: (process.memoryUsage().rss - rss) / 1048576, maxReturnedDocuments: page.result.paths.length };
  const output = path.resolve('artifacts/vcp-validation'); mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'document-catalog-100k.json'), JSON.stringify(report, null, 2));
  console.log('DOCUMENT_CATALOG_100K', JSON.stringify(report));
  db.close(); closes.pop();
  const reopened = new Database(path.join(root, 'catalog.sqlite')); closes.push(() => reopened.close());
  const afterRestart = new CompanionDocumentCatalogStore(reopened as unknown as CompanionConnection); afterRestart.initialize();
  expect(afterRestart.execute({ type: 'document.catalog.query', companionId: 'alice', query: '防波堤', directory: '', tags: [], limit: 64 })!.documentCatalog?.paths).toEqual(cold.result.paths);
  expect(afterRestart.execute({ type: 'document.catalog.query', companionId: 'bob', query: '', directory: '', tags: [], limit: 64 })!.documentCatalog?.total).toBe(0);
}, 180_000);

it('revalidates file content/tags/source versions after keyword candidate indexing and follows edits and forgetting', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-document-catalog-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', persona: '稳定人格', description: '', avatar: 'sister', model: '', proactive: false }]); closes.push(() => store.close());
  const directory = path.join(root, '伙伴记忆');
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, request: async command => store.request(command) }); closes.push(() => library.close());
  const manager = new CompanionMemoryDocuments({ libraryDirectory: directory, library, requestStorage: async command => store.request(command) }); closes.push(() => manager.close());
  const call = (command: unknown) => manager.handle(companionWorkspaceRequestSchema.parse({ companionId: 'alice', ...(command as object) }) as Parameters<typeof manager.handle>[0]);
  let note = (await call({ type: 'memory.documents.create', path: '资料/海边约定.md', content: '傍晚沿着防波堤看海。', tags: ['海边'] })).document!;
  expect((await call({ type: 'memory.documents.list', query: '防波堤', tags: ['海边'] })).documents?.items.map(item => item.path)).toEqual([note.document.path]);
  note = (await call({ type: 'memory.documents.save', path: note.document.path, expectedRevision: note.document.revision, content: '周末去山上看云。', tags: ['山间'] })).document!;
  expect((await call({ type: 'memory.documents.list', query: '防波堤' })).documents?.items).toEqual([]);
  expect((await call({ type: 'memory.documents.list', query: '看云', tags: ['山间'] })).documents?.items.map(item => item.path)).toEqual([note.document.path]);
  await call({ type: 'memory.documents.delete', path: note.document.path, expectedRevision: note.document.revision });
  expect((await call({ type: 'memory.documents.list', query: '看云' })).documents?.items).toEqual([]);
});

it('removes vanished empty folders after a complete generation while preserving actual empty notebooks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-document-catalog-')); roots.push(root);
  const db = new Database(path.join(root, 'catalog.sqlite')); closes.push(() => db.close());
  const catalog = new CompanionDocumentCatalogStore(db); catalog.initialize();
  catalog.execute({ type: 'document.catalog.put', companionId: 'alice', generation: 'before', entries: [], folders: ['资料/旧空目录', '资料/保留目录'] });
  catalog.execute({ type: 'document.catalog.put', companionId: 'alice', generation: 'after', entries: [], folders: ['资料/保留目录'] });
  catalog.execute({ type: 'document.catalog.finish', companionId: 'alice', generation: 'after' });
  const page = catalog.execute({ type: 'document.catalog.query', companionId: 'alice', directory: '', query: '', tags: [], limit: 64 })!.documentCatalog!;
  expect(page.folders).toEqual([{ path: '资料/保留目录', name: '保留目录', count: 0 }]);
});

it('opens a real 3,000-file library incrementally and performs repeat searches without rescanning its tree', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-document-catalog-')); roots.push(root);
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', persona: '稳定人格', description: '', avatar: 'sister', model: '', proactive: false }]); closes.push(() => store.close());
  const directory = path.join(root, '伙伴记忆'), notebook = path.join(directory, 'alice', '资料'); mkdirSync(notebook, { recursive: true });
  const body = '这是可直接管理的自然文本资料。我们会记录学习、日常生活和真实世界的细节。'.repeat(20);
  for (let i = 0; i < 3000; i++) writeFileSync(path.join(notebook, `资料-${String(i).padStart(5, '0')}.md`), body + (i === 2999 ? '\n蓝色鲸鱼藏在第两千九百九十九篇文件。' : `\n编号 ${i}`));
  let writes = 0;
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => { if (command.type === 'document.catalog.put') writes++; return store.request(command); };
  const library = new CompanionMemoryLibrary({ libraryDirectory: directory, request }); closes.push(() => library.close());
  const manager = new CompanionMemoryDocuments({ libraryDirectory: directory, library, requestStorage: request }); closes.push(() => manager.close());
  const list = async (query = '') => manager.handle({ type: 'memory.documents.list', companionId: 'alice', directory: '资料', limit: 64, query });
  const at = performance.now(), first = await list(), firstPageMs = performance.now() - at;
  expect(first.ok, first.error).toBe(true); expect(first.documents?.items).toHaveLength(64); expect(first.documents?.index?.state).toBe('building');
  const until = Date.now() + 60_000;
  while (store.request({ type: 'document.catalog.query', companionId: 'alice', directory: '资料', query: '', tags: [], limit: 1 }).documentCatalog!.total < 3000) {
    if (Date.now() > until) throw new Error('Incremental catalogue did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  // Let the scanner's final generation fence settle before testing steady state.
  await new Promise(resolve => setTimeout(resolve, 100));
  const fullScanMs = performance.now() - at, before = writes, times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(), found = await list('蓝色鲸鱼'); times.push(performance.now() - start);
    expect(found.ok, found.error).toBe(true); expect(found.documents?.items.map(item => item.path)).toEqual(['资料/资料-02999.md']);
  }
  expect(writes).toBe(before);
  const report = { files: 3000, charactersPerOrdinaryFile: body.length, firstPageMs, fullScanMs, repeatQueryMs: times, steadyStateCatalogWrites: writes - before, pageLimit: 64 };
  const output = path.resolve('artifacts/vcp-validation'); mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'document-catalog-real-files.json'), JSON.stringify(report, null, 2));
  console.log('DOCUMENT_CATALOG_REAL_FILES', JSON.stringify(report));
}, 120_000);
