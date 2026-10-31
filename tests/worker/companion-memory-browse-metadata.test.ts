import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { companionMemorySearchSchema, type CompanionMemorySearch, type CompanionMemoryPage } from '../../src/shared/companion-memory';
import type { CompanionMemory } from '../../src/shared/companions';
import { companionMemoryDateRange } from '../../src/shared/companion-memory-time';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

afterEach(() => vi.useRealTimers());
type Statement = ReturnType<CompanionConnection['prepare']> & { iterate(...args: unknown[]): Iterable<unknown> };
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T02:00:00Z');
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-memory-browse-metadata-')), filename = path.join(root, 'state.sqlite');
  const store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: 'Synthetic browse fixture.', model: '', avatar: 'sister', active: true, proactive: false })));
  const Sqlite = Database as { new(file: string): CompanionConnection }, db = new Sqlite(filename);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const metrics = { metadataRows: 0, metadataBytes: 0, fullBodyRows: 0, allFullBodies: 0, sourceReads: 0 };
  let track = false, afterMetadata: undefined | (() => void);
  const measure = (sql: string, kind: string, result: unknown) => {
    if (!track) return;
    if (/SELECT\s+data\s+FROM\s+vcp_memory_notes/iu.test(sql)) {
      metrics.fullBodyRows += Array.isArray(result) ? result.length : result ? 1 : 0;
      if (kind === 'all') metrics.allFullBodies++;
    }
    if (/SELECT\s+\*\s+FROM\s+messages/iu.test(sql)) metrics.sourceReads++;
  };
  const port: CompanionConnection = { function: db.function.bind(db), exec: db.exec.bind(db), pragma: db.pragma.bind(db), transaction: db.transaction.bind(db), close: db.close.bind(db),
    prepare: sql => {
      const statement = db.prepare(sql) as Statement;
      return { all: (...args: unknown[]) => { const result = statement.all(...args); measure(sql, 'all', result); return result; },
        get: (...args: unknown[]) => { const result = statement.get(...args); measure(sql, 'get', result); return result; }, run: statement.run.bind(statement),
        *iterate(...args: unknown[]) {
          for (const result of statement.iterate(...args)) {
            if (track && sql.includes('json_remove(data')) {
              metrics.metadataRows++; metrics.metadataBytes += Buffer.byteLength(String((result as { metadata: string }).metadata));
            }
            if (sql.includes('json_remove(data') && afterMetadata) { const hook = afterMetadata; afterMetadata = undefined; hook(); }
            yield result;
          }
        } };
    } };
  const memory = new CompanionMemoryStore(port, id => store.getMessage(id), undefined, undefined, undefined, undefined, undefined, () => 'UTC');
  const alice = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bob = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
  const record = (content: string, tags: string[], diaryName = '日记', occurredAt = '2026-10-14T02:00:00Z', target = alice) => {
    const source = store.appendMessage({ conversationId: target.conversationId, authorId: 'user', content, replyDirective: 'none' });
    return store.request({ type: 'memory.record', ...target, candidate: { artifactKind: 'episode_memory' as const, content, tags, diaryName, occurredAt, metadata: { autoTags: false },
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content.slice(0, 16000) }] } }).memories![0]!;
  };
  // This is the old full-body listing algorithm, with the unchanged public
  // read gate as its visibility oracle. It never calls optimized browse.
  const oracle = (input: CompanionMemorySearch): CompanionMemoryPage => {
    const query = companionMemorySearchSchema.parse(input); memory.sources.requireScope(query);
    const range = companionMemoryDateRange(query.from, query.to, 'UTC');
    const all = memory.list(query.companionId).filter(note => {
      try { memory.read(query, note.id); } catch { return false; }
      const at = Date.parse(note.occurredAt ?? note.sources.at(-1)?.worldCreatedAt ?? note.sources.at(-1)?.createdAt ?? note.createdAt);
      return (!query.diaryName || note.diaryName === query.diaryName) && query.tags.every(tag => note.tags.includes(tag))
        && (range.start === undefined || at >= range.start) && (range.end === undefined || at <= range.end);
    });
    const cursor = query.cursor ?? 0, hasMore = all.length > cursor + query.limit;
    return { items: all.slice(cursor, cursor + query.limit).map(note => ({ memory: memory.read(query, note.id).memory, reasons: ['journal-list'], path: [note.id] })),
      hasMore, nextCursor: hasMore ? cursor + query.limit : undefined };
  };
  return { root, filename, store, db, memory, alice, bob, record, oracle, metrics,
    track: () => { for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) metrics[key] = 0; track = true; },
    stop: () => { track = false; }, onMetadata: (hook: () => void) => { afterMetadata = hook; },
    close: async () => { db.close(); store.close(); await removeOwnedDirectory(root); } };
}

