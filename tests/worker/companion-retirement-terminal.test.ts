import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';

it('deletes exact terminal owner notes and FKs without creating last versions or forget work while preserving another owner bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-terminal-retire-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-terminal-retire-')) throw new Error('Unsafe terminal fixture path.');
  const filename = path.join(root, 'messages.sqlite'), store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '真实来源。', model: '', avatar: 'sister', active: true, proactive: false })));
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename);
  try {
    const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, bobScope = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '合成事件：先检查蓝色资料袋，再登记结果。', replyDirective: 'none' });
    const base = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: source.content,
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: ['合成事件'] } }).memories![0]!;
    store.request({ type: 'memory.record', ...scope, readMemories: [{ id: base.id, version: base.version, contentRevision: base.contentRevision! }],
      candidate: { artifactKind: 'episode_memory', content: '这一次合成事件的顺序是先检查资料袋，再登记结果。', relatedMemoryIds: [base.id],
        sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: ['顺序'] } });
    const otherSource = store.appendMessage({ conversationId: bobScope.conversationId, authorId: 'user', content: '另一身份保留的独立合成资料。', replyDirective: 'none' });
    const other = store.request({ type: 'memory.record', ...bobScope, candidate: { artifactKind: 'knowledge', content: otherSource.content,
      sourceMessageIds: [otherSource.id], evidence: [{ sourceMessageId: otherSource.id, quote: otherSource.content }], tags: ['独立'] } }).memories![0]!;
    const digest = () => createHash('sha256').update(String((db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(other.id) as { data: string }).data)).digest('hex');
    const otherHash = digest(), beforeOutbox = db.prepare("SELECT COUNT(*) AS count FROM vcp_memory_outbox WHERE companion_id='alice'").get();
    const job = store.request({ type: 'companion.retire', id: 'alice', scope: 'all' }).reset!;
    store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: job.id });
    for (let step = 0; step < 20; step++) {
      await store.advanceReset();
      if ((db.prepare("SELECT COUNT(*) AS count FROM vcp_memory_notes WHERE companion_id='alice'").get() as { count: number }).count === 0) break;
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM vcp_memory_notes WHERE companion_id='alice'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM companion_memory_content_revisions WHERE companion_id='alice'").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vcp_memory_outbox WHERE companion_id='alice'").get()).toEqual(beforeOutbox);
    expect(db.prepare('SELECT COUNT(*) AS count FROM vcp_note_dependencies WHERE source_note_id=? OR note_id=?').get(base.id, base.id)).toEqual({ count: 0 });
    expect(digest()).toBe(otherHash); expect(store.getMessage(otherSource.id).content).toBe(otherSource.content);
    for (let step = 0; step < 200 && store.request({ type: 'companion.retire.status', id: 'alice' }).reset!.status !== 'completed'; step++) await store.advanceReset();
    expect(store.request({ type: 'companion.retire.status', id: 'alice' }).reset!.status).toBe('completed');
    expect(digest()).toBe(otherHash);
  } finally { db.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
