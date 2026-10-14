import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';
const count = Number(process.env.WORLDLINEBOX_HISTORY_BENCHMARK ?? 0);
it.skipIf(!count)('measures indexed search and deep cursor reads on a large real SQLite history', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-history-benchmark-'));
  const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename);
  const Database = BetterSqlite3 as { new(filename: string): { function(name: string, options: { deterministic: boolean }, fn: (text: string) => string): void;
    prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }; transaction<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void; pragma(sql: string): void; close(): void } };
  const db = new Database(filename);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const rooms = ['gpt', 'kimi', 'grok', 'qwen'].map(role => store.openPrivate(role));
  const insert = db.prepare("INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status) VALUES(?,?,?,'text',?,?,'sent')");
  const start = performance.now();
  const batch = db.transaction((first: number, last: number) => {
    for (let index = first; index < last; index++) {
      const room = rooms[index % rooms.length]!;
      const day = new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 4000) * 86400_000).toISOString();
      insert.run('benchmark_' + index, room.id, index % 3 ? room.memberIds[0] : 'user',
        '今天一起写小说，整理项目与文件。编号 ' + index + (index % 10000 === 0 ? ' 星海合同验收' : ' 普通日常记录'), day);
    }
  });
  try {
    for (let index = 0; index < count; index += 10000) batch(index, Math.min(count, index + 10000));
    db.pragma('wal_checkpoint(TRUNCATE)');
    const buildMs = performance.now() - start;
    const samples: Record<string, number[]> = {};
    function measure(name: string, fn: () => unknown) { const start = performance.now(); const value = fn(); (samples[name] ??= []).push(performance.now() - start); return value; }
    for (let run = 0; run < 7; run++) {
      measure('one Han character', () => expect(store.search({ query: '小', compact: true }).searchPage.items).toHaveLength(30));
      measure('two Han characters', () => expect(store.search({ query: '小说', compact: true }).searchPage.items).toHaveLength(30));
      measure('rare phrase', () => expect(store.search({ query: '星海合同', compact: true }).searchPage.items.length).toBeGreaterThan(0));
      measure('absent phrase', () => expect(store.search({ query: '完全没有出现的词', compact: true }).searchPage.items).toHaveLength(0));
      measure('AND keywords', () => expect(store.search({ query: '合同 验收', compact: true }).searchPage.items.length).toBeGreaterThan(0));
      measure('conversation and author', () => expect(store.search({ query: '小说', conversationId: rooms[0]!.id, authorId: 'user', compact: true }).searchPage.items).toHaveLength(30));
      measure('old date filter', () => expect(store.search({ query: '小说', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', compact: true }).searchPage.items).toHaveLength(30));
      measure('deep keyset history', () => expect(store.messages({ conversationId: rooms[0]!.id, before: Math.floor(count / 2), limit: 50 }).messages).toHaveLength(50));
    }
    const timings = Object.fromEntries(Object.entries(samples).map(([name, times]) => { const sorted = [...times].sort((a, b) => a - b); return [name, { firstMs: times[0], medianMs: sorted[3], maxMs: sorted.at(-1) }]; }));
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT m.sequence FROM messages m JOIN message_search ON message_search.rowid=m.sequence WHERE message_search MATCH ? AND m.sequence<? ORDER BY message_search.rowid DESC LIMIT 31').all('"u5c0f"', count);
    const receipt = { count, buildMs, databaseBytes: statSync(filename).size, timings, plan };
    writeFileSync(path.resolve('.tools/history-benchmark-' + count + '.json'), JSON.stringify(receipt, null, 2));
    expect(JSON.stringify(plan)).not.toContain('"SCAN m"');
    expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
    for (const times of Object.values(samples)) expect(Math.max(...times)).toBeLessThan(5000);
  } finally { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
}, 600_000);