it('matches the full-body oracle for row order, tags, dates, cutoff, archives, owner ACL and actual source withdrawal', async () => {
  const f = await fixture();
  try {
    const first = f.record('First legitimate original.', ['red'], '资料', '2026-10-13T20:00:00Z');
    const second = f.record('Second original with both tags.', ['red', 'blue']);
    f.record('Third original in another diary.', ['blue'], '资料');
    const archived = f.record('Archived history is outside the directory.', ['red']);
    f.db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.archivedAt','2026-10-14T03:00:00Z') WHERE id=?").run(archived.id);
    f.record('FOREIGN_OWNER_BROWSE_SECRET', ['red'], '日记', undefined, f.bob);
    const queries: CompanionMemorySearch[] = [{ ...f.alice, limit: 1 }, { ...f.alice, limit: 1, cursor: 1 }, { ...f.alice, limit: 2, cursor: 2 },
      { ...f.alice, tags: ['red'], diaryName: '资料', from: '2026-10-13T00:00:00Z', to: '2026-10-14T23:59:59Z', limit: 10 },
      { ...f.alice, tags: ['red', 'blue'], limit: 10 }, { ...f.alice, beforeSequence: first.sourceSequence + 1, limit: 10 }];
    for (const query of queries) expect(f.memory.browse(query)).toEqual(f.oracle(query));
    f.store.request({ type: 'memory.forget', ...f.alice, sourceMessageIds: [second.sources[0]!.messageId] });
    for (const query of queries) expect(f.memory.browse(query)).toEqual(f.oracle(query));
    expect(f.memory.browse({ ...f.alice, limit: 100 }).items.some(hit => hit.memory.id === second.id)).toBe(false);
    expect(() => f.memory.browse({ companionId: 'alice', conversationId: f.bob.conversationId })).toThrow();
  } finally { await f.close(); }
});

it('loads only returned top-level bodies from a large-body SQLite corpus, including a deep cursor, without claiming bounded source work', async () => {
  const f = await fixture(), pages: unknown[] = [], notes: CompanionMemory[] = [], output = path.resolve('artifacts/vcp-validation/memory-browse-metadata-' + randomUUID() + '.json');
  let passed = false;
  try {
    for (let index = 0; index < 128; index++) notes.push(f.record('ORIGINAL_BODY_' + index + '\n' + '关键状态、归属和未完成条件。'.repeat(2500), ['large-body']));
    for (const cursor of [0, 5, 125]) {
      const query = { ...f.alice, tags: ['large-body'], limit: 3, cursor }, expected = f.oracle(query);
      f.track(); const actual = f.memory.browse(query); f.stop();
      expect(actual).toEqual(expected); expect(f.metrics.allFullBodies).toBe(0);
      expect(f.metrics.fullBodyRows).toBe(actual.items.length); expect(f.metrics.sourceReads).toBeGreaterThan(0);
      expect(f.metrics.metadataRows).toBeLessThanOrEqual(cursor + query.limit + 1);
      expect(f.metrics.metadataBytes).toBeLessThan(notes.reduce((sum, note) => sum + Buffer.byteLength(note.content), 0) / 10);
      pages.push({ cursor, returned: actual.items.length, ...f.metrics });
    }
    passed = true;
  } finally {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ passed, corpusNotes: notes.length, bodyCharacters: notes.reduce((sum, note) => sum + note.content.length, 0),
      bodyBytes: notes.reduce((sum, note) => sum + Buffer.byteLength(note.content), 0), actualSQLite: true, pages,
      limitation: 'Bounded returned top-level body loads only; metadata scanning, SQL json_remove and source/dependency validation are not O(page).' }, null, 2));
    await f.close();
  }
});

it('keeps metadata and returned bodies in one deferred WAL snapshot when an actual host revision commits between them', async () => {
  const f = await fixture();
  try {
    const original = f.record('Original body pinned by the browse snapshot.', ['snapshot']);
    let revised: CompanionMemory | undefined;
    f.onMetadata(() => {
      const content = 'New body committed by the other real SQLite connection.', source = f.store.appendMessage({ conversationId: f.alice.conversationId, authorId: 'user', content, replyDirective: 'none' });
      revised = f.store.request({ type: 'memory.revise', ...f.alice, id: original.id, expectedVersion: original.version, candidate: { artifactKind: 'episode_memory' as const,
        content, tags: ['snapshot'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] } }).memories![0]!;
    });
    const page = f.memory.browse({ ...f.alice, tags: ['snapshot'], limit: 1 });
    expect(revised?.contentRevision).toBe(2);
    expect(page.items[0]!.memory).toMatchObject({ id: original.id, content: original.content, version: original.version });
    expect(f.memory.browse({ ...f.alice, tags: ['snapshot'], limit: 1 }).items[0]!.memory.content).toBe(revised!.content);
  } finally { await f.close(); }
});
