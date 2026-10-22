import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, onTestFinished } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionTopic } from '../../src/shared/companion-topic';
const NativeDatabase = Database as { new (filename: string): CompanionConnection };

it('pages and filters ten thousand actual SQLite topics without returning an unbounded catalog', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-topic-scale-')), file = path.join(root, 'messages.sqlite');
  const seed = [{ id: 'alice', name: 'Alice', description: '', persona: '独立伙伴', model: '', avatar: 'sister' as const, proactive: false }];
  let store = new CompanionsStore(file, seed);
  onTestFinished(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const room = store.openPrivate('alice'); store.close();
  const db = new NativeDatabase(file), insert = db.prepare('INSERT INTO companion_topics(id,conversation_id,data) VALUES(?,?,?)'), stamp = new Date().toISOString();
  // Seed storage volume directly; this is a query benchmark, not a model creating 10,000 activities.
  db.transaction(() => { for (let index = 0; index < 10000; index++) {
    const topic: CompanionTopic = { id: 'scale_' + index, conversationId: room.id, title: index % 500 ? '长期讨论' + index : '星际笔记' + index,
      kind: 'discussion', status: 'active', participantIds: ['user'], invitedIds: ['alice'], tags: index % 7 ? ['日常'] : ['狼人杀', '策略'],
      moderatorId: 'user', revision: 1, createdAt: stamp, updatedAt: stamp };
    insert.run(topic.id, room.id, JSON.stringify(topic));
  } })(); db.close(); store = new CompanionsStore(file, seed);
  const started = performance.now(), seen = new Set<string>(); let before: number | undefined;
  for (let page = 0; page < 5; page++) {
    const result = store.request({ type: 'topic.list', conversationId: room.id, readerId: 'user', before, limit: 50 });
    expect(result.topics).toHaveLength(50); expect(result.hasMore).toBe(true);
    for (const topic of result.topics!) { expect(seen.has(topic.id)).toBe(false); seen.add(topic.id); }
    before = result.topicNextCursor;
  }
  const fuzzy = store.request({ type: 'topic.list', conversationId: room.id, readerId: 'user', query: '际笔', limit: 100 });
  expect(fuzzy.topics).toHaveLength(20); expect(fuzzy.hasMore).toBe(false);
  const tags = store.request({ type: 'topic.list', conversationId: room.id, readerId: 'user', tags: ['狼人杀'], limit: 50 });
  expect(tags.topics).toHaveLength(50); expect(tags.hasMore).toBe(true); expect(tags.topics!.every(topic => topic.tags.includes('狼人杀'))).toBe(true);
  const elapsedMs = performance.now() - started;
  expect(elapsedMs).toBeLessThan(1500);
  const output = path.resolve('.tools/test-output/companion-topic-scale.json'); mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ status: 'passed', topicCount: 10000, pages: 5, pageSize: 50, uniqueRows: seen.size,
    fuzzyMatches: fuzzy.topics!.length, tagPageSize: tags.topics!.length, elapsedMs }, null, 2));
});
