import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const roots: string[] = [], stores: CompanionsStore[] = [], connections: CompanionConnection[] = [];
afterEach(() => {
  vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('scheduler-query-ports-')) throw Error('Unexpected fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'scheduler-query-ports-')); roots.push(root);
  const filename = path.join(root, 'state.sqlite'), store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '保留真实来源。', model: '', avatar: 'sister' as const, active: true, proactive: false }))); stores.push(store);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename); connections.push(db);
  const room = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: room.id };
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '独立讨论', kind: 'discussion' }).topic!;
  const source = store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content: '明天上午去图书馆核对资料。', replyDirective: 'none' });
  const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: source.content,
    tags: ['实际安排'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  for (let n = 0; n < 10; n++) { const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break; store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); }
  // Retire the bounded UI archive tail before asserting exact zero writes in
  // the healthy query fixture. A separate test below exercises that tail.
  const observed = new Set<CompanionConnection>(), prototype = Object.getPrototypeOf(db), prepare = prototype.prepare;
  const capture = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    if (this !== db) observed.add(this); return Reflect.apply(prepare, this, args);
  });
  try { for (let n = 0; n < 3; n++) store.request({ type: 'work.list' }); } finally { capture.mockRestore(); }
  expect(observed.size).toBe(1); const actual = [...observed][0]!;
  const changes = () => actual.prepare('SELECT total_changes() AS n').get();
  const snapshot: CompanionStorageCommand = { type: 'memory.snapshot', ...scope };
  const page: Extract<CompanionStorageCommand, { type: 'topic.compaction.sources' }> = { type: 'topic.compaction.sources', conversationId: room.id, topicId: topic.id, readerId: 'alice',
    beforeSequence: source.sequence, afterPublicationRevision: 0, legacyAfterSequence: 0, limit: 10 };
  return { store, db, room, scope, topic, source, note, snapshot, page, changes };
}

it.each(['complete', 'missing', 'stale-participants'] as const)('reads exact topic sources and snapshot with %s primary without lazy topic or authority mutations', condition => {
  const f = fixture();
  if (condition === 'missing') {
    f.db.prepare('DELETE FROM companion_topic_current WHERE topic_id=?').run(f.room.defaultTopicId!);
    f.db.prepare('DELETE FROM metadata WHERE key=?').run('primary-chat-topic/' + f.room.id);
    f.db.prepare('DELETE FROM companion_topics WHERE id=?').run(f.room.defaultTopicId!);
  } else if (condition === 'stale-participants') f.db.prepare("UPDATE companion_topics SET data=json_set(data,'$.participantIds',json(?)) WHERE id=?").run(JSON.stringify(['user']), f.room.defaultTopicId!);
  const before = f.changes(), dataVersion = f.db.prepare('PRAGMA data_version').get();
  const page = f.store.request(f.page).topicCompactionPage!, snapshot = f.store.request(f.snapshot).memorySnapshot!;
  expect(page.items.map(item => item.message.id)).toEqual([f.source.id]); expect(page.items[0]!.message.content).toBe(f.source.content);
  expect(snapshot.notes.map(note => note.id)).toEqual([f.note.id]); expect(snapshot.notes[0]!.sources).toEqual(f.note.sources);
  expect(f.changes()).toEqual(before); expect(f.db.prepare('PRAGMA data_version').get()).toEqual(dataVersion);
  if (condition === 'missing') expect(f.db.prepare("SELECT 1 FROM companion_topics WHERE conversation_id=? AND json_extract(data,'$.isPrimary')=1").get(f.room.id)).toBeUndefined();
  if (condition === 'stale-participants') expect(JSON.parse((f.db.prepare('SELECT data FROM companion_topics WHERE id=?').get(f.room.defaultTopicId!) as { data: string }).data).participantIds).toEqual(['user']);
});

it('reads a guarded compaction page without renewing, binding, invalidating or indexing its actual job', () => {
  const f = fixture(); f.store.request({ type: 'topic.compaction.enqueue', ...f.scope, topicId: f.topic.id, sourceMessageId: f.source.id });
  const job = f.store.request({ type: 'topic.compaction.claim', excludedCompanionIds: [], leaseMs: 120000 }).topicCompactionJob!;
  const command = { ...f.page, beforeSequence: job.claimedThroughSequence!, throughPublicationRevision: job.claimedPublicationRevision,
    sourceMessageId: f.source.id, sourceChecksum: createHash('sha256').update(f.source.content).digest('hex'), jobGuard: { id: job.id, leaseToken: job.leaseToken! } };
  const before = f.db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(job.id), changes = f.changes();
  expect(f.store.request(command).topicCompactionPage?.items[0]?.message.id).toBe(f.source.id);
  expect(f.db.prepare('SELECT * FROM companion_topic_compaction_jobs WHERE id=?').get(job.id)).toEqual(before); expect(f.changes()).toEqual(changes);
});

it('retains reader membership and source-withdrawal checks on both query ports', () => {
  const f = fixture();
  expect(() => f.store.request({ ...f.page, readerId: 'bob' })).toThrow('读者');
  expect(() => f.store.request({ type: 'memory.snapshot', companionId: 'bob', conversationId: f.room.id })).toThrow('成员');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] });
  expect(f.store.request(f.page).topicCompactionPage?.items).toEqual([]);
  expect(f.store.request(f.snapshot).memorySnapshot?.notes).toEqual([]);
  expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
});

it('allows the existing archive maintenance tail without treating it as a source or permission mutation', () => {
  const f = fixture();
  f.store.appendMessage({ conversationId: f.room.id, topicId: f.topic.id, authorId: 'alice', content: '已收到明天核对资料的安排。', replyDirective: 'none' });
  const authority = () => ['companions', 'conversations', 'conversation_members', 'companion_topics', 'companion_topic_current', 'messages',
    'vcp_source_observers', 'vcp_source_blocks', 'vcp_source_prohibitions', 'vcp_memory_notes', 'vcp_memory_scopes', 'companion_topic_compaction_jobs', 'metadata']
    .map(table => f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  const before = authority(), changes = f.changes() as { n: number };
  expect(f.store.request(f.snapshot).memorySnapshot?.notes[0]?.id).toBe(f.note.id);
  expect(authority()).toEqual(before);
  expect((f.changes() as { n: number }).n).toBeGreaterThan(changes.n);
});
