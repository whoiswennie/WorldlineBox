import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { CompanionMemory, CompanionMessage } from '../../src/shared/companions';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';

let root: string, store: CompanionsStore, scope: { companionId: string; conversationId: string };
const seeds = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister' as const, proactive: false, active: true }));
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'companion-consolidation-')); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
});
afterEach(() => {
  store.close(); const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('companion-consolidation-')) throw new Error('Invalid cleanup');
  rmSync(resolved, { recursive: true, force: true });
});
const candidate = (source: CompanionMessage, content = source.content): CompanionMemoryCandidate => ({ content, tags: ['有条件认识'],
  sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] });
function note(content: string, room = scope.conversationId) {
  const source = store.appendMessage({ conversationId: room, authorId: 'user', content, replyDirective: 'none' });
  const memory = store.request({ type: 'memory.record', companionId: scope.companionId, conversationId: room, candidate: candidate(source) }).memories![0]!;
  return { source, memory };
}
function index() {
  for (let count = 0; count < 100; count++) {
    const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
    if (job) store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
  }
}
const read = (id: string) => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory;
const active = () => store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes;
function consolidate(inputs: CompanionMemory[], source: CompanionMessage, operationId = 'merge_one') {
  return store.request({ type: 'memory.consolidate', ...scope, operationId, inputs: inputs.map(note => ({ id: note.id, version: note.version })),
    candidate: candidate(source, '昨日不适合运动；今天只是天气允许时可以散步，并非保证总能出门。') }).memories![0]!;
}
it('publishes the new index before archiving originals, preserves evidence versions and survives restart', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步，并非保证总能出门。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source);
  expect(active().map(note => note.id).sort()).toEqual([a.memory.id, b.memory.id].sort());
  expect(read(a.memory.id).archivedAt).toBeUndefined(); index();
  expect(active().map(note => note.id)).toEqual([merged.id]);
  expect(read(a.memory.id)).toMatchObject({ version: 1, supersededBy: merged.id, status: 'indexed', content: a.source.content });
  expect(consolidate([a.memory, b.memory], a.source).id).toBe(merged.id);
  store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds);
  expect(active().map(note => note.id)).toEqual([merged.id]); expect(read(b.memory.id).sources[0]?.messageId).toBe(b.source.id);
});
it('withdraws the derivative when a source reached only through the dependency graph is forgotten', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source); index();
  store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [b.source.id] });
  expect(() => read(merged.id)).toThrow();
  expect(active().map(note => note.id)).toEqual([a.memory.id]);
});
it.each(['A', 'B'] as const)('preserves the other original after source-only forget %s invalidates a merge carrying both sources and an expired archive outbox', forgottenSide => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步，并非保证总能出门。'); index();
  const forgotten = forgottenSide === 'A' ? a : b, survivor = forgottenSide === 'A' ? b : a;
  const merged = store.request({ type: 'memory.consolidate', ...scope, operationId: 'merge_complete_sources',
    inputs: [read(a.memory.id), read(b.memory.id)].map(memory => ({ id: memory.id, version: memory.version })),
    candidate: { content: `${a.source.content}${b.source.content}`, tags: ['有条件认识'], sourceMessageIds: [a.source.id, b.source.id],
      evidence: [a.source, b.source].map(source => ({ sourceMessageId: source.id, quote: source.content })) } }).memories![0]!;
  expect(merged.sources.map(source => source.messageId).sort()).toEqual([a.source.id, b.source.id].sort());
  const publish = store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  expect(publish).toMatchObject({ operation: 'remember', noteId: merged.id });
  store.request({ type: 'memory.outbox.complete', id: publish.id, leaseToken: publish.leaseToken, indexed: true });
  expect(active().map(memory => memory.id)).toEqual([merged.id]);
  expect(read(survivor.memory.id).archivedAt).toBeDefined();
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    let staleArchive: NonNullable<ReturnType<CompanionsStore['request']>['memoryOutbox']> | undefined;
    for (let count = 0; count < 2; count++) {
      const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
      expect(job?.operation).toBe('forget');
      if (job?.noteId === survivor.memory.id) { staleArchive = job; break; }
      store.request({ type: 'memory.outbox.complete', id: job!.id, leaseToken: job!.leaseToken, indexed: true });
    }
    expect(staleArchive).toMatchObject({ operation: 'forget', noteId: survivor.memory.id, noteVersion: 1 });
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [forgotten.source.id] });
    expect(() => read(forgotten.memory.id)).toThrow(); expect(() => read(merged.id)).toThrow();
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [forgotten.source.id] }).memorySources).toEqual([]);
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [survivor.source.id] }).memorySources).toEqual([survivor.source]);
    expect(read(survivor.memory.id)).toMatchObject({ content: survivor.source.content, sources: [expect.objectContaining({ messageId: survivor.source.id })] });
    expect(read(survivor.memory.id).archivedAt).toBeUndefined();
    clock.mockReturnValue(now + 120001);
    const dispatched: Array<{ id: string; noteId: string; operation: string }> = [];
    for (let count = 0; count < 100; count++) {
      const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox;
      if (!job) continue;
      dispatched.push({ id: job.id, noteId: job.noteId, operation: job.operation });
      store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
    }
    expect(dispatched.some(job => job.noteId === survivor.memory.id && job.operation === 'remember')).toBe(true);
    expect(dispatched.some(job => job.id === staleArchive!.id || job.noteId === survivor.memory.id && job.operation === 'forget')).toBe(false);
    expect(active().map(memory => memory.id)).toEqual([survivor.memory.id]);
    expect(read(survivor.memory.id)).toMatchObject({ content: survivor.source.content, status: 'indexed' });
    store.close(); store = new CompanionsStore(path.join(root, 'state.sqlite'), seeds); index();
    expect(active().map(memory => memory.id)).toEqual([survivor.memory.id]);
    expect(read(survivor.memory.id)).toMatchObject({ content: survivor.source.content, status: 'indexed' });
    expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [survivor.source.id] }).memorySources).toEqual([survivor.source]);
    expect(() => read(forgotten.memory.id)).toThrow(); expect(() => read(merged.id)).toThrow();
  } finally { clock.mockRestore(); }
});
it('does not resurrect omitted parent evidence when the merged entry itself is forgotten', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source); index();
  store.request({ type: 'memory.forget', ...scope, id: merged.id }); index();
  expect(active()).toEqual([]);
  expect(store.request({ type: 'memory.sources.filter', ...scope, ids: [a.source.id, b.source.id] }).memorySources).toEqual([]);
});
it('restores still-valid originals after a correction invalidates the merge, with no stale archive-removal delivery', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const merged = consolidate([read(a.memory.id), read(b.memory.id)], a.source); index();
  const corrected = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '更正：昨日只是不适合高强度运动。', replyDirective: 'none' });
  store.request({ type: 'memory.revise', ...scope, id: a.memory.id, expectedVersion: 1, candidate: candidate(corrected) });
  expect(() => read(merged.id)).toThrow(); index();
  expect(active().map(note => note.id).sort()).toEqual([a.memory.id, b.memory.id].sort());
  expect(read(b.memory.id).archivedAt).toBeUndefined(); expect(read(a.memory.id).version).toBe(2);
});
it('rejects stale versions and merging different visibility domains before creating a derivative', () => {
  const a = note('私人认识。'); const group = store.createConversation('公开讨论', ['alice', 'bob']); const b = note('群内认识。', group.id); index();
  expect(() => consolidate([{ ...a.memory, version: 99 }, b.memory], a.source)).toThrow('准确记忆版本');
  expect(() => consolidate([read(a.memory.id), read(b.memory.id)], a.source)).toThrow('不同来源可见域');
  expect(active()).toHaveLength(2);
});
it('classifies a real requested merge without allowing free metadata to claim it was an automatic sleep job', () => {
  const a = note('昨日不适合运动。'), b = note('今天天气允许时可以散步。'); index();
  const existing = store.request({ type: 'memory.record', ...scope, candidate: { ...candidate(a.source, '昨日不适合运动，今天只在天气允许时散步。'),
    relatedMemoryIds: [a.memory.id, b.memory.id], metadata: { customLabel: '保留来源条件' } } }).memories![0]!;
  expect(existing.metadata?.consolidation).toBeUndefined();
  const merged = store.request({ type: 'memory.consolidate', ...scope, operationId: 'honest_merge', inputs: [a.memory, b.memory].map(note => ({ id: note.id, version: note.version })),
    candidate: { ...candidate(a.source, '昨日不适合运动，今天只在天气允许时散步。'),
      metadata: { consolidation: false, automaticConsolidation: true, sleepReflection: true, sleepWorldJobId: 'fake_job', worldJobId: 'fake_job', sleepEpisodeId: 'fake_episode', customLabel: '保留来源条件' } } }).memories![0]!;
  expect(merged.id).toBe(existing.id);
  expect(merged.metadata).toMatchObject({ consolidation: 'source_version_graph', customLabel: '保留来源条件' });
  for (const key of ['automaticConsolidation', 'sleepReflection', 'sleepWorldJobId', 'worldJobId', 'sleepEpisodeId']) expect(merged.metadata?.[key]).toBeUndefined();
  index(); expect(active().map(note => note.id)).toEqual([merged.id]); expect(read(a.memory.id).archivedAt).toBeDefined();
});
