import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection, type CompanionSeed } from '../../src/companions/store';
import { companionLoopCheckpointSchema, type CompanionLoopCheckpoint } from '../../src/shared/companion-loop';

const seeds: CompanionSeed[] = [{ id: 'alice', name: '甲', description: '', persona: '认真', model: '', avatar: 'sister', proactive: false }];
const stores = new Set<CompanionsStore>(), folders: string[] = [];
function open(filename: string) { const store = new CompanionsStore(filename, seeds.map(seed => ({ ...seed, active: true }))); stores.add(store); return store; }
function close(store: CompanionsStore) { store.close(); stores.delete(store); }
function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'companion-stream-')); folders.push(folder);
  const filename = path.join(folder, 'messages.sqlite'), store = open(filename);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请继续回答。' });
  const bubble = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: '', loopStep: 0 });
  const checkpoint: CompanionLoopCheckpoint = { ...scope, sourceMessageId: source.id, messageId: bubble.id, status: 'running', turns: [], supplements: [] };
  return { store, filename, scope, source, bubble, checkpoint };
}
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('durable companion reply streaming drafts', () => {
  it('accepts only visible text for the current unfinished step', () => {
    const { checkpoint } = fixture();
    expect(companionLoopCheckpointSchema.safeParse({ ...checkpoint, draft: { step: 1, attemptId: 'attempt', text: '内容' } }).success).toBe(false);
    expect(companionLoopCheckpointSchema.safeParse({ ...checkpoint, status: 'done', draft: { step: 0, attemptId: 'attempt', text: '内容' } }).success).toBe(false);
    expect(companionLoopCheckpointSchema.safeParse({ ...checkpoint, draft: { step: 0, attemptId: 'attempt', text: '', arguments: '{}' } }).success).toBe(false);
  });

  it('reopens the same partially written bubble and replaces a retried step without appending twice', () => {
    const { store, filename, checkpoint, bubble, source } = fixture();
    const turns = [{ text: '', rawText: '', calls: [] }];
    store.request({ type: 'loop.save', checkpoint: { ...checkpoint, turns, draft: { step: 1, attemptId: 'attempt_a', text: '杭州草稿未完成' } } });
    expect(store.getMessage(bubble.id)).toMatchObject({ content: '杭州草稿未完成', isReplyDraft: true, replyDraft: { step: 1, attemptId: 'attempt_a', text: '杭州草稿未完成' }, segments: [{ text: '' }, { text: '杭州草稿未完成' }] });
    close(store);
    const reopened = open(filename), recovered = reopened.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'alice' }).loop!;
    expect(recovered.messageId).toBe(bubble.id); expect(recovered.draft?.attemptId).toBe('attempt_a');
    reopened.request({ type: 'loop.save', checkpoint: { ...recovered, draft: { step: 1, attemptId: 'attempt_b', text: '重试后的完整答案' } } });
    expect(reopened.getMessage(bubble.id).content).toBe('重试后的完整答案');
    expect(reopened.messages({ conversationId: checkpoint.conversationId }).messages).toHaveLength(2);
    expect(() => reopened.request({ type: 'loop.save', checkpoint: { ...checkpoint, draft: { step: 0, attemptId: 'stale', text: '丢失完成步骤' } } })).toThrow('已完成');
  });

  it('keeps partial text out of FTS, extraction, source fallback and source revisions, then indexes an identical final body once', () => {
    const { store, filename, scope, checkpoint, source, bubble } = fixture();
    // Explicit internal flush isolates formal-publication and draft exclusion
    // from the separately tested episode quiet interval.
    const job = store.request({ type: 'memory.jobs.claim', companionId: scope.companionId, force: true }).memoryJob!;
    expect(job.sourceMessageIds).toEqual([source.id]);
    for (const text of ['杭州', '杭州的地址是未核实的草稿']) store.request({ type: 'loop.save', checkpoint: { ...checkpoint, draft: { step: 0, attemptId: 'active_attempt', text } } });
    const Database = BetterSqlite3 as { new(filename: string, options: { readonly: boolean }): CompanionConnection };
    const read = new Database(filename, { readonly: true });
    expect(read.prepare('SELECT revision FROM messages WHERE id=?').get(bubble.id)).toMatchObject({ revision: 1 });
    expect(read.prepare('SELECT rowid FROM message_search WHERE rowid=?').get(bubble.sequence)).toBeUndefined(); read.close();
    expect(store.search({ query: '杭州' }).messages).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [bubble.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [bubble.id] }).memorySources).toEqual([]);
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
    expect(store.request({ type: 'memory.status', ...scope }).memoryStatus).toMatchObject({ pending: 0, completed: 1 });
    const later = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '另一条请求' });
    const final = { ...checkpoint, status: 'done' as const, turns: [{ text: '杭州的地址是未核实的草稿', rawText: '杭州的地址是未核实的草稿', calls: [] }] };
    store.request({ type: 'loop.save', checkpoint: final });
    expect(store.getMessage(bubble.id).isReplyDraft).toBeUndefined(); expect(store.getMessage(bubble.id).replyDraft).toBeUndefined();
    expect(store.search({ query: '杭州' }).messages.map(message => message.id)).toEqual([bubble.id]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, beforeSequence: later.sequence, ids: [bubble.id] }).memorySources).toEqual([]);
    const next = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '下一条请求' });
    expect(store.request({ type: 'memory.sources.filter', ...scope, beforeSequence: next.sequence, ids: [bubble.id] }).memorySources?.map(message => message.id)).toEqual([bubble.id]);
    store.request({ type: 'loop.save', checkpoint: final });
    expect(store.request({ type: 'memory.jobs.claim', companionId: scope.companionId, force: true }).memoryJob?.sourceMessageIds.filter(id => id === bubble.id)).toEqual([bubble.id]);
    expect(() => store.request({ type: 'loop.save', checkpoint })).toThrow('迟到草稿');
    expect(store.getMessage(source.id).content).toBe('请继续回答。');
  });

  it('allows a new proactive bubble using the same original source while protecting the older completed bubble', () => {
    const { store, checkpoint, bubble } = fixture();
    store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', turns: [{ text: '已完成的原回复', rawText: '已完成的原回复', calls: [] }] } });
    const next = store.appendMessage({ conversationId: checkpoint.conversationId, authorId: 'alice', content: '', loopStep: 0 });
    store.request({ type: 'loop.save', checkpoint: { ...checkpoint, messageId: next.id, draft: { step: 0, attemptId: 'proactive', text: '另一条实际正在生成的回复' } } });
    expect(store.getMessage(next.id).replyDraft?.attemptId).toBe('proactive');
    expect(store.getMessage(bubble.id).content).toBe('已完成的原回复');
    expect(() => store.request({ type: 'loop.save', checkpoint })).toThrow('迟到草稿');
  });
});
