import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';

let store: CompanionsStore | undefined, directory: string | undefined;
afterEach(() => {
  store?.close(); store = undefined;
  if (directory) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-recall-state-')) throw new Error('Unexpected fixture path');
    rmSync(target, { recursive: true, force: true }); directory = undefined;
  }
});
function fixture() {
  directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-recall-state-'));
  store = new CompanionsStore(path.join(directory, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, persona: '认真', description: '', model: '', avatar: 'sister', proactive: false, active: true })));
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  return { db: store, scope, stamp: (owner = 'alice') => store!.request({ type: 'memory.corpus.stamp', companionId: owner }).memoryCorpusStamp };
}

it('changes the cheap owner stamp for actual corpus writes and index completion, while unrelated messages preserve it', () => {
  const { db, scope, stamp } = fixture(), initial = stamp(), bob = stamp('bob');
  const source = db.appendMessage({ conversationId: scope.conversationId, content: '我的名字是天幻。', authorId: 'user' });
  expect(stamp()).toBe(initial);
  const note = db.request({ type: 'memory.record', ...scope, candidate: { content: '玩家介绍自己叫天幻。', tags: ['名字'],
    sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const queued = stamp(); expect(queued).not.toBe(initial); expect(stamp('bob')).toBe(bob);
  const job = db.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox!;
  db.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
  const indexed = stamp(); expect(indexed).not.toBe(queued);
  db.request({ type: 'world.clock.peek' }); expect(stamp()).toBe(indexed);
  db.request({ type: 'memory.forget', ...scope, id: note.id }); expect(stamp()).not.toBe(indexed);
});

it('locates only the exact saved message checkpoint without generating a model request or changing the corpus', () => {
  const { db, scope, stamp } = fixture();
  const source = db.appendMessage({ conversationId: scope.conversationId, content: '你记得我吗？', authorId: 'user' });
  const reply = db.appendMessage({ conversationId: scope.conversationId, content: '', authorId: 'alice', loopStep: 0 });
  db.request({ type: 'loop.save', checkpoint: { ...scope, sourceMessageId: source.id, messageId: reply.id, status: 'running', turns: [], supplements: [],
    context: { system: '没有模型推理', user: JSON.stringify({ memoryRecall: { pending: true, degraded: false } }) } } });
  const before = stamp();
  expect(db.request({ type: 'loop.for-message', messageId: reply.id }).loop).toMatchObject({ ...scope, sourceMessageId: source.id, messageId: reply.id });
  expect(db.request({ type: 'loop.for-message', messageId: source.id }).loop).toBeUndefined();
  expect(stamp()).toBe(before);
});
